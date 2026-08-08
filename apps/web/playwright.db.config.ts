import { defineConfig, devices } from '@playwright/test';

// Config secundaria para los e2e que SÍ necesitan Postgres (un webServer por
// config: la principal arranca en modo fixture sin base de datos). Se lanza
// con `pnpm test:e2e:db`, que exporta E2E_DATABASE_URL (login administrador
// del cluster local). El globalSetup recrea el esquema, aplica fixtures y crea
// un login sin BYPASSRLS con el que corre el servidor.

// Sobrescribible para ejecuciones paralelas (worktrees/CI local) sin chocar
// con otro servidor reutilizado en el puerto por defecto.
const PORT = Number(process.env.E2E_PORT ?? 4317);
const adminUrl = process.env.E2E_DATABASE_URL ?? '';

export const E2E_APP_LOGIN = 'e2e_casa_clara_web';
export const E2E_APP_PASSWORD = 'e2e-only';

function appDatabaseUrl(): string {
  if (!adminUrl) return '';
  const url = new URL(adminUrl);
  url.username = E2E_APP_LOGIN;
  url.password = E2E_APP_PASSWORD;
  return url.toString();
}

export default defineConfig({
  testDir: './e2e',
  // Los flujos serializados escriben sobre la MISMA base de datos: un único
  // worker y sin paralelismo para que ningún spec pise el estado de otro.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  globalSetup: './e2e/db-global-setup',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'e2e-db',
      testMatch: /.*\.dbe2e\.ts/,
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    // Build de producción con adapter-node y DATABASE_URL: login por selector
    // demo (sin DATABASE_AUTH_URL) pero con datos reales bajo RLS.
    command: `pnpm build && PORT=${PORT} ORIGIN=http://127.0.0.1:${PORT} node build`,
    env: { DATABASE_URL: appDatabaseUrl() },
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000
  }
});
