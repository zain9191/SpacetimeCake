import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 5191;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => { let buf=''; server.stdout.on('data', d=>{buf+=d.toString(); if(buf.includes('Serving')) res();}); setTimeout(rej, 6000); });

try {
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=metal','--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => console.log(m.type(), m.text()));
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__spacetimeReady);

  const result = await page.evaluate(async () => {
    const d = await import('/src/detection.js');
    const { samModel, samProcessor, RawImage } = await d.loadSam();

    // Create a tiny 32x32 test image
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'red'; ctx.fillRect(10, 10, 40, 40);
    const img = await RawImage.fromCanvas(c);

    // Try processor with box prompt
    const inputs = await samProcessor(img, { input_boxes: [[[10, 10, 50, 50]]] });
    const inputKeys = Object.keys(inputs);
    const inputShapes = {};
    for (const k of inputKeys) {
      const v = inputs[k];
      if (v && v.dims) inputShapes[k] = { dims: Array.from(v.dims), dtype: v.type };
      else inputShapes[k] = Array.isArray(v) ? `array(${v.length})` : typeof v;
    }
    return { inputKeys, inputShapes };
  });

  console.log('\nProcessor input keys:', result.inputKeys);
  console.log('Shapes:', JSON.stringify(result.inputShapes, null, 2));

  await browser.close();
} finally { server.kill(); }
