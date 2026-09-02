import type {
  FinanceAssignConceptRecurrencePayloadV1,
  FinanceCategoryAssignConceptPayloadV1,
  FinanceCommandRecurrence,
  FinanceCommandTxStatus,
  FinanceEventAssignConceptPayloadV1,
  FinanceEventAssignTransactionsPayloadV1,
  FinanceEventCreatePayloadV1,
  FinanceTransactionInvestPayloadV1,
  FinanceTransactionUpdatePayloadV1,
  FinanceTransactionsBulkPayloadV1,
  FinanceWritePayloadV1
} from '@housekeeper/contracts';

import { financeCommand } from './commands';
import { queueCommand, type QueueCommandOptions, type QueueCommandResult } from '$lib/offline/queue-command';

import { resolveSelectionIds, type SelectableItem } from './pivot-state';

/**
 * Comandos de sync que dispara el pivot (dnd y barra de acciones) y el plan de
 * «Deshacer». Los `kind` y los nombres de campo son los canónicos de
 * `@housekeeper/contracts` (resolución nº 5 del coordinador:
 * `transactionIds`/`transactionId`, nunca `txIds`/`txId`); cada constructor
 * devuelve el tipo concreto del contrato — nunca `Record<string, unknown>` —
 * para que un campo que no exista en el esquema real no compile.
 */

// ── Envío por el outbox (R6) ─────────────────────────────────────────────────
// Constructor ÚNICO de envelopes de Finanzas ya vive en `./commands`
// (`financeCommand`); aquí solo se encadena con `queueCommand`. Nunca se llama
// a `createCommandEnvelope` directamente ni se fija `aggregateType` en este
// fichero: si `financeCommand` cambia cómo arma el envelope, este wrapper no
// tiene nada que desalinear.
export async function sendFinanceCommand(
  householdId: string,
  payload: FinanceWritePayloadV1,
  options?: QueueCommandOptions
): Promise<QueueCommandResult> {
  return queueCommand(financeCommand(householdId, payload), options);
}

// ── Objetivo «concepto»: categoría entera o proveedor(+concepto) ─────────────

export interface ConceptTarget {
  categoryId?: string;
  provider?: string;
  concept?: string;
}

/**
 * No llamar con hojas de movimiento (`item.txId != null`): una hoja se
 * construye con `provider: ''`, que aquí saldría como `{ provider: '' }` — el
 * servidor lo rechaza (`provider` exige `min(1)`). Una hoja va por
 * `assignTransactionsToEvent`/`updateTransactionRecurrence`, no por un
 * `ConceptTarget`.
 */
export function conceptTargetOf(item: SelectableItem): ConceptTarget {
  if (item.categoryId != null) return { categoryId: item.categoryId };
  return { provider: item.provider, ...(item.concept != null ? { concept: item.concept } : {}) };
}

// ── Constructores puros de payloads (un objeto = un comando) ─────────────────

export function assignConceptToEvent(
  target: ConceptTarget,
  destination: { eventId: string } | { newEventName: string }
): FinanceEventAssignConceptPayloadV1 {
  return { kind: 'finance.event.assignConcept', ...target, ...destination };
}

/** Deshacer una asignación a evento: eventId null borra asignaciones y reglas creadas. */
export function undoEventAssign(target: ConceptTarget): FinanceEventAssignConceptPayloadV1 {
  return { kind: 'finance.event.assignConcept', ...target, eventId: null };
}

export function assignConceptToCategory(
  provider: string,
  concept: string | null,
  categoryId: string
): FinanceCategoryAssignConceptPayloadV1 {
  return {
    kind: 'finance.category.assignConcept',
    provider,
    ...(concept != null ? { concept } : {}),
    categoryId
  };
}

export function assignConceptRecurrence(
  target: ConceptTarget,
  recurrence: FinanceCommandRecurrence
): FinanceAssignConceptRecurrencePayloadV1 {
  return { kind: 'finance.transactions.assignConceptRecurrence', ...target, recurrence };
}

/**
 * Cambio en bloque por ids exactos. Contrato de `@housekeeper/contracts`: el
 * campo es `transactionIds` y solo admite `categoryId` y `status` (ambos
 * opcionales, pero manda al menos uno — lo valida el handler, no este
 * constructor). Para evento y naturaleza hay comandos propios:
 * `assignTransactionsToEvent` y `updateTransactionRecurrence`.
 */
export function bulkByIds(
  transactionIds: readonly string[],
  set: { categoryId?: string; status?: FinanceCommandTxStatus }
): FinanceTransactionsBulkPayloadV1 {
  return { kind: 'finance.transactions.bulk', transactionIds: [...transactionIds], ...set };
}

