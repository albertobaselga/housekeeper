import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/**
 * Batería de MAQUETA de Revisión (sin base de datos): lo que se comprueba aquí
 * es lo que la pantalla ofrece, no lo que el servidor guarda —eso lo cubre
 * `finanzas-revision.dbe2e.ts`—. Vive en su propio fichero para no tocar
 * `finanzas.e2e.ts`, que otras tareas de esta misma ola están ejecutando.
 */
test('admin en modo fixture: la casilla de regla se apaga en la fila sin proveedor', async ({ page }) => {
  await loginAs(page, 'admin');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas/revision`);
  expect(response?.status()).toBe(200);

  // [FASE 5 · despacho de cierre, F5-I7 (2)] Con proveedor la casilla se puede
  // marcar; sin proveedor el handler rechazaría la regla con `invalid_payload`
  // y «Confirmar» se convertía en un rechazo silencioso, así que la casilla ni
  // se ofrece y el título explica por qué.
  const conProveedor = page.locator('tr', { hasText: 'LUZ DEMO' });
  await expect(conProveedor.getByLabel('Crear regla al confirmar')).toBeEnabled();

  const sinProveedor = page.locator('tr', { hasText: 'AJUSTE DE CAJA DEMO' });
  await expect(sinProveedor.getByLabel('Crear regla al confirmar')).toBeDisabled();
  await expect(sinProveedor.locator('.rule-toggle')).toHaveAttribute(
    'title',
    'Sin proveedor no se puede crear una regla'
  );

  // [FASE 5 · despacho de cierre, F5-I1] Los tres pendientes de la maqueta
  // caben en una página: sin aviso de «hay más».
  await expect(page.getByText('movimientos más recientes de')).toHaveCount(0);
});
