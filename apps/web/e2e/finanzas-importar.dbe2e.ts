import { expect, test, type Page } from '@playwright/test';

import pg from 'pg';

import { E2E_SEED, HOUSEHOLD, loginAs } from './helpers';

test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

// [FASE 5, T12] Este es el ÚNICO dbe2e propietario de este fichero: la fase 7
// solo puede AÑADIR casos al final, nunca reescribirlo (brief).
const OPENBANK_HTML = `<html>
<head><title>OPENBANK - Cuentas - Movimientos</title></head>
<body><table>
<tr><td>Número de cuenta:</td><td>ES21 0073 0100 5500 9876 5432</td></tr>
<tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>05/07/2026</td><td>05/07/2026</td><td>TRANSFERENCIA A FAVOR DE CLARA DEMO, CONCEPTO ALQUILER JULIO</td><td>-850,00</td><td>1.150,00</td></tr>
<tr><td>03/07/2026</td><td>03/07/2026</td><td>LIQUIDACION CUENTA INTERESES</td><td>1,23</td><td>2.000,00</td></tr>
</table></body></html>`;

test('importar: previsualizar, dar de alta la cuenta, confirmar y deshacer', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);

  await page.setInputFiles('input[type="file"]', {
    name: 'movimientos-e2e.xls',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from(OPENBANK_HTML, 'latin1')
  });

  await expect(page.locator('body')).toContainText('2 nuevas');
  // [Corrección revisión #9] `retries: 1` (playwright.db.config.ts) puede
  // volver a correr esta prueba sobre la MISMA base si el fallo anterior fue
  // posterior a confirmar: «Deshacer» borra lote y transacciones, pero no la
  // cuenta que este test dio de alta, así que en la repetición `unknownRefs`
  // viene vacío, el fieldset no se pinta, y un `.fill(...)` incondicional
  // agotaría el timeout — convirtiendo una intermitencia en rojo fijo, sin
  // posibilidad de que el reintento pase nunca.
  const cuentaNueva = page.getByLabel('Nombre de la cuenta nueva');
  if ((await cuentaNueva.count()) > 0) await cuentaNueva.fill('OpenBank E2E');
  await page.getByRole('button', { name: 'Confirmar importación' }).click();

  await expect(page.locator('.success-message')).toContainText('Importadas 2');
  const fila = page.locator('tr', { hasText: 'movimientos-e2e.xls' });
  await expect(fila).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await fila.getByRole('button', { name: 'Deshacer' }).click();
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await expect(page.locator('tr', { hasText: 'movimientos-e2e.xls' })).toHaveCount(0);
});

// [FASE 7, T4] Ampliación: lo importado tiene que VERSE en Movimientos bajo
// RLS, y el deshacer tiene que dejarlo en cero. El ciclo de importación en sí
// ya lo cubre el test de arriba (fase 5): aquí se comprueba el efecto sobre
// los datos que ve la administración con concesión — y, por resolución del
// coordinador, que quien NO tiene Finanzas no ve esas MISMAS filas recién
// importadas, ni por pantalla ni por la API, en los dos repartos de la
// resolución: la empleada (le falta la capacidad por rol) y la administración
// sin concesión (tiene la capacidad y le falta el segundo cerrojo).
const MOVIMIENTOS_JULIO = `/h/${HOUSEHOLD}/finanzas/movimientos?from=2026-07-01&to=2026-07-31&q=ALQUILER+JULIO`;
const TRANSACCIONES_JULIO = `/api/v1/finance/transactions?household=${HOUSEHOLD}&from=2026-07-01&to=2026-07-31&q=${encodeURIComponent('ALQUILER JULIO')}`;

/**
 * El único movimiento que casa con el filtro: −850,00 € del extracto sintético,
 * en CÉNTIMOS y como cadena (la API serializa el `bigint` así; nunca `number`,
 * que es coma flotante y aquí es dinero).
 */
const ALQUILER_JULIO_CENTS = '-85000';

/**
 * La concesión de Finanzas de la administración del roble: la fila que siembra
 * `packages/db/fixtures/002_finance.sql:10-12`, con este identificador exacto.
 * Retirarla y devolverla es lo que permite medir de extremo a extremo la rama
 * «family_admin CON la capacidad por rol pero SIN concesión» — el segundo
 * cerrojo, `app.finance_enabled()` (packages/db/migrations/0036_finance.sql) —.
 * No hay ninguna cuenta de ese tipo en el selector de fixtures dbe2e, y sembrar
 * una nueva tocaría infraestructura compartida por las 18 specs; retirar y
 * restaurar la ya sembrada cabe entero en este fichero, con el patrón de
 * `finanzas-concesion.dbe2e.ts` (`SET LOCAL row_security = off`, restauración
 * que empieza por borrar, garantizada en el `afterEach`).
 */
