import { expect, test } from '@playwright/test';
import pg from 'pg';

import { HOUSEHOLD, E2E_SEED, loginAs } from './helpers';

// «Hoy» real contra Postgres (UX-P1-1/UX-P1-2): la pantalla de aterrizaje
// agrega lo urgente por rol («Necesita tu decisión») con resolución a 1 click,
// y la rutina del día se marca desde Hoy con el comando real (routine.complete)
// sin dejar jamás el banner rojo del bug routine_occurrence.
//
// La siembra es propia del spec (ids ab…) y relativa a HOY: los specs previos
// de la batería ya consumieron la jornada requested y la rutina de la siembra
// global, así que este archivo crea sus propios hechos pendientes.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const EXTRA_HOY = 'ab600000-0000-4000-8000-000000000001';
const ROUTINE_HOY = 'ab500000-0000-4000-8000-000000000001';

// La misma fecha civil de Madrid que usa el load de Hoy.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

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
        id, household_id, title, details, audience, frequency, interval_count,
        next_due_on, created_by_membership_id,
        pattern, anchor_on, repeat_every
      ) VALUES (
        '${ROUTINE_HOY}', '${HOUSEHOLD}', 'Riego de la terraza E2E-HOY', 'Solo las jardineras',
        'employee', 'weekly', 1, '${TODAY}', '${E2E_SEED.memberships.admin}',
        'every_n_days', '${TODAY}', 7
      ) ON CONFLICT DO NOTHING;

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

  // 1 click: del item de Hoy al ancla de la jornada en Acuerdos y pagos.
  await decisionRow.getByRole('link', { name: 'Revisar' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/h/${HOUSEHOLD}/employment\\?empleada=${E2E_SEED.agreement}#extra-${EXTRA_HOY}$`)
  );

  const extraRow = page.locator(`#extra-${EXTRA_HOY}`);
  await expect(extraRow).toContainText('Recogida del tinte E2E-HOY');
  await expect(extraRow).toContainText('Solicitada');
  await expect(extraRow.getByRole('button', { name: 'Aceptar' })).toBeVisible();
});

test('Ana marca su rutina de hoy desde Hoy sin banner rojo y la recurrencia avanza', async ({ page }) => {
  await loginAs(page, 'employee');

  // Su rutina aflora también como decisión con ancla a la propia sección.
  await expect(
    page.locator('.ledger-list > div').filter({ hasText: 'Rutina de hoy: Riego de la terraza E2E-HOY' })
  ).toBeVisible();

  const routineRow = page
    .locator('#rutinas-de-hoy .ledger-list > div')
    .filter({ hasText: 'Riego de la terraza E2E-HOY' });
  await expect(routineRow).toContainText('Hoy');

  await routineRow.getByRole('button', { name: 'Marcar hecha' }).click();

  // El comando real (routine.complete) sincroniza y la función definer avanza
  // la recurrencia. La fila NO desaparece en seco (P3): queda atenuada, con el
  // chip optimista «Hecha ✓ · próxima el X» pintado al instante. Nada de
  // «Revisión necesaria».
  await expect(routineRow.locator('.status-chip').filter({ hasText: 'Hecha ✓ · próxima el' })).toBeVisible();
  await expect(routineRow).toHaveClass(/routine-done/);
  await expect(routineRow.getByRole('button', { name: 'Marcar hecha' })).toHaveCount(0);
  await expect(page.locator('.status-banner')).toHaveCount(0);
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');
});
