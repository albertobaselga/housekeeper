import { expect, test, type Locator, type Page } from '@playwright/test';

import pg from 'pg';

import { E2E_APP_LOGIN, E2E_APP_PASSWORD } from '../playwright.db.config';
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
 * imaginado, porque todas miraban CÓMO está escrito el componente. Siempre
 * queda una escritura más.
 *
 * Aquí se mira otra cosa: con el servidor diciendo que no, ¿qué acaba viendo
 * quien pulsa? Eso no depende de la sintaxis, así que cubre también las formas
 * que no se nos han ocurrido. Las defensas anteriores se conservan porque son
 * baratas y cazan antes —en el compilador, o en un test de milisegundos—, pero
 * la que manda es esta.
 *
 * Tres decisiones que no son de adorno:
 *
 * 1. **Las tres superficies, juntas y en cada caso**: el chip, la frase de
 *    debajo del nombre y el botón —su texto VISIBLE y su nombre accesible—. Una
 *    fila que dice «Apagado» mientras su botón ofrece «Desactivar Finanzas» no
 *    es media verdad: no hay forma de saber cuál de las dos es.
 * 2. **La ventana en vuelo, con un observador de mutaciones**. Mirar la fila
 *    después del acuse deja libre todo el viaje de red: se puede pintar la
 *    mentira entera durante dos segundos y deshacerla al resolver. Y añadir una
 *    aserción «en vuelo» tampoco vale, porque las de Playwright reintentan: en
 *    cuanto la mentira desaparece, pasan. El observador se instala ANTES del
 *    clic, guarda una instantánea por cada cambio del DOM de la fila, y al
 *    final se afirma sobre el registro entero. Es determinista y no reintenta.
 * 3. **En los dos tamaños**, incluido el móvil de 390 px: pintar la mentira
 *    solo por debajo de 500 px la escondería de una batería que corre a 1.280,
 *    y esta es una aplicación pensada para el móvil.
 */
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');
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

const TARJETA = 'section[aria-labelledby="finance-grants-title"]';

async function onDatabase(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`BEGIN; SET LOCAL row_security = off;\n${sql}\nCOMMIT;`);
  } finally {
    await client.end();
  }
}

/** Retira todo rastro de la segunda administración. Vale como limpieza y como preludio del alta. */
const RETIRAR = `
  DELETE FROM app.finance_module_grants WHERE membership_id = '${ADMIN2_MEMBERSHIP}';
  DELETE FROM app.household_memberships WHERE id = '${ADMIN2_MEMBERSHIP}';
  DELETE FROM app.user_profiles WHERE user_id = '${ADMIN2_USER}';
`;

test.beforeAll(async () => {
  // El alta empieza por retirar: si una ejecución anterior se cortó antes de
  // limpiar, sin esto la siguiente revienta por clave duplicada y deja una fila
  // de más en Ajustes para las baterías vecinas.
  await onDatabase(`
    ${RETIRAR}
    INSERT INTO app.user_profiles (user_id, display_name)
      VALUES ('${ADMIN2_USER}', '${ADMIN2_NAME}');
    INSERT INTO app.household_memberships (id, household_id, user_id, role)
      VALUES ('${ADMIN2_MEMBERSHIP}', '${HOUSEHOLD}', '${ADMIN2_USER}', 'family_admin');
  `);
});

test.beforeEach(async () => {
  // Cada caso parte de la fila APAGADA: el que concede de verdad (el simétrico)
  // deja la concesión puesta, y el siguiente tamaño de pantalla la encontraría.
  await onDatabase(`DELETE FROM app.finance_module_grants WHERE membership_id = '${ADMIN2_MEMBERSHIP}';`);
});

test.afterAll(async () => {
  await onDatabase(RETIRAR);
});

function financeRow(page: Page, name: string): Locator {
  return page.locator('ul[data-lista="finanzas"] > li').filter({ hasText: name });
}

/** Lo que la fila enseña de sí misma en un instante dado. */
interface Instantanea {
  chips: string[];
  frase: string;
  botonVisible: string;
  botonEtiqueta: string;
}

/**
 * Lo que la fila dice de sí misma, por sus superficies a la vez. Se afirma
 * también la AUSENCIA del estado contrario: un chip que miente no se detecta
 * comprobando que el verdadero sigue por ahí, sino que el falso no está.
 */
