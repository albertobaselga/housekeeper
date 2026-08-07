import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Flujo laboral de la FAMILIA (Alberto, family_admin) contra Postgres real
// (config playwright.db.config.ts, `pnpm test:e2e:db`): acepta y resuelve las
// jornadas extra sembradas, aprueba el gasto pendiente de Ana y lleva la
// liquidación del mes en curso de abierta a pagada. Los tests son serializados
// porque cada paso construye sobre el estado que dejó el anterior.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

function euroToCents(label: string): bigint {
  const [units = '0', fraction = '00'] = label.replace(/\.|\s|€/g, '').split(',');
  return BigInt(units) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToEuroInput(cents: bigint): string {
  const units = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${units},${(cents % 100n).toString().padStart(2, '0')}`;
}

async function gotoEmployment(page: Page): Promise<void> {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/employment`);
  await expect(page.getByRole('heading', { name: 'Acuerdos y pagos' })).toBeVisible();
}

test('Alberto acepta la jornada solicitada y resuelve el festivo como descanso: el saldo permanente sube', async ({ page }) => {
  await gotoEmployment(page);

  const extrasCard = page.locator('article.card').filter({ hasText: 'Jornadas extra' });
  const balanceCard = page.locator('article.card').filter({ hasText: 'Tiempo y compensación' });

  // Estado sembrado: crédito permanente de partida (fixture) y dos pendientes.
  const balanceRow = balanceCard.locator('.balance-list > div').filter({ hasText: 'Descanso compensatorio' });
  await expect(balanceRow).toContainText('1 día');

  // 1) Acepta la jornada extra sembrada en estado requested.
  const requestedRow = extrasCard.locator('.ledger-list > div').filter({ hasText: 'Plancha del sábado E2E' });
  await expect(requestedRow).toContainText('Solicitada');
  await requestedRow.getByRole('button', { name: 'Aceptar' }).click();
  await expect(requestedRow).toContainText('Aceptada · sin realizar');

  // 2) Resuelve el festivo trabajado como compensación en descanso, con motivo.
  const resolvableRow = extrasCard.locator('.ledger-list > div').filter({ hasText: 'Festivo trabajado E2E' });
  await expect(resolvableRow).toContainText('Realizada sin aceptación previa');
  await resolvableRow.getByRole('button', { name: 'Resolver' }).click();
  const resolveForm = extrasCard.locator('form.action-form');
  await expect(resolveForm).toBeVisible();
  await resolveForm.getByLabel('Compensación').selectOption('time_off');
  await resolveForm.getByLabel('Motivo').fill('Descanso pactado con Ana E2E');
  await resolveForm.getByRole('button', { name: 'Confirmar resolución' }).click();

  // La jornada resuelta desaparece de pendientes y el crédito PERMANENTE sube
  // (worked_rest_day_credit_minutes = 1440 de la versión vigente: 1 día más).
  await expect(resolvableRow).toHaveCount(0);
  await expect(balanceRow).toContainText('2 días');
});

test('Alberto aprueba el gasto pendiente de Ana con motivo y entra en el devengo', async ({ page }) => {
  await gotoEmployment(page);

  const expensesCard = page.locator('article.card').filter({ hasText: 'Gastos pendientes' });
  const pendingRow = expensesCard.locator('.ledger-list > div').filter({ hasText: 'Farmacia E2E pendiente' });
  await expect(pendingRow).toContainText('21,75 €');
  await pendingRow.getByRole('button', { name: 'Revisar' }).click();

  const decideForm = expensesCard.locator('form.action-form');
  await decideForm.getByLabel('Motivo de la decisión').fill('Justificante correcto E2E');
  await decideForm.getByRole('button', { name: 'Aprobar' }).click();

  // Aprobado: sale de pendientes y el devengo del mes lo proyecta como reembolso.
  await expect(pendingRow).toHaveCount(0);
  await expect(page.locator('.summary-strip')).toContainText('21,75 €');
});

test('Alberto abre la liquidación del mes en curso con vencimiento, la cierra y la paga en dos plazos', async ({ page }) => {
  await gotoEmployment(page);

  // 1) Abrir: el formulario de cabecera propone el fin de mes como vencimiento.
  const openForm = page.locator('form.open-settlement-form');
  await expect(openForm).toBeVisible();
  const dueOn = await openForm.getByLabel('Vencimiento').inputValue();
  expect(dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await openForm.getByRole('button', { name: /Abrir liquidación de/ }).click();

  // La liquidación nueva aparece abierta, con su vencimiento y botón de cierre.
  const closeButton = page.getByRole('button', { name: 'Cerrar liquidación' });
  await expect(closeButton).toBeVisible();
  await expect(page.locator('article.card').filter({ hasText: 'Historial con pagos' })).toContainText(`vence el ${dueOn}`);
  await expect(openForm).toHaveCount(0);

  // 2) Cerrar: el servidor materializa las líneas desde los hechos del mes.
  await closeButton.click();
  const paymentForm = page.locator('form').filter({ hasText: 'Registrar pago' });
  await expect(paymentForm).toBeVisible();
  await expect(page.locator('.status-chip').filter({ hasText: 'Pendiente de pago' })).toBeVisible();

  // 3) Pago parcial: queda visible el pendiente restante.
  const amountInput = paymentForm.getByLabel('Importe (€)');
  const totalLabel = await amountInput.getAttribute('placeholder');
  const totalCents = euroToCents(totalLabel ?? '');
  expect(totalCents).toBeGreaterThan(100000n);
  await amountInput.fill('1.000,00');
  await paymentForm.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(page.locator('.status-chip').filter({ hasText: 'Pago parcial registrado' })).toBeVisible();

  const remainingCents = totalCents - 100000n;
  const remainingLabel = `${centsToEuroInput(remainingCents)} €`;
  const settlementsCard = page.locator('article.card').filter({ hasText: 'Historial con pagos' });
  await expect(settlementsCard).toContainText(remainingLabel);

  // 4) El resto: la liquidación queda pagada (el cobro lo confirma Ana aparte).
  const secondForm = page.locator('form').filter({ hasText: 'Registrar pago' });
  await secondForm.getByLabel('Importe (€)').fill(centsToEuroInput(remainingCents));
  await secondForm.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(page.locator('.status-chip').filter({ hasText: 'Pagada · cobro sin confirmar' })).toBeVisible();
});
