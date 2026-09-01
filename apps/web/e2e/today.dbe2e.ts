import { expect, test } from '@playwright/test';
import pg from 'pg';

import { HOUSEHOLD, E2E_SEED, loginAs } from './helpers';

// «Hoy» real contra Postgres (UX-P1-1/UX-P1-2 y enmienda E5): la pantalla de
// aterrizaje agrega lo urgente por rol («Necesita tu decisión») con resolución
// a 1 click, la rutina del día se marca con el comando real (routine.complete)
// sin dejar jamás el banner rojo del bug routine_occurrence, y las tres
// correcciones del propietario funcionan de verdad:
//
//   E5.1 · desmarcar lo marcado por error, sin motivo y sin perder la fecha.
//   E5.2 · el detalle al tocar el título, y solo si la rutina lo tiene.
//   E5.3 · «Esta semana», después de lo de hoy y sin nada que marcar.
//
// La siembra es propia del spec (ids ab…) y relativa a HOY: los specs previos
// de la batería ya consumieron la jornada requested y la rutina de la siembra
// global, así que este archivo crea sus propios hechos pendientes.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const EXTRA_HOY = 'ab600000-0000-4000-8000-000000000001';
const ROUTINE_HOY = 'ab500000-0000-4000-8000-000000000001';
const ROUTINE_SIN_DETALLE = 'ab500000-0000-4000-8000-000000000002';
const ROUTINE_DIARIA = 'ab500000-0000-4000-8000-000000000003';
const ROUTINE_EN_DOS_DIAS = 'ab500000-0000-4000-8000-000000000004';

