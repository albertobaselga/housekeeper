import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs, nativeDragDrop, nativeDragStart, nativeDrop } from './helpers';

// Misma razón que en finanzas.e2e.ts: sin la dimensión de proveedor activa,
// «Mercadona» no se pinta nunca (la maqueta no tiene subcategorías). El rango
// va explícito (F6-M4) para no depender del reloj de la máquina.
const ANALITICA = `/h/${HOUSEHOLD}/finanzas/analitica?dims=cat,prov&from=2026-01-01&to=2026-03-31`;

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(ANALITICA);
  const tabla = page.getByTestId('pivot-table');
  await tabla.getByRole('button', { name: 'desplegar Supermercado' }).click();
  await expect(tabla).toContainText('Mercadona');
});

// `locator.dragTo()` (mouse simulado por Playwright) no dispara con fiabilidad
// el dnd HTML5 nativo de PivotTable bajo Chromium/CDP (nota de la Task 13, ya
// verificada con dos pruebas en verde en finanzas.e2e.ts): se reutiliza
// `nativeDragDrop`/`nativeDragStart`/`nativeDrop` de './helpers' en vez del
// gesto de ratón que proponía el brief como primera vía.

test('arrastrar un proveedor a otra categoría dispara el comando y da acuse honesto', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  const destino = tabla.locator('tr', { hasText: 'Ocio' }).first();
  await nativeDragDrop(page, asa, destino);
  // Sin base de datos el comando queda en cola: acuse honesto, no un éxito falso.
  await expect(page.getByTestId('pivot-toast')).toContainText('Guardado en este dispositivo');
});

test('soltar sobre la banda EVENTOS abre el popover de nuevo evento y Escape lo cierra', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  await nativeDragDrop(page, asa, page.getByTestId('pivot-banda-eventos'));
  const campo = page.getByPlaceholder('＋ nuevo evento…');
  await expect(campo).toBeVisible();
  await campo.press('Escape');
  await expect(campo).toHaveCount(0);
});

// Cobertura pendiente de la revisión de la Task 13 (task-13-review-0.md, M3,
// punto 1): soltar sobre la FILA de un evento YA existente en la maqueta
// («Semana Santa 2026») debe dar el mismo acuse con «regla creada» que
// summarizeEventDrop (pivot-state.ts) construye para la barra de acciones —
// no solo la nota de cola genérica.
test('arrastrar a un evento existente da acuse honesto con el resumen de la regla', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  const evento = tabla.locator('tr', { hasText: 'Semana Santa 2026' }).first();
  await nativeDragDrop(page, asa, evento);
  const toast = page.getByTestId('pivot-toast');
  // Los 3 movimientos de Mercadona (COMPRA TARJ. MERCADONA, ene/feb/mar) son un
  // único concepto con proveedor único: `summarizeEventDrop(3, 'Semana Santa
  // 2026', 0)` → «3 movimientos → Semana Santa 2026 · regla creada».
  await expect(toast).toContainText('→ Semana Santa 2026 · regla creada');
  await expect(toast).toContainText('Guardado en este dispositivo');
});

// F6-I4, cobertura pendiente: el submit del popover con nombre («crear evento
// → asignarle los movimientos», la cadena más delicada de la fase) no lo
// ejercitaba ningún test de ningún nivel — los e2e llegaban hasta abrir el
// popover y cerrarlo con Escape.
test('soltar sobre EVENTOS, escribir un nombre y «Crear y asignar» encadena crear+asignar con acuse', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  await nativeDragDrop(page, asa, page.getByTestId('pivot-banda-eventos'));

  const campo = page.getByPlaceholder('＋ nuevo evento…');
  await expect(campo).toBeVisible();
  await campo.fill('Vuelta al cole');
  await page.getByRole('button', { name: 'Crear y asignar' }).click();

  // Mismo resumen que la barra de acciones (summarizeEventDrop): los 3
  // movimientos de Mercadona son un único concepto con proveedor único.
  const toast = page.getByTestId('pivot-toast');
  await expect(toast).toContainText('3 movimientos → Vuelta al cole · regla creada');
  // Sin base de datos el sync no confirma: el acuse lo dice, no finge éxito.
  await expect(toast).toContainText('Guardado en este dispositivo');
  // El popover se cierra al aplicar.
  await expect(campo).toHaveCount(0);
});

// Cobertura pendiente de la revisión de la Task 13 (task-13-review-0.md, M3,
// punto 2): `dnd-target`/`dnd-dimmed` son clases EFÍMERAS (solo existen
// mientras `dragging !== null`, entre el `dragstart` y el `drop`) — un test
// que solo mira el estado final nunca las vería. Se parte el gesto en dos
// pasos (`nativeDragStart` / `nativeDrop`) para poder aserirlas A MITAD del
// arrastre.
test('dnd-target y dnd-dimmed se pintan durante el arrastre, antes de soltar', async ({ page }) => {
  const tabla = page.getByTestId('pivot-table');
  const asa = tabla.locator('tr', { hasText: 'Mercadona' }).first().locator('[title="arrastrar"]');
  // Fila de otra categoría de GASTOS (destino válido → dnd-target).
  const ocioRow = tabla.locator('tr', { hasText: 'Ocio' }).first();
  // Fila de INTERNAS (dropCatId null para `transferencia` → dnd-dimmed, nunca target).
  const traspasoRow = tabla.locator('tr', { hasText: 'Traspaso hogar' }).first();
  await expect(ocioRow).not.toHaveClass(/dnd-target/);
  await expect(traspasoRow).not.toHaveClass(/dnd-dimmed/);

  const dataTransfer = await nativeDragStart(page, asa);
  await expect(ocioRow).toHaveClass(/dnd-target/);
  await expect(traspasoRow).toHaveClass(/dnd-dimmed/);

  await nativeDrop(asa, ocioRow, dataTransfer);
  await expect(ocioRow).not.toHaveClass(/dnd-target/);
  await expect(page.getByTestId('pivot-toast')).toContainText('Guardado en este dispositivo');
});
