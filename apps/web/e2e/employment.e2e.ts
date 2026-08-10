import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// El servidor de Playwright arranca SIN base de datos: la página de expediente
// queda en modo fixture (solo lectura) y ninguna acción de escritura del
// outbox debe aparecer, sea cual sea el rol.
const ACTION_LABELS = [
  'Registrar jornada extra',
  'Apuntar la jornada',
  'Marcar realizada',
  'Aceptar',
  'Decidir compensación',
  'Añadir gasto',
  'Aprobar',
  'Rechazar',
  'Empezar la cuenta',
  'Cerrar el mes',
  'Registrar pago',
  'Confirmar cobro'
];

async function expectReadOnlyEmployment(page: Page): Promise<void> {
  await page.goto(`/h/${HOUSEHOLD}/employment`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Contrato');
  // La lectura fixture sigue renderizando el resumen de liquidación.
  await expect(page.locator('.summary-strip')).toContainText('Total transferencia');
  await expect(page.locator('.ledger-total')).toBeVisible();
  for (const label of ACTION_LABELS) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  }
  await expect(page.locator('.action-form')).toHaveCount(0);
}

test('admin en modo fixture: expediente legible pero sin acciones de escritura', async ({ page }) => {
  await loginAs(page, 'admin');
  await expectReadOnlyEmployment(page);
});

test('empleada en modo fixture: expediente legible pero sin acciones de escritura', async ({ page }) => {
  await loginAs(page, 'employee');
  await expectReadOnlyEmployment(page);
});
