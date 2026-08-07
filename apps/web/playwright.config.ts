import { defineConfig, devices } from '@playwright/test';

const PORT = 4317;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'e2e',
      testMatch: /.*\.e2e\.ts/,
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'a11y',
      testMatch: /.*\.a11y\.ts/,
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    // Build de producción con adapter-node: el service worker y el bundle real,
    // no el dev server. Sin DATABASE_URL la web queda en modo demo fixture.
    command: `pnpm build && PORT=${PORT} ORIGIN=http://127.0.0.1:${PORT} node build`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000
  }
});
