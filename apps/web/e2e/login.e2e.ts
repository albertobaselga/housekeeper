import { expect, test } from '@playwright/test';

// La pantalla de acceso, servida por el build de producción y sin base de datos
// de identidad. Aquí se comprueba lo que debe ser cierto en TODOS los entornos:
// que nadie puede darse de alta solo, y que el selector sintético no finge ser
// una entrada de verdad.

test('sin base de datos de identidad la entrada es el selector sintético, no un formulario de contraseña', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Entra con una perspectiva' })).toBeVisible();
  await expect(page.locator('input[name="password"]')).toHaveCount(0);
  await expect(page.getByText('Demostración sin contraseña')).toBeVisible();
});

test('el alta pública no existe: POST /api/auth/sign-up/email no crea cuentas', async ({ request }) => {
  const response = await request.post('/api/auth/sign-up/email', {
    data: { name: 'Intruso', email: 'intruso@ejemplo.test', password: 'una-contrasena-larguisima-2026' },
    failOnStatusCode: false
  });
  // Sin instalación de identidad el hook responde 404 (no hay ninguna ruta
  // /api/auth montada); con instalación real responde 400 por disableSignUp.
  // Lo que nunca puede ocurrir es un 200.
  expect([400, 404]).toContain(response.status());
});

test('la acción de contraseña no existe mientras no haya identidad real', async ({ page }) => {
  await page.goto('/login');
  // El envío sale del propio documento para que lleve `Origin` y no lo pare
  // antes la protección CSRF de SvelteKit: lo que se quiere comprobar es que la
  // acción no existe, no que el navegador la envía mal.
  const status = await page.evaluate(async () => {
    const body = new URLSearchParams({ username: 'alberto', password: 'una-contrasena-larguisima-2026' });
    const response = await fetch('/login?/password', { method: 'POST', body });
    return response.status;
  });
  expect(status).toBe(404);
});
