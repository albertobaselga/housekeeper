import { dayDiffIso, normText } from "./text.js";
import type { FinanceAccountView, FinanceTxView, TransferProposal } from "./types.js";

const RECIBO_MARKER = "RECIBO ENVIADO A SU BANCO";
const BANK_SIDE_MARKER = "AMERICAN EXPRESS";
const MATCH_WINDOW_DAYS = 10;

/** Port de amex.py::reconcile_amex_payments: recibo Amex (+) ↔ cargo bancario
 * (−), importe exacto, ±10 días, gana el más cercano; ambas patas confirmadas. */
export function reconcileAmex(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
): TransferProposal[] {
  const amexIds = new Set(accounts.filter((a) => a.bank === "amex").map((a) => a.id));
  if (amexIds.size === 0) return [];
  const payments = txs
    .filter(
      (t) =>
        amexIds.has(t.accountId) &&
        t.amountCents > 0n &&
        t.transferGroupId === null &&
        normText(t.concept).includes(RECIBO_MARKER),
    )
    .sort((a, b) => a.opDate.localeCompare(b.opDate) || a.id.localeCompare(b.id));
  const charges = txs.filter(
    (t) =>
      !amexIds.has(t.accountId) &&
      t.amountCents < 0n &&
      t.transferGroupId === null &&
      normText(`${t.provider ?? ""} ${t.concept}`).includes(BANK_SIDE_MARKER),
  );
  const proposals: TransferProposal[] = [];
  const used = new Set<string>();
  for (const pay of payments) {
    const candidates = charges.filter(
      (c) =>
        !used.has(c.id) &&
        c.amountCents === -pay.amountCents &&
        Math.abs(dayDiffIso(c.opDate, pay.opDate)) <= MATCH_WINDOW_DAYS,
    );
    if (candidates.length === 0) continue;
    const charge = candidates.reduce((best, c) =>
      Math.abs(dayDiffIso(c.opDate, pay.opDate)) < Math.abs(dayDiffIso(best.opDate, pay.opDate)) ? c : best,
    );
    used.add(charge.id);
    proposals.push({ legIds: [pay.id, charge.id], existingGroupId: null, status: "confirmada" });
  }
  return proposals;
}
