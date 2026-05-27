// Save side-by-side images for visual inspection of mask quality:
//   /tmp/mask-{idx}-rgb.png         the original frame
//   /tmp/mask-{idx}-overlay.png     frame with SAM mask in red, bbox in green
//   /tmp/mask-{idx}-bbox-only.png   frame with only the bbox (the v1 "mask")
// so the user can see if SAM is producing tight/loose/correct masks.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VIDEO = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(ROOT, 'business-man-in-suit-and-tie-plays-basketball-free-video.mp4');
const NUM_FRAMES = parseInt(process.argv[3] || '8', 10);
const MAX_DIM    = parseInt(process.argv[4] || '256', 10);

const PORT = 5197;
const server = spawn(process.execPath, [resolve(ROOT, 'scripts/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  let buf = '';
  server.stdout.on('data', d => { buf += d.toString(); if (buf.includes('Serving')) res(); });
  setTimeout(() => rej(new Error('server start timeout')), 8000);
});

try {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=metal','--ignore-gpu-blocklist'],
  });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', e => console.log('ERR', e.message));
  page.on('console', m => {
    const t = m.text();
    // Don't drown in expected canvas warnings
    if (t.startsWith('Canvas2D')) return;
    console.log(`  ${m.type()}: ${t.slice(0, 300)}`);
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__spacetimeReady);

  await page.locator('#num-frames').fill(String(NUM_FRAMES));
  await page.locator('#max-dim').selectOption(String(MAX_DIM));
  console.log(`Loading ${VIDEO}`);
  await page.locator('#file-input').setInputFiles(VIDEO);
  await page.waitForFunction(() => {
    const b = document.getElementById('detect-btn');
    return b && !b.disabled;
  }, { timeout: 120_000 });
  // Park a direct reference to state on window so the wait poll is sync.
  await page.evaluate(async () => {
    const m = await import('/src/state.js');
    window.__state = m.state;
  });

  const preDetectState = await page.evaluate(() => ({
    numFrames: window.__state.numFrames,
    frameW: window.__state.frameW,
    frameH: window.__state.frameH,
    hasVolume: !!window.__state.volumeTexture,
  }));
  console.log(`Extraction → ${JSON.stringify(preDetectState)}`);

  await page.locator('#detect-btn').click();
  console.log('Detect Objects clicked. Waiting for completion…');

  // Wait until detection finishes — every frame slot recorded.
  await page.waitForFunction(
    () => {
      const s = window.__state;
      if (!s) return false;
      const n = s.numFrames;
      return n > 0 && s.detectionsPerFrame.length >= n;
    },
    null,
    { timeout: 300_000, polling: 500 },
  );
  const postDetectState = await page.evaluate(() => ({
    perFrame: window.__state.detectionsPerFrame.map(d => d.length),
    tracks: window.__state.tracks.length,
  }));
  console.log(`Detection → ${JSON.stringify(postDetectState)}`);

  // Pull data for every detected frame and render comparison PNGs
  const dumps = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const W = state.frameW, H = state.frameH;
    const volumeData = state.volumeTexture.image.data;

    // Helper: build unflipped RGBA for a frame
    function frameRgba(f) {
      const out = new Uint8ClampedArray(W * H * 4);
      const off = f * W * H * 4;
      for (let py = 0; py < H; py++) {
        const srcRow = H - 1 - py; // un-flip
        out.set(volumeData.subarray(off + srcRow * W * 4, off + (srcRow + 1) * W * 4), py * W * 4);
      }
      return out;
    }

    // Pull each per-frame detection (the one with the highest score)
    const out = [];
    for (let f = 0; f < state.detectionsPerFrame.length; f++) {
      const dets = state.detectionsPerFrame[f];
      if (!dets || dets.length === 0) continue;
      // Top detection by score
      dets.sort((a, b) => b.score - a.score);
      const d = dets[0];
      out.push({
        frame: f,
        bbox: d.bbox,
        klass: d.class,
        score: d.score,
        rgba: Array.from(frameRgba(f)),
        mask: Array.from(d.mask),
        maskW: d.maskW,
        maskH: d.maskH,
        W, H,
      });
    }
    return out;
  });

  console.log(`Got ${dumps.length} frame dumps. Writing PNGs…`);

  // Encode each as a PNG. We do this in Node using a tiny zlib-based PNG
  // encoder (no extra deps). Simpler: dispatch back to the page to use
  // OffscreenCanvas → toBlob → arrayBuffer.
  for (let idx = 0; idx < dumps.length; idx++) {
    const d = dumps[idx];
    const buffers = await page.evaluate(async (d) => {
      const W = d.W, H = d.H;
      const rgba = new Uint8ClampedArray(d.rgba);
      const mask = new Uint8Array(d.mask);

      function canvasToBase64(cv) {
        return new Promise(r => cv.convertToBlob({ type: 'image/png' }).then(b => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result.split(',')[1]);
          fr.readAsDataURL(b);
        }));
      }

      // 1. original
      const cRgb = new OffscreenCanvas(W, H);
      cRgb.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);

      // 2. overlay: SAM mask in red, bbox in green
      const cOv = new OffscreenCanvas(W, H);
      const ctxOv = cOv.getContext('2d');
      ctxOv.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
      // mask might be at maskW×maskH — usually equals W×H, but handle scale
      const ov = ctxOv.getImageData(0, 0, W, H);
      const sx = d.maskW / W, sy = d.maskH / H;
      for (let py = 0; py < H; py++) {
        const my = Math.min(d.maskH - 1, Math.floor(py * sy));
        for (let px = 0; px < W; px++) {
          const mx = Math.min(d.maskW - 1, Math.floor(px * sx));
          const inside = mask[my * d.maskW + mx] > 0;
          if (inside) {
            const i = (py * W + px) * 4;
            ov.data[i]     = Math.min(255, ov.data[i]     * 0.4 + 255 * 0.6); // red
            ov.data[i + 1] = ov.data[i + 1] * 0.4;
            ov.data[i + 2] = ov.data[i + 2] * 0.4;
          }
        }
      }
      ctxOv.putImageData(ov, 0, 0);
      // Stroke bbox in lime
      ctxOv.strokeStyle = '#00ff66';
      ctxOv.lineWidth = 2;
      ctxOv.strokeRect(d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]);

      // 3. bbox-only — what v1 looked like
      const cBox = new OffscreenCanvas(W, H);
      const ctxBox = cBox.getContext('2d');
      ctxBox.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
      const bx = ctxBox.getImageData(0, 0, W, H);
      // dim everything outside the bbox
      const [bxx, byy, bww, bhh] = d.bbox;
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const inside = px >= bxx && px <= bxx + bww && py >= byy && py <= byy + bhh;
          if (!inside) {
            const i = (py * W + px) * 4;
            bx.data[i]     *= 0.2;
            bx.data[i + 1] *= 0.2;
            bx.data[i + 2] *= 0.2;
          }
        }
      }
      ctxBox.putImageData(bx, 0, 0);

      // 4. SAM-only — only show the SAM-masked region
      const cSam = new OffscreenCanvas(W, H);
      const ctxSam = cSam.getContext('2d');
      ctxSam.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
      const sm = ctxSam.getImageData(0, 0, W, H);
      for (let py = 0; py < H; py++) {
        const my = Math.min(d.maskH - 1, Math.floor(py * sy));
        for (let px = 0; px < W; px++) {
          const mx = Math.min(d.maskW - 1, Math.floor(px * sx));
          const inside = mask[my * d.maskW + mx] > 0;
          if (!inside) {
            const i = (py * W + px) * 4;
            sm.data[i]     *= 0.2;
            sm.data[i + 1] *= 0.2;
            sm.data[i + 2] *= 0.2;
          }
        }
      }
      ctxSam.putImageData(sm, 0, 0);

      return {
        rgb:    await canvasToBase64(cRgb),
        ov:     await canvasToBase64(cOv),
        boxOnly:await canvasToBase64(cBox),
        samOnly:await canvasToBase64(cSam),
      };
    }, d);

    const idxStr = String(d.frame).padStart(2, '0');
    for (const [suffix, b64] of Object.entries({
      'rgb': buffers.rgb,
      'overlay': buffers.ov,
      'bbox-only': buffers.boxOnly,
      'sam-only': buffers.samOnly,
    })) {
      writeFileSync(`/tmp/mask-${idxStr}-${suffix}.png`, Buffer.from(b64, 'base64'));
    }
    console.log(`  frame ${idxStr}: ${d.klass} @ ${(d.score*100).toFixed(0)}%, bbox ${d.bbox.map(n=>n.toFixed(0)).join(',')}`);
  }

  await browser.close();
  console.log(`\nWrote ${dumps.length * 4} PNGs to /tmp/mask-NN-*.png`);
} finally {
  server.kill();
}
