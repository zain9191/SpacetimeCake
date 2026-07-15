import * as THREE from 'three';
import { state } from './state.js';

const localPoint = new THREE.Vector3();

function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}

export function formatTime(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe - minutes * 60;
  return `${minutes}:${secs.toFixed(1).padStart(4, '0')}`;
}

export function syncTimelineUI(t = state.timePosition) {
  const value = clamp01(t);
  state.timePosition = value;
  const input = document.getElementById('time-scrubber');
  const frame = document.getElementById('time-frame');
  const clock = document.getElementById('time-clock');
  if (input && document.activeElement !== input) input.value = String(Math.round(value * 1000));
  if (frame) {
    const idx = state.numFrames ? Math.min(state.numFrames - 1, Math.round(value * (state.numFrames - 1))) : 0;
    frame.textContent = `Frame ${idx + 1}/${Math.max(1, state.numFrames)}`;
  }
  if (clock) clock.textContent = `${formatTime(value * state.videoDuration)} / ${formatTime(state.videoDuration)}`;
}

export function setSliceCoordinates(coords = {}) {
  if (!state.cube || !state.slicePlane) return;
  state.cube.updateMatrixWorld(true);
  localPoint.copy(state.slicePlane.position);
  state.cube.worldToLocal(localPoint);
  if (coords.u != null) localPoint.x = (clamp01(coords.u) - 0.5) * state.cubeSize.x;
  if (coords.v != null) localPoint.y = (clamp01(coords.v) - 0.5) * state.cubeSize.y;
  if (coords.t != null) localPoint.z = (clamp01(coords.t) - 0.5) * state.cubeSize.z;
  state.cube.localToWorld(localPoint);
  state.slicePlane.position.copy(localPoint);
  if (coords.t != null) syncTimelineUI(coords.t);
}

export function setSliceTime(t) {
  setSliceCoordinates({ t });
}

export function setPlaying(playing) {
  state.isPlaying = Boolean(playing && state.volumeTexture);
  const btn = document.getElementById('play-time');
  if (btn) {
    btn.textContent = state.isPlaying ? 'Pause' : 'Play';
    btn.setAttribute('aria-pressed', String(state.isPlaying));
  }
}

export function updatePlayback(deltaSeconds) {
  if (!state.isPlaying || !state.videoDuration) return;
  let next = state.timePosition + deltaSeconds / Math.max(2, state.videoDuration);
  if (next > 1) next %= 1;
  setSliceTime(next);
}

export function wirePreviewNavigation() {
  const mappings = [
    ['canvas-xy', (x, y) => ({ u: x, v: 1 - y })],
    ['canvas-xt', (x, y) => ({ u: x, t: 1 - y })],
    ['canvas-yt', (x, y) => ({ v: x, t: 1 - y })],
  ];
  for (const [id, map] of mappings) {
    const canvas = document.getElementById(id);
    if (!canvas) continue;
    canvas.addEventListener('pointerdown', (event) => {
      if (!state.volumeTexture) return;
      const rect = canvas.getBoundingClientRect();
      setSliceCoordinates(map((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height));
    });
  }
}
