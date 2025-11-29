// ==============================================
// GA → Hull — A2: Geometry-based View Detection
// ==============================================

// Logger
const log = document.getElementById("log");
function appendLog(msg) {
  const t = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.textContent += t + "\n";
  log.scrollTop = log.scrollHeight;
}

// Canvas refs
const fullCanvas = document.getElementById("fullCanvas");
const topCanvas = document.getElementById("topCanvas");
const sideCanvas = document.getElementById("sideCanvas");
const bodyCanvas = document.getElementById("bodyCanvas");

// Inputs / Buttons
const gaInput = document.getElementById("gaInput");
const btnDetectViews = document.getElementById("detectViews");
const btnAutoDetect = document.getElementById("autoDetect");

// pipeline storage
window.pipeline = { full: null, top: null, side: null, body: null, classified: {} };

// Ensure OpenCV callback hook exists
window.onOpenCvReady = function () {
  appendLog("OpenCV.js loaded successfully.");
};

// --- Render file to fullCanvas (PDF first page or image) ---
async function renderFileToCanvas(file, canvas) {
  const cssW = Math.max(800, canvas.clientWidth || 800);
  const dpr = devicePixelRatio || 1;

  // If PDF
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport0 = page.getViewport({ scale: 1 });
      const scale = (cssW * dpr) / viewport0.width;
      const vp = page.getViewport({ scale });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = (canvas.width / dpr) + "px";
      canvas.style.height = (canvas.height / dpr) + "px";
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      appendLog("PDF rendered to full canvas.");
    } catch (err) {
      appendLog("PDF render error: " + err.message);
    }
    return;
  }

  // If image
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const img = new Image();
    reader.onload = (e) => {
      img.onload = () => {
        const cssW = Math.max(800, canvas.clientWidth || 800);
        const cssH = Math.max(600, canvas.clientHeight || 600);
        const dpr = devicePixelRatio || 1;
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        const scale = Math.min(cssW / img.width, cssH / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (cssW - w) / 2, (cssH - h) / 2, w, h);
        appendLog("Image rendered to full canvas.");
        resolve();
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// --- Utility: draw rectangle overlay on full canvas for debug (optional) ---
function drawRectOnFull(rect, color = "red", lineWidth = 3) {
  const ctx = fullCanvas.getContext("2d");
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

// --- Geometry-based view detection ---
// Steps:
// 1) preprocess fullCanvas to binary
// 2) find contours, compute bounding boxes
// 3) filter boxes by area threshold
// 4) classify each box by aspect ratio & position
function detectViewsByGeometry() {
  if (!window.OPENCV_READY) {
    appendLog("❌ OpenCV.js not ready. Wait a moment and try again.");
    return null;
  }

  const ctx = fullCanvas.getContext("2d");
  if (!fullCanvas.width || !fullCanvas.height) {
    appendLog("Full canvas is empty — render a GA file first.");
    return null;
  }

  // get image data
  let imgData;
  try { imgData = ctx.getImageData(0, 0, fullCanvas.width, fullCanvas.height); }
  catch (e) { appendLog("getImageData failed: " + e.message); return null; }

  // create mats
  let src = cv.matFromImageData(imgData);
  let gray = new cv.Mat();
  let blurred = new cv.Mat();
  let thresh = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();

  // preprocess: grayscale -> blur -> adaptive threshold -> morph close
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 10);
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel);

  // find contours
  cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  appendLog(`Geometry detection: found ${contours.size()} candidate contours.`);

  // collect bounding boxes with area filter
  const boxes = [];
  const W = fullCanvas.width, H = fullCanvas.height;
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < 0.0005 * W * H) { cnt.delete(); continue; } // skip tiny
    const rect = cv.boundingRect(cnt);
    // skip very narrow or tiny
    if (rect.w < 0.05 * W || rect.h < 0.05 * H) { cnt.delete(); continue; }
    boxes.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, area });
    cnt.delete();
  }

  // sort boxes by area descending
  boxes.sort((a, b) => b.area - a.area);

  appendLog(`Filtered boxes: ${boxes.length}`);

  // classify boxes to views using aspect ratio & position heuristics
  // thresholds chosen from earlier discussion
  let assigned = { top: null, side: null, body: null };
  boxes.forEach(b => {
    const aspect = b.w / b.h;
    // side: very long horizontal
    if (!assigned.side && aspect >= 3.5) {
      assigned.side = b;
      return;
    }
    // top: wide but not extreme
    if (!assigned.top && aspect >= 1.6 && aspect < 3.5) {
      assigned.top = b;
      return;
    }
    // body: roughly square or tall
    if (!assigned.body && aspect >= 0.6 && aspect <= 1.6) {
      assigned.body = b;
      return;
    }
  });

  // Fallbacks: if we missed any, pick next-best boxes
  // if side missing, take largest box
  if (!assigned.side && boxes.length > 0) assigned.side = boxes[0];
  if (!assigned.top && boxes.length > 1) assigned.top = boxes[1];
  if (!assigned.body && boxes.length > 2) assigned.body = boxes[2];

  // cleanup
  src.delete(); gray.delete(); blurred.delete(); thresh.delete(); contours.delete(); hierarchy.delete();

  appendLog("Assigned boxes: " + JSON.stringify({
    top: (assigned.top ? {x:assigned.top.x, y:assigned.top.y, w:assigned.top.w, h:assigned.top.h} : null),
    side: (assigned.side ? {x:assigned.side.x, y:assigned.side.y, w:assigned.side.w, h:assigned.side.h} : null),
    body: (assigned.body ? {x:assigned.body.x, y:assigned.body.y, w:assigned.body.w, h:assigned.body.h} : null),
  }));

  return assigned;
}

