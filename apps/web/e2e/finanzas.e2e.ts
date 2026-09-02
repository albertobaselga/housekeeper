import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs, nativeDragDrop } from './helpers';

// [FASE 5, T13 · R35] La barra de secciones es SISTEMA, no una pantalla
// concreta: si `movimientos/+page.svelte` (o cualquier otra) dejase de
// montar `<FinanceNav>`, ninguna prueba existente lo notaría — cada dbe2e de
// pantalla concreta comprueba SU contenido, no la barra compartida. Este
// test de fixture (sin base de datos) recorre las siete rutas y afirma que
// la navegación sigue ahí en todas, en un solo sitio.
test('admin en modo fixture: la barra de secciones de Finanzas está en las siete pantallas', async ({ page }) => {
  await loginAs(page, 'admin');
  const rutas = ['', 'analitica', 'movimientos', 'revision', 'eventos', 'importar', 'ajustes'];
  for (const ruta of rutas) {
    await page.goto(`/h/${HOUSEHOLD}/finanzas${ruta ? `/${ruta}` : ''}`);
    await expect(
      page.getByRole('navigation', { name: 'Secciones de Finanzas' }),
      `«${ruta || 'finanzas'}» no monta la barra de secciones`
    ).toBeVisible();
  }
});

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
  // [FASE 5, T9 · corrección Minor 5] El nombre accesible del checkbox
  // incluye el título del movimiento (`txTitle`), no un rótulo genérico
  // repetido en las 100 filas de una página.
  await expect(encina.getByLabel('Seleccionar Encina')).toBeVisible();
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

  await rows.nth(0).getByLabel('Seleccionar Encina').check();
  const bar = page.locator('.seleccion-bar');
  // [FASE 5, T9 · corrección Minor 3] Singular correcto («1 seleccionado»,
  // no «1 seleccionados»); el plural de abajo con 2 ya estaba bien.
  await expect(bar).toContainText('1 seleccionado');
  await expect(bar).not.toContainText('1 seleccionados');
  const linkButton = bar.getByRole('button', { name: /Vincular transferencia/ });
  await expect(linkButton).toBeDisabled();
  await expect(linkButton).toHaveAttribute('title', 'se necesitan al menos 2 movimientos');

  // Encina (−87,34 €) + nómina (+2.125,00 €): la selección no suma cero.
  await rows.nth(1).getByLabel('Seleccionar Talleres Roble').check();
  await expect(bar).toContainText('2 seleccionados');
  await expect(linkButton).toHaveAttribute('title', 'la selección no suma cero');

  // Encina + traspaso (fila 3, YA pertenece a un grupo): motivo distinto.
  await rows.nth(1).getByLabel('Seleccionar Talleres Roble').uncheck();
  await rows.nth(2).getByLabel('Seleccionar TRASPASO A CUENTA COMUN').check();
  await expect(linkButton).toHaveAttribute('title', 'algún movimiento ya pertenece a un grupo');

  await bar.getByRole('button', { name: 'Quitar selección' }).click();
  await expect(page.locator('.seleccion-bar')).toHaveCount(0);
});

// [FASE 5, T9 · corrección Minor 4] `selected` no sobrevive a un cambio de
// filtro: el fixture ignora el valor del filtro (siempre las mismas 5 filas),
// así que esto no verifica un recorte de filas — verifica que `applyLocal`
// vacía la selección en el mismo gesto que dispara la navegación, que es la
// causa real señalada en la revisión (el estado del componente sobrevive al
// `goto` porque es la misma ruta).
test('Movimientos: cambiar el filtro de búsqueda vacía la selección', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
  const rows = page.locator('.finance-ledger .finance-row-wrap');

  await rows.nth(0).getByLabel('Seleccionar Encina').check();
  await expect(page.locator('.seleccion-bar')).toContainText('1 seleccionado');

  await page.getByPlaceholder('Buscar concepto o proveedor…').fill('encina');
  // `getByRole('button', { name: 'Buscar' })` a secas casa también con la lupa
  // global de la cabecera («Buscar en toda la casa»): se acota al formulario.
  await page.locator('.finance-localfilters').getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.locator('.seleccion-bar')).toHaveCount(0);
  await expect(rows.nth(0).getByLabel('Seleccionar Encina')).not.toBeChecked();
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

// Task 13: drag-and-drop nativo del pivot de Analítica. `nativeDragDrop` (el
// helper de dispatchEvent + DataTransfer real que SÍ dispara el dnd HTML5 de
// PivotTable bajo Chromium/CDP) vive ahora en './helpers' (movido en la Task
// 15 para que finanzas-pivot-dnd.e2e.ts lo reutilice sin duplicarlo).

