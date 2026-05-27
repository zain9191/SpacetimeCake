// Object detection + pixel-accurate segmentation pipeline.
//   1. COCO-SSD (TF.js) for fast bbox + class detection.
//   2. SAM ("Segment Anything") via transformers.js for the exact silhouette
//      of each detected object — bbox-prompted, so the bbox tells SAM
//      where to look and SAM returns a per-pixel mask.
// Both libraries are loaded lazily on first detection.
import { state } from './state.js';
import { buildTracksFromDetections } from './tracker.js';
import { renderTracksList } from './tracks.js';

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
  // `cocoSsd` global is provided by the <script> tag in index.html
  cocoSsdModel = await cocoSsd.load();
  return cocoSsdModel;
}

export async function loadSam() {
  if (samModel && samProcessor) return { samModel, samProcessor, RawImage: samRawImage };

  const txt = document.getElementById('det-progress-text');
  const bar = document.querySelector('#det-progress-bar > div');
  if (txt) txt.textContent = 'Loading SAM (segmenter)…';
  if (bar) bar.style.width = '5%';

  const tx = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.js');
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
  try {
    samModel = await SamModel.from_pretrained(SAM_MODEL_ID, {
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      device,
    });
  } catch (err) {
    console.warn('Preferred SAM dtype failed, retrying with q8/wasm:', err);
    samModel = await SamModel.from_pretrained(SAM_MODEL_ID, { dtype: 'q8', device: 'wasm' });
    samBackend = 'wasm';
  }
  return { samModel, samProcessor, RawImage };
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

  const detections = await cocoSsdModel.detect(scratchCanvas);
  if (detections.length === 0) return [];

  const { samModel: m, samProcessor: p, RawImage } = await loadSam();
  const rawImg = await RawImage.fromCanvas(scratchCanvas);

  const boxes = detections.map(d => [
    Math.max(0, d.bbox[0]),
    Math.max(0, d.bbox[1]),
    Math.min(W, d.bbox[0] + d.bbox[2]),
    Math.min(H, d.bbox[1] + d.bbox[3]),
  ]);

  const inputs = await p(rawImg, { input_boxes: [boxes] });
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
    let bestK = 0, bestS = iouScores[i * nPer];
    for (let k = 1; k < nPer; k++) {
      const s = iouScores[i * nPer + k];
      if (s > bestS) { bestS = s; bestK = k; }
    }
    const baseOff = ((i * nPer) + bestK) * mH * mW;
    const mask = new Uint8Array(mH * mW);
    for (let p2 = 0; p2 < mH * mW; p2++) mask[p2] = samMaskBytes[baseOff + p2] ? 255 : 0;

    result.push({
      bbox: detections[i].bbox,
      score: detections[i].score,
      class: detections[i].class,
      mask, maskW: mW, maskH: mH,
    });
  }
  return result;
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
