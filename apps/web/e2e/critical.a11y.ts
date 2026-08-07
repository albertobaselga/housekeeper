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
