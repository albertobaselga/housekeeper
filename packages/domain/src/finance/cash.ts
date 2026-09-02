import type { CashProposal, FinanceAccountView, FinanceTxView } from "./types.js";

/** Regex portada 1:1 de cash.py::WITHDRAWAL_RX. */
const WITHDRAWAL_RX = /REINT\.?\s*CAJERO|CAJERO\s+AUTOM|RETIRADA\s+(DE\s+)?EFECTIVO|\bCAJERO\b|\bATM\b/i;

/** Port de cash.py::detect_cash_withdrawals: retiradas de cajero a recategorizar
 * como gasto «Efectivo» confirmado (la categoría la resuelve/crea el pipeline).
 * La cuenta Efectivo llega por id: el esquema no admite `bank = 'efectivo'`.
 * `accounts` se mantiene en la firma para no divergir del contrato del dominio
 * y para validar que el id recibido pertenece al hogar. */
export function detectCashMovements(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
  opts: { cashAccountId: string | null },
): CashProposal[] {
  const cashAccountIds = new Set(
    accounts.filter((a) => a.id === opts.cashAccountId).map((a) => a.id),
  );
  return txs
    .filter(
      (t) =>
        t.amountCents < 0n &&
        t.transferGroupId === null &&
        !cashAccountIds.has(t.accountId) &&
        t.status !== "confirmada" &&
        WITHDRAWAL_RX.test(`${t.provider ?? ""} ${t.concept}`),
    )
    .map((t) => ({ txId: t.id }));
}

/** Contrapartida de doble entrada del efectivo. La fase 5 la inserta tal cual en
 * `finance.transaction.manual.create`, heredando además el `batch_id` del gasto
 * que la origina (igual que los espejos de inversión del pipeline). */
export interface CashCounterleg {
  accountId: string;
  opDate: string;
  concept: string;
  provider: string;
  amountCents: bigint;
  categoryId: string;
  status: "confirmada";
  recurrenceManual: true;
  dedupHash: string;
}

/** Port de cash.py::create_cash_counterleg: contrapartida +Efectivo (confirmada,
 * recurrence_manual=true, hash `cashpair-`) de un gasto manual en la cuenta
 * Efectivo. ÚNICA productora de filas `cashpair-`: el pipeline no las crea. */
export function cashCounterlegFor(
  expense: FinanceTxView,
  opts: { cashAccountId: string; efectivoCategoryId: string },
): CashCounterleg | null {
  if (
    expense.accountId !== opts.cashAccountId ||
    expense.amountCents >= 0n ||
    expense.categoryId === null ||
    expense.categoryId === opts.efectivoCategoryId ||
    expense.categoryKind !== "gasto"
  ) {
    return null;
  }
  return {
    accountId: opts.cashAccountId,
    opDate: expense.opDate,
    concept: `Contrapartida efectivo — ${expense.concept}`,
    provider: "EFECTIVO",
    amountCents: -expense.amountCents,
    categoryId: opts.efectivoCategoryId,
    status: "confirmada",
    recurrenceManual: true,
    dedupHash: `cashpair-${expense.dedupHash}`,
  };
}
