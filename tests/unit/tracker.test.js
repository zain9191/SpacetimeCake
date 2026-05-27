// Unit tests for the pure tracking logic. No browser, no DOM, no Three.js.
// Run with `node --test tests/unit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIoU, buildTracksFromDetections } from '../../src/tracker.js';

test('computeIoU: identical boxes → 1', () => {
  const a = [10, 10, 50, 50];
  assert.equal(computeIoU(a, a), 1);
});

test('computeIoU: disjoint boxes → 0', () => {
  assert.equal(computeIoU([0, 0, 10, 10], [100, 100, 10, 10]), 0);
});

test('computeIoU: half-overlapping boxes', () => {
  // Two 10×10 boxes, second shifted 5 px to the right.
  // Intersection: 5×10 = 50. Union: 100 + 100 - 50 = 150. IoU = 1/3.
  const iou = computeIoU([0, 0, 10, 10], [5, 0, 10, 10]);
  assert.ok(Math.abs(iou - 1 / 3) < 1e-9, `expected ~0.333, got ${iou}`);
});

test('computeIoU: edge-touching boxes → 0', () => {
  // Boxes that share only an edge have zero-area intersection.
  assert.equal(computeIoU([0, 0, 10, 10], [10, 0, 10, 10]), 0);
});

test('computeIoU: zero-area boxes return 0, not NaN', () => {
  // A zero-area bbox upstream (bad detection) must not poison every
  // subsequent IoU with NaN — otherwise tracking dies silently.
  assert.equal(computeIoU([0, 0, 0, 0], [0, 0, 0, 0]), 0);
  assert.equal(computeIoU([0, 0, 0, 0], [0, 0, 10, 10]), 0);
  assert.equal(computeIoU([5, 5, 10, 10], [5, 5, 0, 10]), 0);
});

test('computeIoU: negative-dimension boxes return 0', () => {
  // Shouldn't happen but is the kind of malformed input that has slipped
  // through detection-model outputs in the past.
  assert.equal(computeIoU([0, 0, -5, 10], [0, 0, 10, 10]), 0);
});

test('buildTracksFromDetections: empty input → no tracks', () => {
  assert.deepEqual(buildTracksFromDetections([]), []);
});

test('buildTracksFromDetections: single detection in one frame is filtered (< 2 frames)', () => {
  const detections = [
    [{ bbox: [0, 0, 10, 10], class: 'person', score: 0.9 }],
  ];
  assert.deepEqual(buildTracksFromDetections(detections), []);
});

test('buildTracksFromDetections: same-class overlapping boxes across 3 frames → 1 track', () => {
  const detections = [
    [{ bbox: [0,  0, 10, 10], class: 'person', score: 0.9 }],
    [{ bbox: [1,  1, 10, 10], class: 'person', score: 0.8 }],
    [{ bbox: [2,  2, 10, 10], class: 'person', score: 0.7 }],
  ];
  const tracks = buildTracksFromDetections(detections);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].class, 'person');
  assert.equal(tracks[0].numFrames, 3);
  assert.equal(tracks[0].firstFrame, 0);
  assert.equal(tracks[0].lastFrame, 2);
});

test('buildTracksFromDetections: low IoU between frames starts a new track', () => {
  const detections = [
    [{ bbox: [0,  0, 10, 10], class: 'person', score: 0.9 }],
    // 60 px away — no overlap with the first
    [{ bbox: [60, 0, 10, 10], class: 'person', score: 0.8 }],
  ];
  const tracks = buildTracksFromDetections(detections);
  // Two singletons → both filtered out (< 2 frames each)
  assert.equal(tracks.length, 0);
});

test('buildTracksFromDetections: different classes never match', () => {
  const detections = [
    [{ bbox: [0, 0, 10, 10], class: 'person', score: 0.9 }],
    [{ bbox: [0, 0, 10, 10], class: 'dog',    score: 0.9 }],
  ];
  const tracks = buildTracksFromDetections(detections);
  assert.equal(tracks.length, 0);
});

test('buildTracksFromDetections: maxGap allows brief disappearance', () => {
  const detections = [
    [{ bbox: [0, 0, 10, 10], class: 'person', score: 0.9 }],
    [],                                                              // gone for one frame
    [{ bbox: [1, 1, 10, 10], class: 'person', score: 0.8 }],
  ];
  const tracks = buildTracksFromDetections(detections, 0.2, 3);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].numFrames, 2);
});

test('buildTracksFromDetections: multiple objects produce multiple tracks', () => {
  const detections = [
    [
      { bbox: [0,   0,   10, 10], class: 'person', score: 0.9 },
      { bbox: [100, 100, 10, 10], class: 'dog',    score: 0.8 },
    ],
    [
      { bbox: [1,   1,   10, 10], class: 'person', score: 0.9 },
      { bbox: [102, 102, 10, 10], class: 'dog',    score: 0.8 },
    ],
    [
      { bbox: [2,   2,   10, 10], class: 'person', score: 0.9 },
      { bbox: [104, 104, 10, 10], class: 'dog',    score: 0.8 },
    ],
  ];
  const tracks = buildTracksFromDetections(detections);
  assert.equal(tracks.length, 2);
  // Sorted by track length descending; both have 3 frames so order between
  // them is fine either way — just confirm both classes appear.
  const classes = new Set(tracks.map(t => t.class));
  assert.deepEqual(classes, new Set(['person', 'dog']));
});

test('buildTracksFromDetections: average score is computed', () => {
  const detections = [
    [{ bbox: [0, 0, 10, 10], class: 'person', score: 1.0 }],
    [{ bbox: [1, 1, 10, 10], class: 'person', score: 0.5 }],
  ];
  const tracks = buildTracksFromDetections(detections);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].avgScore, 0.75);
});

test('buildTracksFromDetections: each detection assigned to at most one track', () => {
  // Two close persons in frame 0; one in frame 1. The closer match wins,
  // the other persons just stays a singleton.
  const detections = [
    [
      { bbox: [0, 0, 10, 10], class: 'person', score: 0.9 },
      { bbox: [3, 3, 10, 10], class: 'person', score: 0.8 },
    ],
    [
      { bbox: [4, 4, 10, 10], class: 'person', score: 0.9 },
    ],
  ];
  const tracks = buildTracksFromDetections(detections);
  // The closer track survives (2 frames); the other is a singleton (filtered).
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].numFrames, 2);
});
