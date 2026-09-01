import { defineConfig, devices } from '@playwright/test';

// Sobrescribible para ejecuciones paralelas (worktrees/CI local) sin chocar
// con otro servidor reutilizado en el puerto por defecto.
const PORT = Number(process.env.E2E_PORT ?? 4317);

// Evidencia JUnit (assert-junit-nonempty.py). Cada invocación puede darle un
// nombre propio (test:a11y lo hace) para no pisar el junit.xml de la e2e.
const JUNIT_OUTPUT = process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME ?? '../../artifacts/e2e/junit.xml';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // JUnit siempre (evidencia para assert-junit-nonempty.py) sin tocar la salida normal.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: JUNIT_OUTPUT }]]
    : [['list'], ['junit', { outputFile: JUNIT_OUTPUT }]],
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
    // `vite build` deja el selector de cuentas sintéticas FUERA del paquete
    // salvo que se pida explícitamente. Estas suites entran por ese selector,
    // así que lo piden. Es la variable que ninguna build de producción declara.
    env: { HOUSEKEEPER_FIXTURE_LOGIN: 'true' },
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000
  }
});
