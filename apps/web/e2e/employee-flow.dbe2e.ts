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
  await expect(page.getByRole('heading', { name: 'Pagos', exact: true })).toBeVisible();
}

test('Ana registra una jornada extra del catálogo, con la duración pactada', async ({ page }) => {
  await gotoEmployment(page);

  const extrasCard = page.locator('article.card').filter({ hasText: 'Jornadas extra' });
  const form = extrasCard.locator('form.action-form').filter({ hasText: 'Registrar jornada extra' });
  // Las opciones son los conceptos del acuerdo, con su tarifa a la vista.
  await form.getByLabel('Tipo').selectOption({ label: 'Jornada extra · 50,00 € por jornada' });
  await expect(form.getByLabel('Fecha')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  // Una jornada no pide horas: la duración es la pactada, y pedirla haría creer
  // que cambia el importe.
  await expect(form.getByLabel('Horas', { exact: true })).toHaveCount(0);
  await expect(form).toContainText('jornada de 10 h, según lo pactado');
  await form.getByLabel('Nota (opcional)').fill('Canguro nocturno E2E');
  await form.getByRole('button', { name: 'Registrar jornada extra' }).click();

  const newRow = extrasCard.locator('.ledger-list > div').filter({ hasText: 'Canguro nocturno E2E' });
  await expect(newRow).toContainText('Jornada extra');
  await expect(newRow).toContainText('10 h');
  await expect(newRow).toContainText('Solicitada');
});

test('Ana envía el parte de la semana en curso con dos días', async ({ page }) => {
  await gotoEmployment(page);

  const weekCard = page.locator('article.card').filter({ hasText: 'Días trabajados esta semana' });
  await expect(weekCard.getByRole('button', { name: 'Enviar mi semana' })).toBeVisible();

  // Primera fila: hoy, 8 h por defecto. Segunda fila: otro día, 5 h.
  await weekCard.getByRole('button', { name: 'Añadir día' }).click();
  const hourInputs = weekCard.getByLabel('Horas', { exact: true });
  await expect(hourInputs).toHaveCount(2);
  await hourInputs.nth(1).fill('5');
  await weekCard.getByLabel('Nota (opcional)').nth(1).fill('Media jornada E2E');
  await weekCard.getByRole('button', { name: 'Enviar mi semana' }).click();

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

// Bug original cazado por esta batería (envelope 'routine_occurrence' vs
// handler 'routine' → rejected/unsupported_aggregate) ya corregido en
// src/lib/food/commands.ts. Semántica real al completar: la función definer de
// la 0009 AVANZA la recurrencia, así que la rutina pasa a mostrar la próxima
// fecha (sin chip «Hecha» para la nueva ocurrencia) y jamás un conflicto.
test('Ana completa la rutina de audiencia empleada y la recurrencia avanza', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/routines`);

  const routineItem = page.locator('li').filter({ hasText: 'Repaso del filtro del agua (E2E)' });
  const dueLine = routineItem.locator('small').first();
  const before = await dueLine.innerText();

  await routineItem.getByRole('button', { name: 'Marcar hecha' }).click();

  await expect(page.locator('.status-banner')).toHaveCount(0);
  await expect(dueLine).not.toHaveText(before);
  // Feedback visible del resultado: chip «Hecha ✓ · próxima el X» en la fila,
  // y el botón sigue disponible para la NUEVA ocurrencia ya avanzada.
  await expect(routineItem.locator('.status-chip').filter({ hasText: 'Hecha ✓ · próxima el' })).toBeVisible();
  await expect(routineItem.getByRole('button', { name: 'Marcar hecha' })).toBeVisible();
  await expect(routineItem.getByRole('button', { name: 'Marcar hecha' })).toBeEnabled();
});
