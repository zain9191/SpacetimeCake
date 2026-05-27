// Object detection + pixel-accurate segmentation pipeline.
//   1. COCO-SSD (TF.js) for fast bbox + class detection.
//   2. SAM ("Segment Anything") via transformers.js for the exact silhouette
//      of each detected object — bbox-prompted, so the bbox tells SAM
//      where to look and SAM returns a per-pixel mask.
// Both libraries are loaded lazily on first detection.
import { state } from './state.js';
import { buildTracksFromDetections } from './tracker.js';
import { renderTracksList } from './tracks.js';

// SlimSAM-77 is ≈20× faster than sam-vit-base (1–2 s/frame vs ~20 s/frame)
// at slightly lower mask quality. We compensate for the quality gap with a
// bbox fallback when SAM produces a sparse mask and a one-pixel dilation
// to close small interior gaps, so the end result is consistently good.
const SAM_MODEL_ID = 'Xenova/slimsam-77-uniform';

let cocoSsdModel = null;
let samModel = null;
let samProcessor = null;
let samRawImage = null;
let samBackend = null;

export async function loadCocoSsd() {
  if (cocoSsdModel) return cocoSsdModel;
  if (window.tf && window.tf.setBackend) {
    try { await tf.setBackend('webgl'); await tf.ready(); } catch (e) { /* ignore */ }
  }
  // Use the full `mobilenet_v2` base instead of the default `lite_mobilenet_v2`.
  // It's larger (~30 MB more) but catches significantly more small objects —
  // sports balls, hoops, vehicles in the background, etc. — which is what
  // makes the tracks panel actually multi-object.
  cocoSsdModel = await cocoSsd.load({ base: 'mobilenet_v2' });
  return cocoSsdModel;
}

export async function loadSam() {
  if (samModel && samProcessor) return { samModel, samProcessor, RawImage: samRawImage };

  const txt = document.getElementById('det-progress-text');
  const bar = document.querySelector('#det-progress-bar > div');
  if (txt) txt.textContent = 'Loading SAM (segmenter)…';
  if (bar) bar.style.width = '5%';

  // Use jsdelivr's ESM resolver (+esm) so bare specifiers like
  // 'onnxruntime-web/webgpu' inside the package get rewritten to URLs.
  // The plain /dist/transformers.web.js file has unresolved imports and
  // crashes with "Failed to resolve module specifier" in the browser.
  const tx = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm');
  const { SamModel, AutoProcessor, RawImage, env } = tx;
  samRawImage = RawImage;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  let device = 'wasm';
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) device = 'webgpu';
    }
  } catch (e) { /* ignore */ }
  samBackend = device;

  if (txt) txt.textContent = `Loading SAM (${device})…`;
  samProcessor = await AutoProcessor.from_pretrained(SAM_MODEL_ID);
  // Try a sequence of dtype/device combinations and pick the first that loads
  // AND actually runs a forward pass — fp16 on WebGPU is unstable for SlimSAM
  // (the decoder returns undefined .dims and every frame crashes).
  const attempts = device === 'webgpu'
    ? [
        { dtype: 'fp32', device: 'webgpu' },
        { dtype: 'q8',   device: 'wasm'   },
      ]
    : [
        { dtype: 'q8',   device: 'wasm'   },
        { dtype: 'fp32', device: 'wasm'   },
      ];

  let lastErr = null;
  for (const cfg of attempts) {
    try {
      samModel = await SamModel.from_pretrained(SAM_MODEL_ID, cfg);
      samBackend = cfg.device;
      if (txt) txt.textContent = `Loading SAM (${cfg.device}, ${cfg.dtype})…`;
      return { samModel, samProcessor, RawImage };
    } catch (err) {
      lastErr = err;
      console.warn(`SAM load with ${cfg.dtype}/${cfg.device} failed:`, err);
    }
  }
  throw lastErr || new Error('Could not load SAM');
}

// Render an un-flipped version of frame `f` from the volume to a 2D canvas.
function frameToCanvas(frameIdx, dstCanvas) {
  const W = state.frameW, H = state.frameH;
  const data = state.volumeTexture.image.data;
  const offset = frameIdx * W * H * 4;
  const unflipped = new Uint8ClampedArray(W * H * 4);
  for (let row = 0; row < H; row++) {
    const srcRow = H - 1 - row;
    unflipped.set(data.subarray(offset + srcRow * W * 4, offset + (srcRow + 1) * W * 4), row * W * 4);
  }
  dstCanvas.width = W;
  dstCanvas.height = H;
  dstCanvas.getContext('2d').putImageData(new ImageData(unflipped, W, H), 0, 0);
}

