import { expect, test } from '@playwright/test';
import pg from 'pg';

import { HOUSEHOLD, loginAs } from './helpers';

// Calendario real (Ola E) contra Postgres: vacío honesto sin fuentes, alta de
// un calendario enlazado desde la propia página en lenguaje llano, eventos
// «sincronizados» (la función definer del worker) visibles en Calendario y en
// Hoy, y visor con agenda pero sin gestión.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const SOURCE_LABEL = 'Cole de los niños (E2E)';
const SOURCE_URL = 'https://calendario.example.com/cole-e2e.ics';

// La misma fecha civil de Madrid que usan los loads de Calendario y Hoy.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

async function withAdminDb<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    return await operation(admin);
  } finally {
    await admin.end();
  }
}

test('sin calendarios enlazados, el vacío es honesto y el alta habla llano', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/calendar`);
  await expect(page.getByRole('heading', { name: 'Ningún calendario enlazado todavía' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('demostración');

  // El formulario explica el alta sin tecnicismos por delante.
  await page.getByRole('button', { name: 'Enlazar un calendario' }).first().click();
  await expect(page.getByText('Pega el enlace de tu calendario')).toBeVisible();

  // Y en Hoy no hay bloque de agenda que finja eventos.
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await expect(page.locator('body')).not.toContainText('Hoy en el calendario');
});

test('la familia enlaza un calendario desde la página y queda listado', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/calendar`);
  await page.getByRole('button', { name: 'Enlazar un calendario' }).first().click();
  await page.getByLabel('¿De quién es este calendario?').fill(SOURCE_LABEL);
  await page.getByLabel('Enlace del calendario').fill(SOURCE_URL);
  await page.getByRole('button', { name: 'Enlazar el calendario' }).click();

  await expect(page.getByRole('heading', { name: 'Calendarios enlazados' })).toBeVisible();
  await expect(page.getByText(SOURCE_LABEL)).toBeVisible();
  await expect(page.getByText('Pendiente de la primera lectura')).toBeVisible();

  // El alta encoló la sincronización real con la URL en el payload.
  const job = await withAdminDb((admin) =>
    admin.query(
      `select payload from app_private.job_queue
        where household_id = $1 and job_type = 'ics.sync_source'
        order by created_at desc limit 1`,
      [HOUSEHOLD]
    )
  );
  expect(job.rows[0]?.payload).toEqual({ url: SOURCE_URL, sourceId: expect.any(String) });
});

test('los eventos sincronizados se ven en el Calendario y en Hoy', async ({ page }) => {
  // El «worker» de esta batería: la función definer de la 0015 persiste las
  // ocurrencias como lo haría ics.sync_source tras descargar la fuente.
  await withAdminDb(async (admin) => {
    const source = await admin.query(
      `select id from app.ics_sources where household_id = $1 and label = $2`,
      [HOUSEHOLD, SOURCE_LABEL]
    );
    const sourceId = source.rows[0]?.id as string;
    expect(sourceId).toBeTruthy();
    await admin.query('select app_private.replace_ics_source_events($1, $2, $3::jsonb)', [
      HOUSEHOLD,
      sourceId,
      JSON.stringify([
        {
          uid: 'natacion-e2e@example.com',
          startsAt: `${TODAY}T10:00:00Z`,
          endsAt: `${TODAY}T11:00:00Z`,
          allDay: false,
          summary: 'Natación (E2E)',
          location: 'Piscina municipal',
          contentHash: 'a'.repeat(64)
        },
        {
          uid: 'excursion-e2e@example.com',
          startsAt: `${TODAY}T05:00:00Z`,
          endsAt: null,
          allDay: true,
          summary: 'Excursión del cole (E2E)',
          location: null,
          contentHash: 'b'.repeat(64)
        }
      ])
    ]);
    await admin.query("select app_private.record_ics_sync($1, $2, '')", [HOUSEHOLD, sourceId]);
  });

  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/calendar`);
  await expect(page.getByText('Natación (E2E)')).toBeVisible();
  await expect(page.getByText('Excursión del cole (E2E)')).toBeVisible();
  await expect(page.getByText('Todo el día').first()).toBeVisible();
  await expect(page.getByText(`· ${SOURCE_LABEL}`).first()).toBeVisible();
  await expect(page.getByText('Al día (leído el').first()).toBeVisible();

  // Y el bloque de agenda real de Hoy lista los eventos del día.
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await expect(page.getByRole('heading', { name: 'Hoy en el calendario' })).toBeVisible();
  await expect(page.getByText('Natación (E2E)')).toBeVisible();
});

test('el visor ve la agenda del hogar pero no la gestión de calendarios', async ({ page }) => {
  await loginAs(page, 'viewer');
  await page.goto(`/h/${HOUSEHOLD}/calendar`);
  await expect(page.getByText('Natación (E2E)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enlazar un calendario' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Calendarios enlazados');
});
