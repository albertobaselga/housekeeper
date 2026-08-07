import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Flujo de la INTERNA (Ana, employee_live_in) contra Postgres real: registra
// una jornada extra, envía el parte de la semana en curso con dos días, añade
// un gasto con importe con coma, descarga su expediente (AC-13) y completa la
// rutina de audiencia empleada. Serial: cada test asume el estado del previo.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

async function gotoEmployment(page: Page): Promise<void> {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/employment`);
  await expect(page.getByRole('heading', { name: 'Acuerdos y pagos' })).toBeVisible();
}

test('Ana registra una jornada extra nueva con tipo, fecha y minutos', async ({ page }) => {
  await gotoEmployment(page);

  const extrasCard = page.locator('article.card').filter({ hasText: 'Jornadas extra' });
  const form = extrasCard.locator('form.action-form').filter({ hasText: 'Registrar jornada extra' });
  await form.getByLabel('Tipo').selectOption('worked_rest_day');
  await expect(form.getByLabel('Fecha')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await form.getByLabel('Minutos', { exact: true }).fill('120');
  await form.getByLabel('Nota (opcional)').fill('Canguro nocturno E2E');
  await form.getByRole('button', { name: 'Registrar jornada extra' }).click();

  const newRow = extrasCard.locator('.ledger-list > div').filter({ hasText: 'Canguro nocturno E2E' });
  await expect(newRow).toContainText('Festivo o descanso trabajado');
  await expect(newRow).toContainText('2 h');
  await expect(newRow).toContainText('Solicitada');
});

test('Ana envía el parte de la semana en curso con dos días', async ({ page }) => {
  await gotoEmployment(page);

  const weekCard = page.locator('article.card').filter({ hasText: 'Parte semanal de tiempo' });
  await expect(weekCard.getByRole('button', { name: 'Enviar parte semanal' })).toBeVisible();

  // Primera fila: hoy, 480 minutos por defecto. Segunda fila: otro día, 300.
  await weekCard.getByRole('button', { name: 'Añadir día' }).click();
  const minuteInputs = weekCard.getByLabel('Minutos trabajados');
  await expect(minuteInputs).toHaveCount(2);
  await minuteInputs.nth(1).fill('300');
  await weekCard.getByLabel('Nota (opcional)').nth(1).fill('Media jornada E2E');
  await weekCard.getByRole('button', { name: 'Enviar parte semanal' }).click();

  await expect(weekCard.locator('.status-chip').filter({ hasText: 'Semana enviada' })).toBeVisible();
  await expect(weekCard.locator('.ledger-list')).toContainText('Enviado · pendiente de confirmación');
});

test('Ana añade un gasto con importe con coma', async ({ page }) => {
  await gotoEmployment(page);

  const expensesCard = page.locator('article.card').filter({ hasText: 'Añadir gasto' });
  const form = expensesCard.locator('form.action-form');
  await form.getByLabel('Importe (€)').fill('19,95');
  await form.getByLabel('Descripción').fill('Taxi a la farmacia E2E');
  await form.getByRole('button', { name: 'Añadir gasto' }).click();

  const newRow = expensesCard.locator('.ledger-list > div').filter({ hasText: 'Taxi a la farmacia E2E' });
  await expect(newRow).toContainText('19,95 €');
  await expect(newRow).toContainText('pendiente de aprobación');
});

test('Ana descarga «mi expediente» como ZIP (AC-13)', async ({ page }) => {
  await gotoEmployment(page);

  const link = page.getByRole('link', { name: 'Descargar mi expediente (PDF + CSV)' });
  await expect(link).toBeVisible();

  const response = await page.request.get(`/api/v1/households/${HOUSEHOLD}/employment-export`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/zip');
  expect(response.headers()['content-disposition']).toContain('mi-expediente.zip');
});

test('Ana ve la rutina de audiencia empleada y no la de familia (RLS por audiencia)', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  // RLS por audiencia: la rutina family no existe para la empleada.
  await expect(page.getByText('Repaso del filtro del agua (E2E)')).toBeVisible();
  await expect(page.getByText('Revisión del botiquín (E2E)')).toHaveCount(0);
});

// BUG real detectado por esta batería: el cliente emite la finalización de
// rutina con aggregateType 'routine_occurrence' (src/lib/food/commands.ts →
// completeRoutine), pero el servidor registra el action 'complete' bajo el
// aggregate 'routine' (rhythmCommandHandlers en packages/server). /api/v1/sync
// responde `rejected · unsupported_aggregate`, el comando queda varado en la
// outbox ("Revisión necesaria") y «Marcar hecha» nunca persiste. Arreglo
// pendiente fuera de esta ronda (tocaría src/ o packages/): igualar el
// aggregateType del envelope con la clave del handler.
test.fixme('Ana completa la rutina de audiencia empleada y queda «Hecha»', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  const routineItem = page.locator('li').filter({ hasText: 'Repaso del filtro del agua (E2E)' });
  await routineItem.getByRole('button', { name: 'Marcar hecha' }).click();
  // La ocurrencia vigente avanza al completarse: o chip «Hecha» o la siguiente
  // fecha con el botón de nuevo disponible, pero NUNCA un conflicto de outbox.
  await expect(page.locator('.status-banner')).toHaveCount(0);
  await expect(routineItem.locator('.status-chip').filter({ hasText: 'Hecha' })).toBeVisible();
});