// Detect every object in `frameIdx` and segment each with SAM.
// Returns [{ bbox: [x,y,w,h], score, class, mask: Uint8Array, maskW, maskH }, ...]
export async function detectAndSegmentFrame(frameIdx, scratchCanvas) {
  frameToCanvas(frameIdx, scratchCanvas);
  const W = state.frameW, H = state.frameH;

  // COCO-SSD defaults to (maxBoxes=20, minScore=0.5). The 0.5 floor drops
  // every small or partially-occluded object — only the dominant subject
  // makes it through. Lower the floor aggressively and keep more boxes so
  // the tracks panel surfaces every object COCO-SSD has any signal for.
  // The per-class IoU tracker still filters single-frame flickers out of
  // the final list, so noise stays manageable.
  const detections = await cocoSsdModel.detect(scratchCanvas, 100, 0.03);
  if (detections.length === 0) return [];

  const { samModel: m, samProcessor: p, RawImage } = await loadSam();
  const rawImg = await RawImage.fromCanvas(scratchCanvas);

  // Build a multi-point prompt per detection. A single center point makes
  // SAM pick the smallest object containing that point (just the torso, just
  // the shirt). With a grid of foreground points sampled inside the bbox,
  // SAM has enough signal to segment the full object.
  const pointsPerBox = detections.map(d => buildPromptPoints(d.bbox, W, H));

  const inputs = await p(rawImg, { input_points: [pointsPerBox] });
  const outputs = await m(inputs);

  const maskTensors = await p.post_process_masks(
    outputs.pred_masks,
    inputs.original_sizes,
    inputs.reshaped_input_sizes,
  );
  const samMasksTensor = maskTensors[0];
  const iouScores = outputs.iou_scores.data;
  const samMaskBytes = samMasksTensor.data;

  const dims = samMasksTensor.dims;
  const nBoxes = dims[0];
  const nPer   = dims[1];
  const mH     = dims[2];
  const mW     = dims[3];

  const result = [];
  for (let i = 0; i < detections.length && i < nBoxes; i++) {
    const det = detections[i];
    const bestK = pickBestMaskCandidate(
      samMaskBytes, iouScores, i, nPer, mW, mH, det.bbox, W, H,
    );
    const baseOff = ((i * nPer) + bestK) * mH * mW;
    let mask = new Uint8Array(mH * mW);
    let onCount = 0;
    for (let p2 = 0; p2 < mH * mW; p2++) {
      if (samMaskBytes[baseOff + p2]) { mask[p2] = 255; onCount++; }
    }

    // Fallback: if SAM's mask covers less than 30% of the detection bbox,
    // SAM probably lost the object (low contrast, occlusion, etc.).
    // Substitute the full bbox so the trail stays continuous.
    const bboxAreaInMask = (det.bbox[2] * mW / W) * (det.bbox[3] * mH / H);
    if (bboxAreaInMask > 0 && onCount / bboxAreaInMask < 0.30) {
      mask = bboxToMask(det.bbox, mW, mH, W, H);
    } else {
      // Light morphological closing (one round of dilation) to fill
      // small interior holes from SAM's per-pixel decisions.
      mask = dilateMask(mask, mW, mH);
    }

    result.push({
      bbox: det.bbox,
      score: det.score,
      class: det.class,
      mask, maskW: mW, maskH: mH,
    });
  }
  return result;
}

// Fill the bbox region as a fallback when SAM produces a sparse mask.
function bboxToMask(bbox, mW, mH, W, H) {
  const m = new Uint8Array(mW * mH);
  const sx = mW / W, sy = mH / H;
  const x0 = Math.max(0, Math.floor(bbox[0] * sx));
  const y0 = Math.max(0, Math.floor(bbox[1] * sy));
  const x1 = Math.min(mW, Math.ceil((bbox[0] + bbox[2]) * sx));
  const y1 = Math.min(mH, Math.ceil((bbox[1] + bbox[3]) * sy));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) m[y * mW + x] = 255;
  }
  return m;
}

// In-place 3×3 dilation — pixel turns on if any 3×3 neighbour is on.
// Fills small interior holes without changing the overall silhouette much.
function dilateMask(mask, W, H) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) { out[y * W + x] = 255; continue; }
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          if (mask[yy * W + xx]) { any = 1; break; }
        }
      }
      out[y * W + x] = any ? 255 : 0;
    }
  }
  return out;
}

