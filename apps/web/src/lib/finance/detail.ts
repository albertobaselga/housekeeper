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
  return (
    [
      `${dateLabel(tx.opDate)} · ${tx.accountName}`,
      tx.categoryName ?? 'Sin categorizar',
      tx.eventIds.map((id) => eventNameById[id]).filter(Boolean).join(', ') || null,
      tx.recurrence === 'recurrente' ? '♻' : tx.recurrence === 'extraordinario' ? '✦' : null,
      STATUS_LABEL[tx.status] ?? tx.status
    ] as (string | null)[]
  )
    .filter((piece): piece is string => piece !== null)
    .join(' · ');
}

/** `raw` es jsonb NOT NULL DEFAULT '{}' (Ruling R11): la guarda exige también claves. */
function hasRaw(tx: FinanceTxDto): boolean {
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
      rows: Object.entries(source.raw as Record<string, string>).map(([key, value]) => [key, String(value)])
    };
  }
  const rows = (
    [
      ['Fecha valor', source.valueDate],
      ['Saldo', source.balanceCents === null ? null : formatCents(source.balanceCents)],
      ['Concepto común', source.codeCommon],
      ['Concepto propio', source.codeOwn],
      ['Categoría banco', source.bankCategory]
    ] as [string, string | null][]
  ).filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '');
  return rows.length > 0 ? { label: 'Detalles', rows } : null;
}

/** Tarjetas a pintar en el panel según el modo: el propio movimiento, o lo ya traído para ids/grupo. */
export function detailCards(mode: FinanceDetailMode | null, fetched: FinanceTxDto[] | null): FinanceTxDto[] {
  if (mode === null) return [];
  if (mode.kind === 'movimiento') return [mode.tx];
  return fetched ?? [];
}
