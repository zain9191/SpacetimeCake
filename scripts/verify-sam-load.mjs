// Quick smoke check: can we actually load the SAM segmenter in the browser
// without "Failed to resolve module specifier" or other ESM errors?
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5187;

const server = spawn(process.execPath, [resolve(ROOT, 'scripts/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolveReady, rejectReady) => {
  let buf = '';
  server.stdout.on('data', d => { buf += d.toString(); if (buf.includes('Serving')) resolveReady(); });
  setTimeout(() => rejectReady(new Error('server start timeout')), 8000);
});

try {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__spacetimeReady === true, { timeout: 15_000 });

  console.log('Page loaded. Trying loadSam()…');
  const t0 = Date.now();
  const result = await page.evaluate(async () => {
    try {
      const d = await import('/src/detection.js');
      const r = await d.loadSam();
      return {
        ok: true,
        hasSamModel: typeof r.samModel === 'function' || typeof r.samModel === 'object',
        hasProcessor: typeof r.samProcessor === 'function' || typeof r.samProcessor === 'object',
        hasRawImage: typeof r.RawImage === 'function' || typeof r.RawImage === 'object',
        backend: d.detectionBackend ? d.detectionBackend() : '?',
      };
    } catch (err) {
      return { ok: false, error: err.message, stack: err.stack };
    }
  });
  const took = Date.now() - t0;
  console.log(`loadSam() returned in ${took}ms:`, JSON.stringify(result, null, 2));

  if (errors.length) {
    console.log('Errors during load:');
    for (const e of errors) console.log('  ', e);
  } else {
    console.log('No console errors.');
  }

  await browser.close();
  process.exit(result.ok && errors.length === 0 ? 0 : 1);
} finally {
  server.kill();
}
