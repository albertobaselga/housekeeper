import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/**
 * [FASE 5 · despacho de cierre, F5-C1] La pantalla de Ajustes se caía entera
 * (500 en SSR, `Cannot read properties of null`) en cuanto el hogar tenía una
 * cuenta sin `bank_ref` —la de Efectivo que el ETL de la fase 3 crea en todo
 * hogar migrado—, porque la plantilla hacía `account.bankRef.slice(-4)` sobre
 * una columna nullable. Ninguna prueba lo veía: las cuatro semillas del repo
 * ponían siempre esa columna. La maqueta ya trae esa cuenta; esto la renderiza
 * de verdad, con servidor, y afirma que la respuesta es 200.
 *
 * Vive en su propio fichero (y no en `finanzas.e2e.ts`) para no tocar la
 * batería compartida de la fase, que otras tareas de esta misma ola están
 * ejecutando en paralelo.
 */
test('admin en modo fixture: Ajustes pinta una cuenta sin referencia bancaria sin caerse', async ({ page }) => {
  await loginAs(page, 'admin');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas/ajustes`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ajustes del módulo');

  // Cuenta CON referencia: se pinta recortada a los cuatro últimos dígitos.
  const comun = page.locator('tr', { hasText: 'Cuenta común (demo)' });
  await expect(comun).toContainText('…5678');
  await expect(comun).toContainText('caixabank');

  // Cuenta SIN banco ni referencia: dos guiones, ni «null» ni una pantalla rota.
  const efectivo = page.locator('tr', { hasText: 'Efectivo (demo)' });
  await expect(efectivo).toBeVisible();
  await expect(efectivo).not.toContainText('null');
  expect(await efectivo.locator('td', { hasText: '—' }).count()).toBeGreaterThanOrEqual(2);
});
