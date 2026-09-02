import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

// Vacaciones contra Postgres real (config playwright.db.config.ts,
// `pnpm test:e2e:db`): la familia apunta un periodo y el saldo lo refleja; la
// empleada ve exactamente lo mismo y no encuentra por dónde escribirlo; y los
// días que quedaron de un año ya cerrado se deciden, no se pierden solos.
// Serializados porque cada paso construye sobre el estado que dejó el anterior.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

/*
 * EL AÑO DE VACACIONES ES EL DEL CONTRATO, y eso reescribe cómo se interroga
 * esta pantalla.
 *
 * Esta batería estaba escrita contra el año natural y se rompió dos veces por
 * sitios distintos, que es lo que pasa cuando las aserciones no dicen lo que de
 * verdad quieren comprobar. El caso claro: buscar el encabezado «2026» casaba a
 * la vez con «Primer año · 3 feb 2025 – 2 feb 2026» y con «Segundo año · 3 feb
 * 2026 – 2 feb 2027». Una aserción que encaja con dos años distintos no
 * comprueba ninguno.
 *
 * Así que aquí un año de contrato se identifica SIEMPRE por su ordinal y sus
 * fechas —que es como lo escribe la pantalla y como lo lee una persona—, y el
 * año en curso por el único rótulo que lleva «· en curso».
 *
 * El acuerdo de la fixture del roble empieza el 3 de febrero de 2025, un día
 * que existe todos los meses, así que el aniversario es siempre un 3 de febrero
 * y no hace falta traerse la aritmética de meses del dominio:
 *
 *   · primer año   3 feb 2025 – 2 feb 2026   (cerrado, sin un solo día apuntado)
 *   · segundo año  3 feb 2026 – 2 feb 2027   (el que corre mientras esto se escribe)
 */
const AGREEMENT_STARTS_ON = '2025-02-03';
/** «02-03»: el aniversario del contrato, y con él el corte de cada año. */
const ANNIVERSARY = AGREEMENT_STARTS_ON.slice(5);
/** Como lo escribe la pantalla: el primer año cerró la víspera del aniversario. */
const FIRST_YEAR_ENDS_LABEL = '2 feb 2026';
/** Seis meses de margen desde ese cierre: la política de caducidad por omisión. */
const FIRST_YEAR_DEADLINE_LABEL = '2 ago 2026';

const CONTRACT_YEAR_NAME =
  '(?:(?:Primer|Segundo|Tercer|Cuarto|Quinto|Sexto|Séptimo|Octavo|Noveno|Décimo) año|Año \\d+)';
const DATE = '\\d{1,2} \\w{3} \\d{4}';
/** «Segundo año · 3 feb 2026 – 2 feb 2027 · en curso». */
const CURRENT_YEAR_HEADING = new RegExp(
  `^${CONTRACT_YEAR_NAME} · ${DATE} – ${DATE} · en curso$`
);
/** «A 1 sep 2026 llevas devengados 18 de los 30 días del año.» */
const ACCRUED_LINE = new RegExp(`A ${DATE} llevas devengados \\d+ de los 30 días del año\\.`);

/** Hoy en la zona del hogar, que es la que decide en qué año de contrato estamos. */
function todayInMadrid(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
}

/**
 * El año NATURAL en el que empieza el año de contrato en curso. El corte cae el
 * 3 de febrero, no el 1 de enero, así que en enero no es el año de hoy.
 */
function contractYearStartsIn(): number {
  const today = todayInMadrid();
  const calendar = Number(today.slice(0, 4));
  return today.slice(5) >= ANNIVERSARY ? calendar : calendar - 1;
}

// Noviembre de ese año: siempre cae dentro del año de contrato en curso, la
// corra la batería en marzo o en diciembre. Antes se tomaba el año natural en
// curso, y una ejecución de enero habría apuntado los días en el año de
// contrato SIGUIENTE sin que ninguna aserción se enterase: el saldo que se
// comprueba habría sido el de otro año.
const NOV = contractYearStartsIn();
const FIRST_DAY = `${NOV}-11-02`;
const LAST_DAY = `${NOV}-11-08`;
const SECOND_FIRST_DAY = `${NOV}-11-20`;
const SECOND_LAST_DAY = `${NOV}-11-22`;

