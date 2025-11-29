// ===============================
// GA → Hull MVP
// Stage 1.5+: PDF support + Contour Classification + Layering
// ===============================

const log = document.getElementById("log");
function appendLog(msg) {
  log.textContent += msg + "\n";
  log.scrollTop = log.scrollHeight;
}

// Canvas references
const canvases = {
  top: document.getElementById("topCanvas"),
  side: document.getElementById("sideCanvas"),
  profile: document.getElementById("profileCanvas"),
};

// Input references
const inputs = {
  top: document.getElementById("topInput"),
  side: document.getElementById("sideInput"),
  profile: document.getElementById("profileInput"),
};

// Pipeline storage
window.pipeline = {
  top: null,
  side: null,
  profile: null,
  classified: {
    top: [],
    side: [],
    profile: []
  }
};

// -------------------------------
// PDF.js worker setup (CDN)
if (window.pdfjsLib) {
  // Use CDN worker (matches PDF.js version used in index)
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.7.107/pdf.worker.min.js';
} else {
  appendLog("Warning: PDF.js not found (pdf uploads will fail).");
}
// -------------------------------

// ===============================
// Helper: fit & draw image onto canvas (keeps high-DPI scaling)
// ===============================
function drawImageOnCanvasElement(img, canvas) {
  const ctx = canvas.getContext("2d");
  // Ensure CSS dimensions are set (style.css provides fixed canvas height)
  const cssW = Math.max(1, canvas.clientWidth);
  const cssH = Math.max(1, canvas.clientHeight);
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Fit image preserving aspect
  const scale = Math.min(cssW / img.width, cssH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const dx = (cssW - w) / 2;
  const dy = (cssH - h) / 2;
  ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, w, h);
}

// ===============================
// 1. IMAGE PREVIEW (PNG/JPG)
function previewToCanvas(file, canvas) {
  return new Promise((resolve, reject) => {
    const ctx = canvas.getContext("2d");
    const img = new Image();
    // avoid cross-origin tainting (we're using local uploads so this is fine)
    img.crossOrigin = "anonymous";
    const reader = new FileReader();

    reader.onload = (e) => {
      img.onload = () => {
        try {
          drawImageOnCanvasElement(img, canvas);
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = (err) => reject(err);
      img.src = e.target.result;
    };

    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

// ===============================
// 2. PDF → Canvas (renders first page)
// ===============================
async function loadPdfToCanvas(file, canvas) {
  if (!window.pdfjsLib) {
    appendLog("PDF.js not loaded - cannot render PDF.");
    return;
  }
  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1); // render first page for now

    // compute scale to fit canvas width
    const cssW = Math.max(1, canvas.clientWidth);
    const viewport0 = page.getViewport({ scale: 1 });
    const scale = cssW / viewport0.width;
    const dpr = devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * dpr });

    // set canvas buffer size (high DPI)
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    // set CSS transform so internal drawing matches CSS pixels
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset
    // draw at DPR scale then scale down via CSS transform for sharpness
    // but our CSS canvas size in pixels is device-scaled, so set transform to 1/dpr:
    ctx.scale(1, 1);

    const renderContext = {
      canvasContext: ctx,
      viewport: viewport
    };

    await page.render(renderContext).promise;

    // After rendering, adjust CSS transform so canvas displays correctly in page
    // We already sized the canvas buffer to DPR * CSS px; set CSS width/height
    canvas.style.width = (canvas.width / dpr) + "px";
    canvas.style.height = (canvas.height / dpr) + "px";

    appendLog("PDF page rendered to canvas.");
  } catch (err) {
    appendLog("PDF render error: " + err.message);
  }
}

// ===============================
// Wire inputs to preview (image or pdf)
Object.keys(inputs).forEach((key) => {
  inputs[key].addEventListener("change", async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      if (f.type === "application/pdf" || f.name?.toLowerCase().endsWith(".pdf")) {
        await loadPdfToCanvas(f, canvases[key]);
      } else {
        await previewToCanvas(f, canvases[key]);
      }
      appendLog(`Loaded ${key} file: ${f.name}`);
    } catch (err) {
      appendLog(`Load error for ${key}: ${err.message}`);
    }
  });
});

// ===============================
// 3. OPENCV LOADER CHECK
let OPENCV_READY = false;

function onOpenCvReady() {
  OPENCV_READY = true;
  appendLog("OpenCV.js loaded successfully.");
}