/** Añadir o quitar movimientos concretos de un evento (kind canónico propio). */
export function assignTransactionsToEvent(
  eventId: string,
  transactionIds: readonly string[],
  action: 'add' | 'remove'
): FinanceEventAssignTransactionsPayloadV1 {
  return { kind: 'finance.event.assignTransactions', eventId, transactionIds: [...transactionIds], action };
}

/** Naturaleza de UNA hoja de movimiento (por concepto se usa assignConceptRecurrence). */
export function updateTransactionRecurrence(
  transactionId: string,
  recurrence: FinanceCommandRecurrence
): FinanceTransactionUpdatePayloadV1 {
  return { kind: 'finance.transaction.update', transactionId, recurrence };
}

export function investTransaction(transactionId: string, accountId: string): FinanceTransactionInvestPayloadV1 {
  return { kind: 'finance.transaction.invest', transactionId, accountId };
}

/**
 * El id lo genera el CLIENTE (`crypto.randomUUID()`) para poder encadenar
 * «crear evento → asignarle movimientos» sin esperar al ACK del sync
 * (resolución nº 5 del coordinador). El id viaja SIEMPRE presente — nunca
 * `undefined` — aunque el campo sea opcional en el esquema: así el llamador
 * puede usarlo de inmediato para el siguiente comando encadenado.
 */
export function createEventPayload(name: string, id: string = crypto.randomUUID()): FinanceEventCreatePayloadV1 {
  return { kind: 'finance.event.create', id, name };
}

// ── Composición de payloads (F6-I4 + T12-M1) ─────────────────────────────────
// La capa que COMPONE —quién va por concepto y quién por id exacto, en qué
// orden se encadena «crear evento» con «asignarle movimientos», qué se cuenta
// para el acuse— vivía entera dentro de `PivotTable.svelte`, donde no la
// tocaba ninguna prueba de ningún nivel y donde la misma partición estaba
// escrita tres veces. Aquí es pura, se prueba con los casos de siempre
// (concepto solo, hoja sola, mezcla, categoría agregada) y el componente solo
// encadena.

export interface TxSplit {
  /** Ítems que viajan POR CONCEPTO: proveedor(+concepto) o categoría entera. */
  concepts: SelectableItem[];
  /** Hojas de la dimensión Movimiento: la identidad es el id exacto. */
  transactionIds: string[];
  /** Movimientos que representan TODOS los ítems, para el acuse. */
  movs: number;
}

/**
 * Partición canónica de una selección o de un arrastre. `txId` es lo que
 * decide: una hoja de movimiento NUNCA puede ir por `ConceptTarget` (se
 * construye con `provider: ''`, que el servidor rechaza por `min(1)`).
 */
export function splitByTx(items: readonly SelectableItem[]): TxSplit {
  return {
    concepts: items.filter((i) => i.txId == null),
    transactionIds: items.flatMap((i) => (i.txId != null ? [i.txId] : [])),
    movs: items.reduce((sum, i) => sum + i.count, 0)
  };
}

export function eventAssignPayloads(
  items: readonly SelectableItem[],
  eventId: string
): FinanceWritePayloadV1[] {
  const { concepts, transactionIds } = splitByTx(items);
  return [
    ...concepts.map((i) => assignConceptToEvent(conceptTargetOf(i), { eventId })),
    ...(transactionIds.length > 0 ? [assignTransactionsToEvent(eventId, transactionIds, 'add')] : [])
  ];
}

/**
 * Evento nuevo: el id lo genera el LLAMADOR y viaja en el primer comando, de
 * modo que los siguientes pueden usarlo sin esperar al ACK. Así los
 * movimientos sueltos (hojas con `txId`) también se asignan — antes se perdían
 * en silencio con un toast de éxito.
 */
export function newEventPayloads(
  items: readonly SelectableItem[],
  name: string,
  eventId: string
): FinanceWritePayloadV1[] {
  return [createEventPayload(name, eventId), ...eventAssignPayloads(items, eventId)];
}

export function undoEventPayloads(
  items: readonly SelectableItem[],
  eventId: string
): FinanceWritePayloadV1[] {
  const { concepts, transactionIds } = splitByTx(items);
  return [
    ...concepts.map((i) => undoEventAssign(conceptTargetOf(i))),
    ...(transactionIds.length > 0 ? [assignTransactionsToEvent(eventId, transactionIds, 'remove')] : [])
  ];
}

/** Naturaleza: por concepto va `assignConceptRecurrence`; una hoja, `transaction.update`. */
export function recurrencePayloads(
  items: readonly SelectableItem[],
  recurrence: FinanceCommandRecurrence
): FinanceWritePayloadV1[] {
  const { concepts, transactionIds } = splitByTx(items);
  return [
    ...concepts.map((i) => assignConceptRecurrence(conceptTargetOf(i), recurrence)),
    ...transactionIds.map((id) => updateTransactionRecurrence(id, recurrence))
  ];
}

