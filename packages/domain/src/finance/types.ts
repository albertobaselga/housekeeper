export type FinanceBank = "caixabank" | "deutsche_bank" | "openbank" | "amex";
export type FinanceAccountKind = "comun" | "personal" | "inversion";
export type FinanceCategoryKind = "gasto" | "ingreso" | "transferencia";
export type FinanceTransactionStatus =
  | "pendiente"
  | "sugerida_regla"
  | "sugerida_agente"
  | "confirmada";
export type FinanceRuleType = "proveedor_exacto" | "concepto_contiene" | "codigo_norma43";
export type FinanceRecurrence = "recurrente" | "extraordinario" | null;

/** Fila normalizada que producen los parsers (fechas ISO yyyy-mm-dd). */
export interface ParsedRow {
  accountRef: string; // CCC/IBAN/nº de cuenta detectado por fila o cabecera
  bankRef: string; // idéntico a accountRef; entra en el hash de dedup (compatibilidad con el origen)
  opDate: string;
  valueDate: string | null;
  concept: string;
  provider: string | null;
  amountCents: bigint;
  balanceCents: bigint | null;
  codeCommon: string | null;
  codeOwn: string | null;
  dedupRef: string | null; // solo Amex (columna Referencia)
  bankCategory: string | null; // extensión fase 2: columna «Categoría» de Amex → bank_category
  raw: Record<string, string>; // cabecera→valor del fichero original
}

export interface ParsedStatement {
  bank: FinanceBank;
  accountRefs: string[]; // refs únicas detectadas en el fichero
  rows: ParsedRow[];
}

/** Vista de transacción que consumen las heurísticas puras del dominio. */
export interface FinanceTxView {
  id: string;
  accountId: string;
  opDate: string;
  concept: string;
  provider: string | null;
  providerNorm: string | null;
  amountCents: bigint;
  categoryId: string | null;
  status: FinanceTransactionStatus;
  transferGroupId: string | null;
  recurrence: FinanceRecurrence;
  recurrenceManual: boolean;
  dedupHash: string;
  // Extensión fase 2 (port fiel del origen; se rellenan desde SQL con join a categorías):
  codeCommon: string | null;
  codeOwn: string | null;
  categoryKind: FinanceCategoryKind | null;
}

export interface FinanceAccountView {
  id: string;
  name: string;
  /** NULL en cuentas sin banco (Efectivo, inversión, manuales): el CHECK de
   * `app.finance_accounts.bank` (fase 1) solo admite los cuatro bancos reales.
   * El dominio NUNCA deduce «efectivo» ni «inversión» de este campo. */
  bank: FinanceBank | null;
  kind: FinanceAccountKind;
  bankRef: string;
  ownerAliases: readonly string[];
  transferRefs: readonly string[];
}

export interface FinanceCategoryView {
  id: string;
  parentId: string | null;
  name: string;
  kind: FinanceCategoryKind;
}

export interface FinanceRuleView {
  id: string;
  ruleType: FinanceRuleType;
  pattern: string;
  categoryId: string;
  priority: number;
}

export interface FinanceEventRuleView {
  id: string;
  /** NULLABLE en el esquema de la fase 1: las reglas por categoría no traen
   * proveedor (`CHECK (provider_norm IS NOT NULL OR category_id IS NOT NULL)`). */
  providerNorm: string | null;
  conceptNorm: string | null;
  categoryId: string | null;
  eventId: string;
}

export interface FinanceProviderAliasView {
  providerNorm: string;
  display: string;
}

/** Cruce de dos patas propuesto (transferencias y conciliación Amex). El uuid
 * de grupo lo genera el servidor: el dominio solo reutiliza grupos existentes. */
export interface TransferProposal {
  legIds: readonly [string, string];
  existingGroupId: string | null;
  status: "confirmada" | "sugerida_regla";
}

export interface InvestmentMirrorProposal {
  chargeTxId: string;
  investmentAccountId: string;
  mirrorOpDate: string;
  mirrorConcept: string;
  mirrorProvider: string;
  mirrorAmountCents: bigint; // positivo (abs del cargo)
  mirrorDedupHash: string; // `invmirror-${dedupHash del cargo}`
}

/** Retirada de cajero a recategorizar como gasto «Efectivo» confirmado. */
export interface CashProposal {
  txId: string;
}

export interface RecurrenceVerdict {
  txId: string;
  recurrence: "recurrente" | "extraordinario";
}

export interface EventAssignmentProposal {
  txId: string;
  eventId: string;
}

export interface SummaryOptions {
  from: string;
  to: string;
  accountIds?: readonly string[] | null;
  eventId?: string | null;
  excludeEventIds?: readonly string[];
  accounts: readonly FinanceAccountView[];
  /** eventos asignados por transacción (para filtros ev/exev). */
  eventIdsByTx?: ReadonlyMap<string, readonly string[]>;
}

export interface RangeSummary {
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
  prev: RangeSummary | null;
}
