import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test('admin en modo fixture: el Dashboard de Finanzas pinta KPIs, flujo de caja y proveedores', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Finanzas');
  const kpis = page.locator('.finance-kpis');
  await expect(page.locator('.finance-kpis .card')).toHaveCount(5);
  await expect(kpis).toContainText('Ingresos');
  await expect(kpis).toContainText('Tasa de ahorro');

  // Ruling R18: importes reales del corpus demo de getFinanceDashboardFixture,
  // no solo los rótulos — para que el test detecte un formateo o un cruce de
  // filas equivocado, no solo una tarjeta ausente.
  // Filtro EXACTO (no `hasText` de subcadena): «Inversión … 14,1 % sobre
  // ingresos» contiene la subcadena «ingresos» y `hasText` no distingue may/min,
  // así que un filtro por subcadena confunde la tarjeta de Inversión con la de
  // Ingresos.
  const ingresosCard = kpis.locator('.card').filter({ has: page.getByText('Ingresos', { exact: true }) });
  await expect(ingresosCard).toContainText('4.250,00 €'); // incomeCents '425000'
  const gastosCard = kpis.locator('.card').filter({ has: page.getByText('Gastos', { exact: true }) });
  await expect(gastosCard).toContainText('−3.185,50 €'); // expenseCents '-318550' (menos tipográfico U+2212)

  // El chip de variación de Gastos compara TAMAÑOS, no signos: expenseCents
  // pasa de -355000 (prev) a -318550 (ahora) → se gastó MENOS → ▼ + verde.
  // (Antes de esta corrección, el signo negativo del dato invertía el chip:
  // gastar menos salía en naranja con flecha hacia arriba.)
  const gastosDelta = gastosCard.locator('.status-chip');
  await expect(gastosDelta).toHaveClass(/success/);
  await expect(gastosDelta).toContainText('▼ 10 %');

  // Con pendingCount: 3 de la fixture, la tarjeta «Tasa de ahorro» enlaza a revisión.
  const pendingChip = page.getByRole('link', { name: '3 sin revisar' });
  await expect(pendingChip).toBeVisible();
  await expect(pendingChip).toHaveAttribute('href', `/h/${HOUSEHOLD}/finanzas/revision`);

  await expect(page.locator('.cashflow svg')).toBeVisible();
  const providersHeading = page.getByRole('heading', { name: 'Top proveedores' });
  await expect(providersHeading).toBeVisible();
  const providersCard = page.locator('article', { has: providersHeading });
  await expect(providersCard).toContainText('Encina');
  await expect(providersCard).toContainText('−980,00 €'); // provider Encina, totalCents '-98000'
});

test('la empleada no alcanza Finanzas: 403 en ruta declarada sin capacidad', async ({ page }) => {
  await loginAs(page, 'employee');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
  expect(response?.status()).toBe(403);
  await expect(page.locator('body')).toContainText('no está incluida en tu acceso');
});