const CONCESION_ADMIN = 'f1900000-0000-4000-8000-000000000001';
const ADMIN_MEMBERSHIP = E2E_SEED.memberships.admin;

async function onDatabase(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`BEGIN; SET LOCAL row_security = off;\n${sql}\nCOMMIT;`);
  } finally {
    await client.end();
  }
}

/** Deja a la administración con el rol intacto y el segundo cerrojo apagado. */
const RETIRAR_CONCESION = `
  DELETE FROM app.finance_module_grants
   WHERE household_id = '${HOUSEHOLD}' AND membership_id = '${ADMIN_MEMBERSHIP}';
`;

/**
 * Devuelve la concesión EXACTA de la fixture. Empieza por borrar para ser
 * idempotente: da igual si el cuerpo del test murió con la concesión retirada,
 * con ella puesta o entre medias — al salir hay una sola fila viva y es la de
 * siempre, así que las specs vecinas de la misma base encuentran el hogar como
 * estaba.
 */
const RESTAURAR_CONCESION = `
  ${RETIRAR_CONCESION}
  INSERT INTO app.finance_module_grants (id, household_id, membership_id, granted_by_membership_id)
    VALUES ('${CONCESION_ADMIN}', '${HOUSEHOLD}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}');
`;

/**
 * Lee la página de movimientos de la API sin `as` ni `!`: si la forma no es la
 * esperada, el fallo señala aquí en vez de colarse como un `undefined` que casa
 * con cualquier cosa.
 */
function paginaDeMovimientos(cuerpo: unknown): { total: number; sumCents: string } {
  if (typeof cuerpo !== 'object' || cuerpo === null) throw new Error('La API no devolvió un objeto');
  if (!('total' in cuerpo) || typeof cuerpo.total !== 'number') {
    throw new Error('Respuesta de movimientos sin `total` numérico');
  }
  if (!('sumCents' in cuerpo) || typeof cuerpo.sumCents !== 'string') {
    throw new Error('Respuesta de movimientos sin `sumCents` en céntimos');
  }
  return { total: cuerpo.total, sumCents: cuerpo.sumCents };
}

/**
 * Limpieza del hook: idempotente y a prueba de más de un lote homónimo. Deshace
 * de uno en uno hasta que no queda ninguno, con un solo `count()` por vuelta —
 * se lee al entrar al bucle y se decrementa en memoria—. Con dos lotes (un
 * reintento de Playwright que dejó uno a medio deshacer), deshacer solo el
 * primero y afirmar cero sobre TODAS las filas homónimas marcaría en rojo un
 * cuerpo que había pasado.
 */
async function deshacerSiQueda(page: Page): Promise<void> {
  await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
  const fila = page.locator('tr', { hasText: 'movimientos-e2e.xls' });
  let restantes = await fila.count();
  while (restantes > 0) {
    page.once('dialog', (dialog) => void dialog.accept());
    await fila.first().getByRole('button', { name: 'Deshacer' }).click();
    restantes -= 1;
    await expect(fila).toHaveCount(restantes);
  }
}

/**
 * El deshacer como ACCIÓN BAJO PRUEBA (no como limpieza, que es
 * `deshacerSiQueda`): afirma primero que la fila está. Si no lo estuviera, el
 * fallo real señala este sitio en vez de aparecer tres líneas después como
 * «esperaba 0 filas, había 1».
 */
async function deshacerLote(page: Page): Promise<void> {
  await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
  const fila = page.locator('tr', { hasText: 'movimientos-e2e.xls' });
  await expect(fila).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await fila.getByRole('button', { name: 'Deshacer' }).click();
  await expect(fila).toHaveCount(0);
}

