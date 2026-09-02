/**
 * Lógica pura del ledger y del panel de detalle de Finanzas (Ruling R13 de la
 * Task 11): se extrae aquí para poder testearla sin Postgres ni
 * testing-library — LedgerTable.svelte y FinanceDetailPanel.svelte quedan
 * finos, solo marcado y disparo de estos cálculos.
 */
import type { FinanceTxDto } from '@housekeeper/server';

import type { FinanceDetailMode } from './api';
import { dateLabel, formatCents, STATUS_LABEL } from './format';

/** Línea secundaria de una fila del ledger: fecha·cuenta · categoría · eventos · recurrencia · estado. */
export function ledgerRowMeta(tx: FinanceTxDto, eventNameById: Record<string, string>): string {
  return [
    `${dateLabel(tx.opDate)} · ${tx.accountName}`,
    tx.categoryName ?? 'Sin categorizar',
    tx.eventIds.map((id) => eventNameById[id]).filter(Boolean).join(', ') || null,
    tx.recurrence === 'recurrente' ? '♻' : tx.recurrence === 'extraordinario' ? '✦' : null,
    STATUS_LABEL[tx.status] ?? tx.status
  ]
    .filter((piece): piece is string => piece !== null)
    .join(' · ');
}

/**
 * Título visible de un movimiento: proveedor mostrado, o el bruto, o el
 * concepto (única definición: LedgerTable, FinanceDetailPanel y la celda de
 * Revisión consumen esta en vez de repetir el mismo `||` a mano — [FASE 5,
 * T10 · corrección Important 2] Revisión reimplementaba esto con `??`, que no
 * cae al siguiente campo ante una cadena VACÍA). Una cadena vacía en
 * cualquiera de los dos primeros campos cae al siguiente, como siempre hizo
 * el operador `||`.
 *
 * La firma pide solo los tres campos que usa (no el `FinanceTxDto` completo):
 * `FinanceRevisionRow` (`$lib/server/finance.server.ts`) no es un
 * `FinanceTxDto` —le faltan `eventIds`, `raw`, etc.— y no debía fabricar uno
 * falso solo para llamar aquí. `FinanceTxDto` sigue satisfaciendo esta forma
 * sin cambios en sus llamadores actuales.
 */
export function txTitle(tx: { providerDisplay: string | null; provider: string | null; concept: string }): string {
  return tx.providerDisplay || tx.provider || tx.concept;
}

/**
 * `raw` es jsonb NOT NULL DEFAULT '{}' (Ruling R11): la guarda exige también
 * claves. Predicado de tipo (no `boolean`) para que `source.raw` quede
 * estrechado a `Record<string, string>` sin recurrir a un `as` sobre datos de
 * fila (R7 prohíbe esas aserciones). Exportado: es la única definición válida
 * de «tiene raw» del módulo — cualquier llamador que necesite decidir si un
 * movimiento trae datos de origen propios debe usar esta, no repetir
 * `tx.raw` a pelo (un `{}` es truthy y rompería esa comprobación).
 */
export function hasRaw(tx: FinanceTxDto): tx is FinanceTxDto & { raw: Record<string, string> } {
  return tx.raw !== null && Object.keys(tx.raw).length > 0;
}

/**
 * «Datos del origen» de un movimiento: el `raw` propio si lo tiene; si no, y
 * el llamador resolvió el cargo emparejado del mismo grupo de transferencia
 * (espejo sin fichero propio), el `raw` de ese cargo; a falta de ambos, los
 * campos sueltos de la fila (fecha valor, saldo, conceptos, categoría banco).
 */
export function originRows(
  tx: FinanceTxDto,
  partner?: FinanceTxDto | null
): { label: string; rows: [string, string][] } | null {
  const source = hasRaw(tx) ? tx : partner && hasRaw(partner) ? partner : tx;
  if (hasRaw(source)) {
    return {
      label: source === tx ? 'Datos del origen' : 'Datos del origen (cargo emparejado)',
      rows: Object.entries(source.raw).map(([key, value]) => [key, String(value)])
    };
  }
  const entries: [string, string | null][] = [
    ['Fecha valor', source.valueDate],
    ['Saldo', source.balanceCents === null ? null : formatCents(source.balanceCents)],
    ['Concepto común', source.codeCommon],
    ['Concepto propio', source.codeOwn],
    ['Categoría banco', source.bankCategory]
  ];
  const rows = entries.filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '');
  return rows.length > 0 ? { label: 'Detalles', rows } : null;
}

/**
 * [FASE 5, T9] Un manual borrable: sin lote de importación (`batchId` null) y
 * con el hash sintético que el servidor genera al crearlo (`manual-…`) — no un
 * lote real ni la contrapartida `cashpair-` de una inversión. Réplica EXACTA
 * de la guarda del servidor (`packages/server/src/commands/finance.ts`:
 * `if (tx.batch_id !== null || !tx.dedup_hash.startsWith("manual-")) rechaza`,
 * aquí en positivo) para que la UI no ofrezca un borrado que el servidor fuera
 * a rechazar. Única definición: LedgerTable la consume en vez de repetir el
 * predicado a mano, y queda testeada aquí sin compilar el componente.
 */
export function isManualTransaction(tx: FinanceTxDto): boolean {
  return tx.batchId === null && tx.dedupHash.startsWith('manual-');
}

/** Tarjetas a pintar en el panel según el modo: el propio movimiento, o lo ya traído para ids/grupo. */
export function detailCards(mode: FinanceDetailMode | null, fetched: FinanceTxDto[] | null): FinanceTxDto[] {
  if (mode === null) return [];
  if (mode.kind === 'movimiento') return [mode.tx];
  return fetched ?? [];
}