async function expectRowSays(row: Locator, state: 'activado' | 'apagado'): Promise<void> {
  const granted = state === 'activado';
  const [chip, opposite] = granted ? ['Activado', 'Apagado'] : ['Apagado', 'Activado'];
  const chipVisible = row.locator('.status-chip').filter({ hasText: chip });
  await expect(chipVisible).toBeVisible();
  await expect(row.locator('.status-chip').filter({ hasText: opposite })).toHaveCount(0);
  // También el TONO, no solo la palabra: el verde dice «esta cuenta ve las
  // finanzas de la casa», y a un metro de distancia el color se lee antes que el
  // texto. Un chip «Apagado» pintado de logro no lo detectaba nadie.
  if (granted) await expect(chipVisible).toHaveClass(/success/);
  else await expect(chipVisible).not.toHaveClass(/success/);
  await expect(row.locator('small')).toHaveText(
    granted ? 'Ve el módulo de Finanzas' : 'No ve el módulo de Finanzas'
  );

  const boton = row.getByRole('button', {
    name: `${granted ? 'Desactivar' : 'Activar'} Finanzas a ${ADMIN2_NAME}`,
    exact: true
  });
  await expect(boton).toBeVisible();
  // El TEXTO VISIBLE, no solo el nombre accesible: localizar el botón por su
  // `aria-label` deja que lo que se lee en pantalla diga lo contrario sin que
  // nadie se entere.
  const visible = granted ? 'Desactivar Finanzas' : 'Activar Finanzas';
  await expect(boton).toHaveText(visible);
  // Y el nombre accesible CONTIENE el visible (WCAG 2.5.3, «etiqueta en el
  // nombre»): quien maneja la casa por voz dice lo que lee.
  expect(await boton.getAttribute('aria-label')).toContain(visible);
  // El botón contrario no existe: si existieran los dos, la fila ofrecería
  // encender y apagar lo mismo al mismo tiempo.
  await expect(
    row.getByRole('button', {
      name: `${granted ? 'Activar' : 'Desactivar'} Finanzas a ${ADMIN2_NAME}`,
      exact: true
    })
  ).toHaveCount(0);
}

/**
 * Instala un observador de mutaciones sobre la fila y guarda una instantánea de
 * sus superficies por cada cambio del DOM. Es lo único que distingue «no pinta»
 * de «la prueba mira tarde»: una aserción normal reintenta, y una mentira que
 * dura lo que dura el viaje de red pasaría inadvertida.
 */
async function observarFila(page: Page, nombre: string): Promise<void> {
  await page.evaluate((name) => {
    // Se vigila la LISTA, no la fila, y la fila se vuelve a buscar en cada
    // instantánea. Un observador atado al <li> deja de ver nada en cuanto el
    // framework SUSTITUYE ese nodo —un `{#key}` alrededor basta—: se queda
    // mirando un nodo separado, registra sólo la foto inicial, y mientras tanto
    // la fila de la pantalla puede decir lo que quiera.
    const lista = document.querySelector('ul[data-lista="finanzas"]');
    if (!lista) throw new Error('Sin lista de concesiones de Finanzas');
    const instantanea = () => {
      const fila = [...lista.querySelectorAll(':scope > li')].find((item) =>
        item.textContent?.includes(name)
      );
      if (!fila) return { chips: [], frase: '', botonVisible: '', botonEtiqueta: '' };
      const boton = fila.querySelector('button');
      return {
        chips: [...fila.querySelectorAll('.status-chip')].map((chip) => chip.textContent?.trim() ?? ''),
        frase: fila.querySelector('small')?.textContent?.trim() ?? '',
        botonVisible: boton?.textContent?.trim() ?? '',
        botonEtiqueta: boton?.getAttribute('aria-label') ?? ''
      };
    };
    const registro = [instantanea()];
    const observer = new MutationObserver(() => registro.push(instantanea()));
    observer.observe(lista, { subtree: true, childList: true, characterData: true, attributes: true });
    Reflect.set(window, '__filaObservada', { registro, observer });
  }, nombre);
}

async function instantaneas(page: Page): Promise<Instantanea[]> {
  return page.evaluate(() => {
    const observado = Reflect.get(window, '__filaObservada') as
      | { registro: unknown[]; observer: MutationObserver }
      | undefined;
    if (!observado) throw new Error('El observador no llegó a instalarse');
    observado.observer.disconnect();
    return observado.registro as never[];
  });
}

/**
 * El observador tiene que haber visto MOVERSE la fila: el chip «Enviando…»
 * aparece siempre al pulsar. Que el registro no esté vacío no basta —la foto
 * inicial siempre está—, y un registro que sólo tiene esa foto significa que se
 * vigiló un nodo que ya no es el de la pantalla.
 */