export interface CategorySplit {
  /** Conceptos sin categoría propia: los únicos que se recategorizan por regla. */
  concepts: SelectableItem[];
  /** Ids exactos (hojas de movimiento), deduplicados. */
  transactionIds: string[];
  /** Nodos categoría/subcategoría: el servidor no recategoriza una categoría. */
  omitted: number;
  /** Movimientos que de verdad se mueven, para el acuse. */
  moved: number;
}

export function splitForCategory(
  items: readonly SelectableItem[],
  movIdsByKey: ReadonlyMap<string, string[]>
): CategorySplit {
  const concepts = items.filter((i) => i.txId == null && i.categoryId == null);
  const transactionIds = resolveSelectionIds(items.filter((i) => i.txId != null), movIdsByKey);
  return {
    concepts,
    transactionIds,
    omitted: items.filter((i) => i.categoryId != null).length,
    moved: concepts.reduce((sum, i) => sum + i.count, 0) + transactionIds.length
  };
}

export function categoryAssignPayloads(
  items: readonly SelectableItem[],
  categoryId: string,
  movIdsByKey: ReadonlyMap<string, string[]>
): FinanceWritePayloadV1[] {
  const { concepts, transactionIds } = splitForCategory(items, movIdsByKey);
  return [
    ...concepts.map((i) => assignConceptToCategory(i.provider, i.concept, categoryId)),
    ...(transactionIds.length > 0 ? [bulkByIds(transactionIds, { categoryId })] : [])
  ];
}

// ── Deshacer una recategorización ────────────────────────────────────────────
// El ACK de sync no devuelve «categorías previas», así que el plan se captura
// EN EL CLIENTE antes de soltar: las filas del pivot ya saben la categoría de
// cada movimiento. Previa única → re-asignar el concepto; previas mixtas →
// restauración por ids.
//
// F6-I1, con la mitad de servidor ya integrada: `finance.category.assignConcept`
// SUSTITUYE la regla manual de prioridad 0 del mismo `(rule_type, pattern)`
// antes de insertar la suya (`replaceManualRule`, en
// packages/server/src/commands/finance.ts, compartido con la ruta `createRule`
// de `finance.transaction.update`). Consecuencia por rama:
//  - `reassignments` reenvía `assignConcept` con la categoría previa, así que
//    REAJUSTA la regla que creó el drop: queda apuntando a donde estaba, no
//    hay nada que borrar en Ajustes (y borrarla desharía el estado correcto);
//  - `bulkRestores` va por ids exactos y no toca reglas, así que la del drop
//    sobrevive apuntando a la categoría equivocada.
// Por eso el acuse solo avisa en el segundo caso, y solo si el drop llegó a
// crear alguna regla (`runCategoryUndo` en PivotTable.svelte).

/**
 * Forma mínima de una fila de movimiento tal como la sirve el servidor: solo
 * lo que hace falta para indexar la categoría previa. Tipado ESTRUCTURAL a
 * propósito — sin importar el DTO completo del servidor.
 */
export interface TxCategoryRow {
  id: string;
  categoryId: string | null;
}

export function buildTxCategoryIndex(rows: readonly TxCategoryRow[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of rows) map.set(row.id, row.categoryId);
  return map;
}

export interface CategoryUndo {
  reassignments: { provider: string; concept: string | null; categoryId: string }[];
  /** Se manda con `bulkByIds`, así que el campo se llama ya `transactionIds`. */
  bulkRestores: { transactionIds: string[]; categoryId: string }[];
  /** Movimientos cuya categoría previa se desconoce (null): no se restauran. */
  skipped: number;
}

export function planCategoryUndo(
  items: readonly SelectableItem[],
  movIdsByKey: ReadonlyMap<string, string[]>,
  txCat: ReadonlyMap<string, string | null>
): CategoryUndo {
  const plan: CategoryUndo = { reassignments: [], bulkRestores: [], skipped: 0 };
  for (const item of items) {
    if (item.categoryId != null) continue; // el drop no procesa categorías: nada que deshacer
    const ids = item.txId != null ? [item.txId] : (movIdsByKey.get(item.key) ?? []);
    const prevs = new Set(ids.map((id) => txCat.get(id) ?? null));
    const [only] = [...prevs];
    if (prevs.size === 1 && only != null && item.provider) {
      plan.reassignments.push({ provider: item.provider, concept: item.concept, categoryId: only });
      continue;
    }
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const prev = txCat.get(id) ?? null;
      if (prev === null) {
        plan.skipped += 1;
        continue;
      }
      groups.set(prev, [...(groups.get(prev) ?? []), id]);
    }
    for (const [categoryId, transactionIds] of groups) plan.bulkRestores.push({ transactionIds, categoryId });
  }
  return plan;
}

