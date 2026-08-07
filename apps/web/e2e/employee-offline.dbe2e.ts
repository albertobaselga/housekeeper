import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// AC-11 (sin foto) con la INTERNA (Ana): un añadido a la compra hecho sin
// conexión queda en la outbox local con aviso visible y, al volver la red y
// dispararse el evento `online`, se sincroniza contra Postgres real.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

test('Ana añade a la compra sin conexión y el artículo se sincroniza al volver la red', async ({ page, context }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/menu`);
  await page.getByRole('button', { name: 'Lista de la compra' }).click();

  const addForm = page.locator('form.action-form').filter({ hasText: 'Nombre libre' });
  await expect(addForm).toBeVisible();

  await context.setOffline(true);
  try {
    await addForm.getByRole('textbox', { name: 'Nombre libre' }).fill('Pilas AAA E2E');
    await addForm.getByLabel('Cantidad').fill('4');
    await addForm.getByLabel('Unidad').fill('uds');
    await addForm.getByLabel('Sección').fill('hogar');
    await addForm.getByRole('button', { name: 'Añadir a la compra' }).click();

    // El comando queda en la outbox local: aviso en página y píldora offline.
    await expect(page.locator('.success-message')).toContainText('outbox local, pendiente de sincronizar');
    await expect(page.locator('.sync-pill')).toContainText('Sin conexión · 1 pendiente');
  } finally {
    await context.setOffline(false);
  }

  // Vuelve la red: el evento `online` dispara el flush de la outbox.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');

  // Tras recargar, el artículo viene ya del servidor bajo RLS: sincronizado.
  await page.reload();
  await page.getByRole('button', { name: 'Lista de la compra' }).click();
  const item = page.locator('.ingredient-list li').filter({ hasText: 'Pilas AAA E2E' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('4 uds');
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');
});
