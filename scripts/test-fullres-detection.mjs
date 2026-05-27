// Run COCO-SSD directly on the original-resolution video frame to see if
// it detects more objects than our downsized 256-px input.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VIDEO = resolve(ROOT, 'business-man-in-suit-and-tie-plays-basketball-free-video.mp4');

const PORT = 5202;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => { let buf = ''; server.stdout.on('data', d => { buf += d.toString(); if (buf.includes('Serving')) res(); }); setTimeout(rej, 6000); });

try {
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=metal','--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__spacetimeReady);

  const result = await page.evaluate(async (videoPath) => {
    // Wait for cocoSsd global
    while (!window.cocoSsd) await new Promise(r => setTimeout(r, 50));
    const model = await window.cocoSsd.load({ base: 'mobilenet_v2' });

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.src = videoPath;
    await new Promise(r => video.onloadedmetadata = r);
    try { await video.play(); video.pause(); } catch (e) {}
    const W = video.videoWidth, H = video.videoHeight;

    // Seek to ~1 second in (player shooting)
    video.currentTime = 1.5;
    await new Promise(r => video.onseeked = r);
    await new Promise(r => requestAnimationFrame(r));

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(video, 0, 0, W, H);

    const all = [];
    // Run at different scales
    for (const target of [W, 640, 384, 256]) {
      const scale = target / W;
      const w = Math.round(W * scale);
      const h = Math.round(H * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(canvas, 0, 0, w, h);
      const dets = await model.detect(c, 100, 0.03);
      all.push({
        resolution: `${w}×${h}`,
        count: dets.length,
        classes: dets.map(d => `${d.class}:${d.score.toFixed(2)}`),
      });
    }
    return all;
  }, `/business-man-in-suit-and-tie-plays-basketball-free-video.mp4`);

  console.log('\n=== Detection at different input sizes (threshold 0.03, mobilenet_v2 base) ===');
  for (const r of result) {
    console.log(`\n${r.resolution} → ${r.count} det(s)`);
    for (const c of r.classes) console.log(`  ${c}`);
  }

  await browser.close();
} finally { server.kill(); }
