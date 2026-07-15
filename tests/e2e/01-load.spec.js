// Smoke test: the page loads, the bootstrap completes, and the main panels
// are visible with no JS errors. Doesn't touch any models.
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
  await expect(page.locator('#workspace-controls')).toBeVisible({ timeout: 60_000 });
}

test('page loads with all key UI elements and no JS errors', async ({ page }) => {
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/');

  // App finishes bootstrapping
  await page.waitForFunction(() => window.__spacetimeReady === true, { timeout: 15_000 });

  // Title check
  await expect(page).toHaveTitle(/Spacetime Cake/);

  // Both panels render
  await expect(page.locator('#panel')).toBeVisible();
  await expect(page.locator('#three')).toBeVisible();
  await expect(page.locator('#empty-state')).toBeVisible();

  // Import is the only action presented before a video is loaded.
  await expect(page.locator('#file-btn')).toBeVisible();
  await expect(page.locator('#sample-btn')).toBeVisible();
  await expect(page.locator('#workspace-controls')).toBeHidden();
  await expect(page.locator('#detect-btn')).toBeDisabled();

  // No JS errors
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

test('mode buttons toggle their active state', async ({ page }) => {
  await loadFixture(page);

  const opaque = page.locator('#mode-opaque');
  const fog    = page.locator('#mode-volume');
  const path   = page.locator('#mode-path');

  await expect(opaque).toHaveClass(/active/);
  await fog.click();
  await expect(fog).toHaveClass(/active/);
  await expect(opaque).not.toHaveClass(/active/);

  // Density row visible for fog, hidden for path
  await expect(page.locator('#opacity-row')).toBeVisible();
  await expect(page.locator('#path-softness-row')).toBeHidden();

  await path.click();
  await expect(page.locator('#opacity-row')).toBeHidden();
  await expect(page.locator('#path-softness-row')).toBeVisible();

  await opaque.click();
  await expect(page.locator('#opacity-row')).toBeHidden();
  await expect(page.locator('#path-softness-row')).toBeHidden();
});

test('keyboard shortcuts toggle selection and tool', async ({ page }) => {
  await loadFixture(page);

  // Default: slice selected, translate active
  await expect(page.locator('#select-slice')).toHaveClass(/active/);
  await expect(page.locator('#tool-translate')).toHaveClass(/active/);

  // Press "2" → select cube
  await page.keyboard.press('2');
  await expect(page.locator('#select-cube')).toHaveClass(/active/);
  await expect(page.locator('#select-slice')).not.toHaveClass(/active/);

  // Press "R" → rotate tool
  await page.keyboard.press('r');
  await expect(page.locator('#tool-rotate')).toHaveClass(/active/);
  await expect(page.locator('#tool-translate')).not.toHaveClass(/active/);

  // Press "1" → back to slice
  await page.keyboard.press('1');
  await expect(page.locator('#select-slice')).toHaveClass(/active/);
});
