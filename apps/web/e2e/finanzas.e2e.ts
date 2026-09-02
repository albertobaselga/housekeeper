import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test('admin en modo fixture: el Dashboard de Finanzas pinta KPIs, flujo de caja y proveedores', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Finanzas');
  const kpis = page.locator('.finance-kpis');
  await expect(page.locator('.finance-kpis .card')).toHaveCount(5);
  await expect(kpis).toContainText('Ingresos');
  await expect(kpis).toContainText('Tasa de ahorro');

  // Ruling R18: importes reales del corpus demo de getFinanceDashboardFixture,
  // no solo los rótulos — para que el test detecte un formateo o un cruce de
  // filas equivocado, no solo una tarjeta ausente.
  // Filtro EXACTO (no `hasText` de subcadena): «Inversión … 14,1 % sobre
  // ingresos» contiene la subcadena «ingresos» y `hasText` no distingue may/min,
  // así que un filtro por subcadena confunde la tarjeta de Inversión con la de
  // Ingresos.
  const ingresosCard = kpis.locator('.card').filter({ has: page.getByText('Ingresos', { exact: true }) });
  await expect(ingresosCard).toContainText('4.250,00 €'); // incomeCents '425000'
  const gastosCard = kpis.locator('.card').filter({ has: page.getByText('Gastos', { exact: true }) });
  await expect(gastosCard).toContainText('−3.185,50 €'); // expenseCents '-318550' (menos tipográfico U+2212)

  // Con pendingCount: 3 de la fixture, la tarjeta «Tasa de ahorro» enlaza a revisión.
  const pendingChip = page.getByRole('link', { name: '3 sin revisar' });
  await expect(pendingChip).toBeVisible();
  await expect(pendingChip).toHaveAttribute('href', `/h/${HOUSEHOLD}/finanzas/revision`);

  await expect(page.locator('.cashflow svg')).toBeVisible();
  const providersHeading = page.getByRole('heading', { name: 'Top proveedores' });
  await expect(providersHeading).toBeVisible();
  const providersCard = page.locator('article', { has: providersHeading });
  await expect(providersCard).toContainText('Encina');
  await expect(providersCard).toContainText('−980,00 €'); // provider Encina, totalCents '-98000'
});

test('la empleada no alcanza Finanzas: 403 en ruta declarada sin capacidad', async ({ page }) => {
  await loginAs(page, 'employee');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
  expect(response?.status()).toBe(403);
  await expect(page.locator('body')).toContainText('no está incluida en tu acceso');
});

test('una ruta hija inventada de Finanzas sí es 404', async ({ page }) => {
  await loginAs(page, 'admin');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas/inventada`);
  expect(response?.status()).toBe(404);
});
