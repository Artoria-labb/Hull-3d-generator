// ================================================
// GA → Hull MVP — Improved Contour Extraction (A1)
// ================================================

const log = document.getElementById("log");
function appendLog(msg) {
  log.textContent += msg + "\n";
  log.scrollTop = log.scrollHeight;
}

const canvases = {
  top: document.getElementById("topCanvas"),
  side: document.getElementById("sideCanvas"),
  profile: document.getElementById("profileCanvas")
};

const inputs = {
  top: document.getElementById("topInput"),
  side: document.getElementById("sideInput"),
  profile: document.getElementById("profileInput")
};

window.pipeline = {
  top: [],
  side: [],
  profile: [],
  classified: { top: [], side: [], profile: [] }
};

window.onOpenCvReady = () => appendLog("OpenCV.js loaded successfully.");


// ==================================================
// IMAGE PREVIEW (PNG/JPG)
// ==================================================
function previewImage(file, canvas) {
  return new Promise(resolve => {
    const reader = new FileReader();
    const img = new Image();

    reader.onload = e => {
      img.onload = () => {
        const ctx = canvas.getContext("2d");
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;

        canvas.width = w;
        canvas.height = h;

        ctx.clearRect(0, 0, w, h);

        const s = Math.min(w / img.width, h / img.height);
        const dw = img.width * s;
        const dh = img.height * s;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;

        ctx.drawImage(img, dx, dy, dw, dh);
        resolve();
      };
      img.src = e.target.result;
    };

    reader.readAsDataURL(file);
  });
}

// ==================================================
// PDF PREVIEW
// ==================================================
async function previewPDF(file, canvas) {
  appendLog("Rendering PDF…");

  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(1);

  const ctx = canvas.getContext("2d");
  const viewport = page.getViewport({ scale: 1 });

  const w = canvas.clientWidth;
  const scale = w / viewport.width;

  canvas.width = w;
  canvas.height = viewport.height * scale;

  await page.render({
    canvasContext: ctx,
    viewport: page.getViewport({ scale })
  }).promise;

  appendLog("PDF rendered.");
}

// ==================================================
// File Upload Handling
// ==================================================
Object.keys(inputs).forEach(key => {
  inputs[key].addEventListener("change", async ev => {
    const file = ev.target.files?.[0];
    if (!file) return;

    if (file.type === "application/pdf") {
      await previewPDF(file, canvases[key]);
    } else {
      await previewImage(file, canvases[key]);
    }

    appendLog(`Loaded ${key}: ${file.name}`);
  });
});


// ==================================================
// IMPROVED CONTOUR EXTRACTION (HULL FOCUSED)
// ==================================================
function extractContours(canvas, name) {
  if (!window.OPENCV_READY) {
    appendLog("❌ OpenCV.js is not loaded yet!");
    return [];
  }

  const ctx = canvas.getContext("2d");
  let imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let src = cv.matFromImageData(imgData);
  let gray = new cv.Mat();
  let thresh = new cv.Mat();
  let morph = new cv.Mat();
  let edges = new cv.Mat();

  // Convert to grayscale
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Adaptive threshold (works for GA drawings)
  cv.adaptiveThreshold(
    gray, thresh, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY_INV,
    25, 10
  );

  // Morphology to remove small objects
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(thresh, morph, cv.MORPH_CLOSE, kernel);

  // Canny edges
  cv.Canny(morph, edges, 75, 200);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  appendLog(`[${name}] All contours detected: ${contours.size()}`);

  // Find largest contour (hull body)
  let maxArea = 0;
  let hullIndex = -1;

  for (let i = 0; i < contours.size(); i++) {
    const area = cv.contourArea(contours.get(i));
    if (area > maxArea) {
      maxArea = area;
      hullIndex = i;
    }
  }

  if (hullIndex < 0) {
    appendLog(`[${name}] ❌ No usable contours found.`);
    return [];
  }

  appendLog(`[${name}] Hull contour area = ${maxArea}`);

  // Extract hull contour points
  let c = contours.get(hullIndex);
  let out = [];
  for (let j = 0; j < c.data32S.length; j += 2) {
    out.push({ x: c.data32S[j], y: c.data32S[j + 1] });
  }

  // Cleanup memory
  src.delete(); gray.delete(); thresh.delete(); morph.delete();
  edges.delete(); contours.delete(); hierarchy.delete();

  return [ { id: name + "_hull", points: out } ];
}


// ==================================================
// Classification (still simple placeholder)
// ==================================================
function classifyContours(name, list) {
  appendLog(`Classifying ${name} contours...`);
  return list;
}


// ==================================================
// AUTO-DETECT BUTTON
// ==================================================
document.getElementById("autoDetect").addEventListener("click", () => {
  appendLog("=== AUTO-DETECT START ===");

  ["top", "side", "profile"].forEach(key => {
    window.pipeline[key] = extractContours(canvases[key], key);
    window.pipeline.classified[key] = classifyContours(key, window.pipeline[key]);
  });

  appendLog("=== AUTO-DETECT COMPLETE ===");
});
