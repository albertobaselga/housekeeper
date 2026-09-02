import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

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
// coordinador, que quien NO tiene concesión no ve esas MISMAS filas recién
// importadas, ni por pantalla ni por la API.
const MOVIMIENTOS_JULIO = `/h/${HOUSEHOLD}/finanzas/movimientos?from=2026-07-01&to=2026-07-31&q=ALQUILER+JULIO`;
const TRANSACCIONES_JULIO = `/api/v1/finance/transactions?household=${HOUSEHOLD}&from=2026-07-01&to=2026-07-31&q=${encodeURIComponent('ALQUILER JULIO')}`;

/**
 * Limpieza del hook: idempotente y a prueba de más de un lote homónimo. Antes
 * deshacía `fila.first()` pero afirmaba `toHaveCount(0)` sobre TODAS las filas
 * con ese nombre de fichero — con dos lotes (p. ej. un reintento de Playwright
 * que dejó uno a medio deshacer), el hook deshacía uno y reventaba en la
 * aserción, marcando en rojo un cuerpo que había pasado. Ahora deshace de uno
 * en uno hasta que no quede ninguno.
 */
async function deshacerSiQueda(page: Page): Promise<void> {
  await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
  const fila = page.locator('tr', { hasText: 'movimientos-e2e.xls' });
  // [Corrección revisión-1, Minor 4] Un solo `count()` por vuelta: se lee al
  // entrar al bucle y se decrementa en memoria, en vez de volver a contar el
  // DOM justo antes de deshacer — dos lecturas que en teoría podían discrepar
  // y en la práctica solo sobraban.
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

    // [Corrección revisión-1, Minor 2] Control positivo, con la sesión de
    // administración todavía viva: la MISMA URL de la API responde 200 antes
    // de comprobar que la empleada la ve denegada. Sin esto, el 404 de abajo
    // mediría igual de bien una ruta que hubiese dejado de existir.
    expect((await page.request.get(TRANSACCIONES_JULIO)).status()).toBe(200);

    // Resolución del coordinador (T4): la empleada no ve las filas RECIÉN
    // IMPORTADAS, ni por pantalla ni por la API.
    //
    // Por pantalla: `finance.access` no está entre las capacidades del rol
    // `employee_live_in` (packages/contracts/src/capabilities.ts) — la propia
    // matriz de capacidades ya la excluye, sin depender de ninguna concesión
    // —, así que el layout del hogar (`h/[householdId]/+layout.server.ts:70`)
    // corta con `error(403, 'Esta parte la lleva la familia.')` antes de que
    // `finanzas/movimientos/+page.server.ts` llegue a ejecutarse. [Corrección
    // revisión-1, Minor 3] La resolución dice «404/redirección»; lo que
    // ocurre de verdad es un 403 con lenguaje de casa, porque el corte lo da
    // el guard de capacidades sobre un hogar del que la empleada SÍ es
    // miembro (no hay hogar cuya existencia ocultar). La regla «404 nunca
    // 403» (Ruling R2) es de los endpoints de la API — se comprueba más
    // abajo —; aquí se afirma el 403 explícito para que la discrepancia con
    // el texto de la resolución quede documentada en el propio test, no
    // callada detrás de un `toHaveCount(0)` que también pasaría con una
    // redirección al login.
    //
    // Por la API: el mismo doble cerrojo (`requireFinanceAdmin`, packages/
    // server/src/commands/finance.ts) rechaza por rol, y `financeRead`
    // (finance.server.ts) lo traduce SIEMPRE a 404 —nunca a 403, Ruling R2—
    // para no revelar que el hogar existe.
    //
    // El segundo reparto de la resolución —un `family_admin` SIN concesión—
    // pasa por el MISMO `requireFinanceAdmin`, solo que por la rama de la
    // concesión (`finance_enabled()`) en vez de la del rol. [Corrección
    // revisión-1, Important 1] La ronda anterior afirmaba aquí que esa rama
    // «ya la ejercita `finanzas-concesion.dbe2e.ts` con el mismo código de
    // estado» — es falso: ese fichero es una batería sobre la tarjeta de
    // concesiones de Ajustes (siembra una segunda administración por SQL,
    // intercepta `page.route('**/api/v1/sync', …)` y comprueba con un
    // `MutationObserver` que la fila no miente mientras el comando viaja); no
    // contiene ninguna aserción de código de estado HTTP ni ninguna petición
    // a `/api/v1/finance/*`. La ÚNICA cobertura real de «family_admin sin
    // concesión → 404» es UNITARIA y con `requireFinanceAdmin` MOCKEADO
    // (`apps/web/tests/finance-endpoints.test.ts:300-324`): no toca base de
    // datos, RLS ni sesión real. Hoy no existe ninguna cobertura de extremo a
    // extremo de esa rama en ninguna batería.
    //
    // Decisión de alcance (para que el coordinador la confirme o la
    // revierta): esta tarea deja esa mitad FUERA de este fichero. No hay
    // ninguna cuenta de acceso family_admin SIN concesión en el selector de
    // fixtures dbe2e; cubrirla exige o sembrar una cuenta nueva (infra de
    // pruebas compartida por 18 specs, fuera de «añade al final») o retirar y
    // restaurar por SQL la concesión ya sembrada del admin
    // (`packages/db/fixtures/002_finance.sql`) dentro de este mismo test —
    // viable, con un `afterEach` que la restaure con garantía aunque el
    // cuerpo se rompa a mitad, pero con el riesgo de dejar al admin sin
    // Finanzas para las specs vecinas de la misma base si ese `afterEach` no
    // llegara a correr. Ninguna de las dos es «añadir al final sin tocar lo
    // existente»; se deja para que el coordinador la pida explícitamente si
    // la quiere de extremo a extremo.
    await page.context().clearCookies();
    await loginAs(page, 'employee');
    const respuesta = await page.goto(MOVIMIENTOS_JULIO);
    expect(respuesta?.status()).toBe(403);
    await expect(page.locator('body')).toContainText('Esta parte la lleva la familia.');
    await expect(page.locator('.finance-ledger')).toHaveCount(0);
    const denegada = await page.request.get(TRANSACCIONES_JULIO);
    expect(denegada.status()).toBe(404);

    // Se restaura la sesión de administración: el deshacer de abajo (y, si el
    // test se rompiera antes de llegar aquí, el `afterEach`) la necesitan.
    await page.context().clearCookies();
    await loginAs(page, 'admin');

    // Deshacer: el lote se va con sus transacciones (ON DELETE CASCADE).
    await deshacerLote(page);
    await page.goto(MOVIMIENTOS_JULIO);
    await expect(page.locator('.finance-ledger')).toBeVisible();
    await expect(page.locator('.finance-ledger .finance-row')).toHaveCount(0);
  });
});
