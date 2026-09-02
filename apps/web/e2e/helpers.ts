import { expect, type JSHandle, type Locator, type Page } from '@playwright/test';

export const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';

/**
 * Identificadores fijos de la siembra propia de la batería e2e sobre Postgres
 * (prefijos aa… para no chocar con las fixtures 1…/2… de @housekeeper/db ni con
 * la semilla 33… del editor de wiki). La siembra vive en db-global-setup.ts;
 * los specs .dbe2e.ts los usan para seleccionar entidades concretas.
 */
export const E2E_SEED = {
  memberships: {
    admin: '11000000-0000-4000-8000-000000000001',
    employee: '11000000-0000-4000-8000-000000000003'
  },
  agreement: '12000000-0000-4000-8000-000000000001',
  foods: {
    leche: 'aa100000-0000-4000-8000-000000000001',
    arroz: 'aa100000-0000-4000-8000-000000000002',
    pollo: 'aa100000-0000-4000-8000-000000000003',
    sinRevisar: 'aa100000-0000-4000-8000-000000000004'
  },
  diners: {
    marta: 'aa200000-0000-4000-8000-000000000001',
    leo: 'aa200000-0000-4000-8000-000000000002'
  },
  menuGroup: 'aa300000-0000-4000-8000-000000000001',
  wikiSpace: 'aa400000-0000-4000-8000-000000000001',
  recipePages: {
    /** «Arroz con leche (E2E)»: lleva leche → incompatible con Leo. */
    conLeche: 'aa410000-0000-4000-8000-000000000001',
    /** «Pollo asado (E2E)»: sin alérgenos declarados. */
    sinAlergenos: 'aa420000-0000-4000-8000-000000000001'
  },
  routines: {
    employee: 'aa500000-0000-4000-8000-000000000001',
    family: 'aa500000-0000-4000-8000-000000000002'
  },
  extras: {
    /** Jornada extra de Ana en estado requested (la acepta la familia). */
    requested: 'aa600000-0000-4000-8000-000000000001',
    /** Festivo trabajado sin aceptación previa: la familia lo resuelve. */
    porResolver: 'aa600000-0000-4000-8000-000000000002'
  },
  expensePending: 'aa700000-0000-4000-8000-000000000001',
  contacts: {
    /** Destacado: aparece en Emergencias y en el CriticalSnapshot. */
    pediatra: 'aa800000-0000-4000-8000-000000000001',
    /** Destacada (casa y vecinos). */
    vecina: 'aa800000-0000-4000-8000-000000000002',
    /** No destacado: solo en el directorio y la búsqueda. */
    fontanero: 'aa800000-0000-4000-8000-000000000003'
  },
  /**
   * Siembra propia de Finanzas (prefijo ac9…, R20): sin choque con las
   * fixtures 1…/2…, con la siembra aa… de arriba, ni con la segunda
   * administración ab9… de `finanzas-concesion.dbe2e.ts`.
   */
  finanzas: {
    account: 'ac910000-0000-4000-8000-000000000001',
    // [FASE 5, T10 · corrección Minor 6] Raíz `transferencia` del hogar: antes
    // vivía incrustada en db-global-setup.ts mientras sus tres hermanas
    // vivían aquí.
    catTransferencias: 'ac900000-0000-4000-8000-000000000001',
    catCasa: 'ac900000-0000-4000-8000-000000000002',
    txSuper: 'ac920000-0000-4000-8000-000000000001',
    txLuz: 'ac920000-0000-4000-8000-000000000002',
    // [FASE 5, T10 · corrección Important 3] `sugerida_regla` con categoría YA
    // asignada: es la única fila que activa el botón «Confirmar N sugerencias»
    // (finance.transactions.bulk) — sin ella, ni el dbe2e ni la maqueta
    // ejercitaban ese camino ni los estados `sugerida_*` de STATUS_LABEL.
    txSugerida: 'ac920000-0000-4000-8000-000000000003'
  }
} as const;

export const ACCOUNT_EMAILS = {
  admin: 'alberto.admin@hogar.demo',
  family: 'marta.familia@hogar.demo',
  employee: 'ana.empleada@hogar.demo',
  helper: 'lucia.apoyo@hogar.demo',
  viewer: 'diego.canguro@hogar.demo'
} as const;

/**
 * Entra en la aplicación desde la pantalla de acceso.
 *
 * Las dos baterías (fixture y Postgres) corren SIN `DATABASE_AUTH_URL`, así que
 * la pantalla está en modo `fixture-selector`: cuentas sintéticas, sin
 * contraseña. El modo real de producción (usuario + contraseña) no tiene
 * cuentas que sembrar aquí — se cubre por HTTP en tests/auth.integration.test.ts
 * y a mano contra una instalación con identidad real.
 */
export async function loginAs(page: Page, account: keyof typeof ACCOUNT_EMAILS): Promise<void> {
  await page.goto('/login');
  // Si esto falla, la instalación tiene identidad real y el selector no existe:
  // el aviso explícito ahorra un «elemento no encontrado» sin contexto.
  await expect(
    page.getByRole('heading', { name: 'Entra con una perspectiva' }),
    'la batería e2e espera la pantalla sin base de datos de identidad'
  ).toBeVisible();
  await page.locator('button.account-card', { hasText: ACCOUNT_EMAILS[account] }).click();
  await page.waitForURL(`**/h/${HOUSEHOLD}/today`);
}

// [FASE 6, Task 13] Drag-and-drop nativo del pivot de Analítica. `locator.dragTo()`
// simula el arrastre por eventos de RATÓN, y Chromium bajo CDP no siempre los
// traduce a la máquina de estados nativa de HTML5 DnD (dragstart/dragover/
// drop) — es una limitación conocida de Playwright con d&d nativo, no del
// marcado. La técnica que SÍ funciona (documentada por Playwright para este
// caso) es despachar los eventos de arrastre a mano compartiendo un único
// `DataTransfer` real entre origen y destino: los handlers de PivotTable
// reciben un `DragEvent` con `dataTransfer` genuino (setDragImage/setData
// funcionan) exactamente como en un arrastre real, solo que el gesto de
// ratón que los dispara lo escribe la prueba en vez del sistema operativo.
//
// Partido en dos pasos (Task 15) para poder inspeccionar el DOM A MITAD del
// arrastre (p. ej. las clases `dnd-target`/`dnd-dimmed` que solo existen
// mientras `dragging !== null`): `nativeDragDrop` sigue siendo el atajo de un
// solo gesto para quien no necesita ese punto intermedio.
export async function nativeDragStart(page: Page, source: Locator): Promise<JSHandle<DataTransfer>> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  return dataTransfer;
}

export async function nativeDrop(
  source: Locator,
  target: Locator,
  dataTransfer: JSHandle<DataTransfer>
): Promise<void> {
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

export async function nativeDragDrop(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await nativeDragStart(page, source);
  await nativeDrop(source, target, dataTransfer);
}