function expectObservoLaFilaDeVerdad(vistas: Instantanea[]): void {
  expect(
    vistas.filter((vista) => vista.chips.includes('Enviando…')),
    'el observador no llegó a ver el chip «Enviando…»: vigilaba un nodo que dejó de estar en la pantalla'
  ).not.toEqual([]);
}

/** En NINGUNA de las instantáneas la fila pudo decir que la cuenta tiene Finanzas. */
function expectNuncaDijoActivado(vistas: Instantanea[]): void {
  expectObservoLaFilaDeVerdad(vistas);
  const mentiras = vistas.filter(
    (vista) =>
      vista.chips.includes('Activado') ||
      vista.frase === 'Ve el módulo de Finanzas' ||
      vista.botonVisible === 'Desactivar Finanzas' ||
      vista.botonEtiqueta.startsWith('Desactivar')
  );
  expect(mentiras, 'la fila dijo que la cuenta tiene Finanzas en algún instante').toEqual([]);
}

/**
 * El simétrico, y no es una comprobación de adorno: adelantarse al REVOCAR dice
 * «Apagado» de una cuenta que sigue viendo las cifras de la casa. Quien lo mira
 * cree que ha cerrado el acceso y no lo ha cerrado, que es la peor de las dos
 * mentiras posibles en esta tarjeta.
 */
function expectNuncaDijoApagado(vistas: Instantanea[]): void {
  expectObservoLaFilaDeVerdad(vistas);
  const mentiras = vistas.filter(
    (vista) =>
      vista.chips.includes('Apagado') ||
      vista.frase === 'No ve el módulo de Finanzas' ||
      vista.botonVisible === 'Activar Finanzas' ||
      vista.botonEtiqueta.startsWith('Activar')
  );
  expect(mentiras, 'la fila dijo que la cuenta ya no tiene Finanzas en algún instante').toEqual([]);
}

async function gotoSettings(page: Page): Promise<Locator> {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/settings`);
  await expect(page.getByRole('heading', { name: 'Quién puede ver las finanzas de la casa' })).toBeVisible();
  const row = financeRow(page, ADMIN2_NAME);
  await expect(row).toBeVisible();
  return row;
}

/** Los tres casos, declarados una vez y ejecutados en los dos tamaños. */
function casos(): void {
  test('con el servidor rechazando el comando, la fila NO dice que esté activado', async ({ page }) => {
    const row = await gotoSettings(page);
    await expectRowSays(row, 'apagado');

    // El servidor contesta que no, y TARDA: sin esa espera no habría ventana en
    // vuelo que vigilar, que es justo donde cabía la mentira. Es un ACK de
    // rechazo real —el que devuelve el dispatcher ante `already_granted`—, no
    // un fallo de transporte: la aplicación recibe respuesta, y es «no».
    await page.route('**/api/v1/sync', async (route) => {
      const body = route.request().postDataJSON() as { commands: { operationId: string }[] };
      await new Promise((resolve) => setTimeout(resolve, 1200));
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

    await observarFila(page, ADMIN2_NAME);
    await row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();

    // El acuse dice la verdad, con la causa traducida de ESTA tarjeta (la
    // pantalla tiene dos notas: esta y la de accesos).
    await expect(page.locator(TARJETA).locator('.form-error')).toContainText(
      'Esa cuenta ya tiene Finanzas activado'
    );
    // …y en NINGÚN instante del viaje la fila dijo lo contrario.
    expectNuncaDijoActivado(await instantaneas(page));
    await expectRowSays(row, 'apagado');
    await page.unroute('**/api/v1/sync');
  });

  test('con la red cortada, la fila tampoco se adelanta: queda en cola y lo dice', async ({ page }) => {
    const row = await gotoSettings(page);
    await expectRowSays(row, 'apagado');

    // Sin respuesta ninguna: el comando queda en el almacén local y se enviará
    // al recuperar la conexión. Lo que NO puede hacer la tarjeta es dar por
    // hecho el final: mientras nadie lo haya aceptado, la fila sigue apagada.
    await page.route('**/api/v1/sync', (route) => route.abort());
    await observarFila(page, ADMIN2_NAME);
    await row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();

    await expect(page.locator(TARJETA).locator('.queued-note')).toContainText(
      'se enviará al recuperar la conexión',
      { timeout: 15_000 }
    );
    expectNuncaDijoActivado(await instantaneas(page));
    await expectRowSays(row, 'apagado');
    await page.unroute('**/api/v1/sync');
  });

  test('revocando, la fila tampoco se adelanta: sigue diciendo que la cuenta ve Finanzas', async ({
    page
  }) => {
    // La única dirección que no medía nadie. Los otros casos parten de la fila
    // apagada y conceden; aquí se parte de la concesión puesta y se retira.
    await onDatabase(`
      INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
        VALUES ('${HOUSEHOLD}', '${ADMIN2_MEMBERSHIP}', '11000000-0000-4000-8000-000000000001');
    `);
    const row = await gotoSettings(page);
    await expectRowSays(row, 'activado');

    await page.route('**/api/v1/sync', async (route) => {
      const body = route.request().postDataJSON() as { commands: { operationId: string }[] };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          apiVersion: 1,
          acknowledgements: body.commands.map((command) => ({
            operationId: command.operationId,
            status: 'rejected',
            errorCode: 'not_granted'
          }))
        })
      });
    });

    await observarFila(page, ADMIN2_NAME);
    await row.getByRole('button', { name: `Desactivar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();

    await expect(page.locator(TARJETA).locator('.form-error')).toContainText(
      'Esa cuenta no tiene Finanzas activado'
    );
    expectNuncaDijoApagado(await instantaneas(page));
    await expectRowSays(row, 'activado');
    await page.unroute('**/api/v1/sync');
  });

  test('con el servidor aceptando, la fila SÍ refleja el cambio', async ({ page }) => {
    // El caso simétrico, que es lo que impide «arreglar» los dos de arriba
    // dejando la fila clavada: aceptado el comando, la concesión aparece.
    const row = await gotoSettings(page);
    await expectRowSays(row, 'apagado');

    await row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();

    await expect(page.locator(TARJETA).locator('.success-message')).toContainText('Guardado ✓', {
      timeout: 15_000
    });
    await expectRowSays(row, 'activado');

    // Y sobrevive a una recarga: lo que se ve es lo que hay en la base, no un
    // estado de pantalla que se deshace al volver a entrar.
    await page.reload();
    await expectRowSays(financeRow(page, ADMIN2_NAME), 'activado');
  });
}

