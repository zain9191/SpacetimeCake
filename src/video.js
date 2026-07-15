// Seek the <video> element to N evenly-spaced timestamps and stuff each
// frame into a Uint8Array that we then upload as a Data3DTexture.
import * as THREE from 'three';
import { state } from './state.js';
import { buildSceneFromVolume } from './cube.js';
import { applySelection } from './interactions.js';
import { renderTracksList } from './tracks.js';
import { setWorkflowStep, setWorkspaceReady, showNotice } from './experience.js';
import { setPlaying, setSliceTime, syncTimelineUI } from './timeline.js';

function seekTo(video, t) {
  return new Promise((resolve) => {
    let resolved = false;
    let failsafeTimer = null;
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      if (failsafeTimer !== null) clearTimeout(failsafeTimer);
    };
    const onSeeked = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // Wait one frame to ensure decode finished
      requestAnimationFrame(() => resolve());
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = Math.min(t, video.duration - 0.001);
    // Failsafe for codecs that fail to fire `seeked` reliably.
    failsafeTimer = setTimeout(onSeeked, 800);
  });
}

const clamp = (v, lo, hi, fallback) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

export async function extractFramesFromFile(file) {
  // The number input's min/max attributes don't stop typed-in values, and an
  // unclamped frame count multiplies straight into the volume allocation
  // (W × H × N × 4 bytes) — so clamp to the same bounds the UI advertises.
  const numFrames = clamp(parseInt(document.getElementById('num-frames').value, 10), 8, 256, 64);
  const maxDim = clamp(parseInt(document.getElementById('max-dim').value, 10), 64, 512, 256);

  const progress = document.getElementById('progress');
  const progressBar = document.querySelector('#progress-bar > div');
  const progressText = document.getElementById('progress-text');
  progress.classList.add('active');
  progressText.textContent = 'Loading video…';
  progressBar.style.width = '0%';
  setPlaying(false);
  setWorkflowStep(1);
  setWorkspaceReady(false);

  // Reset enabled state so a second load doesn't trick callers into thinking
  // extraction is already done. Detect button is re-enabled at the end.
  const detectBtnEl = document.getElementById('detect-btn');
  if (detectBtnEl) detectBtnEl.disabled = true;

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  // (`crossOrigin = 'anonymous'` is a no-op on blob: URLs — those are
  // always same-origin — so it's intentionally omitted.)
  video.src = URL.createObjectURL(file);

  // Always revoke the blob URL, success or failure.
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not load video'));
    });

    try { await video.play(); video.pause(); } catch (e) { /* ignore */ }

    const W = video.videoWidth;
    const H = video.videoHeight;
    const scale = Math.min(maxDim / W, maxDim / H, 1);
    const w = Math.max(2, Math.floor(W * scale));
    const h = Math.max(2, Math.floor(H * scale));

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    const duration = Math.max(0.001, video.duration || 0.001);
    const data = new Uint8Array(w * h * numFrames * 4);

    progressText.textContent = `Extracting frames (${w}×${h})…`;

    for (let i = 0; i < numFrames; i++) {
      const t = (i + 0.5) / numFrames * duration;
      await seekTo(video, t);
      // Flip Y so volume texture's y=0 sits at the bottom of the original frame.
      ctx.save();
      ctx.translate(0, h);
      ctx.scale(1, -1);
      ctx.drawImage(video, 0, 0, w, h);
      ctx.restore();
      const frame = ctx.getImageData(0, 0, w, h);
      data.set(frame.data, i * w * h * 4);
      progressBar.style.width = `${((i + 1) / numFrames) * 100}%`;
    }

    if (state.volumeTexture) state.volumeTexture.dispose();
    state.volumeTexture = new THREE.Data3DTexture(data, w, h, numFrames);
    state.volumeTexture.format = THREE.RGBAFormat;
    state.volumeTexture.type = THREE.UnsignedByteType;
    state.volumeTexture.minFilter = THREE.LinearFilter;
    state.volumeTexture.magFilter = THREE.LinearFilter;
    state.volumeTexture.unpackAlignment = 1;
    state.volumeTexture.needsUpdate = true;

    buildSceneFromVolume(state.volumeTexture, w, h, numFrames);
    state.videoDuration = duration;
    state.videoName = file.name || 'video';
    state.timePosition = 0.5;
    applySelection();
    setSliceTime(0.5);
    syncTimelineUI(0.5);
    renderTracksList();  // reset tracks panel to "no objects detected yet"

    progressText.textContent = `Done — ${numFrames} frames, ${w}×${h}`;
    progressBar.style.width = '100%';

    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('preview-panel').classList.add('active');
    const importOptions = document.getElementById('import-options');
    if (importOptions) importOptions.open = false;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setWorkspaceReady(true);
    setWorkflowStep(2);
    const detectBtn = document.getElementById('detect-btn');
    if (detectBtn) detectBtn.disabled = false;

    showNotice(`Ready — ${numFrames} frames from ${file.name || 'video'} are now explorable.`, 'success');

    setTimeout(() => progress.classList.remove('active'), 1200);
  } finally {
    URL.revokeObjectURL(video.src);
  }
}
