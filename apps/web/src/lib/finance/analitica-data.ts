import type { FinanceAccountKind, FinanceCategoryKind, FinanceRecurrence } from '@housekeeper/domain/finance';

import type { AnalyticsRowLike } from './chart-data';
import type { FinanceFilters } from './filters';

/** Contrato del load de Analítica (real y demo). Céntimos SIEMPRE bigint. */

export type PivotRowKind = 'gasto' | 'ingreso' | 'transferencia' | 'inversion';

/**
 * Fila fuente del pivot, misma forma que `PivotSourceRow` del dominio (fase 2,
 * `packages/domain/src/finance/pivot.ts`): mismos nombres de campo (`nat`
 * reutiliza `FinanceRecurrence`, que ya es `'recurrente' | 'extraordinario' |
 * null`), para que el mapeo del loader (Step 6) sea directo.
 */
export interface AnaliticaPivotRow {
  cat: string;
  sub: string | null;
  catId: string | null;
  nat: FinanceRecurrence;
  prov: string;
  concept: string;
  event: string | null;
  eventId: string | null;
  kind: PivotRowKind;
  month: string;
  totalCents: bigint;
  count: number;
  movs: { id: string; date: string; cents: bigint }[];
}

export interface AnaliticaSummary {
  incomeCents: bigint;
  expenseCents: bigint;
  recurringExpenseCents: bigint;
  extraordinaryExpenseCents: bigint;
  unclassifiedExpenseCents: bigint;
  savingsCents: bigint;
  netSavingsRate: number | null;
  grossSavingsRate: number | null;
  investedCents: bigint;
  investmentRate: number | null;
  freeCashFlowCents: bigint;
  opsCashFlowCents: bigint;
  receivedContributionsCents: bigint;
  outgoingTransfersCents: bigint;
  pendingCount: number;
}

export interface AnaliticaEventSummary {
  id: string;
  name: string;
  txCount: number;
  netCents: bigint;
  incomeCents: bigint;
  expenseCents: bigint;
}

export interface AnaliticaCategory {
  id: string;
  parentId: string | null;
  name: string;
  kind: FinanceCategoryKind;
}

export interface AnaliticaAccount {
  id: string;
  name: string;
  kind: FinanceAccountKind;
}

/**
 * Guardas de `kind` compartidas por el loader (Step 6, sobre el `string` del
 * DTO de cable) y por la maqueta (sobre el `kind: string` inferido de
 * `FINANCE_ACCOUNTS`/`FINANCE_CATEGORIES` en fixtures.server.ts): una sola
 * definición de qué valores son válidos, en vez de que cada lado invente su
 * propia lista y puedan divergir en silencio.
 */
export const ACCOUNT_KINDS = ['comun', 'personal', 'inversion'] as const;

export function isFinanceAccountKind(value: string): value is FinanceAccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(value);
}

export const CATEGORY_KINDS = ['gasto', 'ingreso', 'transferencia'] as const;

export function isFinanceCategoryKind(value: string): value is FinanceCategoryKind {
  return (CATEGORY_KINDS as readonly string[]).includes(value);
}

export interface AnaliticaData {
  from: string;
  to: string;
  months: string[];
  /** Filtros ya parseados: los necesita `FinanceFilterBar` (fase 4) tal cual. */
  filters: FinanceFilters;
  summary: AnaliticaSummary;
  analyticsRows: AnalyticsRowLike[];
  pivotRows: AnaliticaPivotRow[];
  eventsSummary: AnaliticaEventSummary[];
  categories: AnaliticaCategory[];
  accounts: AnaliticaAccount[];
  /** Subconjunto `kind === 'inversion'` precalculado: lo usa la barra de acciones. */
  invAccounts: { id: string; name: string }[];
}
