// ========================================
// GA → Hull — A2 OCR View Detection Build
// ========================================

// short logger
const log = document.getElementById("log");
function appendLog(msg) {
  log.textContent += msg + "\n";
  log.scrollTop = log.scrollHeight;
}

// canvases
const fullCanvas = document.getElementById("fullCanvas");
const topCanvas = document.getElementById("topCanvas");
const profileCanvas = document.getElementById("profileCanvas");
const bodyCanvas = document.getElementById("bodyCanvas");

// inputs & buttons
const gaInput = document.getElementById("gaInput");
const btnDetectViews = document.getElementById("detectViews");
const btnAutoDetect = document.getElementById("autoDetect");

// pipeline storage
window.pipeline = {
  full: null,
  top: null,
  profile: null,
  body: null,
  classified: {}
};

// PDF rendering helper (first page only)
async function renderFileToCanvas(file, canvas) {
  // reset canvas css size to make preview consistent
  const cssW = Math.max(300, canvas.clientWidth);
  const cssH = Math.max(200, canvas.clientHeight);
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width, canvas.height);

  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      // scale to canvas width (device pixels)
      const scale = (canvas.width) / viewport.width;
      const vp = page.getViewport({ scale });
      // resize buffer to exact pixel size
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = (canvas.width / dpr) + "px";
      canvas.style.height = (canvas.height / dpr) + "px";
      const renderContext = { canvasContext: ctx, viewport: vp };
      await page.render(renderContext).promise;
      appendLog("PDF rendered to full canvas.");
    } catch (e) {
      appendLog("PDF render error: " + e.message);
    }
  } else {
    // image
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const img = new Image();
      reader.onload = (ev) => {
        img.onload = () => {
          // fit image to canvas preserving aspect (draw into buffer pixels)
          const cssW = canvas.clientWidth;
          const cssH = canvas.clientHeight;
          const dpr = devicePixelRatio || 1;
          canvas.width = Math.floor(cssW * dpr);
          canvas.height = Math.floor(cssH * dpr);
          canvas.style.width = cssW + "px";
          canvas.style.height = cssH + "px";
          const ctx = canvas.getContext("2d");
          ctx.setTransform(dpr,0,0,dpr,0,0);
          ctx.clearRect(0,0,cssW,cssH);
          const scale = Math.min(cssW / img.width, cssH / img.height);
          const w = img.width * scale, h = img.height * scale;
          ctx.drawImage(img, (cssW-w)/2, (cssH-h)/2, w, h);
          appendLog("Image rendered to full canvas.");
          resolve();
        };
        img.onerror = reject;
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
}

// OCR and keyword matching
const KEYWORDS = [
  { words: ["TOP VIEW","TOP PLAN","PLAN VIEW","TOP PLAN"], view: "top" },
  { words: ["PROFILE VIEW","PROFILE","SIDE ELEVATION","SIDE VIEW","SHEER PLAN"], view: "profile" },
  { words: ["BODY PLAN","BODY","BODY OF REVOLUTION","BODY PLAN"], view: "body" },
  { words: ["GENERAL ARRANGEMENT","GA","GA PLAN","GENERAL ARRANGEMENT PLAN"], view: "top" } // GA often near top/plan
];

// run OCR on fullCanvas and return list of detections {text, bbox}
async function runOCR(canvas) {
  appendLog("Running OCR (this may take a few seconds)...");
  const ctx = canvas.getContext("2d");
  // use the canvas as the source image for Tesseract
  const dataURL = canvas.toDataURL("image/png");
  const worker = Tesseract.createWorker({
    logger: m => { /* optionally appendLog(JSON.stringify(m)) */ }
  });
  await worker.load();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  const { data } = await worker.recognize(dataURL);
  await worker.terminate();
  // data.words contains words with bbox {x0,y0,x1,y1}
  const words = (data.words || []).map(w => ({
    text: w.text.trim(),
    bbox: { x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 }
  }));
  appendLog(`OCR found ${words.length} word boxes.`);
  return words;
}

// match OCR words to keywords, return best bbox per view
function matchKeywords(words) {
  const found = { top: null, profile: null, body: null };
  const normalized = words.map(w => ({ text: w.text.toUpperCase(), bbox: w.bbox }));

  // for each keyword set, search for a match
  KEYWORDS.forEach(k => {
    k.words.forEach(kw => {
      const uc = kw.toUpperCase();
      normalized.forEach(w => {
        if (w.text.includes(uc)) {
          // if view not assigned yet, take this bbox (or prefer larger bbox)
          const view = k.view;
          if (!found[view]) found[view] = w.bbox;
          else {
            // prefer bbox with larger area (more confidence)
            const curArea = found[view].w * found[view].h;
            const newArea = w.bbox.w * w.bbox.h;
            if (newArea > curArea) found[view] = w.bbox;
          }
        }
      });
    });
  });
  return found;
}

// given a label bbox on fullCanvas, produce crop rect (heuristic)
function computeCropFromLabel(bbox, canvas) {
  const W = canvas.width, H = canvas.height;
  // expand label region into a crop region below and around label
  const marginX = Math.min(W * 0.05, bbox.w * 2);
  const marginY = Math.min(H * 0.02, bbox.h * 2);

  // If label is in upper half, crop downward; else crop around it.
  let x = Math.max(0, Math.floor(bbox.x - marginX));
  let y;
  let w = Math.min(W - x, Math.floor(bbox.w + marginX * 2));
  let h;
  if (bbox.y < H * 0.4) {
    // assume label on top of view: crop region below label
    y = Math.max(0, Math.floor(bbox.y - marginY));
    h = Math.min(H - y, Math.floor(H * 0.45)); // crop ~45% of height
  } else {
    // label near middle or bottom: crop centered around label
    y = Math.max(0, Math.floor(bbox.y - bbox.h * 2));
    h = Math.min(H - y, Math.floor(bbox.h * 12));
  }

  // enlarge width to capture entire view if reasonable
  if (w < W * 0.6) {
    x = Math.max(0, Math.floor(W * 0.05));
    w = Math.min(W - x, Math.floor(W * 0.9));
  }

  return { x, y, w, h };
}

// crop from fullCanvas to targetCanvas using rect
function cropToCanvas(rect, sourceCanvas, targetCanvas) {
  const sCtx = sourceCanvas.getContext("2d");
  const tCtx = targetCanvas.getContext("2d");

  const dpr = devicePixelRatio || 1;
  // set target buffer size to rect size in device pixels
  targetCanvas.width = Math.floor(rect.w);
  targetCanvas.height = Math.floor(rect.h);
  targetCanvas.style.width = (targetCanvas.width / dpr) + "px";
  targetCanvas.style.height = (targetCanvas.height / dpr) + "px";

  // draw cropped region scaled to target buffer
  tCtx.setTransform(1,0,0,1,0,0);
  tCtx.clearRect(0,0,targetCanvas.width, targetCanvas.height);
  tCtx.drawImage(sourceCanvas, rect.x, rect.y, rect.w, rect.h, 0, 0, targetCanvas.width, targetCanvas.height);
}

// main detection pipeline: OCR -> match -> crop -> run contours
async function detectAndCropViews() {
  if (!fullCanvas.width || !fullCanvas.height) {
    appendLog("Render a GA file to the full canvas first (upload).");
    return;
  }

  const words = await runOCR(fullCanvas);
  const found = matchKeywords(words);
  appendLog("Matched keyword bboxes: " + JSON.stringify(found));

  // For each view produce a crop (if found), else leave blank
  if (found.top) {
    const rect = computeCropFromLabel(found.top, fullCanvas);
    cropToCanvas(rect, fullCanvas, topCanvas);
    appendLog("Top view cropped.");
  } else {
    appendLog("Top label not found.");
  }

  if (found.profile) {
    const rect = computeCropFromLabel(found.profile, fullCanvas);
    cropToCanvas(rect, fullCanvas, profileCanvas);
    appendLog("Profile view cropped.");
  } else {
    appendLog("Profile label not found.");
  }

  if (found.body) {
    const rect = computeCropFromLabel(found.body, fullCanvas);
    cropToCanvas(rect, fullCanvas, bodyCanvas);
    appendLog("Body plan cropped.");
  } else {
    appendLog("Body plan label not found.");
  }

  // after cropping we optionally run the contour extraction immediately
  appendLog("Crops ready. You can press Auto-detect to run contour extraction on each cropped view.");
}

// wire GA input (single file)
gaInput.addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  await renderFileToCanvas(f, fullCanvas);
  window.pipeline.full = f.name;
  appendLog("Loaded GA file: " + f.name);
});

