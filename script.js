// ===============================
// GA → Hull MVP
// Stage 1.5: Contour Classification + Layering
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

// ===============================
// 1. IMAGE PREVIEW
// ===============================

function previewToCanvas(file, canvas) {
  const ctx = canvas.getContext("2d");
  const img = new Image();
  const reader = new FileReader();

  reader.onload = (e) => {
    img.onload = () => {
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const scale = Math.min(
        canvas.clientWidth / img.width,
        canvas.clientHeight / img.height
      );

      const w = img.width * scale;
      const h = img.height * scale;

      ctx.drawImage(
        img,
        (canvas.clientWidth - w) / 2,
        (canvas.clientHeight - h) / 2,
        w,
        h
      );
    };
    img.src = e.target.result;
  };

  reader.readAsDataURL(file);
}

Object.keys(inputs).forEach((key) => {
  inputs[key].addEventListener("change", (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    previewToCanvas(f, canvases[key]);
    appendLog(`Loaded ${key} image: ${f.name}`);
  });
});

// ===============================
// 2. OPENCV LOADER CHECK
// ===============================

let OPENCV_READY = false;

function onOpenCvReady() {
  OPENCV_READY = true;
  appendLog("OpenCV.js loaded successfully.");
}

window.Module = {
  onRuntimeInitialized: onOpenCvReady,
};

// ===============================
// 3. EDGE + CONTOUR EXTRACTION
// ===============================

function extractContoursFromCanvas(canvas, viewName) {
  if (!OPENCV_READY) {
    appendLog("OpenCV not ready yet...");