function vacationsCard(page: Page) {
  return page.locator('article.card').filter({ hasText: 'Días disfrutados y días que quedan' });
}

function carryoverCard(page: Page) {
  return page.locator('article.card').filter({ hasText: 'Días de años ya cerrados' });
}

async function gotoEmployment(page: Page, account: 'admin' | 'employee'): Promise<void> {
  await loginAs(page, account);
  // La tarjeta del año vive en su pestaña: saldo, apuntar días e historial
  // comparten pantalla desde el rediseño en pestañas.
  await page.goto(`/h/${HOUSEHOLD}/employment/vacaciones`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('Alberto apunta una semana y el saldo del año de contrato baja siete días', async ({ page }) => {
  await gotoEmployment(page, 'admin');

  const card = vacationsCard(page);
  await expect(card).toBeVisible();

  // La tarjeta dice DE QUÉ doce meses habla. Sin las fechas, «segundo año» no
  // le dice nada a quien lo lee, y es justo el dato que el cambio al año de
  // contrato tenía que poner delante.
  await expect(card.locator('.audit-note').first()).toHaveText(
    new RegExp(`^${CONTRACT_YEAR_NAME} · ${DATE} – ${DATE}$`)
  );

  // Estado de partida: 30 días de derecho y nada apuntado en este año de contrato.
  await expect(card.getByText('0 de 30 días disfrutados · quedan 30')).toBeVisible();
  await expect(card).toContainText('Todavía no hay vacaciones apuntadas en este año de contrato');

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
  await form.getByLabel('Último día').fill(`${NOV}-11-12`);
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

// El primer año de contrato de las dos empleadas se cerró sin un solo día
// apuntado, así que la casa tiene 30 días de cada una que decidir. Antes de la
// segunda vuelta esos días se perdían por aritmética y nadie se enteraba; esto
// comprueba que ahora hay que decidirlos y que la decisión queda escrita.
test('los días del año cerrado se deciden, y sin tarifa pactada no se ofrece pagarlos', async ({
  page
}) => {
  await gotoEmployment(page, 'admin');

  const carry = carryoverCard(page);
  await expect(carry).toBeVisible();
  // Un año cerrado por empleada, dicho con su ordinal y con los días que
  // quedaron. El hogar de la fixture emplea a dos.
  const propuestas = carry.getByRole('heading', {
    name: '30 días de vacaciones sin disfrutar del primer año'
  });
  await expect(propuestas).toHaveCount(2);

  // El contrato de la fixture NO pacta el precio del día de vacaciones no
  // disfrutado, así que compensar no se OFRECE: no hay botón de pagar, ni un
  // cero, ni una estimación. Lo que hay es el camino para pactarlo.
  await expect(carry.getByRole('button', { name: /^Pagar / })).toHaveCount(0);
  await expect(carry.getByRole('link', { name: 'Pactar el precio del día' })).toHaveCount(2);

  // La propuesta de Ana, nombrada: con dos empleadas, cada línea dice de quién
  // es, y una aserción que no lo dijera podría decidir sobre la persona que no
  // era.
  const deAna = page
    .locator('.carryover-proposal')
    .filter({ hasText: 'Fixture Empleada Roble' });
  await expect(deAna).toHaveCount(1);
  // Y dice hasta cuándo se pueden disfrutar: seis meses desde que el año cerró.
  await expect(deAna).toContainText(`Se pueden arrastrar hasta el ${FIRST_YEAR_DEADLINE_LABEL}`);
  await expect(deAna).toContainText('pactar antes el precio del día');

  await deAna.getByRole('button', { name: 'Arrastrarlos' }).click();

  // La propuesta deja su sitio a la decisión, y los días arrastrados se dicen
  // como LÍNEA APARTE con su fecha límite: nunca sumados al derecho del año
  // siguiente, porque un «60» se leería como un error de la aplicación.
  await expect(carry).toContainText(
    `30 días arrastrados del primer año, hasta el ${FIRST_YEAR_DEADLINE_LABEL}`
  );
  await expect(propuestas).toHaveCount(1);

  // La tercera salida: perderlos exige decir por qué, y hasta que no se dice el
  // botón no deja pulsar.
  const otra = page.locator('.carryover-proposal').first();
  await otra.getByRole('button', { name: 'Darlos por perdidos' }).click();
  const perder = carry.locator('form.action-form');
  await expect(perder.getByRole('button', { name: 'Darlos por perdidos' })).toBeDisabled();
  await perder.getByLabel('Por qué se pierden').fill('Se acordó con ella que no se arrastraban E2E');
  await perder.getByRole('button', { name: 'Darlos por perdidos' }).click();

  await expect(carry).toContainText('30 días del primer año no se arrastraron');
  await expect(carry).toContainText('Se acordó con ella que no se arrastraban E2E');
  await expect(propuestas).toHaveCount(0);
});

// Este test va ANTES de que Ana visite su página de vacaciones: mirar es lo
// que apaga el aviso, y desde el rediseño en pestañas su tarjeta del año
// también vive allí, así que cualquier visita anterior lo consumiría.
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
  // El arrastre es asunto de quien administra: a ella no se le pide decidirlo.
  await expect(block).not.toContainText('sin disfrutar del primer año');

  const notice = block.locator('.ledger-list > div').filter({ hasText: 'Te han apuntado vacaciones' });
  await notice.getByRole('link', { name: 'Verlas' }).click();
  await expect(page.getByRole('heading', { name: 'Mis vacaciones' })).toBeVisible();

  // Su sección: los años, lo que ya disfrutó y lo anulado como anulado.
  const mine = page.locator('article.card').filter({ hasText: 'Año a año' });

  // EL AÑO EN CURSO, identificado como lo identifica una persona: por su
  // ordinal y sus fechas. Es uno y solo uno; buscar un número de año suelto
  // casaba con dos rótulos a la vez, que es como se rompió esta batería.
  const enCurso = mine.getByRole('heading', { name: CURRENT_YEAR_HEADING });
  await expect(enCurso).toHaveCount(1);

  // El dato que el propietario pidió en la segunda vuelta y que hasta ahora se
  // calculaba sin llegar a la pantalla: cuántos días lleva GANADOS a día de
  // hoy, que no es lo mismo que cuántos le tocan en el año. Lleva siempre la
  // fecha: sin ella el número no significa nada.
  await expect(mine).toContainText(ACCRUED_LINE);

  await expect(mine).toContainText('Semana de noviembre E2E');
  await expect(mine).toContainText('Anuladas: Al final no se cogieron E2E');
  await expect(mine).toContainText('días que te tocan');
  // Historia, no evaluación: aquí no hay porcentajes ni notas de nadie.
  await expect(mine).not.toContainText('%');

  // Nada que descartar a mano: mirar es lo que apaga el aviso.
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await expect(page.getByText('Te han apuntado vacaciones')).toHaveCount(0);
});

test('Ana ve su saldo, sus periodos y lo decidido, pero no escribe ni decide nada', async ({ page }) => {
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

  // Lo decidido sobre SUS días sí lo ve —es su expediente, y lleva importe—,
  // pero en solo lectura: la decisión es de quien administra la casa.
  const carry = carryoverCard(page);
  await expect(carry).toContainText(
    `30 días arrastrados del primer año, hasta el ${FIRST_YEAR_DEADLINE_LABEL}`
  );
  await expect(carry.getByRole('button', { name: 'Arrastrarlos' })).toHaveCount(0);
  await expect(carry.getByRole('button', { name: 'Darlos por perdidos' })).toHaveCount(0);
  // Y sólo lo suyo: la decisión sobre su compañera no es asunto suyo.
  await expect(carry).not.toContainText('no se arrastraron');

  // El derecho pactado se lee en el historial del acuerdo, que ahora vive en
  // su pestaña de Condiciones, no en un rótulo suelto.
  await page.goto(`/h/${HOUSEHOLD}/employment/condiciones`);
  const versionsCard = page.locator('article.card').filter({ hasText: 'Tu contrato, versión a versión' });
  await expect(versionsCard).toContainText('30 días naturales al año de vacaciones');
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
  // El historial enseña TODOS los años de contrato, también el primero, que
  // cerró sin un solo día apuntado: un año en blanco es información, y
  // saltárselo dejaría un agujero que parece un dato perdido.
  await expect(cards.first()).toContainText(`– ${FIRST_YEAR_ENDS_LABEL}`);
  // Lo anulado sigue a la vista, y sigue sin contar.
  await expect(page.getByText('Anuladas: Al final no se cogieron E2E')).toBeVisible();
});
