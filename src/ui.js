// All DOM event wiring — buttons, sliders, drag-and-drop, keyboard shortcuts.
// Tracks-list rendering lives in ./tracks.js to avoid circular imports.
import * as THREE from 'three';
import { state } from './state.js';
import { extractFramesFromFile } from './video.js';
import { runDetection } from './detection.js';
import { renderTracksList, clearTrack } from './tracks.js';
import { applySelection, transformControls } from './interactions.js';
import { resizeSlicePlaneToCube } from './cube.js';
import { renderer } from './scene.js';
import { showNotice, clearNotice } from './experience.js';
import { setPlaying, setSliceTime, syncTimelineUI, wirePreviewNavigation } from './timeline.js';

// Re-export for tests and external callers
export { renderTracksList, clearTrack };

// Pipe an error string into the side-panel progress text instead of an alert()
// so we never feed attacker-controlled message strings into a blocking dialog.
function showError(scope, err) {
  console.error(scope, err);
  document.getElementById('progress')?.classList.remove('active');
  showNotice(`${scope}: ${err && err.message ? err.message : 'failed'}`, 'error', { persistent: true });
}

function safeName(name) {
  return (name || 'spacetime-cake').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Wire everything up ----
export function wireUI() {
  // File picker — visible "Choose Video…" is a <label for="file-input">, so
  // mouse clicks already open the picker natively. We only need to forward
  // keyboard Enter/Space (labels don't activate on those by default).
  const fileInput = document.getElementById('file-input');
  const fileBtn = document.getElementById('file-btn');
  fileBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      clearNotice();
      extractFramesFromFile(file).catch(err => showError('Video load failed', err));
    }
  });

  document.getElementById('sample-btn').addEventListener('click', async () => {
    const button = document.getElementById('sample-btn');
    button.disabled = true;
    button.textContent = 'Loading sample…';
    clearNotice();
    try {
      const response = await fetch('./tests/fixtures/sample.mp4');
      if (!response.ok) throw new Error(`Sample unavailable (${response.status})`);
      const blob = await response.blob();
      const sample = new File([blob], 'sample.mp4', { type: blob.type || 'video/mp4' });
      await extractFramesFromFile(sample);
    } catch (err) {
      showError('Sample load failed', err);
    } finally {
      button.disabled = false;
      button.textContent = 'Try the sample video';
    }
  });

  // Drag-and-drop
  const dropOverlay = document.getElementById('drop-overlay');
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('active');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) {
      dropOverlay.classList.remove('active');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      clearNotice();
      extractFramesFromFile(file).catch(err => showError('Video drop failed', err));
    }
  });

  // Render mode buttons
  const modeOpaqueBtn = document.getElementById('mode-opaque');
  const modeVolumeBtn = document.getElementById('mode-volume');
  const modePathBtn   = document.getElementById('mode-path');
  const opacityRow    = document.getElementById('opacity-row');
  const pathSoftnessRow = document.getElementById('path-softness-row');
  const modeDescription = document.getElementById('mode-description');
  const modeDescriptions = [
    'Opaque reveals a clean cross-section at the slice plane.',
    'Fog blends frames into a translucent spacetime volume.',
    'Path emphasizes repeated pixels so motion becomes a visible trail.',
  ];

  function setMode(m) {
    state.renderMode = m;
    modeOpaqueBtn.classList.toggle('active', m === 0);
    modeVolumeBtn.classList.toggle('active', m === 1);
    modePathBtn.classList.toggle('active',   m === 2);
    // Sync aria-pressed for screen readers
    modeOpaqueBtn.setAttribute('aria-pressed', String(m === 0));
    modeVolumeBtn.setAttribute('aria-pressed', String(m === 1));
    modePathBtn.setAttribute('aria-pressed', String(m === 2));
    if (state.cube) {
      if (m === 0) {
        state.cube.material.clippingPlanes = [state.sliceClippingPlane];
        state.cube.material.transparent = false;
        state.cube.material.depthWrite = true;
      } else {
        state.cube.material.clippingPlanes = [];
        state.cube.material.transparent = true;
        state.cube.material.depthWrite = false;
      }
      state.cube.material.needsUpdate = true;
    }
    opacityRow.style.display      = (m === 1) ? 'flex' : 'none';
    pathSoftnessRow.style.display = (m === 2) ? 'flex' : 'none';
    modeDescription.textContent = modeDescriptions[m];
  }
  modeOpaqueBtn.addEventListener('click', () => setMode(0));
  modeVolumeBtn.addEventListener('click', () => setMode(1));
  modePathBtn.addEventListener('click',   () => setMode(2));
  setMode(state.renderMode);

  // Timeline and click-to-navigate orthogonal previews.
  const timeScrubber = document.getElementById('time-scrubber');
  timeScrubber.addEventListener('input', () => setSliceTime(parseInt(timeScrubber.value, 10) / 1000));
  document.getElementById('play-time').addEventListener('click', () => setPlaying(!state.isPlaying));
  wirePreviewNavigation();

  // Sliders
  const opacityInput = document.getElementById('opacity');
  const opacityValue = document.getElementById('opacity-value');
  opacityInput.addEventListener('input', () => {
    state.volumeOpacity = parseInt(opacityInput.value, 10) / 100;
    opacityValue.textContent = opacityInput.value;
  });
  const pathSoftnessInput = document.getElementById('path-softness');
  const pathSoftnessValue = document.getElementById('path-softness-value');
  pathSoftnessInput.addEventListener('input', () => {
    state.pathSoftness = parseInt(pathSoftnessInput.value, 10) / 100;
    pathSoftnessValue.textContent = pathSoftnessInput.value;
  });

  // Selection buttons
  const selectSlice = document.getElementById('select-slice');
  const selectCube = document.getElementById('select-cube');
  function setSelectedTarget(target) {
    state.selectedTarget = target;
    selectSlice.classList.toggle('active', target === 'slice');
    selectCube.classList.toggle('active',  target === 'cube');
    selectSlice.setAttribute('aria-pressed', String(target === 'slice'));
    selectCube.setAttribute('aria-pressed',  String(target === 'cube'));
    applySelection();
  }
  selectSlice.addEventListener('click', () => setSelectedTarget('slice'));
  selectCube.addEventListener('click',  () => setSelectedTarget('cube'));

  // Tool buttons
  const toolTranslate = document.getElementById('tool-translate');
  const toolRotate = document.getElementById('tool-rotate');
  function setTool(mode) {
    transformControls.setMode(mode);
    toolTranslate.classList.toggle('active', mode === 'translate');
    toolRotate.classList.toggle('active',    mode === 'rotate');
    toolTranslate.setAttribute('aria-pressed', String(mode === 'translate'));
    toolRotate.setAttribute('aria-pressed',    String(mode === 'rotate'));
  }
  toolTranslate.addEventListener('click', () => setTool('translate'));
  toolRotate.addEventListener('click',    () => setTool('rotate'));

  document.getElementById('reset-slice').addEventListener('click', () => {
    const target = state.selectedTarget === 'slice' ? state.slicePlane : state.cube;
    if (target) {
      target.position.set(0, 0, 0);
      target.rotation.set(0, 0, 0);
      if (target === state.slicePlane) syncTimelineUI(0.5);
    }
  });

  // Detection buttons
  document.getElementById('detect-btn').addEventListener('click', () => {
    runDetection();
  });
  document.getElementById('clear-track-btn').addEventListener('click', clearTrack);
  document.getElementById('cancel-processing').addEventListener('click', () => {
    state.cancelRequested = true;
    showNotice('Cancelling after the current frame…', 'info');
  });

  // Depth slider (rebuilds cube geometry live)
  const depthInput = document.getElementById('depth');
  const depthValue = document.getElementById('depth-value');
  depthInput.addEventListener('input', () => {
    const val = parseInt(depthInput.value, 10) / 100;
    depthValue.textContent = val.toFixed(1) + '×';
    if (state.cube) {
      state.cubeSize.z = val;
      state.cube.geometry.dispose();
      state.cube.geometry = new THREE.BoxGeometry(state.cubeSize.x, state.cubeSize.y, state.cubeSize.z);
      const wire = state.cube.children[0];
      if (wire) {
        wire.geometry.dispose();
        wire.geometry = new THREE.EdgesGeometry(state.cube.geometry);
      }
      // The slice plane has to grow with the cube too, otherwise oblique cuts
      // leave visible edges inside the volume.
      resizeSlicePlaneToCube();
      setSliceTime(state.timePosition);
    }
  });

  // Collapsible panels preserve canvas space, especially on smaller screens.
  function wireCollapse(panelId, buttonId) {
    const panel = document.getElementById(panelId);
    const button = document.getElementById(buttonId);
    button.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      button.textContent = collapsed ? '+' : '−';
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${panelId === 'panel' ? 'controls' : 'orthogonal previews'}`);
    });
  }
  wireCollapse('panel', 'panel-toggle');
  wireCollapse('preview-panel', 'preview-toggle');
  const collapsePreviewOnNarrowScreens = () => {
    if (window.matchMedia('(max-width: 520px)').matches) {
      const preview = document.getElementById('preview-panel');
      if (!preview.classList.contains('collapsed')) document.getElementById('preview-toggle').click();
    }
  };
  window.addEventListener('resize', collapsePreviewOnNarrowScreens);
  collapsePreviewOnNarrowScreens();

  // Lightweight, local exports: the current WebGL canvas and compact track data.
  document.getElementById('export-png').addEventListener('click', () => {
    renderer.domElement.toBlob((blob) => {
      if (!blob) {
        showNotice('The current view could not be captured. Try orbiting once and retry.', 'error', { persistent: true });
        return;
      }
      downloadBlob(blob, `${safeName(state.videoName)}-view.png`);
      showNotice('PNG view saved.', 'success');
    }, 'image/png');
  });
  document.getElementById('export-json').addEventListener('click', () => {
    const data = {
      version: 1,
      source: { name: state.videoName, duration: state.videoDuration, width: state.frameW, height: state.frameH, frames: state.numFrames },
      view: { mode: state.renderMode, time: state.timePosition, depth: state.cubeSize.z, activeTrack: state.activeTrackIdx },
      tracks: state.tracks.map((track) => ({
        class: track.class,
        firstFrame: track.firstFrame,
        lastFrame: track.lastFrame,
        numFrames: track.numFrames,
        confidence: track.avgScore,
        detections: Object.fromEntries(Object.entries(track.detectionsByFrame).map(([frame, det]) => [frame, { bbox: det.bbox, score: det.score }])),
      })),
    };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${safeName(state.videoName)}-data.json`);
    showNotice('Track data saved.', 'success');
  });

  // Keyboard shortcuts. The previous guard suppressed shortcuts whenever ANY
  // input had focus, including sliders — which silently broke the documented
  // T/R/1/2 keys after any slider interaction. Narrow it to actual typing.
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const isTyping = (t.tagName === 'INPUT' &&
                       /^(text|number|search|email|url|tel|password)$/i.test(t.type))
                  || t.tagName === 'TEXTAREA' || t.isContentEditable;
    if (isTyping) return;
    if (!state.volumeTexture) return;
    if (e.key === 't' || e.key === 'T') toolTranslate.click();
    if (e.key === 'r' || e.key === 'R') toolRotate.click();
    if (e.key === '1') selectSlice.click();
    if (e.key === '2') selectCube.click();
  });
}
