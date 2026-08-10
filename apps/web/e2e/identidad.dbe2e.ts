import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Con Postgres detrás. Ojo: esta batería corre sin base de datos de IDENTIDAD,
// así que quien entra sigue siendo una cuenta sintética y su hogar es el de la
// fixture («Casa Roble»); lo que sí sale de la base de datos es el contenido.
// Que el nombre lo ponga `app.households` en una instalación real se comprueba
// en tests/app-user.integration.test.ts, donde hay identidad y dos hogares.

test('la cabecera y la pestaña llevan el nombre del hogar en cada sección', async ({ page }) => {
  await loginAs(page, 'admin');
  await expect(page).toHaveTitle('Hoy · Casa Roble');
  await expect(page.locator('.sidebar .brand')).toContainText('Casa Roble');

  await page.goto(`/h/${HOUSEHOLD}/routines`);
  await expect(page).toHaveTitle('Rutinas · Casa Roble');
  await expect(page.locator('body')).not.toContainText('Casa Clara');
});

test('una nota de la guía se titula con su propio nombre y el del hogar', async ({ page }) => {
  await loginAs(page, 'admin');
  // Nota sembrada por db-global-setup.ts, con su título en la base de datos.
  await page.goto(`/h/${HOUSEHOLD}/wiki/lavadora`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lavadora · programa corto');
  // El título de la nota gana a la etiqueta de la sección («Guía de la casa»)
  // sin que la página declare ningún <title> propio.
  await expect(page).toHaveTitle('Lavadora · programa corto · Casa Roble');
});