test('una ruta hija inventada de Finanzas sí es 404', async ({ page }) => {
  await loginAs(page, 'admin');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas/inventada`);
  expect(response?.status()).toBe(404);
});

test('admin en modo fixture: Movimientos lista el ledger y abre el panel con «Datos del origen»', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Movimientos');

  // Ruling R18: primera fila del corpus demo de getFinanceMovimientosFixture
  // (fc…0001, amountCents '-8734'). LedgerTable pinta el TÍTULO por
  // `txTitle` (providerDisplay, aquí «Encina»), no el concepto en bruto: el
  // concepto no llega a pintarse en ninguna parte de la fila (ver informe).
  const rows = page.locator('.finance-ledger .finance-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText('Encina');
  await expect(rows.first()).toContainText('−87,34 €'); // amountCents '-8734' (menos tipográfico U+2212)

  // Pie del ledger: total de filas y suma con signo de los 5 movimientos de
  // la fixture (-8734 + 212500 - 50000 + 50000 - 14210 = 189556).
  const total = page.locator('.ledger-total');
  await expect(total).toContainText('5 movimientos con estos filtros');
  await expect(total).toContainText('+1.895,56 €');

  // El panel (FinanceDetailPanel, Task 11) etiqueta el diálogo con el mismo
  // título que la fila (aria-labelledby → el h2 con `txTitle`), no con
  // «Detalle»: se usa el nombre accesible real en vez de forzar uno nuevo.
  await rows.first().click();
  const panel = page.getByRole('dialog', { name: 'Encina' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Datos del origen');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

// [FASE 5, T9] Edición inline, manuales y transferencias en Movimientos. Estas
// tres pruebas se quedan en lo puramente local (selección, apertura/cierre de
// formulario, motivo del botón de vincular): NINGUNA dispara `optimistic.run`
// contra la red, siguiendo la misma convención que el resto de `.e2e.ts` (modo
// fixture = solo lectura; el envío real de comandos se prueba con base propia
// en `.dbe2e.ts`, fuera del alcance de esta tarea).

test('Movimientos: cada fila trae sus controles de edición inline', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
  const rows = page.locator('.finance-ledger .finance-row-wrap');
  await expect(rows).toHaveCount(5);

  // Fila 1 (Encina): tiene proveedor y no pertenece a ningún grupo — checkbox,
  // categoría, eventos, recurrencia y alias de proveedor, pero SIN botón de
  // desvincular ni de borrar (es un movimiento importado, no un manual).
  const encina = rows.nth(0);
  await expect(encina.getByLabel('Seleccionar movimiento')).toBeVisible();
  await expect(encina.getByLabel('Categoría')).toBeVisible();
  await expect(encina.getByTitle('Asignar a eventos')).toBeVisible();
  await expect(encina.getByLabel('Tipo de gasto')).toBeVisible();
  await expect(encina.getByTitle('Editar alias del proveedor')).toBeVisible();
  await expect(encina.getByTitle('Desvincular transferencia')).toHaveCount(0);

  // Fila 3 (traspaso a cuenta común): sin proveedor pero YA vinculada a un
  // grupo — trae el botón de desvincular y no el de alias.
  const traspaso = rows.nth(2);
  await expect(traspaso.getByTitle('Desvincular transferencia')).toBeVisible();
  await expect(traspaso.getByTitle('Editar alias del proveedor')).toHaveCount(0);

  // Ninguna fila del fixture es un manual borrable (todas traen un dedupHash
  // de importación, no `manual-…`): «Borrar» no aparece en ninguna parte.
  await expect(page.getByRole('button', { name: 'Borrar' })).toHaveCount(0);
});

test('Movimientos: seleccionar filas activa la barra y «Vincular transferencia» explica por qué está deshabilitado', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
  const rows = page.locator('.finance-ledger .finance-row-wrap');
  await expect(page.locator('.seleccion-bar')).toHaveCount(0);

  await rows.nth(0).getByLabel('Seleccionar movimiento').check();
  const bar = page.locator('.seleccion-bar');
  await expect(bar).toContainText('1 seleccionados');
  const linkButton = bar.getByRole('button', { name: /Vincular transferencia/ });
  await expect(linkButton).toBeDisabled();
  await expect(linkButton).toHaveAttribute('title', 'se necesitan al menos 2 movimientos');

  // Encina (−87,34 €) + nómina (+2.125,00 €): la selección no suma cero.
  await rows.nth(1).getByLabel('Seleccionar movimiento').check();
  await expect(bar).toContainText('2 seleccionados');
  await expect(linkButton).toHaveAttribute('title', 'la selección no suma cero');

  // Encina + traspaso (fila 3, YA pertenece a un grupo): motivo distinto.
  await rows.nth(1).getByLabel('Seleccionar movimiento').uncheck();
  await rows.nth(2).getByLabel('Seleccionar movimiento').check();
  await expect(linkButton).toHaveAttribute('title', 'algún movimiento ya pertenece a un grupo');

  await bar.getByRole('button', { name: 'Quitar selección' }).click();
  await expect(page.locator('.seleccion-bar')).toHaveCount(0);
});

test('Movimientos: «+ Añadir manual» abre y cierra el formulario', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
  await expect(page.locator('.action-form')).toHaveCount(0);
  await page.getByRole('button', { name: '+ Añadir manual' }).click();
  const form = page.locator('.action-form');
  await expect(form).toBeVisible();
  await expect(form.locator('legend')).toContainText('Añadir movimiento manual');
  await form.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.locator('.action-form')).toHaveCount(0);
});