// Sin red (batería en modo fixture, sin DATABASE_URL) el POST a /api/v1/sync
// responde 503 y el comando queda `queued` — el mismo camino que ya prueba
// finance-pivot-actions.test.ts para `sendAll`/`acuse`, aquí ejercitado de
// punta a punta con el gesto real (DataTransfer real, sin tocar el estado de
// Svelte a mano).
test('admin en modo fixture: arrastrar una categoría a EVENTOS abre el popover y crea el evento', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica`);
  await expect(page.locator('[data-testid="pivot-table"]')).toBeVisible();

  // Fila de categoría «Ocio» (GASTOS, dims por defecto cat/sub): el asa ⠿ es
  // el único elemento draggable de esa fila.
  const ocioAsa = page.locator('tr', { hasText: 'Ocio' }).first().locator('.asa');
  const bandaEventos = page.locator('[data-testid="pivot-banda-eventos"]');
  await expect(bandaEventos).not.toHaveClass(/dnd-target/);

  await nativeDragDrop(page, ocioAsa, bandaEventos);

  const popover = page.locator('.popover-evento');
  await expect(popover).toBeVisible();
  const input = popover.getByLabel('Nombre del evento nuevo');
  await input.fill('Cena de prueba');
  await popover.getByRole('button', { name: 'Crear y asignar' }).click();
  await expect(popover).toHaveCount(0);

  const toast = page.locator('[data-testid="pivot-toast"]');
  await expect(toast).toBeVisible();
  // Éxito con outcome `queued` (sin BD en la batería de fixture): el resumen
  // del drop honesto va seguido de la nota de cola (mismo copy que el outbox,
  // R14 de la tarea 6).
  await expect(toast).toContainText('movimiento');
  await expect(toast).toContainText('→ Cena de prueba · regla creada');
  await expect(toast).toContainText('Guardado en este dispositivo');
});

test('admin en modo fixture: arrastrar un proveedor a otra categoría lo recategoriza con Deshacer', async ({ page }) => {
  await loginAs(page, 'admin');
  // dims=cat,prov: hace falta la dimensión de proveedor para que «Mercadona»
  // llegue a pintarse (la maqueta no tiene subcategorías).
  await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica?dims=cat,prov`);
  const tabla = page.locator('[data-testid="pivot-table"]');
  await expect(tabla).toBeVisible();
  await tabla.getByRole('button', { name: 'desplegar Supermercado' }).click();

  const mercadonaAsa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('.asa');
  const ocioRow = tabla.locator('tr', { hasText: 'Ocio' }).first();
  await expect(ocioRow).not.toHaveClass(/dnd-target/);

  await nativeDragDrop(page, mercadonaAsa, ocioRow);

  const toast = page.locator('[data-testid="pivot-toast"]');
  await expect(toast).toBeVisible();
  // catPathOf resuelve la ruta completa (categoryPath, fase 4); «Ocio» cuelga
  // de la raíz, así que su ruta es su propio nombre.
  await expect(toast).toContainText('→ Ocio · regla creada');
  // Las tres compras de Mercadona venían de Supermercado (categoría previa
  // única), así que el plan de deshacer puede restaurarlas.
  await expect(page.getByRole('button', { name: 'Deshacer' })).toBeVisible();
});

// F6-M6: antes, una categoría con un ÚNICO proveedor (aquí «Ocio», solo Cine
// Ideal) se arrastraba como proveedor y soltarla sobre otra categoría creaba
// regla, mientras que la misma categoría con dos proveedores se rechazaba: el
// gesto dependía de cuántos proveedores hubiera dentro, que no se ve.
test('admin en modo fixture: una categoría sobre otra categoría no se mueve, y el acuse lo explica', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica`);
  const tabla = page.locator('[data-testid="pivot-table"]');
  await expect(tabla).toBeVisible();

  const ocioAsa = tabla.locator('tr', { hasText: 'Ocio' }).first().locator('.asa');
  const supermercadoRow = tabla.locator('tr', { hasText: 'Supermercado' }).first();
  await nativeDragDrop(page, ocioAsa, supermercadoRow);

  const toast = page.locator('[data-testid="pivot-toast"]');
  await expect(toast).toContainText('las categorías no pueden soltarse sobre otra categoría');
  await expect(page.getByRole('button', { name: 'Deshacer' })).toHaveCount(0);
});

const SCREENS = [
  'finanzas',
  'finanzas/analitica',
  'finanzas/movimientos',
  'finanzas/revision',
  'finanzas/eventos',
  'finanzas/importar',
  'finanzas/ajustes'
] as const;

test('la administración con concesión recorre las siete pantallas de Finanzas', async ({ page }) => {
  await loginAs(page, 'admin');
  for (const screen of SCREENS) {
    const response = await page.goto(`/h/${HOUSEHOLD}/${screen}`);
    expect(response?.status(), `${screen} debería responder 200`).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});

for (const account of ['family', 'employee', 'helper', 'viewer'] as const) {
  test(`la cuenta ${account} no alcanza Finanzas por URL directa`, async ({ page }) => {
    await loginAs(page, account);
    const module = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
    expect(module?.status()).toBe(403);
    await expect(page.locator('body')).toContainText('no está incluida en tu acceso');
    const child = await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
    expect(child?.status()).toBe(403);
  });
}

test('una ruta hija de Finanzas no declarada falla cerrada con 404', async ({ page }) => {
  await loginAs(page, 'admin');
  const response = await page.goto(`/h/${HOUSEHOLD}/finanzas/privado`);
  expect(response?.status()).toBe(404);
});
