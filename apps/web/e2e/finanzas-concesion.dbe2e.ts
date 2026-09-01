import { expect, test, type Locator, type Page } from '@playwright/test';

import pg from 'pg';

import { HOUSEHOLD, loginAs } from './helpers';

/**
 * La tarjeta de concesiones de Finanzas, medida por lo que VE LA PERSONA.
 *
 * Esta batería existe porque las otras no bastaban, y conviene que quede
 * escrito por qué. La propiedad que hay que garantizar —«la fila no dice
 * "Activado" de algo que el servidor no ha aceptado»— se defendió primero con
 * expresiones regulares sobre el código, después con un tipo, después con un
 * ayudante que no reenvía ganchos y después con un recorrido del árbol
 * sintáctico. Cada defensa cayó ante una forma de escribirlo que no habíamos
 * imaginado: la clave computada, envolver el bloque vigilado en lugar de
 * sustituirlo, reasignar la fuente río arriba, mutar la fila con
 * `admin.granted = !admin.granted`. Siempre queda una escritura más, porque
 * todas esas pruebas miraban CÓMO está escrito el componente.
 *
 * Aquí se mira otra cosa: con el servidor diciendo que no, ¿qué acaba viendo
 * quien pulsa? Eso no depende de la sintaxis, así que cubre también las formas
 * que no se nos han ocurrido. Las defensas anteriores se conservan porque son
 * baratas y cazan antes —en el compilador, o en un test de milisegundos—, pero
 * la que manda es esta.
 *
 * Las tres superficies se comprueban JUNTAS y en cada caso: el chip, la frase
 * de debajo del nombre y la etiqueta del botón. Una fila que dice «Apagado»
 * mientras su botón ofrece «Desactivar Finanzas» no es media verdad: no hay
 * forma de saber cuál de las dos es.
 */
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
test.describe.configure({ mode: 'serial' });
// Sin service worker: el `page.route` que intercepta /api/v1/sync solo alcanza
// las peticiones que emite la página, no las de un SW que controle la pestaña.
test.use({ serviceWorkers: 'block' });

/**
 * Segunda administración del hogar, propia de esta batería (prefijo ab9…, sin
 * choque con las fixtures 1…/2… ni con la siembra aa… de e2e). Hace falta una
 * fila que NO sea la de quien mira y que empiece APAGADA: así el interruptor
 * concede —la dirección en la que una mentira optimista se ve mejor— y no hay
 * confirmación de por medio. Se retira en el `afterAll`: las baterías vecinas
 * (mobile-densidad visita las siete rutas de Finanzas como esta administración)
 * tienen que encontrar el hogar como estaba.
 */
const ADMIN2_MEMBERSHIP = 'ab900000-0000-4000-8000-000000000001';
const ADMIN2_USER = 'e2e:roble:admin2';
const ADMIN2_NAME = 'Ada Concesión E2E';