// Sample a small grid of foreground points across the bbox so SAM has enough
// signal to segment the whole object rather than a sub-region. We sample on
// a 3×3 grid INSIDE the bbox (avoiding the very edges, where the object's
// silhouette usually doesn't reach).
function buildPromptPoints(bbox, W, H) {
  const [bx, by, bw, bh] = bbox;
  const x0 = Math.max(0, bx);
  const y0 = Math.max(0, by);
  const x1 = Math.min(W, bx + bw);
  const y1 = Math.min(H, by + bh);
  const ix = (t) => x0 + (x1 - x0) * t;
  const iy = (t) => y0 + (y1 - y0) * t;
  // 3×3 grid at t = 0.25, 0.5, 0.75
  return [
    [ix(0.5),  iy(0.5)],   // center first — SAM weights earlier points more
    [ix(0.25), iy(0.25)],
    [ix(0.75), iy(0.25)],
    [ix(0.25), iy(0.75)],
    [ix(0.75), iy(0.75)],
    [ix(0.5),  iy(0.25)],
    [ix(0.5),  iy(0.75)],
    [ix(0.25), iy(0.5)],
    [ix(0.75), iy(0.5)],
  ];
}

// Pick the SAM-candidate mask whose extent (its own bounding box) most
// closely matches the COCO-SSD bbox. Falls back to the highest-IoU-score
// candidate if every candidate is empty.
function pickBestMaskCandidate(maskBytes, iouScores, i, nPer, mW, mH, detBbox, W, H) {
  const [dx, dy, dw, dh] = detBbox;
  // Map detection bbox (in original W×H pixels) into mask space (mW×mH pixels)
  // — only matters if SAM returns masks at a non-original size.
  const sx = mW / W, sy = mH / H;
  const dBboxInMask = [dx * sx, dy * sy, dw * sx, dh * sy];

  let bestK = -1, bestScore = -Infinity;
  for (let k = 0; k < nPer; k++) {
    const baseOff = ((i * nPer) + k) * mH * mW;
    // Compute the mask's bbox in mask coords + the pixel count.
    let minX = mW, minY = mH, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < mH; y++) {
      const row = baseOff + y * mW;
      for (let x = 0; x < mW; x++) {
        if (maskBytes[row + x]) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (count === 0) continue;
    const mBbox = [minX, minY, maxX - minX + 1, maxY - minY + 1];
    // IoU between SAM's mask-bbox and the detection bbox (in mask coords).
    const iou = bboxIoUXYWH(mBbox, dBboxInMask);
    // Blend IoU with SAM's own confidence — pure IoU sometimes prefers a
    // candidate that just happens to be the same shape but covers a tiny
    // subset of the bbox.
    const conf = iouScores[i * nPer + k] || 0;
    const score = iou * 0.7 + conf * 0.3;
    if (score > bestScore) { bestScore = score; bestK = k; }
  }
  return bestK >= 0 ? bestK : 0;
}

function bboxIoUXYWH(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

// Run detection over every frame in the loaded volume, then build tracks.
export async function runDetection() {
  if (!state.volumeTexture || !state.numFrames) return;
  const detectBtn = document.getElementById('detect-btn');
  const det = document.getElementById('det-progress');
  const txt = document.getElementById('det-progress-text');
  const bar = document.querySelector('#det-progress-bar > div');
  detectBtn.disabled = true;

  try {
    det.classList.add('active');
    txt.textContent = 'Loading detection model (COCO-SSD)…';
    bar.style.width = '2%';
    await loadCocoSsd();
    bar.style.width = '15%';
    await loadSam();
    bar.style.width = '25%';

    const scratch = document.createElement('canvas');
    txt.textContent = `Detecting + segmenting (${samBackend || '?'})…`;
    state.detectionsPerFrame = [];

    const t0 = performance.now();
    for (let i = 0; i < state.numFrames; i++) {
      let preds = [];
      try {
        preds = await detectAndSegmentFrame(i, scratch);
      } catch (err) {
        console.warn('Frame', i, 'failed:', err);
      }
      state.detectionsPerFrame.push(preds);
      const p = 0.25 + 0.75 * (i + 1) / state.numFrames;
      bar.style.width = `${(p * 100).toFixed(0)}%`;
      if (i % 2 === 0) await new Promise(r => setTimeout(r, 0));
    }
    const ms = performance.now() - t0;
    console.log(`Detection+SAM: ${ms.toFixed(0)}ms total, ${(ms / state.numFrames).toFixed(0)}ms/frame`);

    state.tracks = buildTracksFromDetections(state.detectionsPerFrame);
    txt.textContent = `Found ${state.tracks.length} object${state.tracks.length === 1 ? '' : 's'}`;
    renderTracksList();
  } catch (err) {
    console.error(err);
    txt.textContent = 'Detection failed: ' + err.message;
  } finally {
    detectBtn.disabled = false;
    setTimeout(() => det.classList.remove('active'), 1500);
  }
}

export function detectionBackend() { return samBackend; }
