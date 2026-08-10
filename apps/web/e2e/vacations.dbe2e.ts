import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Vacaciones contra Postgres real (config playwright.db.config.ts,
// `pnpm test:e2e:db`): la familia apunta un periodo y el saldo lo refleja; la
// empleada ve exactamente lo mismo y no encuentra por dónde escribirlo.
// Serializados porque cada paso construye sobre el estado que dejó el anterior.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

// El bloque enseña el año natural EN CURSO, así que las fechas se calculan
// desde hoy. Noviembre no lo toca ningún otro spec de la batería.
const YEAR = new Date().getFullYear();
const FIRST_DAY = `${YEAR}-11-02`;
const LAST_DAY = `${YEAR}-11-08`;
const SECOND_FIRST_DAY = `${YEAR}-11-20`;
const SECOND_LAST_DAY = `${YEAR}-11-22`;

function vacationsCard(page: Page) {
  return page.locator('article.card').filter({ hasText: 'Días disfrutados y días que quedan' });
}

async function gotoEmployment(page: Page, account: 'admin' | 'employee'): Promise<void> {
  await loginAs(page, account);
  await page.goto(`/h/${HOUSEHOLD}/employment`);
  await expect(page.getByRole('heading', { name: 'Contrato', exact: true })).toBeVisible();
}

test('Alberto apunta una semana de vacaciones y el saldo del año baja siete días', async ({ page }) => {
  await gotoEmployment(page, 'admin');

  const card = vacationsCard(page);
  await expect(card).toBeVisible();
  // Estado de partida: 30 días de derecho y nada apuntado todavía este año.
  await expect(card.getByText('0 de 30 días disfrutados · quedan 30')).toBeVisible();
  await expect(card).toContainText(`Todavía no hay vacaciones apuntadas en ${YEAR}`);

  const form = card.locator('form.action-form');
  await form.getByLabel('Primer día').fill(FIRST_DAY);
  await form.getByLabel('Último día').fill(LAST_DAY);
  await form.getByLabel('Nota (opcional)').fill('Semana de noviembre E2E');
  await form.getByRole('button', { name: 'Apuntar vacaciones' }).click();

  // Días NATURALES con ambos extremos: del 2 al 8 son 7, no 6, y el fin de
  // semana cuenta.
  const row = card.locator('.ledger-list > div').filter({ hasText: 'Semana de noviembre E2E' });
  await expect(row).toContainText('7 días');
  await expect(card.getByText('7 de 30 días disfrutados · quedan 23')).toBeVisible();
});

test('un periodo que se pisa con el anterior se rechaza con una causa legible', async ({ page }) => {
  await gotoEmployment(page, 'admin');

  const card = vacationsCard(page);
  const form = card.locator('form.action-form');
  await form.getByLabel('Primer día').fill(LAST_DAY);
  await form.getByLabel('Último día').fill(`${YEAR}-11-12`);
  await form.getByRole('button', { name: 'Apuntar vacaciones' }).click();

  await expect(card.getByRole('alert')).toContainText('se pisan con otras vacaciones ya apuntadas');
  // El saldo no se ha movido: lo rechazado no cuenta.
  await expect(card.getByText('7 de 30 días disfrutados · quedan 23')).toBeVisible();
});

test('anular deja el periodo tachado con su motivo y devuelve los días al saldo', async ({ page }) => {
  await gotoEmployment(page, 'admin');

  const card = vacationsCard(page);
  const form = card.locator('form.action-form');
  await form.getByLabel('Primer día').fill(SECOND_FIRST_DAY);
  await form.getByLabel('Último día').fill(SECOND_LAST_DAY);
  await form.getByLabel('Nota (opcional)').fill('Puente que no fue E2E');
  await form.getByRole('button', { name: 'Apuntar vacaciones' }).click();
  await expect(card.getByText('10 de 30 días disfrutados · quedan 20')).toBeVisible();

  const row = card.locator('.ledger-list > div').filter({ hasText: 'Puente que no fue E2E' });
  await row.getByRole('button', { name: 'Anular' }).click();
  const voidForm = card.locator('form.action-form').filter({ hasText: 'Por qué se anula' });
  await voidForm.getByLabel('Por qué se anula').fill('Al final no se cogieron E2E');
  await voidForm.getByRole('button', { name: 'Anular el periodo' }).click();

  // La fila NO desaparece: se queda con el motivo, y deja de contar.
  const voidedRow = card
    .locator('.ledger-list > div')
    .filter({ hasText: 'Anulado: Al final no se cogieron E2E' });
  await expect(voidedRow).toBeVisible();
  await expect(card.getByText('7 de 30 días disfrutados · quedan 23')).toBeVisible();
});

test('Ana ve su saldo y sus periodos, pero no puede apuntar ni anular nada', async ({ page }) => {
  await gotoEmployment(page, 'employee');

  const card = vacationsCard(page);
  await expect(card).toBeVisible();
  // El mismo saldo que ve la familia: es su expediente.
  await expect(card.getByText('7 de 30 días disfrutados · quedan 23')).toBeVisible();
  await expect(card.locator('.ledger-list > div').filter({ hasText: 'Semana de noviembre E2E' })).toBeVisible();
  await expect(
    card.locator('.ledger-list > div').filter({ hasText: 'Anulado: Al final no se cogieron E2E' })
  ).toBeVisible();

  // Ni formulario ni botón de anular: no es que estén deshabilitados, es que no
  // existen para ella. La política de la base dice lo mismo.
  await expect(card.locator('form.action-form')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Apuntar vacaciones' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Anular' })).toHaveCount(0);

  // El derecho pactado se lee en el historial del acuerdo, no en un rótulo suelto.
  const versionsCard = page.locator('article.card').filter({ hasText: 'Versiones y cambios de salario' });
  await expect(versionsCard).toContainText('30 días naturales al año de vacaciones');
});

