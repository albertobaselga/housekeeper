import { expect, test } from '@playwright/test';
import pg from 'pg';

import { HOUSEHOLD, loginAs } from './helpers';

// Ola D-4: escribir la PRIMERA instrucción de la Guía sin conexión. Antes hacía
// falta red porque el apartado «General» se creaba con un comando aparte y su
// identificador llegaba con el ACK. Ahora la nota nombra su apartado por slug y
// el servidor lo da de alta al aplicarla, así que el gesto entero funciona
// offline.
//
// Para reproducir una Guía recién estrenada, el spec archiva los apartados del
// hogar y los devuelve a su sitio al terminar (la batería corre en serie, con
// un único worker: nadie ve el hueco).
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });

const TITLE = 'Dónde está la llave del gas E2E-OFF';

let archivedSpaceIds: string[] = [];

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
  await withAdmin(async (admin) => {
    const archived = await admin.query<{ id: string }>(
      `update app.wiki_spaces set archived_at = now()
        where household_id = $1 and archived_at is null
        returning id`,
      [HOUSEHOLD]
    );
    archivedSpaceIds = archived.rows.map((row) => row.id);
  });
});

test.afterAll(async () => {
  await withAdmin(async (admin) => {
    // Los apartados vuelven a su sitio. La nota de prueba y su apartado
    // «General» se quedan (las revisiones de la Guía son inmutables por
    // diseño): el global setup recrea el esquema en cada ejecución.
    if (archivedSpaceIds.length > 0) {
      await admin.query(`update app.wiki_spaces set archived_at = null where id = any($1::uuid[])`, [
        archivedSpaceIds
      ]);
    }
  });
});

test('Alberto escribe la primera instrucción sin conexión y se guarda al volver la red', async ({
  page,
  context
}) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/wiki`);

  await page.getByRole('button', { name: 'Escribir una instrucción' }).click();
  const composer = page.locator('section.wiki-composer');
  await expect(composer).toBeVisible();
  // La Guía está recién estrenada: ni un apartado que elegir, y el aviso ya no
  // pide conexión.
  await expect(composer.locator('select')).toHaveCount(0);
  await expect(composer).toContainText('Se guardará en el apartado «General», que se crea solo');
  await expect(composer).toContainText('Funciona también sin conexión');

  // Texto sin formato: el editor visual es un chunk aparte y aquí solo importa
  // el camino del comando.
  await composer.locator('.wiki-advanced summary').click();
  await composer.getByRole('button', { name: 'Escribir en Markdown' }).click();

  await context.setOffline(true);
  try {
    await composer.getByLabel('¿Sobre qué?').fill(TITLE);
    await composer.locator('textarea').fill('La llave está junto a la cocina, detrás de la puerta.');
    await composer.getByRole('button', { name: 'Guardar y publicar' }).click();

    // Nota unificada y honesta: guardada aquí, sin prometer que ya está.
    await expect(page.locator('.queued-note')).toContainText('Guardado en este dispositivo');
    await expect(page.locator('.sync-pill')).toContainText('Sin conexión · 1 pendiente');
    if (process.env.E2E_SHOT_DIR) {
      await page.screenshot({
        path: `${process.env.E2E_SHOT_DIR}/d4-primera-nota-sin-red.png`,
        fullPage: true
      });
    }
  } finally {
    await context.setOffline(false);
  }

  // Vuelve la red: el comando sale y el servidor crea «General» y la nota.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-pill')).toContainText('Todo guardado');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'General' }).first()).toBeVisible();
  await expect(page.locator('body')).toContainText(TITLE);

  const stored = await withAdmin((admin) =>
    admin.query<{ name: string; title: string; status: string }>(
      `select space.name, revision.title, page.status::text as status
         from app.wiki_pages as page
         join app.wiki_spaces as space
           on space.household_id = page.household_id and space.id = page.space_id
         join app.wiki_revisions as revision
           on revision.household_id = page.household_id and revision.id = page.current_revision_id
        where page.household_id = $1 and revision.title = $2`,
      [HOUSEHOLD, TITLE]
    )
  );
  expect(stored.rows).toEqual([{ name: 'General', title: TITLE, status: 'published' }]);
});