test.describe('lo importado se ve y el deshacer lo borra', () => {
  test.afterEach(async ({ page }) => {
    // La concesión, PRIMERO y siempre: el resto de la limpieza deshace el lote
    // por la pantalla de Importar, que exige Finanzas abierto. Si el cuerpo
    // muriera con la concesión retirada, sin esta línea el propio hook se
    // estrellaría contra un 403 y dejaría el lote sembrado para las specs
    // vecinas de la misma base.
    await onDatabase(RESTAURAR_CONCESION);
    // El cuerpo cambia de sesión a mitad (comprobación de denegación de la
    // empleada, más abajo) y puede romperse ANTES de restaurar admin. Limpiar
    // cookies antes de entrar deja siempre el selector de cuentas —tanto si la
    // sesión viva era admin como si era la empleada—, así que el `loginAs` de
    // aquí ya no choca con «`/login` con sesión viva redirige directo a Hoy»
    // (routes/login/+page.server.ts): sin cookies no hay sesión viva.
    await page.context().clearCookies();
    await loginAs(page, 'admin');
    await deshacerSiQueda(page);
  });

  test('los movimientos del lote aparecen en Movimientos y desaparecen al deshacer', async ({ page }) => {
    await loginAs(page, 'admin');

    // Punto de partida: el hogar no tiene todavía el movimiento del extracto.
    // Se ancla primero a `.finance-ledger` (LedgerTable.svelte la pinta
    // siempre, con o sin filas): sin esto, un `.finance-row` en 0 pasaría
    // igual si la pantalla no fuese la de Movimientos.
    await page.goto(MOVIMIENTOS_JULIO);
    await expect(page.locator('.finance-ledger')).toBeVisible();
    await expect(page.locator('.finance-ledger .finance-row')).toHaveCount(0);

    // Importar el mismo extracto sintético de la fase 5 (en memoria, sin
    // ficheros binarios en el repo).
    await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
    await page.setInputFiles('input[type="file"]', {
      name: 'movimientos-e2e.xls',
      mimeType: 'application/vnd.ms-excel',
      buffer: Buffer.from(OPENBANK_HTML, 'latin1')
    });
    await expect(page.locator('body')).toContainText('2 nuevas');

    // El alta de cuenta es condicional a propósito: el test de la fase 5 corre
    // antes en este mismo fichero y su deshacer borra el lote y sus
    // transacciones, pero la cuenta «OpenBank E2E» que dio de alta se queda.
    // Si ya existe, la previsualización no pide crearla y no hay formulario.
    const nombreCuenta = page.getByLabel('Nombre de la cuenta nueva');
    if (await nombreCuenta.count()) {
      await nombreCuenta.fill('OpenBank E2E');
    }

    await page.getByRole('button', { name: 'Confirmar importación' }).click();
    await expect(page.locator('.success-message')).toContainText('Importadas 2');

    // El movimiento existe para la administración con concesión: RLS lo deja
    // pasar. El filtro `q=ALQUILER+JULIO` ya casa por `ilike` contra el
    // concepto en el servidor (readFinanceTransactions), así que el único
    // resultado es justo la fila importada; el título visible de la fila es
    // el beneficiario extraído del concepto de transferencia («CLARA DEMO»),
    // no el concepto en crudo (txTitle: providerDisplay || provider ||
    // concept) — se confirma también el importe exacto del extracto sintético.
    await page.goto(MOVIMIENTOS_JULIO);
    const filas = page.locator('.finance-ledger .finance-row');
    await expect(filas).toHaveCount(1);
    await expect(filas.first()).toContainText('CLARA DEMO');
    await expect(filas.first()).toContainText('850,00');

    // Control positivo, con la sesión de administración todavía viva: la MISMA
    // URL de la API responde 200 Y trae exactamente el movimiento importado.
    // Sin leer el cuerpo, un 200 con cero filas serviría igual de control y los
    // 404 de abajo medirían lo mismo que mediría una ruta que hubiese dejado de
    // existir. `sumCents` es la comprobación de que la fila es LA fila: el
    // importe del extracto, en céntimos.
    const concedida = await page.request.get(TRANSACCIONES_JULIO);
    expect(concedida.status()).toBe(200);
    expect(paginaDeMovimientos(await concedida.json())).toEqual({
      total: 1,
      sumCents: ALQUILER_JULIO_CENTS
    });

    // Resolución del coordinador (T4), primer reparto: la empleada no ve las
    // filas RECIÉN IMPORTADAS, ni por pantalla ni por la API.
    //
    // Por pantalla: `finance.access` no está entre las capacidades del rol
    // `employee_live_in` (packages/contracts/src/capabilities.ts) — la propia
    // matriz de capacidades ya la excluye, sin depender de ninguna concesión
    // —, así que el layout del hogar (`h/[householdId]/+layout.server.ts:70`)
    // corta con `error(403, 'Esta parte la lleva la familia.')` antes de que
    // `finanzas/movimientos/+page.server.ts` llegue a ejecutarse. La
    // resolución dice «404/redirección»; lo que ocurre de verdad es un 403 con
    // lenguaje de casa, porque el corte lo da el guard de capacidades sobre un
    // hogar del que la empleada SÍ es miembro (no hay hogar cuya existencia
    // ocultar). La regla «404 nunca 403» (Ruling R2) es de los endpoints de la
    // API — se comprueba justo debajo —; aquí se afirma el 403 explícito para
    // que la discrepancia con el texto de la resolución quede documentada en
    // el propio test, no callada detrás de un `toHaveCount(0)` que también
    // pasaría con una redirección al login.
    //
    // Por la API: el mismo doble cerrojo (`requireFinanceAdmin`, packages/
    // server/src/commands/finance.ts) rechaza por rol, y `financeRead`
    // (finance.server.ts) lo traduce SIEMPRE a 404 —nunca a 403, Ruling R2—
    // para no revelar que el hogar existe.
    await page.context().clearCookies();
    await loginAs(page, 'employee');
    const respuesta = await page.goto(MOVIMIENTOS_JULIO);
    expect(respuesta?.status()).toBe(403);
    await expect(page.locator('body')).toContainText('Esta parte la lleva la familia.');
    await expect(page.locator('.finance-ledger')).toHaveCount(0);
    const denegada = await page.request.get(TRANSACCIONES_JULIO);
    expect(denegada.status()).toBe(404);

    // Se restaura la sesión de administración: el segundo reparto de la
    // resolución y el deshacer de abajo (y, si el test se rompiera antes de
    // llegar aquí, el `afterEach`) la necesitan.
    await page.context().clearCookies();
    await loginAs(page, 'admin');

    // Resolución del coordinador (T4), segundo reparto: una administración CON
    // la capacidad por rol pero SIN concesión viva tampoco ve esas MISMAS
    // filas. Es la rama que el producto puede romper de verdad: la de la
    // empleada la corta la matriz de capacidades (estática), mientras que esta
    // depende de una consulta viva a `finance_module_grants` — el layout la
    // hace con `financeAccessGranted` y la API dentro de la transacción
    // autorizada, vía `app.finance_enabled()` —, que es justo el mecanismo que
    // un refactor puede dejar sin efecto. La única otra cobertura que tiene es
    // UNITARIA y con `requireFinanceAdmin` MOCKEADO
    // (`apps/web/tests/finance-endpoints.test.ts:300-324`): no toca base de
    // datos, RLS ni sesión real.
    //
    // Se mide sobre la MISMA cuenta que acaba de importar, con la MISMA sesión
    // y las MISMAS URLs: lo único que cambia entre el 200 de arriba y el
    // 403/404 de aquí es la fila de la concesión, así que eso es exactamente
    // lo que se está midiendo.
    await onDatabase(RETIRAR_CONCESION);
    const sinConcesion = await page.goto(MOVIMIENTOS_JULIO);
    expect(sinConcesion?.status()).toBe(403);
    await expect(page.locator('body')).toContainText('Esta parte la lleva la familia.');
    await expect(page.locator('.finance-ledger')).toHaveCount(0);
    expect((await page.request.get(TRANSACCIONES_JULIO)).status()).toBe(404);

    // Devuelta la concesión, la misma sesión vuelve a ver la misma fila con el
    // mismo importe. Cierra el control por los dos lados: el 404 de arriba no
    // podía venir de una sesión caducada ni de un lote que hubiese
    // desaparecido por el camino.
    await onDatabase(RESTAURAR_CONCESION);
    const recuperada = await page.request.get(TRANSACCIONES_JULIO);
    expect(recuperada.status()).toBe(200);
    expect(paginaDeMovimientos(await recuperada.json())).toEqual({
      total: 1,
      sumCents: ALQUILER_JULIO_CENTS
    });

    // Deshacer: el lote se va con sus transacciones (ON DELETE CASCADE).
    await deshacerLote(page);
    await page.goto(MOVIMIENTOS_JULIO);
    await expect(page.locator('.finance-ledger')).toBeVisible();
    await expect(page.locator('.finance-ledger .finance-row')).toHaveCount(0);
  });
});
