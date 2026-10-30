import {defineConfig} from '@playwright/test';

// Single source of truth for the e2e port (5192); E2E_PORT overrides it and is
// handed to scripts/serve-e2e.sh via webServer.env.
const PORT = Number(process.env.E2E_PORT || 5192);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bash scripts/serve-e2e.sh',
    url: `http://127.0.0.1:${PORT}/healthz/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {...process.env, E2E_PORT: String(PORT)},
  },
  projects: [
    {
      name: 'iphone',
      use: {
        browserName: 'chromium',
        viewport: {width: 390, height: 844},
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'se',
      use: {
        browserName: 'chromium',
        viewport: {width: 375, height: 667},
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
