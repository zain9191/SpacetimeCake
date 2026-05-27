// Pure functions for tracking objects across frames. No Three.js, no DOM —
// so these are easy to unit-test in Node.

// IoU of two [x, y, w, h] boxes. Returns 0 for any degenerate (zero-area)
// box so downstream callers never see NaN/Infinity.
export function computeIoU(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) return 0;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

// Greedy IoU matching between consecutive frames. Each detection that
// matches an existing track (same class, IoU above threshold) extends it;
// unmatched detections start new tracks. Tracks that "go missing" for
// more than maxGap frames are not revived.
export function buildTracksFromDetections(perFrame, iouThresh = 0.25, maxGap = 8) {
  const trackList = [];

  for (let f = 0; f < perFrame.length; f++) {
    const dets = perFrame[f] || [];
    const usedDet = new Set();

    for (const tr of trackList) {
      if (tr.lastFrame < f - maxGap) continue;
      let bestI = -1, bestIoU = iouThresh;
      for (let i = 0; i < dets.length; i++) {
        if (usedDet.has(i)) continue;
        if (dets[i].class !== tr.class) continue;
        const iou = computeIoU(tr.lastBbox, dets[i].bbox);
        if (iou > bestIoU) { bestIoU = iou; bestI = i; }
      }
      if (bestI >= 0) {
        tr.detectionsByFrame[f] = dets[bestI];
        tr.scores.push(dets[bestI].score);
        tr.lastBbox = dets[bestI].bbox;
        tr.lastFrame = f;
        usedDet.add(bestI);
      }
    }

    for (let i = 0; i < dets.length; i++) {
      if (usedDet.has(i)) continue;
      trackList.push({
        class: dets[i].class,
        classId: dets[i].classId,
        detectionsByFrame: { [f]: dets[i] },
        scores: [dets[i].score],
        lastBbox: dets[i].bbox,
        lastFrame: f,
      });
    }
  }

  return trackList
    .map(tr => {
      const frames = Object.keys(tr.detectionsByFrame).map(n => parseInt(n, 10)).sort((a, b) => a - b);
      const avgScore = tr.scores.reduce((a, b) => a + b, 0) / tr.scores.length;
      return {
        class: tr.class,
        classId: tr.classId,
        detectionsByFrame: tr.detectionsByFrame,
        firstFrame: frames[0],
        lastFrame: frames[frames.length - 1],
        numFrames: frames.length,
        avgScore,
      };
    })
    .filter(tr => tr.numFrames >= 2)
    .sort((a, b) => b.numFrames - a.numFrames);
}
