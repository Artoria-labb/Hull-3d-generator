// ================================================
// GA → Hull MVP — Corrected OpenCV Initialization Build
// ================================================

// Log helper
const log = document.getElementById("log");
function appendLog(msg) {
  log.textContent += msg + "\n";
  log.scrollTop = log.scrollHeight;
}

// Canvases
const canvases = {
  top: document.getElementById("topCanvas"),
  side: document.getElementById("sideCanvas"),
  profile: document.getElementById("profileCanvas")
};

// File inputs
const inputs = {
  top: document.getElementById("topInput"),
  side: document.getElementById("sideInput"),
  profile: document.getElementById("profileInput")
};

// Store extracted results
window.pipeline = {
  top: [],
  side: [],
  profile: [],
  classified: {
    top: [],
    side: [],
    profile: []
  }
};

// Called when OpenCV initializes (connected from index.html)
window.onOpenCvReady = function () {
  appendLog("OpenCV.js loaded successfully.");
};

// ===============================
// IMAGE PREVIEW (PNG/JPG)
// ===============================
function previewImage(file, canvas) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    const img = new Image();

    reader.onload = (e) => {
      img.onload = () => {
        const ctx = canvas.getContext("2d");

        const w = canvas.clientWidth;
        const h = canvas.clientHeight;

        canvas.width = w;
        canvas.height = h;

        ctx.clearRect(0, 0, w, h);

        const scale = Math.min(w / img.width, h / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
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

// ===============================
// PDF PREVIEW (first page only)
// ===============================
async function previewPDF(file, canvas) {
  appendLog("Rendering PDF…");

  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(1);

  const ctx = canvas.getContext("2d");

  const viewport = page.getViewport({ scale: 1 });
  const canvasW = canvas.clientWidth;
  const scale = canvasW / viewport.width;

  canvas.width = canvasW;
  canvas.height = viewport.height * scale;

  await page.render({
    canvasContext: ctx,
    viewport: page.getViewport({ scale })
  }).promise;

  appendLog("PDF rendered to canvas.");
}

// ===============================
// File input event binding
// ===============================
Object.keys(inputs).forEach((key) => {
  inputs[key].addEventListener("change", async (ev) => {
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

// ===============================
// Contour extraction
// ===============================
function extractContours(canvas, name) {
  if (!window.OPENCV_READY) {
    appendLog("❌ OpenCV.js is not loaded yet!");
    return [];
  }

  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let src = cv.matFromImageData(img);
  let gray = new cv.Mat();
  let blur = new cv.Mat();
  let edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  cv.Canny(blur, edges, 50, 150);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  appendLog(`[${name}] Found ${contours.size()} contours`);

  const out = [];

  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    let pts = [];

    for (let j = 0; j < c.data32S.length; j += 2) {
      pts.push({
        x: c.data32S[j],
        y: c.data32S[j + 1]
      });
    }

    out.push({
      id: `${name}_${i}`,
      points: pts
    });
  }

  src.delete(); gray.delete(); blur.delete(); edges.delete();
  contours.delete(); hierarchy.delete();

  return out;
}

// ===============================
// Classification placeholder
// ===============================
function classifyContours(name, list) {
  appendLog(`Classifying ${name} contours...`);
  return list;
}

// ===============================
// AUTO-DETECT BUTTON
// ===============================
document.getElementById("autoDetect").addEventListener("click", () => {
  appendLog("=== AUTO-DETECT START ===");

  ["top", "side", "profile"].forEach((key) => {
    window.pipeline[key] = extractContours(canvases[key], key);
    window.pipeline.classified[key] = classifyContours(key, window.pipeline[key]);
  });

  appendLog("=== AUTO-DETECT COMPLETE ===");
});
