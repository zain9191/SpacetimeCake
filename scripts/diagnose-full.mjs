// Full-pipeline diagnostic: actually click "Detect Objects" in the running
// app, with the real COCO-SSD and real SAM. Reports per-frame outcomes,
// any errors that crash a frame, and the final tracks list.
//
// Usage:
//   node scripts/diagnose-full.mjs [video] [numFrames] [maxDim]
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
const NUM_FRAMES = parseInt(process.argv[3] || '16', 10);
const MAX_DIM    = parseInt(process.argv[4] || '256', 10);

if (!existsSync(VIDEO)) { console.error('No such video:', VIDEO); process.exit(1); }

const PORT = 5189;
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
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('console', m => {
    const t = m.text();
    // Show probe lines, warnings (e.g. "Frame N failed"), and errors
    if (t.startsWith('[probe]') || /^(error|warning)$/.test(m.type())) {
      console.log(`  ${m.type().padEnd(8)} ${t}`);
    }
  });
  page.on('pageerror', e => console.log('  pageerror', e.message));
  page.on('requestfailed', r => {
    if (r.failure()?.errorText !== 'net::ERR_ABORTED') {
      console.log(`  netfail  ${r.url().slice(0, 120)} → ${r.failure().errorText}`);
    }
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__spacetimeReady === true, { timeout: 15_000 });

  // Wrap COCO-SSD detect + the detection.js per-frame call to log everything
  await page.evaluate(() => {
    window.__frameCount = 0;
    window.__cocoFound = 0;
    window.__sumFails = 0;
    // Patch COCO-SSD to log
    (async () => {
      while (!window.cocoSsd) await new Promise(r => setTimeout(r, 50));
      const oload = window.cocoSsd.load.bind(window.cocoSsd);
      window.cocoSsd.load = async (...a) => {
        const m = await oload(...a);
        const odet = m.detect.bind(m);
        m.detect = async (input) => {
          const ds = await odet(input);
          if (ds.length) window.__cocoFound++;
          console.log(`[probe] frame ${window.__frameCount++} → cocoSsd: ${ds.length} det(s) [${ds.map(d => d.class+':'+d.score.toFixed(2)).join(',') || '(none)'}]`);
          return ds;
        };
        console.log('[probe] cocoSsd loaded');
        return m;
      };
    })();
  });

  await page.locator('#num-frames').fill(String(NUM_FRAMES));
  await page.locator('#max-dim').selectOption(String(MAX_DIM));
  console.log(`Loading video: ${VIDEO}`);
  console.log(`Settings: numFrames=${NUM_FRAMES}, maxDim=${MAX_DIM}`);
  await page.locator('#file-input').setInputFiles(VIDEO);
  await page.waitForFunction(() => {
    const b = document.getElementById('detect-btn');
    return b && !b.disabled;
  }, { timeout: 60_000 });
  console.log('Extraction done. Clicking Detect Objects…');

  // Click and wait until either the progress bar disappears or we time out.
  await page.locator('#detect-btn').click();
  const start = Date.now();
  while (Date.now() - start < 300_000) {
    const progressClosed = await page.evaluate(() =>
      !document.getElementById('det-progress').classList.contains('active')
    );
    if (progressClosed) break;
    await page.waitForTimeout(1000);
  }

  // Read the final state
  const result = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    return {
      numFrames: state.numFrames,
      perFrameDets: state.detectionsPerFrame.map(d => d.length),
      tracks: state.tracks.map(t => ({ class: t.class, numFrames: t.numFrames, avgScore: t.avgScore })),
      progressText: document.getElementById('det-progress-text').textContent,
    };
  });
  console.log('\n=== Final ===');
  console.log('Progress text:', result.progressText);
  console.log(`Per-frame detection counts: [${result.perFrameDets.join(', ')}]`);
  console.log(`Frames with ≥1 detection: ${result.perFrameDets.filter(n => n > 0).length} / ${result.numFrames}`);
  console.log(`Tracks built: ${result.tracks.length}`);
  for (const t of result.tracks) {
    console.log(`  - ${t.class} (${t.numFrames} frames, avg ${(t.avgScore * 100).toFixed(0)}%)`);
  }

  await browser.close();
} finally {
  server.kill();
}
