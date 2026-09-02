import { expect, test } from '@playwright/test';

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
// ya lo cubre el test de arriba (fase 5): aquí solo se comprueba el efecto
// sobre los datos que ve la administración con concesión.
const MOVIMIENTOS_JULIO = `/h/${HOUSEHOLD}/finanzas/movimientos?from=2026-07-01&to=2026-07-31&q=ALQUILER+JULIO`;

async function deshacerSiQueda(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
  const fila = page.locator('tr', { hasText: 'movimientos-e2e.xls' });
  if (await fila.count()) {
    page.once('dialog', (dialog) => void dialog.accept());
    await fila.first().getByRole('button', { name: 'Deshacer' }).click();
    await expect(page.locator('tr', { hasText: 'movimientos-e2e.xls' })).toHaveCount(0);
  }
}

test.describe('lo importado se ve y el deshacer lo borra', () => {
  // Nada de `loginAs` aquí: el `page` del hook es el MISMO del cuerpo del
  // test (fixture de Playwright compartida entre el test y sus hooks), que ya
  // se autenticó como admin en su primera línea. Repetir el login rompía la
  // limpieza — `/login` con sesión viva redirige directo a Hoy (véase
  // `routes/login/+page.server.ts`) y el selector de cuentas nunca se pinta,
  // así que `loginAs` fallaba buscando una pantalla que no iba a aparecer.
  test.afterEach(async ({ page }) => {
    await deshacerSiQueda(page);
  });

  test('los movimientos del lote aparecen en Movimientos y desaparecen al deshacer', async ({ page }) => {
    await loginAs(page, 'admin');

    // Punto de partida: el hogar no tiene todavía el movimiento del extracto.
    await page.goto(MOVIMIENTOS_JULIO);
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

    // Deshacer: el lote se va con sus transacciones (ON DELETE CASCADE).
    await deshacerSiQueda(page);
    await page.goto(MOVIMIENTOS_JULIO);
    await expect(page.locator('.finance-ledger .finance-row')).toHaveCount(0);
  });
});