// La misma fecha civil de Madrid que usa el load de Hoy.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Pasado mañana: dentro de la ventana de «Esta semana» (hoy+1 … hoy+6) y con
// nombre de día distinto del de hoy y del de mañana.
const EN_DOS_DIAS = addDays(TODAY, 2);
const EN_DOS_DIAS_ISODOW = ((new Date(`${EN_DOS_DIAS}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const DIA_EN_DOS_DIAS = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  timeZone: 'UTC'
}).format(new Date(`${EN_DOS_DIAS}T00:00:00Z`));

test.beforeAll(async () => {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`
      BEGIN;
      SET LOCAL row_security = off;

      INSERT INTO app.extra_work_events (
        id, household_id, agreement_id, employee_membership_id, kind, worked_on,
        duration_minutes, note, origin, status, requested_by_membership_id, requested_at
      ) VALUES (
        '${EXTRA_HOY}', '${HOUSEHOLD}', '${E2E_SEED.agreement}', '${E2E_SEED.memberships.employee}',
        'overtime', '${TODAY}', 90, 'Recogida del tinte E2E-HOY', 'employee_report',
        'requested', '${E2E_SEED.memberships.employee}', now() - interval '1 hour'
      ) ON CONFLICT DO NOTHING;

      INSERT INTO app.extra_work_transitions (
        id, household_id, extra_work_event_id, sequence_number, from_status, to_status,
        actor_membership_id, occurred_at, reason
      ) VALUES (
        'ab610000-0000-4000-8000-000000000001', '${HOUSEHOLD}', '${EXTRA_HOY}', 1, NULL, 'requested',
        '${E2E_SEED.memberships.employee}', now() - interval '1 hour', 'Solicitada E2E-HOY'
      ) ON CONFLICT DO NOTHING;

      INSERT INTO app.routines (
        id, household_id, title, details, audience, next_due_hint, created_by_membership_id,
        pattern, anchor_on, repeat_every, weekdays, overdue_policy
      ) VALUES
        -- Con detalle: su título abre el desplegable nativo (E5.2).
        ('${ROUTINE_HOY}', '${HOUSEHOLD}', 'Riego de la terraza E2E-HOY', 'Solo las jardineras',
         'employee', '${TODAY}', '${E2E_SEED.memberships.admin}',
         'every_n_days', '${TODAY}', 7, NULL, 'carry'),
        -- Sin detalle: su título NO debe fingir que se pulsa.
        ('${ROUTINE_SIN_DETALLE}', '${HOUSEHOLD}', 'Buzón E2E-HOY', '',
         'employee', '${TODAY}', '${E2E_SEED.memberships.admin}',
         'every_n_days', '${TODAY}', 7, NULL, 'carry'),
        -- Diaria: en «Esta semana» se resume, no se repite seis veces.
        ('${ROUTINE_DIARIA}', '${HOUSEHOLD}', 'Ventilación E2E-HOY', '',
         'employee', '${TODAY}', '${E2E_SEED.memberships.admin}',
         'every_n_days', '${TODAY}', 1, NULL, 'skip'),
        -- De un día fijo: la que sí merece su grupo con el día nombrado.
        ('${ROUTINE_EN_DOS_DIAS}', '${HOUSEHOLD}', 'Colada E2E-HOY', '',
         'employee', '${EN_DOS_DIAS}', '${E2E_SEED.memberships.admin}',
         'days_of_week', '${EN_DOS_DIAS}', 1, ARRAY[${EN_DOS_DIAS_ISODOW}]::smallint[], 'skip')
      ON CONFLICT DO NOTHING;

      COMMIT;
    `);
  } finally {
    await admin.end();
  }
});

test('Alberto ve la jornada sembrada en «Necesita tu decisión» y llega a resolverla en 1 click', async ({ page }) => {
  await loginAs(page, 'admin');

  // Fecha real (no la maqueta) y el bloque de decisiones arriba.
  const heading = page.getByRole('heading', { name: 'Necesita tu decisión' });
  await expect(heading).toBeVisible();

  const decisionRow = page
    .locator('section', { has: heading })
    .locator('.ledger-list > div')
    .filter({ hasText: 'Recogida del tinte E2E-HOY' });
  await expect(decisionRow).toContainText('Jornada extra solicitada');

  // Las rutinas de HOY ya no piden decisión una a una: son el trabajo, y viven
  // en su tarjeta. Solo el atraso real merece una línea aquí.
  await expect(
    page.locator('.ledger-list > div').filter({ hasText: 'Rutina de hoy:' })
  ).toHaveCount(0);

  // 1 click: del item de Hoy al ancla de la jornada, en su pestaña (Conceptos).
  await decisionRow.getByRole('link', { name: 'Revisar' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/h/${HOUSEHOLD}/employment/conceptos\\?empleada=${E2E_SEED.agreement}#extra-${EXTRA_HOY}$`)
  );

  const extraRow = page.locator(`#extra-${EXTRA_HOY}`);
  await expect(extraRow).toContainText('Recogida del tinte E2E-HOY');
  await expect(extraRow).toContainText('Solicitada');
  await expect(extraRow.getByRole('button', { name: 'Aceptar' })).toBeVisible();
});

test('el detalle se abre al tocar el título, y solo si la rutina lo tiene (E5.2)', async ({ page }) => {
  await loginAs(page, 'employee');

  const conDetalle = page
    .locator('#rutinas-de-hoy .ledger-list > div')
    .filter({ hasText: 'Riego de la terraza E2E-HOY' });
  // El texto ya viajó con la página: está en el DOM, plegado, sin JavaScript.
  await expect(conDetalle).toContainText('Solo las jardineras');
  const detalle = conDetalle.locator('details.routine-detail');
  await expect(detalle.locator('summary')).toHaveText('Riego de la terraza E2E-HOY');
  await expect(detalle.locator('p')).toBeHidden();
  await detalle.locator('summary').click();
  await expect(detalle.locator('p')).toBeVisible();

  // Sin detalle no hay desplegable: el título no finge que se pulsa.
  const sinDetalle = page
    .locator('#rutinas-de-hoy .ledger-list > div')
    .filter({ hasText: 'Buzón E2E-HOY' });
  await expect(sinDetalle.locator('details.routine-detail')).toHaveCount(0);
  await expect(sinDetalle.locator('strong')).toHaveText('Buzón E2E-HOY');
});

