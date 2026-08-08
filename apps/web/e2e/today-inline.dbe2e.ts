import { expect, test } from '@playwright/test';
import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

// Ola D-5: los dos asuntos que se resuelven en un gesto («Confirmar» la comida
// y «Aceptar» la jornada extra) se resuelven DESDE Hoy, sin navegar. El enlace
// a la pantalla completa sigue ahí para todo lo demás.
//
// Siembra propia (ids ae…) y relativa a HOY, para no depender del estado que
// dejan los specs anteriores de la batería.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const GROUP = 'ae300000-0000-4000-8000-000000000001';
const SLOT = 'ae310000-0000-4000-8000-000000000001';
const EXTRA = 'ae600000-0000-4000-8000-000000000001';
const DISH = 'Sopa de puerros inline E2E';
const EXTRA_NOTE = 'Plancha inline E2E';

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

async function withAdmin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

test.beforeAll(async () => {
  await withAdmin((admin) =>
    admin.query(`
      BEGIN;
      SET LOCAL row_security = off;

      INSERT INTO app.menu_groups (id, household_id, name, position)
      VALUES ('${GROUP}', '${HOUSEHOLD}', 'Cocina inline E2E', 40)
      ON CONFLICT DO NOTHING;

      INSERT INTO app.menu_slots (
        id, household_id, group_id, on_date, meal, recipe_page_id, free_text, notes, updated_by_membership_id
      ) VALUES (
        '${SLOT}', '${HOUSEHOLD}', '${GROUP}', '${TODAY}', 'comida', NULL, '${DISH}', '',
        '${E2E_SEED.memberships.admin}'
      ) ON CONFLICT DO NOTHING;

      INSERT INTO app.extra_work_events (
        id, household_id, agreement_id, employee_membership_id, kind, worked_on,
        duration_minutes, note, origin, status, requested_by_membership_id, requested_at
      ) VALUES (
        '${EXTRA}', '${HOUSEHOLD}', '${E2E_SEED.agreement}', '${E2E_SEED.memberships.employee}',
        'overtime', '${TODAY}', 60, '${EXTRA_NOTE}', 'employee_report',
        'requested', '${E2E_SEED.memberships.employee}', now() - interval '30 minutes'
      ) ON CONFLICT DO NOTHING;

      INSERT INTO app.extra_work_transitions (
        id, household_id, extra_work_event_id, sequence_number, from_status, to_status,
        actor_membership_id, occurred_at, reason
      ) VALUES (
        'ae610000-0000-4000-8000-000000000001', '${HOUSEHOLD}', '${EXTRA}', 1, NULL, 'requested',
        '${E2E_SEED.memberships.employee}', now() - interval '30 minutes', 'Solicitada inline E2E'
      ) ON CONFLICT DO NOTHING;

      COMMIT;
    `)
  );
});

test('Alberto confirma la comida de hoy desde Hoy, sin salir de la página', async ({ page }) => {
  await loginAs(page, 'admin');

  const row = page.locator('.ledger-list > div').filter({ hasText: DISH });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Sin confirmar');

  await row.getByRole('button', { name: 'Confirmar' }).click();

  // Chip optimista al instante, nota unificada y NADA de navegar. La nota
  // verde solo aparece con el ACK real del servidor.
  await expect(row.locator('.status-chip').filter({ hasText: 'Confirmado' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/h/${HOUSEHOLD}/today$`));
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await expect(page.locator('.status-banner')).toHaveCount(0);
  // El camino largo sigue disponible.
  await expect(page.getByRole('link', { name: 'Ver la semana →' })).toBeVisible();
  if (process.env.E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/d5-confirmar-desde-hoy.png`, fullPage: true });
  }

  const confirmed = await withAdmin((admin) =>
    admin.query(`select 1 from app.menu_confirmations where household_id = $1 and slot_id = $2`, [
      HOUSEHOLD,
      SLOT
    ])
  );
  expect(confirmed.rowCount).toBe(1);
});

test('Alberto acepta la jornada extra desde Hoy, sin salir de la página', async ({ page }) => {
  await loginAs(page, 'admin');

  const decision = page.locator('.ledger-list > div').filter({ hasText: EXTRA_NOTE });
  await expect(decision).toContainText('Jornada extra solicitada');
  // El enlace a Acuerdos y pagos sigue estando junto al atajo.
  await expect(decision.getByRole('link', { name: 'Revisar' })).toBeVisible();

  await decision.getByRole('button', { name: 'Aceptar' }).click();

  await expect(decision.locator('.status-chip').filter({ hasText: 'Aceptada ✓' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/h/${HOUSEHOLD}/today$`));
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');

  const status = await withAdmin((admin) =>
    admin.query<{ status: string }>(`select status::text as status from app.extra_work_events where id = $1`, [
      EXTRA
    ])
  );
  expect(status.rows[0]?.status).toBe('accepted');
});
