import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

test('el admin con concesión confirma un pendiente desde Revisión', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/revision`);

  // Badge de pendientes visible en la navegación del módulo.
  await expect(page.locator('.revision-badge')).toBeVisible();

  const fila = page.locator('tr', { hasText: 'SUPERMERCADO RIO E2E' });
  await expect(fila).toBeVisible();
  await fila.getByRole('combobox', { name: 'Categoría' }).selectOption({ label: 'Casa E2E' });
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await fila.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await expect(page.locator('tr', { hasText: 'SUPERMERCADO RIO E2E' })).toHaveCount(0);
});
