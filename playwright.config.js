// Playwright config. Spins up our tiny static server, drives Chromium, and
// makes the bundled test video available to tests as ./tests/fixtures/sample.mp4.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: 0,
  // 4 parallel WebGL contexts saturate the headless GPU on most laptops,
  // causing context-teardown timeouts. Two workers is a stable compromise.
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5179',
    headless: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      // WebGL works in headless Chromium with these flags.
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-angle=metal',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: 'PORT=5179 node scripts/serve.mjs',
    url: 'http://localhost:5179/',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
