import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

/** Comandos aún en el outbox local (0 = todos enviados y confirmados). */
function outboxCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('casa-clara-web');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('outbox')) {
            db.close();
            resolve(0);
            return;
          }
          const request = db.transaction('outbox', 'readonly').objectStore('outbox').count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => {
            db.close();
            reject(request.error);
          };
        };
      })
  );
}

// Latencia percibida (P2-1): el patrón optimista de la wiki replicado en los
// caminos dominantes. Este spec verifica las dos promesas nuevas:
//  1. Compra: dos marcados ENCADENADOS sin espera entre taps (sin `busy`
//     global) que ambos persisten en Postgres.
//  2. Hoy: el chip «Hecha ✓ · próxima el X» se pinta ANTES de que llegue el
//     ACK del servidor (red artificialmente lenta) y la fila no desaparece
//     en seco.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });
// Sin service worker: el `page.route` que retarda /api/v1/sync solo intercepta
// peticiones emitidas por la página (no las de un SW que controla la pestaña).
test.use({ serviceWorkers: 'block' });

const ROUTINE_LATENCIA = 'ab500000-0000-4000-8000-000000000099';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

test.beforeAll(async () => {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`
      BEGIN;
      SET LOCAL row_security = off;
      INSERT INTO app.routines (
        id, household_id, title, details, audience, next_due_hint, created_by_membership_id,
        pattern, anchor_on, repeat_every
      ) VALUES (
        '${ROUTINE_LATENCIA}', '${HOUSEHOLD}', 'Riego optimista E2E-LAT', '',
        'employee', '${TODAY}', '${E2E_SEED.memberships.admin}',
        'every_n_days', '${TODAY}', 7
      ) ON CONFLICT DO NOTHING;
      COMMIT;
    `);
  } finally {
    await admin.end();
  }
});

test('Ana marca dos artículos de la compra encadenados, sin esperar entre taps', async ({ page }) => {
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/menu`);
  await page.getByRole('button', { name: 'Lista de la compra' }).click();

  // Dos añadidos propios del spec (el formulario no bloquea la página).
  const addForm = page.locator('form.action-form').filter({ hasText: 'Escríbelo aquí' });
  for (const name of ['Cadena A E2E', 'Cadena B E2E']) {
    await addForm.getByRole('textbox', { name: 'Escríbelo aquí' }).fill(name);
    await addForm.getByRole('button', { name: 'Añadir a la compra' }).click();
    // La fila aparece al instante (optimista) y después llega la del servidor.
    await expect(page.locator('.ingredient-list li').filter({ hasText: name })).toBeVisible();
  }

  const itemA = page.locator('.ingredient-list li').filter({ hasText: 'Cadena A E2E' });
  const itemB = page.locator('.ingredient-list li').filter({ hasText: 'Cadena B E2E' });
  await expect(itemA.getByRole('checkbox')).toBeVisible();
  await expect(itemB.getByRole('checkbox')).toBeVisible();

  // Taps ENCADENADOS: el segundo entra mientras el primero aún viaja. Antes,
  // el `busy` global deshabilitaba todos los checkboxes hasta el invalidateAll.
  await itemA.getByRole('checkbox').check();
  await itemB.getByRole('checkbox').check();
  await expect(itemA.getByRole('checkbox')).toBeChecked();
  await expect(itemB.getByRole('checkbox')).toBeChecked();

  // Ambos comandos llegan al servidor (el reintento de flush encadenado envía
  // el segundo aunque el primero tuviese el flush en vuelo): el outbox local
  // queda a cero de forma ESTABLE antes de recargar (la doble lectura evita
  // muestrear el hueco entre el tap y la escritura en IndexedDB).
  await expect
    .poll(
      async () => {
        const first = await outboxCount(page);
        if (first > 0) return first;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return outboxCount(page);
      },
      { timeout: 10_000 }
    )
    .toBe(0);
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');
  await page.reload();
  await page.getByRole('button', { name: 'Lista de la compra' }).click();
  await expect(itemA.getByRole('checkbox')).toBeChecked();
  await expect(itemB.getByRole('checkbox')).toBeChecked();
});

test('el chip optimista de la rutina en Hoy se pinta antes del ACK y la fila no desaparece en seco', async ({ page }) => {
  await loginAs(page, 'employee');

  const routineRow = page
    .locator('#rutinas-de-hoy .ledger-list > div')
    .filter({ hasText: 'Riego optimista E2E-LAT' });
  await expect(routineRow).toBeVisible();

  // Red lenta artificial: el ACK tarda 1,5 s. El chip debe aparecer MUCHO
  // antes (pintado local inmediato), no tras el viaje de red.
  let syncRequests = 0;
  await page.route('**/api/v1/sync', async (route) => {
    syncRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  const clickedAt = Date.now();
  await routineRow.getByRole('button', { name: 'Marcar hecha' }).click();
  await expect(
    routineRow.locator('.status-chip').filter({ hasText: 'Hecha ✓ · próxima el' })
  ).toBeVisible({ timeout: 1000 });
  const chipAt = Date.now();
  await expect(routineRow).toHaveClass(/routine-done/);

  // Con el ACK real (≥1,5 s después), la nota verde confirma la aplicación,
  // la fila sigue visible (atenuada) y no queda ningún banner rojo. El retardo
  // tiene que haberse aplicado de verdad: el ACK no puede llegar antes de 1,5 s.
  await expect(page.locator('.success-message')).toContainText('Guardado ✓', { timeout: 15_000 });
  expect(syncRequests).toBeGreaterThan(0);
  expect(chipAt - clickedAt).toBeLessThan(1000);
  expect(Date.now() - clickedAt).toBeGreaterThanOrEqual(1500);
  await page.unroute('**/api/v1/sync');
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');
  await expect(routineRow.locator('.status-chip').filter({ hasText: 'Hecha ✓' })).toBeVisible();
  await expect(page.locator('.status-banner')).toHaveCount(0);
});
