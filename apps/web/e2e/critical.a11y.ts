import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

async function seriousViolations(page: Parameters<typeof loginAs>[0]) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? '')
  );
}

test('la pantalla de acceso no tiene incidencias serias de accesibilidad', async ({ page }) => {
  await page.goto('/login');
  expect(await seriousViolations(page)).toEqual([]);
});

test('Hoy no tiene incidencias serias de accesibilidad', async ({ page }) => {
  await loginAs(page, 'admin');
  expect(await seriousViolations(page)).toEqual([]);
});

test('Emergencias no tiene incidencias serias de accesibilidad', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/emergency`);
  expect(await seriousViolations(page)).toEqual([]);
});

// F6-I3: ninguna pantalla de Finanzas entraba en esta puerta, y Finanzas es la
// parte de la aplicación con los widgets compuestos más complejos (el árbol del
// pivot, el buscador con sugerencias, la gráfica con su tabla sr-only). Se
// escanea la Analítica en el estado que más marcado tiene a la vez: pivot
// expandido y desplegable de sugerencias abierto.
// Rango y dims explícitos: la maqueta anuncia el rango de la URL (F6-M4) y sin
// la dimensión de proveedor «Mercadona» no llega a pintarse.
test('la Analítica de Finanzas no tiene incidencias serias de accesibilidad', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica?dims=cat,prov&from=2026-01-01&to=2026-03-31`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Analítica');

  const tabla = page.getByTestId('pivot-table');
  await tabla.getByRole('button', { name: 'desplegar Supermercado' }).click();
  await expect(tabla).toContainText('Mercadona');

  // Dos letras: es el mínimo que abre el desplegable (`suggestChips` exige 2).
  await page.getByLabel('Buscar', { exact: true }).fill('me');
  await expect(page.getByTestId('pivot-sugerencias')).toBeVisible();

  expect(await seriousViolations(page)).toEqual([]);
});

test('la hoja «Más» de la navegación móvil no tiene incidencias serias', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'family');
  await page.getByRole('button', { name: 'Más' }).click();
  await expect(page.getByRole('dialog', { name: 'Más opciones' })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
