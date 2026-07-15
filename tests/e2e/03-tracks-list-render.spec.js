// Tests the tracks-list rendering & track-select pipeline without actually
// running COCO-SSD or SAM (those download ~50 MB and are slow in CI).
// We populate state.tracks with a synthetic track that has a hand-rolled
// mask, click it, and verify that the mask volume gets filled correctly.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', 'sample.mp4');

async function loadFixture(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__spacetimeReady === true);
  await page.locator('#import-options summary').click();
  await page.locator('#num-frames').fill('8');
  await page.locator('#max-dim').selectOption('128');
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#detect-btn')).toBeEnabled({ timeout: 60_000 });
}

test('renderTracksList: shows "No objects detected yet" when empty', async ({ page }) => {
  await loadFixture(page);
  // After a fresh load, the tracks list should show the empty-state hint.
  const text = await page.locator('#tracks-list').innerText();
  expect(text.toLowerCase()).toContain('no objects detected');
});

test('synthetic track selection populates the 3D mask', async ({ page }) => {
  await loadFixture(page);

  // Stuff a fake track into state and re-render the list.
  await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const { renderTracksList } = await import('/src/ui.js');
    const W = state.frameW, H = state.frameH;

    // Per-frame "mask": a centered square of W/2 × H/2 pixels.
    function squareMask() {
      const m = new Uint8Array(W * H);
      const x0 = Math.floor(W * 0.25);
      const x1 = Math.floor(W * 0.75);
      const y0 = Math.floor(H * 0.25);
      const y1 = Math.floor(H * 0.75);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          m[y * W + x] = 255;
        }
      }
      return m;
    }

    const detectionsByFrame = {};
    for (let f = 0; f < state.numFrames; f++) {
      detectionsByFrame[f] = {
        bbox: [W * 0.25, H * 0.25, W * 0.5, H * 0.5],
        class: 'person', classId: 0, score: 0.9,
        mask: squareMask(), maskW: W, maskH: H,
      };
    }
    state.tracks = [{
      class: 'person', classId: 0,
      detectionsByFrame,
      firstFrame: 0, lastFrame: state.numFrames - 1,
      numFrames: state.numFrames, avgScore: 0.9,
    }];
    renderTracksList();
  });

  // The track item should be there now
  await expect(page.locator('.track-item')).toHaveCount(1);
  await expect(page.locator('.track-item .track-class')).toHaveText('person');

  // Click the track and wait for the mask build to finish.
  await page.locator('.track-item').click();
  await expect(page.locator('#clear-track-btn')).toBeVisible();

  // The mask should have non-zero voxels covering ~25% of the volume.
  const maskStats = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    let on = 0;
    for (let i = 0; i < state.maskData.length; i++) {
      if (state.maskData[i]) on++;
    }
    return { on, total: state.maskData.length, frameW: state.frameW, frameH: state.frameH };
  });

  // The centered 50%-side square covers 25% of each frame.
  const ratio = maskStats.on / maskStats.total;
  expect(ratio).toBeGreaterThan(0.15);
  expect(ratio).toBeLessThan(0.40);

  // "Clear" goes back to nothing-selected
  await page.locator('#clear-track-btn').click();
  await expect(page.locator('#clear-track-btn')).toBeHidden();
  const activeIdx = await page.evaluate(async () => (await import('/src/state.js')).state.activeTrackIdx);
  expect(activeIdx).toBe(-1);
});
