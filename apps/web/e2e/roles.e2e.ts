import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test('sin sesión, una ruta profunda redirige a login conservando el destino', async ({ page }) => {
  await page.goto(`/h/${HOUSEHOLD}/wiki`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test('la administradora entra y ve Hoy con su progreso', async ({ page }) => {
  await loginAs(page, 'admin');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Alberto');
});

test('el visor no puede abrir el expediente laboral por URL directa', async ({ page }) => {
  await loginAs(page, 'viewer');
  const response = await page.goto(`/h/${HOUSEHOLD}/employment`);
  expect(response?.status()).toBe(403);
  await expect(page.locator('body')).toContainText('no está incluida en tu acceso');
});

test('la persona de apoyo tampoco accede a datos laborales', async ({ page }) => {
  await loginAs(page, 'helper');
  const response = await page.goto(`/h/${HOUSEHOLD}/employment`);
  expect(response?.status()).toBe(403);
});

test('una ruta hija no declarada falla cerrada con 404', async ({ page }) => {
  await loginAs(page, 'admin');
  const response = await page.goto(`/h/${HOUSEHOLD}/today/privado`);
  expect(response?.status()).toBe(404);
});

test('la empleada ve su expediente pero no la configuración de accesos', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/employment`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const denied = await page.goto(`/h/${HOUSEHOLD}/settings`);
  expect(denied?.status()).toBe(403);
});

test('leer las condiciones y pactarlas piden permisos distintos', async ({ page }) => {
  await loginAs(page, 'employee');
  // Sus condiciones son suyas: puede leerlas.
  const own = await page.goto(`/h/${HOUSEHOLD}/employment/condiciones`);
  expect(own?.status()).toBe(200);
  // Pactarlas es escribir el acuerdo, y eso no es de ella.
  const denied = await page.goto(`/h/${HOUSEHOLD}/employment/acuerdo`);
  expect(denied?.status()).toBe(403);
});

test('el apoyo no alcanza ni las condiciones del contrato', async ({ page }) => {
  await loginAs(page, 'helper');
  const denied = await page.goto(`/h/${HOUSEHOLD}/employment/condiciones`);
  expect(denied?.status()).toBe(403);
});