// detect views button
btnDetectViews.addEventListener("click", async () => {
  // ensure OCR lib available
  if (!window.Tesseract) {
    appendLog("Tesseract.js not loaded.");
    return;
  }
  await detectAndCropViews();
});

// ==================================================
// --- Reuse previous contour extraction code ---
// Simple extractContours from a canvas using OpenCV (largest hull)
function extractContoursFromCanvas(canvas, viewName) {
  if (!window.OPENCV_READY) {
    appendLog("❌ OpenCV.js is not loaded yet!");
    return [];
  }
  if (!canvas.width || !canvas.height) {
    appendLog(`[${viewName}] canvas empty`);
    return [];
  }

  const ctx = canvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let src = cv.matFromImageData(imgData);
  let gray = new cv.Mat();
  let thresh = new cv.Mat();
  let morph = new cv.Mat();
  let edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 10);
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,5));
  cv.morphologyEx(thresh, morph, cv.MORPH_CLOSE, kernel);
  cv.Canny(morph, edges, 75, 200);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  appendLog(`[${viewName}] All contours detected: ${contours.size()}`);

  // choose largest contour
  let maxArea = 0, hullIndex = -1;
  for (let i=0; i<contours.size(); i++) {
    const area = cv.contourArea(contours.get(i));
    if (area > maxArea) { maxArea = area; hullIndex = i; }
  }
  if (hullIndex < 0) {
    appendLog(`[${viewName}] ❌ No usable contours found`);
    src.delete(); gray.delete(); thresh.delete(); morph.delete();
    edges.delete(); contours.delete(); hierarchy.delete();
    return [];
  }

  appendLog(`[${viewName}] Hull contour area = ${maxArea}`);

  const hull = contours.get(hullIndex);
  const pts = [];
  for (let j=0; j<hull.data32S.length; j+=2) {
    pts.push({ x: hull.data32S[j], y: hull.data32S[j+1] });
  }

  src.delete(); gray.delete(); thresh.delete(); morph.delete();
  edges.delete(); contours.delete(); hierarchy.delete();

  return [{ id: viewName + "_hull", points: pts }];
}

// auto-detect button runs extract on cropped canvases
btnAutoDetect.addEventListener("click", () => {
  appendLog("=== AUTO-DETECT START ===");
  window.pipeline.top = extractContoursFromCanvas(topCanvas, "top");
  window.pipeline.profile = extractContoursFromCanvas(profileCanvas, "profile");
  window.pipeline.body = extractContoursFromCanvas(bodyCanvas, "body");
  appendLog("=== AUTO-DETECT COMPLETE ===");
});

// EOF
