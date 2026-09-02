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