async function onDatabase(work: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

test.beforeAll(async () => {
  await onDatabase(async (client) => {
    await client.query(`
      BEGIN;
      SET LOCAL row_security = off;
      INSERT INTO app.user_profiles (user_id, display_name)
        VALUES ('${ADMIN2_USER}', '${ADMIN2_NAME}');
      INSERT INTO app.household_memberships (id, household_id, user_id, role)
        VALUES ('${ADMIN2_MEMBERSHIP}', '${HOUSEHOLD}', '${ADMIN2_USER}', 'family_admin');
      COMMIT;
    `);
  });
});

test.afterAll(async () => {
  await onDatabase(async (client) => {
    // Las concesiones primero: la clave foránea a la membresía es RESTRICT.
    await client.query(`
      BEGIN;
      SET LOCAL row_security = off;
      DELETE FROM app.finance_module_grants WHERE membership_id = '${ADMIN2_MEMBERSHIP}';
      DELETE FROM app.household_memberships WHERE id = '${ADMIN2_MEMBERSHIP}';
      DELETE FROM app.user_profiles WHERE user_id = '${ADMIN2_USER}';
      COMMIT;
    `);
  });
});

function financeRow(page: Page, name: string): Locator {
  return page.locator('ul[data-lista="finanzas"] > li').filter({ hasText: name });
}

/**
 * Lo que la fila dice de sí misma, por sus tres superficies a la vez. Se afirma
 * también la AUSENCIA del estado contrario: un chip que miente no se detecta
 * comprobando que el verdadero sigue por ahí, sino que el falso no está.
 */
async function expectRowSays(row: Locator, state: 'activado' | 'apagado'): Promise<void> {
  const granted = state === 'activado';
  const [chip, opposite] = granted ? ['Activado', 'Apagado'] : ['Apagado', 'Activado'];
  await expect(row.locator('.status-chip').filter({ hasText: chip })).toBeVisible();
  await expect(row.locator('.status-chip').filter({ hasText: opposite })).toHaveCount(0);
  await expect(row.locator('small')).toHaveText(
    granted ? 'Ve el módulo de Finanzas' : 'No ve el módulo de Finanzas'
  );
  await expect(
    row.getByRole('button', {
      name: `${granted ? 'Desactivar' : 'Activar'} Finanzas a ${ADMIN2_NAME}`,
      exact: true
    })
  ).toBeVisible();
  // Y el botón contrario no existe: si existieran los dos, la fila ofrecería
  // encender y apagar lo mismo al mismo tiempo.
  await expect(
    row.getByRole('button', {
      name: `${granted ? 'Activar' : 'Desactivar'} Finanzas a ${ADMIN2_NAME}`,
      exact: true
    })
  ).toHaveCount(0);
}

async function gotoSettings(page: Page): Promise<Locator> {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/settings`);
  await expect(page.getByRole('heading', { name: 'Quién puede ver las finanzas de la casa' })).toBeVisible();
  const row = financeRow(page, ADMIN2_NAME);
  await expect(row).toBeVisible();
  return row;
}

test('con el servidor rechazando el comando, la fila NO dice que esté activado', async ({ page }) => {
  const row = await gotoSettings(page);
  await expectRowSays(row, 'apagado');

  // El servidor contesta que no. Es un ACK de rechazo real —el mismo que
  // devuelve el dispatcher ante `already_granted`—, no un fallo de transporte:
  // la aplicación SÍ recibe respuesta, y la respuesta es «no».
  await page.route('**/api/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { commands: { operationId: string }[] };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        apiVersion: 1,
        acknowledgements: body.commands.map((command) => ({
          operationId: command.operationId,
          status: 'rejected',
          errorCode: 'already_granted'
        }))
      })
    });
  });

  await row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();

  // El acuse dice la verdad, con la causa traducida de esta tarjeta…
  await expect(page.locator('.form-error')).toContainText('Esa cuenta ya tiene Finanzas activado');
  // …y la fila sigue diciendo lo que dice el servidor, por las tres.
  await expectRowSays(row, 'apagado');
  await page.unroute('**/api/v1/sync');

  // Y no era una carrera ganada por poco: sigue igual pasado un momento.
  await page.waitForTimeout(1000);
  await expectRowSays(row, 'apagado');
});

test('con la red cortada, la fila tampoco se adelanta: queda en cola y lo dice', async ({ page }) => {
  const row = await gotoSettings(page);
  await expectRowSays(row, 'apagado');

  // Sin respuesta ninguna: el comando queda en el almacén local y se enviará al
  // recuperar la conexión. Lo que NO puede hacer la tarjeta es dar por hecho el
  // final: mientras nadie lo haya aceptado, la fila sigue apagada.
  await page.route('**/api/v1/sync', (route) => route.abort());
  await row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();

  await expect(page.locator('.queued-note')).toContainText('se enviará al recuperar la conexión', {
    timeout: 15_000
  });
  await expectRowSays(row, 'apagado');
  await page.unroute('**/api/v1/sync');
});

test('con el servidor aceptando, la fila SÍ refleja el cambio', async ({ page }) => {
  // El caso simétrico, que es lo que impide «arreglar» los dos de arriba
  // dejando la fila clavada: aceptado el comando, la concesión aparece.
  const row = await gotoSettings(page);
  await expectRowSays(row, 'apagado');

  await row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();

  await expect(page.locator('.success-message')).toContainText('Guardado ✓', { timeout: 15_000 });
  await expectRowSays(row, 'activado');

  // Y sobrevive a una recarga: lo que se ve es lo que hay en la base, no un
  // estado de pantalla que se deshace al volver a entrar.
  await page.reload();
  await expectRowSays(financeRow(page, ADMIN2_NAME), 'activado');
});
