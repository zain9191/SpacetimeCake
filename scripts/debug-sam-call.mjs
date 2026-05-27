// Call SAM end-to-end with different prompt formats to find what works.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 5193;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => { let buf=''; server.stdout.on('data', d=>{buf+=d.toString(); if(buf.includes('Serving')) res();}); setTimeout(rej, 6000); });

try {
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=metal','--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('[t]')) console.log(m.type(), m.text()); });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__spacetimeReady);

  const result = await page.evaluate(async () => {
    const d = await import('/src/detection.js');
    const { samModel, samProcessor, RawImage } = await d.loadSam();

    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'red'; ctx.fillRect(50, 50, 150, 150);
    const img = await RawImage.fromCanvas(c);

    const attempts = [];

    // Attempt A: input_boxes only (current code)
    try {
      const inputs = await samProcessor(img, { input_boxes: [[[50, 50, 200, 200]]] });
      const outputs = await samModel(inputs);
      attempts.push({ name: 'input_boxes (object)', ok: true, predMasksDims: outputs.pred_masks?.dims });
    } catch (err) { attempts.push({ name: 'input_boxes (object)', ok: false, err: err.message }); }

    // Attempt B: input_boxes positional (3rd arg)
    try {
      const inputs = await samProcessor(img, null, [[[50, 50, 200, 200]]]);
      const outputs = await samModel(inputs);
      attempts.push({ name: 'input_boxes (positional)', ok: true, predMasksDims: outputs.pred_masks?.dims });
    } catch (err) { attempts.push({ name: 'input_boxes (positional)', ok: false, err: err.message }); }

    // Attempt C: input_points object
    try {
      const inputs = await samProcessor(img, { input_points: [[[[125, 125]]]] });
      const outputs = await samModel(inputs);
      attempts.push({ name: 'input_points (object)', ok: true, predMasksDims: outputs.pred_masks?.dims });
    } catch (err) { attempts.push({ name: 'input_points (object)', ok: false, err: err.message }); }

    // Attempt D: input_points positional (2nd arg)
    try {
      const inputs = await samProcessor(img, [[[125, 125]]]);
      const outputs = await samModel(inputs);
      attempts.push({ name: 'input_points (positional)', ok: true, predMasksDims: outputs.pred_masks?.dims });
    } catch (err) { attempts.push({ name: 'input_points (positional)', ok: false, err: err.message }); }

    // Attempt E: combo — both box AND a point inside it
    try {
      const inputs = await samProcessor(img, { input_points: [[[[125, 125]]]], input_boxes: [[[50, 50, 200, 200]]] });
      const outputs = await samModel(inputs);
      attempts.push({ name: 'input_points + input_boxes', ok: true, predMasksDims: outputs.pred_masks?.dims });
    } catch (err) { attempts.push({ name: 'input_points + input_boxes', ok: false, err: err.message }); }

    return attempts;
  });

  console.log('\n=== Attempts ===');
  for (const a of result) {
    console.log(`${a.ok ? '✓' : '✗'} ${a.name}`);
    if (a.ok) console.log(`   pred_masks.dims = [${a.predMasksDims}]`);
    if (a.err) console.log(`   ERROR: ${a.err}`);
  }

  await browser.close();
} finally { server.kill(); }
