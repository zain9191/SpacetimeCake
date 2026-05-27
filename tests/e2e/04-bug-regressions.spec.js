// Regression tests for bugs that the verification agents surfaced. Each test
// pins one specific failure mode so it can't silently come back.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', 'sample.mp4');

async function loadFixture(page, { numFrames = 8, maxDim = 128 } = {}) {
  await page.goto('/');
  await page.waitForFunction(() => window.__spacetimeReady === true);
  await page.locator('#num-frames').fill(String(numFrames));
  await page.locator('#max-dim').selectOption(String(maxDim));
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#detect-btn')).toBeEnabled({ timeout: 60_000 });
}

test('cube material picks up render mode chosen BEFORE the video loads', async ({ page }) => {
  // Original bug: opening "Fog" before any video, then loading one, left the
  // cube in opaque-mode clipping config — the user had to click Fog twice.
  await page.goto('/');
  await page.waitForFunction(() => window.__spacetimeReady === true);

  await page.locator('#mode-volume').click();
  await page.locator('#num-frames').fill('8');
  await page.locator('#max-dim').selectOption('128');
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#detect-btn')).toBeEnabled({ timeout: 60_000 });

  const materialState = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    return {
      mode: state.renderMode,
      clippingPlanes: state.cube.material.clippingPlanes.length,
      transparent: state.cube.material.transparent,
      depthWrite: state.cube.material.depthWrite,
    };
  });
  expect(materialState.mode).toBe(1);
  expect(materialState.clippingPlanes).toBe(0);
  expect(materialState.transparent).toBe(true);
  expect(materialState.depthWrite).toBe(false);
});

test('reset button moves the selected target back to the origin', async ({ page }) => {
  await loadFixture(page);

  // Move the slice plane somewhere
  await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    state.slicePlane.position.set(0.3, -0.2, 0.1);
    state.slicePlane.rotation.set(0.5, 0.5, 0.5);
  });

  await page.locator('#reset-slice').click();

  const sliceState = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    return {
      pos: [state.slicePlane.position.x, state.slicePlane.position.y, state.slicePlane.position.z],
      rot: [state.slicePlane.rotation.x, state.slicePlane.rotation.y, state.slicePlane.rotation.z],
    };
  });
  expect(sliceState.pos).toEqual([0, 0, 0]);
  expect(sliceState.rot).toEqual([0, 0, 0]);

  // Now switch selection to cube and verify reset targets the cube
  await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    state.cube.position.set(0.5, 0.5, 0.5);
    state.cube.rotation.set(0.3, 0.3, 0.3);
  });
  await page.locator('#select-cube').click();
  await page.locator('#reset-slice').click();
  const cubeState = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    return [
      state.cube.position.x, state.cube.position.y, state.cube.position.z,
      state.cube.rotation.x, state.cube.rotation.y, state.cube.rotation.z,
    ];
  });
  expect(cubeState).toEqual([0, 0, 0, 0, 0, 0]);
});

test('opacity slider drives state.volumeOpacity', async ({ page }) => {
  await loadFixture(page);
  await page.locator('#mode-volume').click();
  await page.locator('#opacity').fill('72');
  await page.locator('#opacity').dispatchEvent('input');
  const op = await page.evaluate(async () => (await import('/src/state.js')).state.volumeOpacity);
  expect(op).toBeCloseTo(0.72, 3);
  await expect(page.locator('#opacity-value')).toHaveText('72');
});

test('path softness slider drives state.pathSoftness', async ({ page }) => {
  await loadFixture(page);
  await page.locator('#mode-path').click();
  await page.locator('#path-softness').fill('85');
  await page.locator('#path-softness').dispatchEvent('input');
  const softness = await page.evaluate(async () => (await import('/src/state.js')).state.pathSoftness);
  expect(softness).toBeCloseTo(0.85, 3);
  await expect(page.locator('#path-softness-value')).toHaveText('85');
});

