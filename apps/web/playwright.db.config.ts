import { defineConfig, devices } from '@playwright/test';

// Config secundaria para los e2e que SÍ necesitan Postgres (un webServer por
// config: la principal arranca en modo fixture sin base de datos). Se lanza
// con `pnpm test:e2e:db`, que exporta E2E_DATABASE_URL (login administrador
// del cluster local). El globalSetup recrea el esquema, aplica fixtures y crea
// un login sin BYPASSRLS con el que corre el servidor.

// Igual que la config principal: E2E_PORT permite ejecutar en paralelo con
// otros worktrees sin pisarse el puerto.
const PORT = Number(process.env.E2E_PORT ?? 4317);
const adminUrl = process.env.E2E_DATABASE_URL ?? '';

// Evidencia JUnit propia (fichero distinto del de la config principal) para que
// assert-junit-nonempty.py y assert-suite-coverage.py puedan comprobar que estas
// 18 specs se han ejecutado de verdad y no sólo recolectado.
const JUNIT_OUTPUT = process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME ?? '../../artifacts/e2e/junit-db.xml';

export const E2E_APP_LOGIN = 'e2e_housekeeper_web';
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
  reporter: [['list'], ['junit', { outputFile: JUNIT_OUTPUT }]],
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
    //
    // Ésta es, literalmente, la combinación que en producción sería letal: un
    // selector de cuentas de mentira sobre datos de verdad. Aquí es legítima
    // porque los datos son fixtures y porque exige declarar
    // HOUSEKEEPER_FIXTURE_LOGIN, que es lo que la vuelve imposible de alcanzar
    // por descuido: sin esa variable el selector no existe en el paquete, y con
    // ella el paquete se niega a arrancar en cualquier despliegue de Vercel
    // (deployment-config.js, 'fixture-bundle-with-database').
    command: `pnpm build && PORT=${PORT} ORIGIN=http://127.0.0.1:${PORT} node build`,
    env: {
      DATABASE_URL: appDatabaseUrl(),
      HOUSEKEEPER_FIXTURE_LOGIN: 'true',
      // Cinturón sobre los tirantes del job de CI: Playwright arranca el
      // webServer con `{...process.env, ...webServer.env}`, así que una
      // variable del entorno se colaría en el servidor bajo prueba. Esta
      // batería comprueba la forma de PRODUCCIÓN y no puede correr con la
      // bandera de datos sintéticos puesta: vacía es ausente por convención
      // de la casa (`present()` de deployment-config.js).
      ALLOW_SYNTHETIC_DATA_ONLY: '',
      // Con canal de avisos configurado. La batería de maqueta cubre el caso
      // contrario —sin claves no se ofrece un interruptor que no funcionaría—,
      // y sin esto NADIE probaba la rama con claves. Ese hueco costó caro: los
      // avisos se desplegaron a producción sin las variables y la pantalla
      // decía «esta instalación no manda avisos» sin que ninguna prueba se
      // enterase. Son claves de juguete: no se manda nada, solo se pinta.
      VAPID_PUBLIC_KEY: 'BJ6XG5oCLC2hmFRFtLbJPYCoRQXhFVFHfIvBrsYcKmYUXVSMxOZMhWJzGqvpTNSNvNsRWzKnFOTsJvBfIQfXKLA',
      VAPID_PRIVATE_KEY: 'kFzRQ5vHJmMwPnLxTbYcVdEfGhIjKlMnOpQrStUvWxY',
      VAPID_SUBJECT: 'https://ejemplo.invalid'
    },
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000
  }
});
