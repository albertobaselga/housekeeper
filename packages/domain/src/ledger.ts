import { invariant } from "./errors.js";

/**
 * Libro mayor append-only para saldos permanentes (p. ej. minutos de descanso
 * compensatorio, regla AC-03: el crédito nunca caduca). Ninguna anotación se
 * edita ni se borra: una corrección es siempre una nueva anotación de reversa.
 */
export type LedgerEntryKind = "credit" | "debit" | "adjustment" | "reversal";

export interface LedgerEntry<Unit extends string = string> {
  readonly id: string;
  readonly accountId: string;
  readonly sequence: number;
  readonly unit: Unit;
  readonly kind: LedgerEntryKind;
  readonly delta: bigint;
  readonly effectiveOn: string;
  readonly recordedAt: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reversesEntryId: string | null;
}

export interface LedgerProjection<Unit extends string = string> {
  readonly accountId: string;
  readonly unit: Unit;
  readonly balance: bigint;
  readonly totalCredits: bigint;
  readonly totalDebits: bigint;
  readonly lastSequence: number;
  readonly entryIds: readonly string[];
  readonly entries: Readonly<Record<string, LedgerEntry<Unit>>>;
  readonly reversedEntryIds: Readonly<Record<string, true>>;
}

export function emptyLedgerProjection<Unit extends string>(
  accountId: string,
  unit: Unit,
): LedgerProjection<Unit> {
  invariant(accountId.trim().length > 0, "INVALID_LEDGER_ACCOUNT", "La cuenta del libro es obligatoria.");
  invariant(unit.trim().length > 0, "INVALID_LEDGER_UNIT", "La unidad del libro es obligatoria.");
  return Object.freeze({
    accountId,
    unit,
    balance: 0n,
    totalCredits: 0n,
    totalDebits: 0n,
    lastSequence: 0,
    entryIds: Object.freeze([]),
    entries: Object.freeze({}),
    reversedEntryIds: Object.freeze({}),
  });
}

function validateEntry<Unit extends string>(
  projection: LedgerProjection<Unit>,
  entry: LedgerEntry<Unit>,
): void {
  invariant(entry.id.trim().length > 0, "INVALID_LEDGER_ENTRY", "La anotación necesita un id.");
  invariant(entry.accountId === projection.accountId, "LEDGER_ACCOUNT_MISMATCH", "La anotación no pertenece a esta cuenta.");
  invariant(entry.unit === projection.unit, "LEDGER_UNIT_MISMATCH", "La anotación no usa la unidad de la cuenta.");
  invariant(
    entry.sequence === projection.lastSequence + 1,
    "LEDGER_SEQUENCE_GAP",
    `Se esperaba la secuencia ${projection.lastSequence + 1} y llegó ${entry.sequence}.`,
  );
  invariant(!projection.entries[entry.id], "DUPLICATE_LEDGER_ENTRY", `Anotación duplicada: ${entry.id}`);
  invariant(entry.delta !== 0n, "ZERO_LEDGER_ENTRY", "Una anotación no puede tener delta cero.");
  invariant(
    Number.isFinite(Date.parse(entry.recordedAt)),
    "INVALID_LEDGER_TIMESTAMP",
    "recordedAt debe ser un instante compatible con ISO.",
  );
  invariant(
    entry.sourceType.trim().length > 0 && entry.sourceId.trim().length > 0,
    "INVALID_LEDGER_SOURCE",
    "Cada anotación exige tipo e id de origen para ser trazable.",
  );

  if (entry.kind === "credit") {
    invariant(entry.delta > 0n, "INVALID_LEDGER_SIGN", "Un crédito debe tener delta positivo.");
    invariant(entry.reversesEntryId === null, "INVALID_LEDGER_REVERSAL", "Un crédito no puede revertir otra anotación.");
  } else if (entry.kind === "debit") {
    invariant(entry.delta < 0n, "INVALID_LEDGER_SIGN", "Un débito debe tener delta negativo.");
    invariant(entry.reversesEntryId === null, "INVALID_LEDGER_REVERSAL", "Un débito no puede revertir otra anotación.");
  } else if (entry.kind === "adjustment") {
    invariant(entry.reversesEntryId === null, "INVALID_LEDGER_REVERSAL", "Un ajuste no puede revertir otra anotación.");
  } else {
    invariant(entry.reversesEntryId !== null, "MISSING_REVERSAL_TARGET", "Una reversa exige la anotación objetivo.");
    const target = projection.entries[entry.reversesEntryId];
    invariant(target, "REVERSAL_TARGET_NOT_FOUND", "La anotación a revertir debe existir previamente.");
    invariant(target.kind !== "reversal", "REVERSAL_OF_REVERSAL", "Una reversa no puede revertir otra reversa.");
    invariant(
      !projection.reversedEntryIds[target.id],
      "LEDGER_ENTRY_ALREADY_REVERSED",
      "Una anotación solo puede revertirse una vez.",
    );
    invariant(entry.delta === -target.delta, "REVERSAL_AMOUNT_MISMATCH", "Una reversa debe negar exactamente su objetivo.");
  }
}

/** Aplica una anotación inmutable a una proyección inmutable; nada se reemplaza. */
export function appendLedgerEntry<Unit extends string>(
  projection: LedgerProjection<Unit>,
  input: LedgerEntry<Unit>,
): LedgerProjection<Unit> {
  validateEntry(projection, input);
  const entry = Object.freeze({ ...input });
  const reversedEntryIds =
    entry.kind === "reversal"
      ? Object.freeze({
          ...projection.reversedEntryIds,
          [entry.reversesEntryId as string]: true as const,
        })
      : projection.reversedEntryIds;

  return Object.freeze({
    accountId: projection.accountId,
    unit: projection.unit,
    balance: projection.balance + entry.delta,
    totalCredits: projection.totalCredits + (entry.delta > 0n ? entry.delta : 0n),
    totalDebits: projection.totalDebits + (entry.delta < 0n ? -entry.delta : 0n),
    lastSequence: entry.sequence,
    entryIds: Object.freeze([...projection.entryIds, entry.id]),
    entries: Object.freeze({ ...projection.entries, [entry.id]: entry }),
    reversedEntryIds,
  });
}

export function projectLedger<Unit extends string>(
  accountId: string,
  unit: Unit,
  entries: readonly LedgerEntry<Unit>[],
): LedgerProjection<Unit> {
  return entries.reduce(
    (projection, entry) => appendLedgerEntry(projection, entry),
    emptyLedgerProjection(accountId, unit),
  );
}