test.describe('la tarjeta de concesiones no miente · escritorio', () => {
  test.describe.configure({ mode: 'serial' });
  casos();
});

test.describe('la tarjeta de concesiones no miente · móvil de 390', () => {
  test.describe.configure({ mode: 'serial' });
  // El tamaño real del contrato móvil (mismo que mobile-densidad): una mentira
  // pintada solo por debajo de 500 px no se le escapa a esta mitad.
  test.use({ viewport: { width: 390, height: 844 } });
  casos();
});

// ─────────────────────────────────────────────────────────────────────────────
// T3′ (fase 7, endurecimiento): los cuatro casos de arriba miran la FILA —que
// no mienta mientras el comando viaja—. Este mira un paso más allá: que
// conceder/revocar cambie de verdad lo que la administración puede ABRIR, no
// solo lo que la tarjeta dice de sí misma.
//
// Se revoca/concede la fila de ADMIN2 y no la de Alberto (el admin de esta
// batería) a propósito: quitarse Finanzas A SÍ MISMO exige el diálogo
// «Quitarme Finanzas ahora» (askFinance/confirmingFinanceId, arriba en este
// mismo fichero) y la concesión de Alberto la dan por sentada TODAS las specs
// de Finanzas que corren después en esta misma base compartida y con un solo
// worker (finanzas-revision.dbe2e, finanzas-importar.dbe2e, mobile-densidad
// visitando las siete rutas «como esta administración»). La fila de ADMIN2 no
// es «propia» desde la sesión de Alberto: el botón concede/revoca sin pasar
// por ese diálogo, y el `beforeEach` de arriba ya la deja apagada antes de
// cada test.
//
// Lo que NO se hace, y por qué: ADMIN2 no tiene cuenta en el selector de
// cuentas demo con el que arranca esta batería (`HOUSEKEEPER_FIXTURE_LOGIN`) —
// vive solo en la base (alta hecha por SQL en el `beforeAll` de arriba), no en
// la lista fija de `$lib/server/fixtures.server.ts` (comprobado leyendo ese
// fichero: `listDemoUsers`/`getDemoUser` solo conocen las cinco cuentas de
// `ACCOUNT_EMAILS`). No hay, por tanto, una pestaña en la que «entrar como
// ADMIN2» para leer un 200/403 de su navegación de verdad — y dar de alta una
// sexta cuenta demo solo para esta prueba sería tocar producción para una
// tarea que pide SOLO añadir un test a este fichero.
//
// Se comprueba en su lugar el mismo cerrojo que consulta el layout del hogar
// antes de decidir esos 200/403 y antes de construir las capacidades de las
// que sale la entrada de navegación (`[householdId]/+layout.server.ts`:
// `financeGranted` decide las dos cosas a la vez) — `app.finance_enabled()`,
// bajo RLS real y con el MISMO login de aplicación sin privilegios con el que
// corre el servidor bajo prueba (`e2e_housekeeper_web`, `nobypassrls`). No es
// una prueba escrita aparte que pueda divergir del cerrojo real: son las
// mismas tres llamadas que hace `financeAccessGranted()`
// (`finance-access.server.ts`) — fijar `app.user_id`, resolver la membresía
// viva y fijar el contexto del hogar — reproducidas aquí en SQL porque ese
// módulo vive en `$lib/server` y no es código de prueba.

