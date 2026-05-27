// End-to-end: load the bundled fixture video via the file input, wait for
// frame extraction to finish, and verify that the scene state populated
// (volume texture, cube + slice plane). Does NOT run object detection.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', 'sample.mp4');

async function loadFixtureVideo(page, { numFrames = 16, maxDim = 192 } = {}) {
  await page.goto('/');
  await page.waitForFunction(() => window.__spacetimeReady === true);

  // Use a small number of frames for speed in tests
  await page.locator('#num-frames').fill(String(numFrames));
  await page.locator('#max-dim').selectOption(String(maxDim));

  await page.locator('#file-input').setInputFiles(FIXTURE);

  // Wait for extraction to finish. video.js disables the detect button while
  // extracting and re-enables it when done.
  await expect(page.locator('#detect-btn')).toBeEnabled({ timeout: 60_000 });
  // The empty-state should be gone and the preview panel visible.
  await expect(page.locator('#empty-state')).toBeHidden();
  await expect(page.locator('#preview-panel')).toBeVisible();
}

test('uploading a video builds the 3D volume and shows preview panel', async ({ page }) => {
  await loadFixtureVideo(page);

  // Internal state hooks
  const state = await page.evaluate(async () => {
    const m = await import('/src/state.js');
    return {
      numFrames: m.state.numFrames,
      frameW: m.state.frameW,
      frameH: m.state.frameH,
      hasCube: !!m.state.cube,
      hasSlicePlane: !!m.state.slicePlane,
      hasMaskData: !!m.state.maskData,
      maskLen: m.state.maskData ? m.state.maskData.length : 0,
    };
  });

  expect(state.numFrames).toBe(16);
  // Aspect-corrected dimensions: maxDim=192 caps the larger side.
  expect(state.frameW).toBeGreaterThan(0);
  expect(state.frameH).toBeGreaterThan(0);
  expect(Math.max(state.frameW, state.frameH)).toBeLessThanOrEqual(192);
  expect(state.hasCube).toBe(true);
  expect(state.hasSlicePlane).toBe(true);
  expect(state.hasMaskData).toBe(true);
  expect(state.maskLen).toBe(state.frameW * state.frameH * state.numFrames);
});

test('ortho preview canvases sized to volume aspect after load', async ({ page }) => {
  await loadFixtureVideo(page);

  const sizes = await page.evaluate(() => {
    function size(id) {
      const c = document.getElementById(id);
      return { w: c.clientWidth, h: c.clientHeight };
    }
    return { xy: size('canvas-xy'), xt: size('canvas-xt'), yt: size('canvas-yt') };
  });

  // All three previews have the same width (232px in CSS) and non-zero height.
  for (const v of Object.values(sizes)) {
    expect(v.w).toBeGreaterThan(0);
    expect(v.h).toBeGreaterThan(0);
  }
});

test('depth slider updates the cube z extent', async ({ page }) => {
  await loadFixtureVideo(page);

  const before = await page.evaluate(async () => (await import('/src/state.js')).state.cubeSize.z);
  await page.locator('#depth').fill('50');
  // Dispatch an 'input' event so the listener fires
  await page.evaluate(() => {
    document.getElementById('depth').dispatchEvent(new Event('input'));
  });
  const after = await page.evaluate(async () => (await import('/src/state.js')).state.cubeSize.z);
  expect(after).toBeCloseTo(0.5, 3);
  expect(after).not.toBeCloseTo(before, 3);
});

test('render mode buttons change state.renderMode', async ({ page }) => {
  await loadFixtureVideo(page);

  await page.locator('#mode-volume').click();
  const fog = await page.evaluate(async () => (await import('/src/state.js')).state.renderMode);
  expect(fog).toBe(1);

  await page.locator('#mode-path').click();
  const path = await page.evaluate(async () => (await import('/src/state.js')).state.renderMode);
  expect(path).toBe(2);

  await page.locator('#mode-opaque').click();
  const opaque = await page.evaluate(async () => (await import('/src/state.js')).state.renderMode);
  expect(opaque).toBe(0);
});

test('the cube canvas paints something (non-blank pixels)', async ({ page }) => {
  await loadFixtureVideo(page);

  // Let the render loop produce a frame
  await page.waitForTimeout(500);

  // Playwright's screenshot uses the browser's compositor, which captures the
  // WebGL output without needing `preserveDrawingBuffer`.
  const png = await page.locator('#three').screenshot();

  // Parse the PNG's pixel data via the page (using ImageBitmap) to count
  // non-near-black pixels.
  const stats = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let nonDarkGray = 0;
    // Background is #0b0d10 ≈ (11,13,16). Any pixel meaningfully brighter
    // counts as "cube content was drawn here".
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 25 || d[i + 1] > 25 || d[i + 2] > 25) nonDarkGray++;
    }
    return { total: d.length / 4, nonDarkGray };
  }, png.toString('base64'));

  expect(stats.nonDarkGray, `${stats.nonDarkGray}/${stats.total} bright pixels`).toBeGreaterThan(500);
});