test('Ana entra en Hoy, se entera de las vacaciones nuevas y el aviso se apaga al mirarlas', async ({
  page
}) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/today`);

  // Lo que se le apuntó mientras no miraba sale en la primera pantalla, y el
  // bloque NO se titula «Necesita tu decisión»: no hay nada que aprobar.
  const block = page.locator('section.card').filter({ hasText: 'Pendientes de ti' });
  await expect(block).toContainText('Te han apuntado vacaciones');
  await expect(block.getByRole('heading', { name: 'Necesita tu decisión' })).toHaveCount(0);

  const notice = block.locator('.ledger-list > div').filter({ hasText: 'Te han apuntado vacaciones' });
  await notice.getByRole('link', { name: 'Verlas' }).click();
  await expect(page.getByRole('heading', { name: 'Mis vacaciones' })).toBeVisible();

  // Su sección: los años, lo que ya disfrutó y lo anulado como anulado.
  const mine = page.locator('article.card').filter({ hasText: 'Año a año' });
  await expect(mine.getByRole('heading', { name: String(YEAR), exact: false })).toBeVisible();
  await expect(mine).toContainText('Semana de noviembre E2E');
  await expect(mine).toContainText('Anuladas: Al final no se cogieron E2E');
  await expect(mine).toContainText('días que te tocan');
  // Historia, no evaluación: aquí no hay porcentajes ni notas de nadie.
  await expect(mine).not.toContainText('%');

  // Nada que descartar a mano: mirar es lo que apaga el aviso.
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await expect(page.getByText('Te han apuntado vacaciones')).toHaveCount(0);
});

test('Alberto abre el historial y están las dos personas del hogar, no solo la primera', async ({
  page
}) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/employment/vacaciones`);

  await expect(page.getByRole('heading', { name: 'Vacaciones', exact: true })).toBeVisible();
  const cards = page.locator('article.card').filter({ hasText: 'Vacaciones de' });
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('días que le tocan');
  // Lo anulado sigue a la vista, y sigue sin contar.
  await expect(page.getByText('Anuladas: Al final no se cogieron E2E')).toBeVisible();
});
