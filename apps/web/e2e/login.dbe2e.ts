import { expect, test } from '@playwright/test';

// Misma comprobación que login.e2e.ts pero con Postgres detrás: el alta pública
// tampoco existe cuando la aplicación sí tiene base de datos de aplicación.
// Es la regresión del agujero descrito en docs/despliegue/opciones-de-acceso.md §1.5.

test('con base de datos, el alta pública sigue cerrada', async ({ request }) => {
  const response = await request.post('/api/auth/sign-up/email', {
    data: { name: 'Intruso', email: 'intruso@ejemplo.test', password: 'una-contrasena-larguisima-2026' },
    failOnStatusCode: false
  });
  expect([400, 404]).toContain(response.status());
});