test('«Esta semana» agrupa por día, resume lo diario y no deja marcar nada (E5.3)', async ({ page }) => {
  await loginAs(page, 'employee');

  const semana = page.locator('.routine-week');
  await expect(semana.getByRole('heading', { name: 'Esta semana' })).toBeVisible();

  // Va DESPUÉS de lo de hoy: es información para planificar, no deberes.
  const posiciones = await page.evaluate(() => {
    const hoy = document.querySelector('#rutinas-de-hoy .ledger-list');
    const semanaEl = document.querySelector('.routine-week');
    return hoy && semanaEl
      ? (hoy.compareDocumentPosition(semanaEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      : false;
  });
  expect(posiciones).toBe(true);

  // La diaria se dice UNA vez con su cadencia; la de un día fijo tiene su grupo
  // con el día NOMBRADO, no una fecha suelta.
  await expect(semana.locator('.routine-week-repeats')).toContainText('Ventilación E2E-HOY');
  await expect(semana.locator('.routine-week-repeats')).toContainText('todos los días');
  const grupo = semana.getByRole('list', { name: `El ${DIA_EN_DOS_DIAS}` });
  await expect(grupo).toContainText('Colada E2E-HOY');

  // Nada accionable: desde aquí no se marca por adelantado.
  await expect(semana.getByRole('button')).toHaveCount(0);
});

test('Ana marca su rutina de hoy, la deshace por error de dedo y vuelve a estar pendiente (E5.1)', async ({ page }) => {
  await loginAs(page, 'employee');

  const routineRow = page
    .locator('#rutinas-de-hoy .ledger-list > div')
    .filter({ hasText: 'Riego de la terraza E2E-HOY' });
  await routineRow.getByRole('button', { name: 'Marcar hecha' }).click();

  // El comando real (routine.complete) sincroniza. La fila NO desaparece en
  // seco (P3): queda atenuada, con el chip «Hecha ✓ · próxima el X» —escrito en
  // el servidor— pintado al instante. Nada de «Revisión necesaria».
  await expect(routineRow.locator('.status-chip').filter({ hasText: 'Hecha ✓ · próxima el' })).toBeVisible();
  await expect(routineRow).toHaveClass(/routine-done/);
  await expect(routineRow.getByRole('button', { name: 'Marcar hecha' })).toHaveCount(0);
  await expect(page.locator('.status-banner')).toHaveCount(0);
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');

  // Deshacer desde el MISMO sitio donde se marcó, y sin pedir motivo.
  await routineRow.getByRole('button', { name: 'Deshacer' }).click();
  await expect(page.locator('.status-banner')).toHaveCount(0);

  // Sin recargar, la rutina vuelve a estar pendiente PARA EL DÍA QUE LE TOCABA:
  // la fecha se restaura, no se recalcula. Esperar a que reaparezca el botón es
  // además la señal de que el comando llegó al servidor, no solo de que se
  // pintó algo.
  const marcable = page
    .locator('#rutinas-de-hoy .ledger-list > div')
    .filter({ hasText: 'Riego de la terraza E2E-HOY' })
    .filter({ has: page.getByRole('button', { name: 'Marcar hecha' }) });
  await expect(marcable).toHaveCount(1);
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');

  // Y sigue pendiente tras recargar: lo deshecho quedó guardado de verdad.
  await page.reload();
  const restaurada = page
    .locator('#rutinas-de-hoy .ledger-list > div')
    .filter({ hasText: 'Riego de la terraza E2E-HOY' });
  await expect(restaurada.getByRole('button', { name: 'Marcar hecha' })).toBeVisible();
});

test('el completado anulado no se borra: queda anotado con quién lo marcó y quién lo deshizo', async () => {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query<{
      due_on: string;
      voided: boolean;
      completed_by: string;
      voided_by: string | null;
    }>(
      `select due_on::text as due_on,
              voided_at is not null as voided,
              completed_by_membership_id::text as completed_by,
              voided_by_membership_id::text as voided_by
         from app.routine_completions
        where household_id = $1 and routine_id = $2`,
      [HOUSEHOLD, ROUTINE_HOY]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      due_on: TODAY,
      voided: true,
      completed_by: E2E_SEED.memberships.employee,
      voided_by: E2E_SEED.memberships.employee
    });
  } finally {
    await admin.end();
  }
});
