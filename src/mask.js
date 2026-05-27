// Build the 3D voxel mask from a track's per-frame SAM masks, plus a
// temporal-gap fill so the path doesn't flicker. Pure JS data manipulation
// — works on a Uint8Array of shape (W * H * numFrames).

// Project a per-frame 2D mask into the 3D voxel grid, applying the y-flip
// the volume texture uses (volume y=0 = bottom of original image).
// `maskData` is mutated in place.
export function writeFrameMaskToVolume(maskData, frameIdx, mask, mW, mH, W, H) {
  const slabOff = frameIdx * W * H;
  if (mW === W && mH === H) {
    // Same dimensions — direct copy with y flip
    for (let py = 0; py < H; py++) {
      const vy = H - 1 - py;
      const srcRow = py * W;
      const dstRow = slabOff + vy * W;
      for (let px = 0; px < W; px++) {
        if (mask[srcRow + px]) maskData[dstRow + px] = 255;
      }
    }
  } else {
    // Different dimensions — nearest-neighbour resample
    const sx = mW / W, sy = mH / H;
    for (let py = 0; py < H; py++) {
      const vy = H - 1 - py;
      const my = Math.min(mH - 1, Math.floor(py * sy));
      const srcRow = my * mW;
      const dstRow = slabOff + vy * W;
      for (let px = 0; px < W; px++) {
        const mx = Math.min(mW - 1, Math.floor(px * sx));
        if (mask[srcRow + mx]) maskData[dstRow + px] = 255;
      }
    }
  }
}

// Fill 1-frame gaps in the temporal axis: a voxel becomes "on" if its
// t-1 and t+1 neighbours are both on. Smooths out single-frame holes
// when the detector momentarily lost the object.
export function temporalFillGaps(maskData, W, H, N) {
  if (N < 3) return;
  const slab = W * H;
  for (let f = 1; f < N - 1; f++) {
    const cur = f * slab, prev = (f - 1) * slab, next = (f + 1) * slab;
    for (let i = 0; i < slab; i++) {
      if (maskData[cur + i] === 0 && maskData[prev + i] > 0 && maskData[next + i] > 0) {
        maskData[cur + i] = 255;
      }
    }
  }
}

// Given a track and the volume dimensions, build the full 3D mask in place.
export async function buildPixelMaskForTrack(state, track, onProgress) {
  const W = state.frameW, H = state.frameH;
  const N = state.numFrames;
  state.maskData.fill(0);

  const frames = Object.keys(track.detectionsByFrame).map(n => parseInt(n, 10)).sort((a, b) => a - b);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const det = track.detectionsByFrame[f];
    if (!det || !det.mask) continue;

    writeFrameMaskToVolume(state.maskData, f, det.mask, det.maskW, det.maskH, W, H);

    if (onProgress && (i % 8 === 0 || i === frames.length - 1)) {
      onProgress((i + 1) / frames.length, 'Building mask…');
      await new Promise(r => setTimeout(r, 0));
    }
  }

  temporalFillGaps(state.maskData, W, H, N);
  state.maskTexture.needsUpdate = true;
}