// OpenCV expects Module.onRuntimeInitialized; ensure it's set before script runs
window.Module = {
  onRuntimeInitialized: onOpenCvReady,
};

// ===============================
// 4. EDGE + CONTOUR EXTRACTION
function extractContoursFromCanvas(canvas, viewName) {
  if (!OPENCV_READY) {
    appendLog("OpenCV not ready yet...");
    return [];
  }

  // if canvas has zero area, bail
  if (!canvas.width || !canvas.height) {
    appendLog(`[${viewName}] canvas empty or zero-sized`);
    return [];
  }

  const ctx = canvas.getContext("2d");
  // Get image data at the canvas buffer resolution
  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (err) {
    appendLog(`[${viewName}] getImageData error: ${err.message}`);
    return [];
  }

  let src = cv.matFromImageData(imgData);
  let gray = new cv.Mat();
  let blur = new cv.Mat();
  let edges = new cv.Mat();

  // Convert & preprocess
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
  cv.Canny(blur, edges, 50, 150, 3, false);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(
    edges,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  );

  appendLog(`[${viewName}] Found ${contours.size()} raw contours`);

  const contourList = [];

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    let pts = [];
    // contour.data32S contains x,y pairs
    for (let j = 0; j < contour.data32S.length; j += 2) {
      pts.push({
        x: contour.data32S[j],
        y: contour.data32S[j + 1],
      });
    }

    contourList.push({
      id: `${viewName}_contour_${i}`,
      points: pts,
    });
  }

  // cleanup
  src.delete();
  gray.delete();
  blur.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  return contourList;
}

// ===============================
// 5. GEOMETRIC ANALYSIS (classify contours)
// ===============================
function classifyContours(viewName, contours) {
  appendLog(`Classifying ${contours.length} contours in ${viewName} view...`);

  const results = [];

  contours.forEach((c) => {
    const pts = c.points;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    pts.forEach((p) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    });

    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const aspect = w / h;

    let role = "UNASSIGNED";
    let layer = "";
    let color = "";

    if (viewName === "top") {
      if (aspect > 3) {
        role = "PLAN_OUTLINE";
        layer = "PLAN_OUTLINE";
        color = "#FF0000";
      } else {
        role = "DECK_SHAPE";
        layer = "DECK_SHAPE";
        color = "#00FFFF";
      }
    }

    if (viewName === "side") {
      if (h < canvases.side.height * 0.1) {
        role = "SHEER";
        layer = "SHEER";
        color = "#FF0000";
      } else if (w > canvases.side.width * 0.5 && minY > canvases.side.height * 0.5) {
        role = "KEEL";
        layer = "KEEL";
        color = "#0000FF";
      } else {
        role = "WATERLINE";
        layer = "WL";
        color = "#00FFFF";
      }
    }

    if (viewName === "profile") {
      if (aspect < 0.5) {
        role = "STATION";
        layer = "ST";
        color = "#FF00FF";
      } else {
        role = "BUTTOCK";
        layer = "BT";
        color = "#FFFF00";
      }
    }

    results.push({
      id: c.id,
      points: c.points,
      role,
      layer,
      color,
    });
  });

  appendLog(`Classification for ${viewName} complete.`);
  return results;
}

// ===============================
// 6. AUTO-DETECT BUTTON HANDLER
document.getElementById("autoDetect").addEventListener("click", () => {
  if (!OPENCV_READY) {
    appendLog("❌ OpenCV.js is not loaded yet!");
    return;
  }

  appendLog("=== AUTO-DETECT START ===");

  ["top", "side", "profile"].forEach((key) => {
    appendLog(`Extracting contours from ${key} view...`);
    const raw = extractContoursFromCanvas(canvases[key], key);

    window.pipeline[key] = raw;

    appendLog(`Classifying ${key} contours...`);
    window.pipeline.classified[key] = classifyContours(key, raw);
  });

  appendLog("=== AUTO-DETECT COMPLETE ===");
  appendLog("Results stored in window.pipeline.classified");
});

// ===============================
// 7. PLACEHOLDERS FOR NEXT STEPS
document.getElementById("generateHull").addEventListener("click", () => {
  appendLog("[TODO] Hull generation will use classified stations + outlines (rhino3dm).");
});

document.getElementById("export3dm").addEventListener("click", () => {
  appendLog("[TODO] Export will convert classified curves into .3dm geometry (rhino3dm).");
});
