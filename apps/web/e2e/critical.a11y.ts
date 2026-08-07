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

test('la hoja «Más» de la navegación móvil no tiene incidencias serias', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'family');
  await page.getByRole('button', { name: 'Más' }).click();
  await expect(page.getByRole('dialog', { name: 'Más opciones' })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
