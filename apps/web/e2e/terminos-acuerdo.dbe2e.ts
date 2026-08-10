import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/*
 * Catálogo de condiciones (migración 0021) en el navegador, contra Postgres.
 *
 * En las fixtures Ana tiene JORNADAS pero NO horas extra —el caso que describió
 * el propietario—, y su acuerdo pacta dos complementos que se comportan al
 * revés: la antigüedad suma a su transferencia y el seguro médico lo paga la
 * casa por su cuenta.
 *
 * Lo que se comprueba aquí y en ningún otro sitio:
 *   1. Que la tarifa horaria no le llega POR NINGUNA VÍA, incluido el JSON que
 *      el servidor incrusta en la página. Una aserción sobre lo que se ve en
 *      pantalla no valdría: bastaría con un `display: none` para pasarla.
 *   2. Que el complemento que no suma consta en sus condiciones y NO aparece
 *      como línea de la cuenta del mes.
 *   3. Que cambiar una tarifa apila una versión nueva y deja intacta la
 *      anterior, incluida la que ya valoró trabajo liquidado.
 *
 * Orden: este fichero corre entre `snapshot-offline` y `today-inline`. La
 * versión que apila entra en vigor HOY, así que la versión vigente el día 1 del
 * mes —la que pone el salario base de la cuenta abierta— no cambia, y ninguna
 * batería posterior ve moverse su total.
 */
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

