import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// El e2e corre sin DATABASE_URL: la vista real de accesos exige Postgres y
// rol family_admin, así que Ajustes debe conservar la maqueta intacta.
test('en modo demo, Ajustes mantiene la maqueta y no renderiza la sección real de accesos', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/settings`);
  await expect(page.getByRole('heading', { name: 'Accesos activos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '¿Hasta cuándo puede entrar cada persona?' })).toHaveCount(0);
  await expect(page.getByText('Quitar el acceso')).toHaveCount(0);
});
