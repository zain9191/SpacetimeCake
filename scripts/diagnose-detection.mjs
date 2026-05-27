// Diagnose "no objects detected" by driving the app with a real video,
// stubbing out the slow SAM model, and reporting what COCO-SSD finds
// per frame plus the final tracks output.
//
// Usage:
//   PORT=5184 node scripts/serve.mjs &   # in another terminal
//   node scripts/diagnose-detection.mjs path/to/video.mp4 [numFrames] [maxDim]
//
// Or just `node scripts/diagnose-detection.mjs` with the basketball video.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const VIDEO = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(ROOT, 'business-man-in-suit-and-tie-plays-basketball-free-video.mp4');
const NUM_FRAMES = parseInt(process.argv[3] || '32', 10);
const MAX_DIM    = parseInt(process.argv[4] || '256', 10);

if (!existsSync(VIDEO)) {
  console.error('No such video:', VIDEO);
  process.exit(1);
}

const PORT = 5184;
const server = spawn(process.execPath, [resolve(ROOT, 'scripts/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const waitForServer = new Promise((resolveReady, rejectReady) => {
  let buf = '';
  server.stdout.on('data', d => {
    buf += d.toString();
    if (buf.includes('Serving')) resolveReady();
  });
  server.stderr.on('data', d => process.stderr.write(d));
  setTimeout(() => rejectReady(new Error('server start timeout')), 8000);
});

try {
  await waitForServer;

  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('console', m => {
    const t = m.text();
    // Surface anything our injected probe logs, plus actual errors
    if (t.startsWith('[probe]') || m.type() === 'error' || m.type() === 'warning') {
      console.log(`  ${m.type().padEnd(7)} ${t}`);
    }
  });
  page.on('pageerror', e => console.log('  pageerror', e.message));

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__spacetimeReady === true, { timeout: 15_000 });

  // Stub SAM to a fast pass-through that yields empty masks. We just want
  // to see what COCO-SSD finds — SAM is the slow / 50 MB part.
  await page.addInitScript(() => {
    window.__spacetimeStubSam = true;
  });

  await page.evaluate(() => {
    // Patch in-place after detection.js has loaded
    return import('/src/detection.js').then(d => {
      // Override loadSam with a stub that never downloads anything.
      const stub = async () => ({
        samModel: async () => ({ pred_masks: { dims: [1,0,0,0,0], data: new Uint8Array() }, iou_scores: { data: new Float32Array() } }),
        samProcessor: async () => ({ original_sizes: [], reshaped_input_sizes: [], input_boxes: [[]] }),
        RawImage: { fromCanvas: async () => ({}) },
      });
      // We can't re-export, so we monkey-patch the module's exports indirectly
      // by intercepting detection at a higher level — wrap COCO-SSD result
      // recording instead.
    });
  });

  // Inject a probe that logs COCO-SSD detection counts and replaces the SAM
  // pipeline with a no-op. We attach this BEFORE clicking Detect Objects.
  await page.evaluate(async () => {
    const tx = await import('/src/state.js');
    const detMod = await import('/src/detection.js');
    const trMod = await import('/src/tracker.js');

    // Wait for COCO-SSD global to exist (loaded via <script>)
    while (!window.cocoSsd) await new Promise(r => setTimeout(r, 50));

    const origLoad = window.cocoSsd.load.bind(window.cocoSsd);
    window.cocoSsd.load = async (...args) => {
      const model = await origLoad(...args);
      const origDetect = model.detect.bind(model);
      let frameIdx = 0;
      model.detect = async (input, ...rest) => {
        const dets = await origDetect(input, ...rest);
        const summary = dets.map(d => `${d.class}:${d.score.toFixed(2)}`).join(',') || '(none)';
        console.log(`[probe] frame ${frameIdx++} → ${dets.length} det(s) [${summary}]`);
        return dets;
      };
      console.log('[probe] cocoSsd model loaded');
      return model;
    };

    // Stub the SAM-import dynamic import. Override transformers.js entirely.
    const origImport = (window).__nativeImport || ((u) => import(u));
    // Find the call in detection.js by replacing the runtime's dynamic import
    // — easiest is to monkey-patch the module's `loadSam` via export reassignment.
    // ES modules are read-only, so we use a different strategy: replace
    // `detectAndSegmentFrame` with one that skips SAM and returns the bboxes
    // with an empty mask. That preserves the rest of `runDetection`.
    const W = () => tx.state.frameW;
    const H = () => tx.state.frameH;

    const noopSegmentFrame = async (frameIdx, scratchCanvas) => {
      // Mirror frameToCanvas inline so we don't need to import internals.
      const w = W(), h = H();
      const data = tx.state.volumeTexture.image.data;
      const offset = frameIdx * w * h * 4;
      const unflipped = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        const srcRow = h - 1 - row;
        unflipped.set(data.subarray(offset + srcRow * w * 4, offset + (srcRow + 1) * w * 4), row * w * 4);
      }
      scratchCanvas.width = w;
      scratchCanvas.height = h;
      scratchCanvas.getContext('2d').putImageData(new ImageData(unflipped, w, h), 0, 0);

      const model = await detMod.loadCocoSsd();
      const dets = await model.detect(scratchCanvas);
      if (dets.length === 0) return [];

      return dets.map(d => ({
        bbox: d.bbox,
        score: d.score,
        class: d.class,
        mask: new Uint8Array(w * h), // empty — fine for this diagnostic
        maskW: w,
        maskH: h,
      }));
    };

    // Replace `runDetection` itself with a copy that doesn't call SAM at all.
    window.__runDiagDetection = async () => {
      console.log('[probe] starting diagnostic run');
      await detMod.loadCocoSsd();
      console.log('[probe] cocoSsd ready, no SAM (stubbed)');
      tx.state.detectionsPerFrame = [];
      const scratch = document.createElement('canvas');
      const t0 = performance.now();
      for (let i = 0; i < tx.state.numFrames; i++) {
        let preds = [];
        try { preds = await noopSegmentFrame(i, scratch); }
        catch (err) { console.log(`[probe] frame ${i} failed: ${err.message}`); }
        tx.state.detectionsPerFrame.push(preds);
      }
      const ms = performance.now() - t0;
      console.log(`[probe] detection finished in ${ms.toFixed(0)}ms`);
      tx.state.tracks = trMod.buildTracksFromDetections(tx.state.detectionsPerFrame);
      console.log(`[probe] tracks built: ${tx.state.tracks.length}`);
      for (const tr of tx.state.tracks) {
        console.log(`[probe]   - ${tr.class} (${tr.numFrames} frames, avg ${(tr.avgScore*100).toFixed(0)}%)`);
      }
      return {
        perFrameCounts: tx.state.detectionsPerFrame.map(d => d.length),
        classesSeen: [...new Set(tx.state.detectionsPerFrame.flat().map(d => d.class))],
        tracks: tx.state.tracks.map(t => ({ class: t.class, numFrames: t.numFrames, avgScore: t.avgScore })),
      };
    };
  });

  // Set frame settings and load the video
  await page.locator('#num-frames').fill(String(NUM_FRAMES));
  await page.locator('#max-dim').selectOption(String(MAX_DIM));
  console.log(`Loading ${VIDEO}`);
  console.log(`  numFrames=${NUM_FRAMES}, maxDim=${MAX_DIM}`);
  await page.locator('#file-input').setInputFiles(VIDEO);
  await page.locator('#detect-btn').waitFor({ state: 'attached' });
  // Wait for extraction
  await page.locator('#detect-btn').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => {
    const btn = document.getElementById('detect-btn');
    return btn && !btn.disabled;
  }, { timeout: 60_000 });
  console.log('  extraction done.');

  // Run the diagnostic detection (no SAM)
  const result = await page.evaluate(() => window.__runDiagDetection());

  console.log('\n=== Summary ===');
  console.log(`Per-frame detection counts: [${result.perFrameCounts.join(', ')}]`);
  console.log(`Total detections: ${result.perFrameCounts.reduce((a, b) => a + b, 0)}`);
  console.log(`Frames with ≥1 detection: ${result.perFrameCounts.filter(n => n > 0).length} / ${result.perFrameCounts.length}`);
  console.log(`Classes seen anywhere: ${result.classesSeen.length ? result.classesSeen.join(', ') : '(none)'}`);
  console.log(`Tracks (≥2 frames, IoU-matched): ${result.tracks.length}`);
  for (const t of result.tracks) {
    console.log(`  - ${t.class}: ${t.numFrames} frames, avg score ${(t.avgScore*100).toFixed(0)}%`);
  }

  await browser.close();
} finally {
  server.kill();
}
