// =======================================
// Full Plan Tracer -> DXF Export (script.js)
// =======================================

const logEl = document.getElementById("log");
function appendLog(s) {
  const t = new Date().toTimeString().split(" ")[0];
  logEl.textContent += `[${t}] ${s}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// Elements
const fileInput = document.getElementById("fileInput");
const traceBtn = document.getElementById("traceBtn");
const exportDxfBtn = document.getElementById("exportDxfBtn");
const downloadPreviewPng = document.getElementById("downloadPreviewPng");
const scaleInput = document.getElementById("scaleInput");

const fullCanvas = document.getElementById("fullCanvas");
const overlayCanvas = document.getElementById("overlayCanvas");
const fullCtx = fullCanvas.getContext("2d");
const overlayCtx = overlayCanvas.getContext("2d");

// traced polylines store: array of arrays of points {x,y}
let tracedPolylines = [];

// helper: set canvas pixel size to image size
function setCanvasSizeForImage(canvas, width, height) {
  canvas.width = width;
  canvas.height = height;
  // keep CSS width constrained for UI (optional)
  const maxW = Math.min(window.innerWidth * 0.45, 1200);
  canvas.style.width = Math.min(maxW, width) + "px";
  canvas.style.height = (canvas.height * (parseFloat(canvas.style.width) / canvas.width)) + "px";
}

// render file (pdf first page or image) to fullCanvas
async function renderFile(file) {
  appendLog("Rendering file...");
  if (file.name.toLowerCase().endsWith(".pdf")) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    // choose scale to get decent resolution
    const scale = 2.0; // higher = more detail, slower
    const viewport = page.getViewport({ scale });
    setCanvasSizeForImage(fullCanvas, Math.floor(viewport.width), Math.floor(viewport.height));
    fullCtx.setTransform(1, 0, 0, 1, 0, 0);
    await page.render({ canvasContext: fullCtx, viewport }).promise;
    appendLog(`PDF page rendered (${fullCanvas.width}x${fullCanvas.height}).`);
  } else {
    // image file
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const img = new Image();
      reader.onload = (e) => {
        img.onload = () => {
          setCanvasSizeForImage(fullCanvas, img.width, img.height);
          fullCtx.setTransform(1, 0, 0, 1, 0, 0);
          fullCtx.drawImage(img, 0, 0);
          appendLog(`Image rendered (${img.width}x${img.height}).`);
          resolve();
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
}

// utility: clear overlay canvas and set its same size
function prepareOverlay() {
  overlayCanvas.width = fullCanvas.width;
  overlayCanvas.height = fullCanvas.height;
  overlayCanvas.style.width = fullCanvas.style.width;
  overlayCanvas.style.height = fullCanvas.style.height;
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  // draw semi-transparent background so user sees overlay
  overlayCtx.fillStyle = "rgba(0,0,0,0)";
  overlayCtx.fillRect(0,0,overlayCanvas.width, overlayCanvas.height);
}

// main trace function using OpenCV
function traceAll() {
  if (!window.OPENCV_READY) {
    appendLog("OpenCV not ready.");
    return;
  }
  if (!fullCanvas.width || !fullCanvas.height) {
    appendLog("No image loaded.");
    return;
  }

  appendLog("Starting trace...");

  // prepare overlay
  prepareOverlay();

  // get image data
  const imgData = fullCtx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
  let src = cv.matFromImageData(imgData);

  // Convert to grayscale
  let gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Adaptive threshold to get lines (works well for scans)
  let bw = new cv.Mat();
  cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 7);

  // morphological opening/closing to clean speckles and join lines
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3,3));
  let closed = new cv.Mat();
  cv.morphologyEx(bw, closed, cv.MORPH_CLOSE, kernel, new cv.Point(-1,-1), 1);

  // optionally thin or skeletonize - we will approximate by contour centerlines
  // use Canny to find edges
  let edges = new cv.Mat();
  cv.Canny(closed, edges, 50, 200);

  // find contours on edges (use RETR_LIST to get everything)
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);

  appendLog(`Contours found: ${contours.size()}`);

  // Convert contours to polylines and simplify
  tracedPolylines = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);

    // drop extremely small contours
    const area = Math.abs(cv.contourArea(cnt));
    if (area < 9) {
      cnt.delete();
      continue;
    }

    // convert to JS array of points
    let pts = [];
    for (let k = 0; k < cnt.data32S.length; k += 2) {
      pts.push({ x: cnt.data32S[k], y: cnt.data32S[k+1] });
    }

    // approximate polyline with epsilon relative to perimeter
    const peri = cv.arcLength(cnt, false);
    const eps = Math.max(1.0, 0.002 * peri); // tweakable
    let approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, eps, false);

    let poly = [];
    for (let p = 0; p < approx.data32S.length; p += 2) {
      poly.push({ x: approx.data32S[p], y: approx.data32S[p+1] });
    }

    // remove duplicates and very small segments
    if (poly.length >= 2) {
      // optionally simplify by removing near-collinear points
      poly = simplifyPolyline(poly, 0.5); // pixel tolerance
      if (poly.length >= 2) tracedPolylines.push(poly);
    }

    approx.delete();
    cnt.delete();
  }

  appendLog(`Polylines traced: ${tracedPolylines.length}`);

  // draw overlay preview
  drawOverlay(tracedPolylines);

  // cleanup
  src.delete(); gray.delete(); bw.delete(); closed.delete();
  edges.delete(); contours.delete(); hierarchy.delete();

  appendLog("Trace complete.");
}

// simple Ramer-Douglas-Peucker polyline simplifier for pixel tolerance
function simplifyPolyline(points, tolerance) {
  if (!points || points.length < 3) return points.slice();
  // recursively
  function getSqSegDist(p, p1, p2) {
    let x = p1.x;
    let y = p1.y;
    let dx = p2.x - x;
    let dy = p2.y - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx*dx + dy*dy);
      if (t > 1) { x = p2.x; y = p2.y; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p.x - x; dy = p.y - y;
    return dx*dx + dy*dy;
  }
  function simplifyDPStep(pts, first, last, sqTol, out) {
    let maxSqDist = sqTol, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = getSqSegDist(pts[i], pts[first], pts[last]);
      if (d > maxSqDist) { index = i; maxSqDist = d; }
    }
    if (index > -1) {
      if (index - first > 1) simplifyDPStep(pts, first, index, sqTol, out);
      out.push(pts[index]);
      if (last - index > 1) simplifyDPStep(pts, index, last, sqTol, out);
    }
  }
  const sqTol = tolerance * tolerance;
  const newPts = [points[0]];
  simplifyDPStep(points, 0, points.length - 1, sqTol, newPts);
  newPts.push(points[points.length - 1]);
  return newPts;
}

// draw polylines onto overlay canvas for preview
function drawOverlay(polylines) {
  overlayCtx.clearRect(0,0,overlayCanvas.width, overlayCanvas.height);
  overlayCtx.lineWidth = Math.max(1, Math.round(overlayCanvas.width / 1500));
  overlayCtx.strokeStyle = "#00ff88";
  overlayCtx.fillStyle = "rgba(0,0,0,0)";
  for (let i=0;i<polylines.length;i++) {
    const poly = polylines[i];
    overlayCtx.beginPath();
    overlayCtx.moveTo(poly[0].x + 0.5, poly[0].y + 0.5);
    for (let j=1;j<poly.length;j++) {
      overlayCtx.lineTo(poly[j].x + 0.5, poly[j].y + 0.5);
    }
    overlayCtx.stroke();
  }
}

// Convert traced polylines to DXF (LWPOLYLINE entities)
// scaleMetersPerPixel: how many meters each pixel equals (user input) - optional for storing units
function buildDxf(polylines, scaleMetersPerPixel) {
  // DXF header
  const header = [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1018", // AutoCAD 2004-compatible
    "0",
    "ENDSEC"
  ];

  // Tables (minimal)
  const tables = [
    "0","SECTION","2","TABLES",
    "0","ENDSEC"
  ];

  // Entities start
  const entsStart = ["0","SECTION","2","ENTITIES"];

  // Entities: produce LWPOLYLINE for each polyline (2D XY)
  const entities = [];
  for (let i = 0; i < polylines.length; i++) {
    const poly = polylines[i];
    if (!poly || poly.length < 2) continue;

    // Build points string
    // Optionally transform coordinates: flip Y (DXF origin is bottom-left vs canvas top-left)
    const pts = poly.map(p => {
      const x = p.x;
      const y = fullCanvas.height - p.y; // flip Y
      return { x, y };
    });

    // LWPOLYLINE header
    entities.push("0");
    entities.push("LWPOLYLINE");
    // number of vertices
    entities.push("90"); // custom group for number of vertices in some DXF flavors (not required)
    entities.push(String(pts.length));
    // polyline flags (1 = closed)
    const closed = (Math.hypot(pts[0].x-pts[pts.length-1].x, pts[0].y-pts[pts.length-1].y) < 1.5) ? 1 : 0;
    entities.push("70");
    entities.push(String(closed));
    // vertex coordinates: code 10 = x, 20 = y
    for (let j=0;j<pts.length;j++) {
      entities.push("10"); entities.push(String((pts[j].x * (scaleMetersPerPixel || 1)).toFixed(6)));
      entities.push("20"); entities.push(String((pts[j].y * (scaleMetersPerPixel || 1)).toFixed(6)));
    }
  }

  // End section
  const entsEnd = ["0","ENDSEC","0","EOF"];

  // combine all pieces
  const dxfArray = [].concat(header, tables, entsStart, entities, entsEnd);
  return dxfArray.join("\r\n");
}

// trigger download of text file
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/dxf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// scale input: meters per pixel; user can enter 0.01 etc.
function getScale() {
  const v = parseFloat(scaleInput.value);
  if (!v || isNaN(v) || v <= 0) return 1.0;
  return v;
}

// Export DXF button handler
exportDxfBtn.addEventListener("click", () => {
  if (!tracedPolylines || tracedPolylines.length === 0) {
    appendLog("No polylines to export. Run Trace All first.");
    return;
  }
  appendLog("Building DXF...");
  // If user provided scale in meters/pixel, we want DXF units to be meters; multiply coords by scale
  const scale = getScale(); // meters per pixel
  const dxf = buildDxf(tracedPolylines, scale);
  const name = "traced_plan.dxf";
  downloadText(name, dxf);
  appendLog("DXF exported: " + name);
});

// Download preview PNG of overlay (combined)
downloadPreviewPng.addEventListener("click", () => {
  // combine full and overlay to a temp canvas
  const tmp = document.createElement("canvas");
  tmp.width = fullCanvas.width;
  tmp.height = fullCanvas.height;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(fullCanvas,0,0);
  tctx.drawImage(overlayCanvas,0,0);
  const url = tmp.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = "preview_traced.png";
  a.click();
  appendLog("Preview PNG downloaded.");
});

// Trace button handler
traceBtn.addEventListener("click", () => {
  try {
    traceAll();
  } catch (e) {
    appendLog("Trace error: " + (e && e.message ? e.message : String(e)));
  }
});

// file input change -> render
fileInput.addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  tracedPolylines = [];
  await renderFile(f);
  prepareOverlay();
  appendLog("Loaded file: " + f.name);
});

// When OpenCV is ready, enable UI
window.onOpenCvReady = function() {
  appendLog("OpenCV.js ready.");
};
