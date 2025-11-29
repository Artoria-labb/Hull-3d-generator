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
    return [];
  }

  const ctx = canvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let src = cv.matFromImageData(imgData);
  let gray = new cv.Mat();
  let blur = new cv.Mat();
  let edges = new cv.Mat();

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

  src.delete();
  gray.delete();
  blur.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  return contourList;
}

// ===============================
// 4. GEOMETRIC ANALYSIS (classify contours)
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

    const w = maxX - minX;
    const h = maxY - minY;
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
// 5. AUTO-DETECT BUTTON HANDLER
// ===============================

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
// 6. PLACEHOLDERS FOR NEXT STEPS
// ===============================

document.getElementById("generateHull").addEventListener("click", () => {
  appendLog("[TODO] Hull generation will use classified stations + outlines.");
});

document.getElementById("export3dm").addEventListener("click", () => {
  appendLog("[TODO] Export will convert classified curves into .3dm geometry.");
});