async function gotoConditions(page: Page): Promise<void> {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/employment/condiciones`);
  await expect(page.getByRole('heading', { name: 'Mis condiciones' })).toBeVisible();
}

test('Ana ve lo que le aplica, y la tarifa horaria no llega ni en el JSON de la página', async ({ page }) => {
  await gotoConditions(page);

  const basics = page.locator('article.card').filter({ hasText: 'Lo básico' });
  await expect(basics).toContainText('1.500,00 €');
  await expect(basics).toContainText('30 días naturales al año');

  const extraCard = page.locator('article.card').filter({ hasText: 'Qué puedes hacer y a cuánto se paga' });
  await expect(extraCard).toContainText('Jornada extra');
  await expect(extraCard).toContainText('50,00 € por jornada');
  await expect(extraCard).toContainText('Noche de guardia');

  // El concepto sin tarifa está pactado, pero sin precio no se le enseña.
  await expect(extraCard).not.toContainText('Acompañamiento a médico');

  // La aserción del encargo: la carga útil que el servidor incrusta en la
  // página no contiene ni el concepto por horas ni su unidad.
  const html = await page.content();
  expect(html).not.toContain('per_hour');
  expect(html).not.toContain('Hora extraordinaria');
  expect(html).not.toContain('/h<');
});

test('el complemento que paga la casa consta en sus condiciones y no en la cuenta del mes', async ({ page }) => {
  await gotoConditions(page);

  const supplements = page.locator('article.card').filter({ hasText: 'Lo que se suma y lo que paga la casa' });
  await expect(supplements).toContainText('Complemento de antigüedad');
  await expect(supplements).toContainText('Se suma a tu transferencia');
  await expect(supplements).toContainText('Seguro médico privado');
  await expect(supplements).toContainText('no viaja en la transferencia');
  // El plus de transporte quedó retirado en esta versión: no existe para ella.
  await expect(supplements).not.toContainText('Plus de transporte');

  await page.goto(`/h/${HOUSEHOLD}/employment`);
  const accrual = page.locator('article.card.ledger-card');
  await expect(accrual.locator('.ledger-list')).toContainText('Complemento de antigüedad');
  // Consta debajo del total, jamás como línea que se suma.
  await expect(accrual.locator('.ledger-list')).not.toContainText('Seguro médico');
  await expect(accrual).toContainText('Además, la casa paga aparte: Seguro médico privado (45,00 €)');
  await expect(accrual).toContainText('No entra en la transferencia');
});

test('Alberto cambia una tarifa y nace una versión nueva: la anterior sigue intacta', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/employment/acuerdo`);
  await expect(page.getByRole('heading', { name: 'Condiciones del acuerdo' })).toBeVisible();

  // Quien administra sí ve lo que a ella se le oculta: sin verlo no podría
  // volver a activarlo.
  const agreementCard = page.locator('article.card').filter({ hasText: 'Fixture Empleada Roble' });
  await expect(agreementCard).toContainText('Hora extraordinaria: desactivado · no lo ve');
  await expect(agreementCard).toContainText('Acompañamiento a médico: sin tarifa · no la ve');
  await expect(agreementCard).toContainText('Seguro médico privado: 45,00 € al mes (lo paga la casa)');

  await agreementCard.getByRole('button', { name: 'Cambiar las condiciones' }).click();
  const form = agreementCard.locator('form.action-form');

  const today = new Date().toISOString().slice(0, 10);
  await form.getByLabel('Entra en vigor el').fill(today);
  await form.getByLabel('Motivo del cambio').fill('Subida de la jornada extra E2E');

  // La jornada extra sube de 50 € a 60 €. El resto del catálogo viaja tal cual.
  const shiftRate = form.getByLabel('Tarifa (vacío = sin tarifa)').nth(2);
  await shiftRate.fill('60,00');
  await form.getByRole('button', { name: 'Guardar como versión nueva' }).click();

  await expect(page.getByText('Versión nueva añadida. La anterior sigue en el historial.')).toBeVisible();

  const versions = page.locator('article.card').filter({ hasText: 'Fixture Empleada Roble' }).locator('.ledger-list > div');
  // La v3 rige y la v2 queda como histórica CON SU TARIFA DE ENTONCES: lo ya
  // trabajado bajo ella no se revaloriza.
  await expect(versions.filter({ hasText: 'v3' })).toContainText('Jornada extra: 60,00 € por jornada');
  /*
   * Y los complementos llegan a la v3 con el MISMO pagador. El `<select>` de
   * «Quién lo cobra» mandaba «true»/«false» y el servidor comparaba con «suma»,
   * así que la comparación no se cumplía nunca y cada versión apilada convertía
   * la antigüedad en un gasto de la casa: 30 € que dejaban de transferirse en
   * silencio, sobre una fila inmutable.
   */
  await expect(versions.filter({ hasText: 'v3' })).toContainText(
    'Complemento de antigüedad: 30,00 € al mes (suma al pago)'
  );
  await expect(versions.filter({ hasText: 'v3' })).toContainText(
    'Seguro médico privado: 45,00 € al mes (lo paga la casa)'
  );
  await expect(versions.filter({ hasText: 'v2' })).toContainText('Jornada extra: 50,00 € por jornada');
  await expect(versions.filter({ hasText: 'v2' })).toContainText('Histórica');

  // Y una versión no puede entrar en vigor antes que la última: lo pactado no
  // se reescribe hacia atrás.
  await agreementCard.getByRole('button', { name: 'Cambiar las condiciones' }).click();
  const retro = agreementCard.locator('form.action-form');
  await retro.getByLabel('Entra en vigor el').fill('2025-01-01');
  await retro.getByLabel('Motivo del cambio').fill('Intento retroactivo E2E');
  await retro.getByRole('button', { name: 'Guardar como versión nueva' }).click();
  await expect(agreementCard.locator('.form-error')).toContainText('lo ya pactado no se reescribe');
});

test('Ana ve la tarifa nueva, y sigue sin ver ninguna tarifa horaria', async ({ page }) => {
  await gotoConditions(page);
  const extraCard = page.locator('article.card').filter({ hasText: 'Qué puedes hacer y a cuánto se paga' });
  await expect(extraCard).toContainText('60,00 € por jornada');

  const html = await page.content();
  expect(html).not.toContain('per_hour');
  expect(html).not.toContain('Hora extraordinaria');
});
