// ===================================================
// A2 OCR-BASED VIEW DETECTION SYSTEM
// ===================================================

// Logger
const log = document.getElementById("log");
function appendLog(msg) {
  log.textContent += msg + "\n";
  log.scrollTop = log.scrollHeight;
}

// Canvases
const fullCanvas = document.getElementById("fullCanvas");
const topCanvas = document.getElementById("topCanvas");
const profileCanvas = document.getElementById("profileCanvas");
const bodyCanvas = document.getElementById("bodyCanvas");

// Inputs & buttons
const gaInput = document.getElementById("gaInput");
const detectViewsBtn = document.getElementById("detectViews");
const autoDetectBtn = document.getElementById("autoDetect");

// Keyword lists for OCR view detection
const OCR_KEYWORDS = [
  { view: "top", words: ["TOP VIEW", "TOP PLAN", "PLAN VIEW", "DECK PLAN"] },
  { view: "profile", words: ["PROFILE VIEW", "SIDE VIEW", "SHEER PLAN", "ELEVATION"] },
  { view: "body", words: ["BODY PLAN", "SECTIONS", "FRAME LINES", "LINES PLAN"] },
  { view: "top", words: ["GENERAL ARRANGEMENT", "GA PLAN", "G.A. PLAN"] }
];

// ===================================================
// 1. RENDER FILE TO CANVAS (PDF or Image)
// ===================================================
async function renderFileToCanvas(file, canvas) {
  const ctx = canvas.getContext("2d");

  if (file.name.toLowerCase().endsWith(".pdf")) {
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const page = await pdf.getPage(1);

    const viewport = page.getViewport({ scale: 1.8 });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport }).promise;
    appendLog("PDF rendered to canvas.");
    return;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      appendLog("Image rendered to canvas.");
      resolve();
    };
    const reader = new FileReader();
    reader.onload = (e) => (img.src = e.target.result);
    reader.readAsDataURL(file);
  });
}

// ===================================================
// 2. RUN OCR ON FULL CANVAS
// ===================================================
async function runOCR(canvas) {
  appendLog("Running OCR... (5–10 seconds)");

  const worker = Tesseract.createWorker();
  await worker.load();
  await worker.loadLanguage("eng");
  await worker.initialize("eng");

  const result = await worker.recognize(canvas.toDataURL("image/png"));
  await worker.terminate();

  const words = result.data.words.map(w => ({
    text: w.text.toUpperCase(),
    bbox: {
      x: w.bbox.x0,
      y: w.bbox.y0,
      w: w.bbox.x1 - w.bbox.x0,
      h: w.bbox.y1 - w.bbox.y0
    }
  }));

  appendLog(`OCR detected ${words.length} words.`);
  return words;
}

// ===================================================
// 3. MATCH OCR WORDS TO VIEW LABELS
// ===================================================
function matchOCR(words) {
  const assigned = { top: null, profile: null, body: null };

  OCR_KEYWORDS.forEach(group => {
    group.words.forEach(keyword => {
      words.forEach(w => {
        if (w.text.includes(keyword)) {
          if (!assigned[group.view]) assigned[group.view] = w.bbox;
        }
      });
    });
  });

  appendLog("Matched OCR boxes: " + JSON.stringify(assigned));
  return assigned;
}

// ===================================================
// 4. COMPUTE CROP AREAS AROUND DETECTED LABELS
// ===================================================
function computeCropArea(bbox, canvas) {
  const W = canvas.width;
  const H = canvas.height;

  return {
    x: Math.max(0, bbox.x - W * 0.05),
    y: Math.max(0, bbox.y + bbox.h * 1.2),
    w: Math.min(W * 0.9, W),
    h: Math.min(H * 0.45, H - bbox.y)
  };
}

// ===================================================
// 5. APPLY CROP FROM FULL CANVAS TO TARGET CANVAS
// ===================================================
function cropToCanvas(rect, source, dest) {
  const ctx = dest.getContext("2d");
  dest.width = rect.w;
  dest.height = rect.h;

  ctx.drawImage(
    source,
    rect.x, rect.y, rect.w, rect.h,
    0, 0, rect.w, rect.h
  );
}

// ===================================================
// 6. OCR VIEW DETECTION MAIN FUNCTION
// ===================================================
async function detectViews() {
  if (!fullCanvas.width) {
    appendLog("❌ No GA loaded yet.");
    return;
  }

  const words = await runOCR(fullCanvas);
  const boxes = matchOCR(words);

  if (boxes.top) {
    cropToCanvas(computeCropArea(boxes.top, fullCanvas), fullCanvas, topCanvas);
    appendLog("✔ Top view cropped");
  }

  if (boxes.profile) {
    cropToCanvas(computeCropArea(boxes.profile, fullCanvas), fullCanvas, profileCanvas);
    appendLog("✔ Profile view cropped");
  }

  if (boxes.body) {
    cropToCanvas(computeCropArea(boxes.body, fullCanvas), fullCanvas, bodyCanvas);
    appendLog("✔ Body plan cropped");
  }

  appendLog("View detection complete.");
}

// ===================================================
// 7. OPENCV HULL EXTRACTION
// ===================================================
function extractContoursFromCanvas(canvas, label) {
  if (!window.OPENCV_READY) {
    appendLog("❌ OpenCV not ready");
    return [];
  }

  const ctx = canvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let src = cv.matFromImageData(imgData);
  let gray = new cv.Mat(), thr = new cv.Mat(), edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.threshold(gray, thr, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  cv.Canny(thr, edges, 75, 200);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  appendLog(`[${label}] All contours: ${contours.size()}`);

  let best = -1;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const area = cv.contourArea(contours.get(i));
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  }

  if (best < 0) {
    appendLog(`[${label}] ❌ No usable contour`);
    return [];
  }

  const hull = contours.get(best);
  appendLog(`[${label}] Hull area = ${bestArea}`);

  const pts = [];
  for (let i = 0; i < hull.data32S.length; i += 2) {
    pts.push({ x: hull.data32S[i], y: hull.data32S[i + 1] });
  }

  return pts;
}

// ===================================================
// 8. BUTTON HANDLERS
// ===================================================
gaInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  await renderFileToCanvas(file, fullCanvas);
  appendLog("Loaded GA file: " + file.name);
});

detectViewsBtn.addEventListener("click", detectViews);

autoDetectBtn.addEventListener("click", () => {
  appendLog("=== AUTO-DETECT START ===");
  extractContoursFromCanvas(topCanvas, "top");
  extractContoursFromCanvas(profileCanvas, "profile");
  extractContoursFromCanvas(bodyCanvas, "body");
  appendLog("=== AUTO-DETECT COMPLETE ===");
});