// --- Crop a box from fullCanvas to target canvas (preserve device pixels) ---
function cropBoxToCanvas(box, sourceCanvas, targetCanvas) {
  if (!box) { 
    // clear target canvas
    const tctx = targetCanvas.getContext("2d");
    tctx.clearRect(0,0,targetCanvas.width || 1, targetCanvas.height || 1);
    return;
  }
  // create target buffer equal to box size
  const dpr = devicePixelRatio || 1;
  targetCanvas.width = Math.floor(box.w);
  targetCanvas.height = Math.floor(box.h);
  targetCanvas.style.width = (targetCanvas.width / dpr) + "px";
  targetCanvas.style.height = (targetCanvas.height / dpr) + "px";
  const tctx = targetCanvas.getContext("2d");
  tctx.setTransform(1,0,0,1,0,0);
  tctx.clearRect(0,0,targetCanvas.width, targetCanvas.height);
  // draw from source (pixel coords)
  tctx.drawImage(sourceCanvas, box.x, box.y, box.w, box.h, 0, 0, targetCanvas.width, targetCanvas.height);
}

// --- Main detectViews handler: runs geometry detection, crops canvases ---
function detectViewsHandler() {
  appendLog("Starting geometry-based view detection...");
  const boxes = detectViewsByGeometry();
  if (!boxes) return;
  cropBoxToCanvas(boxes.top, fullCanvas, topCanvas);
  cropBoxToCanvas(boxes.side, fullCanvas, sideCanvas);
  cropBoxToCanvas(boxes.body, fullCanvas, bodyCanvas);
  appendLog("Cropping complete — cropped regions placed in Top / Side / Body canvases.");
}

// --- Reuse previous extractContoursFromCanvas (largest hull) ---
function extractContoursFromCanvas(canvas, viewName) {
  if (!window.OPENCV_READY) { appendLog("❌ OpenCV.js is not loaded yet!"); return []; }
  if (!canvas.width || !canvas.height) { appendLog(`[${viewName}] canvas empty`); return []; }

  const ctx = canvas.getContext("2d");
  let imgData;
  try { imgData = ctx.getImageData(0,0,canvas.width,canvas.height); }
  catch (e) { appendLog(`[${viewName}] getImageData error: ${e.message}`); return []; }

  let src = cv.matFromImageData(imgData);
  let gray = new cv.Mat();
  let thresh = new cv.Mat();
  let morph = new cv.Mat();
  let edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 10);
  let k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,5));
  cv.morphologyEx(thresh, morph, cv.MORPH_CLOSE, k);
  cv.Canny(morph, edges, 75, 200);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  appendLog(`[${viewName}] All contours detected: ${contours.size()}`);

  let maxArea = 0, hullIndex = -1;
  for (let i=0;i<contours.size();i++){
    const area = cv.contourArea(contours.get(i));
    if (area > maxArea) { maxArea = area; hullIndex = i; }
  }

  if (hullIndex < 0) {
    appendLog(`[${viewName}] ❌ No usable contours found`);
    src.delete(); gray.delete(); thresh.delete(); morph.delete(); edges.delete(); contours.delete(); hierarchy.delete();
    return [];
  }

  appendLog(`[${viewName}] Hull contour area = ${maxArea}`);

  const hull = contours.get(hullIndex);
  const pts = [];
  for (let j=0;j<hull.data32S.length;j+=2) {
    pts.push({ x: hull.data32S[j], y: hull.data32S[j+1] });
  }

  src.delete(); gray.delete(); thresh.delete(); morph.delete(); edges.delete(); contours.delete(); hierarchy.delete();

  return [{ id: viewName + "_hull", points: pts }];
}

// --- Auto-detect button: run extraction on cropped canvases ---
function autoDetectHandler() {
  appendLog("=== AUTO-DETECT START ===");
  window.pipeline.top = extractContoursFromCanvas(topCanvas, "top");
  window.pipeline.side = extractContoursFromCanvas(sideCanvas, "side");
  window.pipeline.body = extractContoursFromCanvas(bodyCanvas, "body");
  appendLog("=== AUTO-DETECT COMPLETE ===");
}

// --- wire inputs ---
gaInput.addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  await renderFileToCanvas(f, fullCanvas);
  window.pipeline.full = f.name;
  appendLog("Loaded GA file: " + f.name);
});

btnDetectViews.addEventListener("click", detectViewsHandler);
btnAutoDetect.addEventListener("click", autoDetectHandler);

// Done
appendLog("A2 geometry view detection script loaded.");
