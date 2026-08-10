import { expect, test } from '@playwright/test';
import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

// Ola D-1: en modo real el paquete offline deja de servir maquetas. Sin
// conexión, la página de último recurso enseña el día del hogar (menú y
// rutinas que vencen) y las instrucciones FIJADAS de la Guía con su contenido,
// todo desde el CriticalSnapshot firmado que se guardó en el dispositivo.
//
// Siembra propia (ids ac…) y relativa a HOY: los specs previos de la batería
// consumen la rutina de la siembra global, así que este archivo crea la suya.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const SPACE = 'ac400000-0000-4000-8000-000000000001';
const PAGE_PINNED = 'ac410000-0000-4000-8000-000000000001';
const REVISION = 'ac411000-0000-4000-8000-000000000001';
const ROUTINE_OFF = 'ac500000-0000-4000-8000-000000000001';

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

test.beforeAll(async () => {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`
      BEGIN;
      SET LOCAL row_security = off;

      INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id)
      VALUES ('${SPACE}', '${HOUSEHOLD}', 'sin-conexion-e2e', 'Imprescindibles E2E', 'Lo que hay que saber sí o sí', 7,
              '${E2E_SEED.memberships.admin}')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.wiki_pages (id, household_id, space_id, parent_page_id, status, current_slug, pinned, position, created_by_membership_id)
      VALUES ('${PAGE_PINNED}', '${HOUSEHOLD}', '${SPACE}', NULL, 'published', 'llave-del-agua-e2e', true, 0,
              '${E2E_SEED.memberships.admin}')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.wiki_page_slugs (household_id, page_id, slug)
      VALUES ('${HOUSEHOLD}', '${PAGE_PINNED}', 'llave-del-agua-e2e')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id)
      VALUES ('${REVISION}', '${HOUSEHOLD}', '${PAGE_PINNED}', 1,
              'Llave de corte del agua E2E',
              'La llave está bajo el fregadero de la cocina.

Gírala hacia la derecha hasta el tope y avisa a la familia.',
              '', ARRAY[]::text[], ARRAY[]::text[], '${E2E_SEED.memberships.admin}')
      ON CONFLICT DO NOTHING;

      UPDATE app.wiki_pages SET current_revision_id = '${REVISION}' WHERE id = '${PAGE_PINNED}';

      INSERT INTO app.routines (
        id, household_id, title, details, audience, frequency, interval_count,
        next_due_on, created_by_membership_id,
        pattern, anchor_on, repeat_every
      ) VALUES (
        '${ROUTINE_OFF}', '${HOUSEHOLD}', 'Cerrar el gas por la noche E2E-OFF', 'Llave de la cocina',
        'all', 'daily', 1, '${TODAY}', '${E2E_SEED.memberships.admin}',
        'every_n_days', '${TODAY}', 1
      ) ON CONFLICT DO NOTHING;

      COMMIT;
    `);
  } finally {
    await admin.end();
  }
});

test('Ana sin conexión ve el día y las instrucciones fijadas REALES del hogar', async ({ page, context }) => {
  await loginAs(page, 'employee');

  // El service worker controla la página y el snapshot firmado ya está en
  // IndexedDB (lo guarda el monitor de sincronización al montar la carcasa).
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
    timeout: 20_000
  });
  await page.waitForFunction(
    async (householdId) => {
      const request = indexedDB.open('casa-clara-web');
      const database = await new Promise<IDBDatabase | null>((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (!database) return false;
      if (!database.objectStoreNames.contains('criticalSnapshots')) return false;
      const read = database.transaction('criticalSnapshots').objectStore('criticalSnapshots').get(householdId);
      return await new Promise<boolean>((resolve) => {
        read.onsuccess = () => resolve(Boolean(read.result));
        read.onerror = () => resolve(false);
      });
    },
    HOUSEHOLD,
    { timeout: 20_000 }
  );

  await context.setOffline(true);
  try {
    // Navegación completa a una página nunca visitada: el service worker no la
    // tiene en caché y sirve la página de último recurso.
    await page.goto(`/h/${HOUSEHOLD}/recipes`);

    // Instrucciones fijadas de la Guía, con su contenido legible sin red.
    await expect(page.getByRole('heading', { name: 'Instrucciones guardadas' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Llave de corte del agua E2E' })).toBeVisible();
    await expect(page.locator('body')).toContainText('bajo el fregadero de la cocina');
    await expect(page.locator('body')).toContainText('Imprescindibles E2E');

    // El día del hogar: la rutina que vence hoy sale con su estado.
    await expect(page.getByRole('heading', { name: 'El día de hoy' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tareas que tocan hoy' })).toBeVisible();
    await expect(page.locator('body')).toContainText('Cerrar el gas por la noche E2E-OFF');

    // Y ni rastro de la maqueta: el paquete offline ya no sirve fixtures.
    await expect(page.locator('body')).not.toContainText('Rutina de sueño de Leo');
    await expect(page.locator('body')).not.toContainText('No uses el programa rápido');
    await expect(page.locator('body')).not.toContainText('Leo · sin lácteos');
    if (process.env.E2E_SHOT_DIR) {
      await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/d1-snapshot-offline-real.png`, fullPage: true });
    }
  } finally {
    await context.setOffline(false);
  }
});
