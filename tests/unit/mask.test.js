// Unit tests for the 3D mask builder. Just verifies coordinate math, the
// y-flip when projecting per-frame masks into the volume, and the temporal
// gap fill. Pure Uint8Array manipulation — no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFrameMaskToVolume, temporalFillGaps } from '../../src/mask.js';

test('writeFrameMaskToVolume: writes single pixel with y-flip', () => {
  // 4×4 volume, 2 frames
  const W = 4, H = 4;
  const maskData = new Uint8Array(W * H * 2);
  // Detection mask: a single pixel at (1, 0) in original-image coords.
  const detMask = new Uint8Array([
    0, 255, 0, 0,   // row 0 (top)
    0,   0, 0, 0,
    0,   0, 0, 0,
    0,   0, 0, 0,
  ]);
  writeFrameMaskToVolume(maskData, 1, detMask, W, H, W, H);

  // After y-flip, (px=1, py=0) → (vx=1, vy = H-1-0 = 3).
  // Slab for frame 1 starts at W*H = 16. Row 3 starts at 16 + 3*W = 28.
  assert.equal(maskData[28 + 1], 255);
  // Nothing else should be set.
  let onCount = 0;
  for (const v of maskData) if (v) onCount++;
  assert.equal(onCount, 1);
});

test('writeFrameMaskToVolume: handles smaller mask via nearest-neighbour resample', () => {
  const W = 4, H = 4;
  const maskData = new Uint8Array(W * H);
  // A 2×2 mask, all pixels on.
  const detMask = new Uint8Array([255, 255, 255, 255]);
  writeFrameMaskToVolume(maskData, 0, detMask, 2, 2, W, H);

  // All 16 voxels in the single-frame slab should be on.
  for (let i = 0; i < W * H; i++) assert.equal(maskData[i], 255, `voxel ${i}`);
});

test('writeFrameMaskToVolume: zero pixels stay zero', () => {
  const W = 4, H = 4;
  const maskData = new Uint8Array(W * H);
  // All zeros
  writeFrameMaskToVolume(maskData, 0, new Uint8Array(W * H), W, H, W, H);
  for (const v of maskData) assert.equal(v, 0);
});

test('temporalFillGaps: fills 1-frame gap when neighbours are on', () => {
  const W = 2, H = 1, N = 3;
  const maskData = new Uint8Array(W * H * N);
  // Voxel (0,0) on in frames 0 and 2, off in frame 1.
  maskData[0] = 255;          // frame 0, voxel 0
  // frame 1 voxel 0 stays 0
  maskData[2 * W * H + 0] = 255; // frame 2, voxel 0

  temporalFillGaps(maskData, W, H, N);

  // After fill, frame 1 voxel 0 should be on.
  assert.equal(maskData[W * H + 0], 255);
  // Voxel 1 was never on, should still be off everywhere.
  assert.equal(maskData[1], 0);
  assert.equal(maskData[W * H + 1], 0);
  assert.equal(maskData[2 * W * H + 1], 0);
});

test('temporalFillGaps: does not fill when only one neighbour is on', () => {
  const W = 1, H = 1, N = 3;
  const maskData = new Uint8Array(W * H * N);
  // Only frame 0 is on.
  maskData[0] = 255;
  temporalFillGaps(maskData, W, H, N);
  // Frame 1 should stay 0 (only one of the two neighbours is on).
  assert.equal(maskData[1], 0);
});

test('temporalFillGaps: bails out gracefully on N < 3', () => {
  const maskData = new Uint8Array([255, 0]);
  temporalFillGaps(maskData, 1, 1, 2);
  assert.deepEqual(Array.from(maskData), [255, 0]);
});

test('temporalFillGaps: preserves boundaries (first and last frame untouched)', () => {
  const W = 1, H = 1, N = 5;
  const maskData = new Uint8Array(W * H * N);
  maskData[1] = 255;
  maskData[3] = 255;
  temporalFillGaps(maskData, W, H, N);
  // The gap at frame 2 should be filled.
  assert.equal(maskData[2], 255);
  // First and last untouched.
  assert.equal(maskData[0], 0);
  assert.equal(maskData[4], 0);
});