/** Los comandos que ejecutan un `CategoryUndo` ya planificado. */
export function categoryUndoPayloads(plan: CategoryUndo): FinanceWritePayloadV1[] {
  return [
    ...plan.reassignments.map((r) => assignConceptToCategory(r.provider, r.concept, r.categoryId)),
    ...plan.bulkRestores.map((g) => bulkByIds(g.transactionIds, { categoryId: g.categoryId }))
  ];
}

// ── Envío en cadena de la barra de acciones (R14) ────────────────────────────
// `sendAll`/`acuse` viven aquí, puros y testeables, para que el componente
// (T12) solo tenga que llamarlos: nada de lógica de outcome dentro de Svelte.

/**
 * Copy único para «se guardó local y se reenviará solo» (outcome `queued`).
 * Es el mismo texto que emite el outbox (`MESSAGES.queued` en
 * `$lib/offline/queue-command`): las dos pantallas deben decir lo mismo.
 */
export const COLA = 'Guardado en este dispositivo; se enviará al recuperar la conexión.';

export interface SendOutcome {
  ok: boolean;
  /**
   * Tamaño del lote enviado a `sendAll`, NO comandos realmente confirmados:
   * tras un corte (`ok: false`) sigue siendo `payloads.length`, aunque los
   * posteriores al rechazo/conflicto no llegaran a enviarse. Solo sirve para
   * distinguir el lote vacío (`sent === 0`).
   */
  sent: number;
  queued: boolean;
  message: string;
}

export interface SendAllDeps {
  /** Inyectable en pruebas; en producción es `sendFinanceCommand`. */
  send?: typeof sendFinanceCommand;
  invalidate: (token: string) => Promise<void>;
  /**
   * F6-I5: una acción en bloque son N peticiones EN SERIE (una por concepto).
   * Con 30-40 filas la interfaz callaba durante todo el envío. Se llama justo
   * ANTES de mandar cada comando, con (nº de este comando, total del lote), y
   * nunca con el lote vacío.
   */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Envía los payloads EN ORDEN, uno a uno. `queued` es éxito y se sigue con el
 * siguiente comando; `rejected`/`conflict` corta la cadena de inmediato (los
 * comandos restantes no se envían) y devuelve el mensaje de ESE resultado. Si
 * algún comando llegó a `synced`, se invalida `cc:finance` UNA sola vez al
 * final (nunca si todo quedó `queued`, y nunca tras un corte).
 */
export async function sendAll(
  householdId: string,
  payloads: readonly FinanceWritePayloadV1[],
  deps: SendAllDeps
): Promise<SendOutcome> {
  if (payloads.length === 0) return { ok: true, sent: 0, queued: false, message: '' };
  const send = deps.send ?? sendFinanceCommand;
  let anySynced = false;
  let anyQueued = false;
  let done = 0;
  for (const payload of payloads) {
    done += 1;
    deps.onProgress?.(done, payloads.length);
    const result = await send(householdId, payload);
    if (result.outcome === 'rejected' || result.outcome === 'conflict') {
      return { ok: false, sent: payloads.length, queued: anyQueued, message: result.message };
    }
    if (result.outcome === 'synced') anySynced = true;
    if (result.outcome === 'queued') anyQueued = true;
  }
  if (anySynced) await deps.invalidate('cc:finance');
  // Con todo `synced` (sin nada en cola) el mensaje es irrelevante: `acuse`
  // siempre usa el `resumen` del llamador en ese camino, nunca `r.message`.
  return { ok: true, sent: payloads.length, queued: anyQueued, message: anyQueued ? COLA : '' };
}

/**
 * Copy final para el toast/acuse de la barra de acciones: sin nada enviado
 * (`sent === 0`) manda `vacio`; un corte por rechazo/conflicto manda el
 * mensaje de ESE resultado; éxito con algo en cola manda el `resumen` seguido
 * de la nota de cola (`resumen · ${r.message}`), para no perder los avisos que
 * el `resumen` trae (reglas conservadas, movimientos saltados…); éxito sin
 * nada en cola manda solo el `resumen`.
 */
export function acuse(r: SendOutcome, resumen: string, vacio = 'No hay nada que asignar'): string {
  if (r.sent === 0) return vacio;
  if (!r.ok) return r.message;
  return r.queued ? `${resumen} · ${r.message}` : resumen;
}