test('selection toggle binds transformControls.object to the right mesh', async ({ page }) => {
  await loadFixture(page);

  await page.locator('#select-cube').click();
  const isCube = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const { transformControls } = await import('/src/interactions.js');
    return transformControls.object === state.cube;
  });
  expect(isCube).toBe(true);

  await page.locator('#select-slice').click();
  const isSlice = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const { transformControls } = await import('/src/interactions.js');
    return transformControls.object === state.slicePlane;
  });
  expect(isSlice).toBe(true);
});

test('keyboard shortcuts still work after focusing a slider', async ({ page }) => {
  // Regression for the "shortcuts die after any slider interaction" bug.
  await loadFixture(page);
  await page.locator('#opacity').focus();  // slider keeps focus
  await page.keyboard.press('2');
  await expect(page.locator('#select-cube')).toHaveClass(/active/);
});

test('applyMaskUniforms propagates uMaskEnabled to all five materials', async ({ page }) => {
  await loadFixture(page);

  // Inject a fake track and select it
  await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const { renderTracksList } = await import('/src/ui.js');
    const W = state.frameW, H = state.frameH;
    const mask = new Uint8Array(W * H).fill(255);
    state.tracks = [{
      class: 'person', classId: 0,
      detectionsByFrame: Object.fromEntries(
        Array.from({ length: state.numFrames }, (_, f) => [f, {
          bbox: [0, 0, W, H], class: 'person', score: 0.9,
          mask: mask.slice(), maskW: W, maskH: H,
        }])
      ),
      firstFrame: 0, lastFrame: state.numFrames - 1, numFrames: state.numFrames, avgScore: 0.9,
    }];
    renderTracksList();
  });
  await page.locator('.track-item').click();
  await expect(page.locator('#clear-track-btn')).toBeVisible();
  // Wait for mask build
  await page.waitForFunction(async () => {
    const { state } = await import('/src/state.js');
    return !state.isBuildingMask;
  });

  const masksOn = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const { orthoXY, orthoXT, orthoYT } = await import('/src/orthoPreviews.js');
    return {
      cube: state.cube.material.uniforms.uMaskEnabled.value,
      slice: state.slicePlane.material.uniforms.uMaskEnabled.value,
      xy: orthoXY.material.uniforms.uMaskEnabled.value,
      xt: orthoXT.material.uniforms.uMaskEnabled.value,
      yt: orthoYT.material.uniforms.uMaskEnabled.value,
    };
  });
  expect(masksOn).toEqual({ cube: true, slice: true, xy: true, xt: true, yt: true });

  // Clearing turns it off everywhere
  await page.locator('#clear-track-btn').click();
  const masksOff = await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const { orthoXY, orthoXT, orthoYT } = await import('/src/orthoPreviews.js');
    return {
      cube: state.cube.material.uniforms.uMaskEnabled.value,
      slice: state.slicePlane.material.uniforms.uMaskEnabled.value,
      xy: orthoXY.material.uniforms.uMaskEnabled.value,
      xt: orthoXT.material.uniforms.uMaskEnabled.value,
      yt: orthoYT.material.uniforms.uMaskEnabled.value,
    };
  });
  expect(masksOff).toEqual({ cube: false, slice: false, xy: false, xt: false, yt: false });
});

test('buildSceneFromVolume hides the "Show everything" button', async ({ page }) => {
  await loadFixture(page);
  // Pretend a track was active before, then re-run the scene builder
  await page.evaluate(async () => {
    document.getElementById('clear-track-btn').style.display = 'block';
  });
  await page.evaluate(async () => {
    const { state } = await import('/src/state.js');
    const { buildSceneFromVolume } = await import('/src/cube.js');
    buildSceneFromVolume(state.volumeTexture, state.frameW, state.frameH, state.numFrames);
  });
  await expect(page.locator('#clear-track-btn')).toBeHidden();
});
