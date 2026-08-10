import { expect, test } from '@playwright/test';
import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

// Ola D-2: la foto del justificante hecha SIN conexión acaba unida a su gasto
// sola. Sin red la foto se guarda en el dispositivo y el gasto la espera; al
// volver la conexión la foto se sube primero y su identificador entra en el
// mismo comando, así que el gasto nace ya con el justificante enlazado.
//
// La tubería de adjuntos real necesita un almacén de objetos, que no existe en
// esta batería: se sustituye SOLO ese salto (la respuesta de /attachments) por
// un objeto de almacenamiento sembrado de verdad en Postgres. Todo lo demás
// —outbox, re-enlace, comando, RLS y documento— es real.
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const STORAGE_OBJECT = 'ad800000-0000-4000-8000-000000000001';
const DESCRIPTION = 'Farmacia con foto sin red E2E';

// Cuenta de marzo de la fixture: cerrada, pagada y con cobro confirmado. Su
// gasto de farmacia se enlaza aquí con el documento que la fixture ya trae,
// como haría el comando del gasto con foto (Ola D-3).
const CLOSED_EXPENSE = '12a00000-0000-4000-8000-000000000001';
const FIXTURE_DOCUMENT = '12f00000-0000-4000-8000-000000000002';

test.beforeAll(async () => {
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`
      BEGIN;
      SET LOCAL row_security = off;

      INSERT INTO app.storage_objects (
        id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
      ) VALUES (
        '${STORAGE_OBJECT}', '${HOUSEHOLD}', 'casa-clara-e2e', '${HOUSEHOLD}/attachments/ticket-e2e.jpg',
        'image/jpeg', 1024, '${'a'.repeat(64)}', '${E2E_SEED.memberships.employee}'
      ) ON CONFLICT DO NOTHING;

      UPDATE app.expenses SET receipt_document_id = '${FIXTURE_DOCUMENT}' WHERE id = '${CLOSED_EXPENSE}';

      COMMIT;
    `);
  } finally {
    await admin.end();
  }
});

test('Ana hace la foto sin conexión y el gasto llega con su justificante enlazado', async ({ page, context }) => {
  await loginAs(page, 'employee');

  // El único salto simulado: el almacén de objetos devuelve el identificador
  // del objeto sembrado, como haría Supabase Storage en un entorno completo.
  await page.route(`**/api/v1/households/${HOUSEHOLD}/attachments`, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ apiVersion: 1, storageObjectId: STORAGE_OBJECT, sha256: 'a'.repeat(64) })
    })
  );

  await page.goto(`/h/${HOUSEHOLD}/employment`);
  const form = page.locator('form.action-form').filter({ hasText: 'Añadir gasto' });
  await expect(form).toBeVisible();

  await context.setOffline(true);
  try {
    // La foto ya NO exige conexión: los campos siguen disponibles sin red.
    // Son DOS: elegir un fichero y hacer la foto. Con `capture` puesto el móvil
    // abre la cámara y deja de ofrecer la galería, así que uno solo no basta.
    const camera = form.getByLabel('Hacer la foto ahora');
    await expect(camera).toBeEnabled();
    await expect(camera).toHaveAttribute('capture', 'environment');
    await expect(form.getByLabel('Elegir un fichero o una foto guardada')).toBeEnabled();
    await expect(form).toContainText('Se guarda en este dispositivo y se une al gasto en cuanto vuelva la red');

    await camera.setInputFiles({
      name: 'ticket.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    });
    // La foto se prepara al elegirla; el gasto no sale hasta que está lista.
    await expect(form).toContainText('Adjunto: ticket.jpg');
    await form.getByLabel('Importe (€)').fill('21,75');
    await form.getByLabel('Descripción').fill(DESCRIPTION);
    await form.getByRole('button', { name: 'Añadir gasto' }).click();

    // Nota veraz: el gasto está guardado aquí y espera a la red por la foto.
    await expect(form.locator('.status-chip')).toContainText('La foto se unirá al gasto con conexión');
    await expect(page.locator('.sync-pill')).toContainText('Sin conexión · 1 pendiente');
  } finally {
    await context.setOffline(false);
  }

  // Vuelve la red: la foto sube y el gasto sale con el justificante dentro.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');

  await page.reload();
  const row = page.locator('.ledger-list > div').filter({ hasText: DESCRIPTION });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Justificante adjunto ✓');
  if (process.env.E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/d2-foto-offline-a-gasto.png`, fullPage: true });
  }

  // Y en la base de datos el gasto quedó con su documento de justificante.
  const admin = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await admin.connect();
  try {
    const result = await admin.query<{ storage_object_id: string }>(
      `select document.storage_object_id
         from app.expenses as expense
         join app.documents as document
           on document.household_id = expense.household_id
          and document.id = expense.receipt_document_id
        where expense.household_id = $1 and expense.description = $2`,
      [HOUSEHOLD, DESCRIPTION]
    );
    expect(result.rows.map((row) => row.storage_object_id)).toEqual([STORAGE_OBJECT]);
  } finally {
    await admin.end();
  }
});

test('Alberto ve el justificante del gasto reembolsado en la cuenta de marzo ya pagada', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/employment`);

  const pharmacyLine = page.locator('.ledger-list > div').filter({ hasText: 'Fixture pharmacy reimbursement' });
  await expect(pharmacyLine).toBeVisible();
  const link = pharmacyLine.getByRole('link', { name: 'Ver el justificante' });
  await expect(link).toHaveAttribute(
    'href',
    `/api/v1/households/${HOUSEHOLD}/receipts/${CLOSED_EXPENSE}`
  );

  // La línea del gasto SIN foto no ofrece enlace: no se inventa nada.
  const groceryLine = page.locator('.ledger-list > div').filter({ hasText: 'Fixture grocery reimbursement' });
  await expect(groceryLine.getByRole('link', { name: 'Ver el justificante' })).toHaveCount(0);
  if (process.env.E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/d3-justificante-cuenta-cerrada.png`, fullPage: true });
  }

  // Y la cuenta sigue siendo de solo lectura: la ruta no admite escritura.
  const response = await page.request.fetch(`/api/v1/households/${HOUSEHOLD}/receipts/${CLOSED_EXPENSE}`, {
    method: 'POST'
  });
  expect(response.status()).toBe(405);
});
