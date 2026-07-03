// Tracks-panel UI: renderTracksList, selectTrack, clearTrack.
// Extracted from ui.js so cube.js / video.js can reset the panel after
// loading a new video without creating a circular import.
import { state } from './state.js';
import { buildPixelMaskForTrack } from './mask.js';
import { applyMaskUniforms } from './cube.js';

export const TRACK_COLORS = [
  '#ff8a4c', '#4cb8ff', '#a4ff4c', '#ff4ce4',
  '#ffd24c', '#4cffd0', '#ff4c4c', '#a14cff',
];

export function renderTracksList() {
  const container = document.getElementById('tracks-list');
  if (!container) return;
  // Replace contents safely (no innerHTML interpolation of detection classes)
  container.replaceChildren();
  if (!state.tracks || state.tracks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tracks-empty';
    empty.style.cssText = 'font-size: 11px; color: var(--text-dim); padding: 8px 0; text-align: center;';
    empty.textContent = 'No objects detected yet.';
    container.append(empty);
    return;
  }
  state.tracks.forEach((tr, i) => {
    const el = document.createElement('div');
    el.className = 'track-item' + (i === state.activeTrackIdx ? ' active' : '');
    el.dataset.trackIdx = String(i);
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');

    const row = document.createElement('div');
    row.className = 'track-info-row';

    const swatch = document.createElement('div');
    swatch.className = 'track-swatch';
    swatch.style.background = TRACK_COLORS[i % TRACK_COLORS.length];

    const text = document.createElement('div');
    const cls = document.createElement('div');
    cls.className = 'track-class';
    cls.textContent = tr.class;
    const meta = document.createElement('div');
    meta.className = 'track-meta';
    meta.textContent = `${tr.numFrames} frames · ${Math.round(tr.avgScore * 100)}%`;
    text.append(cls, meta);

    row.append(swatch, text);
    el.append(row);

    const activate = () => selectTrack(i);
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    container.append(el);
  });
}

export async function selectTrack(idx) {
  if (state.isBuildingMask) return;
  if (idx < 0 || idx >= state.tracks.length) return;
  const previousIdx = state.activeTrackIdx;
  state.isBuildingMask = true;
  state.activeTrackIdx = idx;
  renderTracksList();
  const clearBtn = document.getElementById('clear-track-btn');
  if (clearBtn) clearBtn.style.display = 'block';

  const det = document.getElementById('det-progress');
  const txt = document.getElementById('det-progress-text');
  const bar = document.querySelector('#det-progress-bar > div');
  if (det) det.classList.add('active');
  if (txt) txt.textContent = 'Isolating…';
  if (bar) bar.style.width = '0%';

  try {
    // SAM runs lazily: masks are only computed the first time a track is
    // selected (segmentTrack caches them on the detection objects).
    // Dynamic import because detection.js imports renderTracksList from us —
    // a static import would create a module cycle.
    const { segmentTrack } = await import('./detection.js');
    await segmentTrack(state.tracks[idx], (p, label) => {
      if (label && txt) txt.textContent = label;
      if (bar) bar.style.width = `${Math.round(p * 85)}%`;
    });
    await buildPixelMaskForTrack(state, state.tracks[idx], (p, label) => {
      if (label && txt) txt.textContent = label;
      if (bar) bar.style.width = `${Math.round(85 + p * 15)}%`;
    });
    if (txt) txt.textContent = 'Done';
    if (bar) bar.style.width = '100%';
    applyMaskUniforms();
  } catch (err) {
    console.error(err);
    if (txt) txt.textContent = 'Isolation failed: ' + err.message;
    // Roll back so UI and shader uniforms stay consistent
    state.activeTrackIdx = previousIdx;
    renderTracksList();
    if (clearBtn && previousIdx < 0) clearBtn.style.display = 'none';
    applyMaskUniforms();
  } finally {
    state.isBuildingMask = false;
    setTimeout(() => det && det.classList.remove('active'), 800);
  }
}

export function clearTrack() {
  state.activeTrackIdx = -1;
  applyMaskUniforms();
  renderTracksList();
  const clearBtn = document.getElementById('clear-track-btn');
  if (clearBtn) clearBtn.style.display = 'none';
}