/** El login de aplicación (sin privilegios), igual que usa el servidor bajo prueba — no el admin del `onDatabase` de arriba, que se salta la RLS a propósito. */
function appConnectionString(): string {
  const url = new URL(process.env.E2E_DATABASE_URL ?? '');
  url.username = E2E_APP_LOGIN;
  url.password = E2E_APP_PASSWORD;
  return url.toString();
}

/**
 * ¿Ve `userId` el módulo de Finanzas ahora mismo? Mismos tres pasos que
 * `withAuthorizedTransaction` (`packages/server/src/database.ts`), que es lo
 * que `financeAccessGranted()` llama de verdad en el servidor: fijar la
 * identidad, resolver la membresía viva del hogar y fijar su contexto — y
 * solo entonces preguntarle al cerrojo. Bajo RLS real: sin este contexto,
 * `finance_module_grants` no le enseña ni una fila a nadie.
 */
async function financeEnabledFor(userId: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: appConnectionString() });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const membership = await client.query<{ id: string; household_id: string }>(
      `select id, household_id from app.household_memberships
        where user_id = $1 and household_id = $2
          and starts_at <= now() and revoked_at is null
          and (expires_at is null or expires_at > now())
        limit 1`,
      [userId, HOUSEHOLD]
    );
    const row = membership.rows[0];
    if (!row) throw new Error(`Sin membresía viva de ${userId} en ${HOUSEHOLD}`);
    await client.query('select app.set_household_context($1, $2)', [row.household_id, row.id]);
    const result = await client.query<{ enabled: boolean }>('select app.finance_enabled() as enabled');
    await client.query('commit');
    return Boolean(result.rows[0]?.enabled);
  } catch (cause) {
    await client.query('rollback');
    throw cause;
  } finally {
    await client.end();
  }
}

test('la concesión cambia lo visible', async ({ page }) => {
  const row = await gotoSettings(page);

  // Apagada de partida (el `beforeEach` de arriba lo garantiza): ni la fila lo
  // dice ni el cerrojo real se lo concede — lo que ADMIN2 encontraría al abrir
  // /h/<id>/finanzas si pudiera entrar con su propia cuenta.
  await expect(row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true })).toBeVisible();
  expect(await financeEnabledFor(ADMIN2_USER)).toBe(false);

  // Conceder desde SU fila (no la de Alberto): sin diálogo de por medio.
  await row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();
  await expect(page.locator(TARJETA).locator('.success-message')).toContainText('Guardado ✓', {
    timeout: 15_000
  });
  // El acuse no es de adorno: el mismo cerrojo que le abriría la navegación y
  // la entrada de menú a ADMIN2 ya dice que sí.
  await expect(row.getByRole('button', { name: `Desactivar Finanzas a ${ADMIN2_NAME}`, exact: true })).toBeVisible();
  expect(await financeEnabledFor(ADMIN2_USER)).toBe(true);

  // Revocar: vuelve a lo de antes, tanto en la tarjeta como en el cerrojo real.
  await row.getByRole('button', { name: `Desactivar Finanzas a ${ADMIN2_NAME}`, exact: true }).click();
  await expect(page.locator(TARJETA).locator('.success-message')).toContainText('Guardado ✓', {
    timeout: 15_000
  });
  await expect(row.getByRole('button', { name: `Activar Finanzas a ${ADMIN2_NAME}`, exact: true })).toBeVisible();
  expect(await financeEnabledFor(ADMIN2_USER)).toBe(false);
});
