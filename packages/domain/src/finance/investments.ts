import { normText } from "./text.js";
import type { FinanceAccountView, FinanceTxView, InvestmentMirrorProposal } from "./types.js";

const INVESTMENT_REF_RX = /2860 56 (\d{7})/; // sin ancla: se busca dentro de concept
const NUMERIC_REF_RX = /^\d{7}$/;

function matchInvestmentAccount(
  tx: FinanceTxView,
  invAccounts: readonly FinanceAccountView[],
): FinanceAccountView | null {
  // La ref numérica se compara con el grupo 1 de INVESTMENT_REF_RX sobre el
  // CONCEPTO (nunca el provider: el saneado 04/073 lo reescribe al beneficiario).
  const refMatch = INVESTMENT_REF_RX.exec(tx.concept);
  const haystack = normText(`${tx.provider ?? ""} ${tx.concept}`);
  for (const acc of invAccounts) {
    for (const ref of acc.transferRefs) {
      // Una ref en blanco normaliza a "" y `includes("")` es SIEMPRE true: sin
      // esta guarda, esa cuenta de inversión se llevaría un espejo por cada cargo
      // del hogar. `transfer_refs` la edita el usuario desde Ajustes (fase 5).
      const refNorm = normText(ref);
      if (refNorm === "") continue;
      if (NUMERIC_REF_RX.test(ref)) {
        if (refMatch !== null && refMatch[1] === ref) return acc;
      } else if (haystack !== "" && haystack.includes(refNorm)) {
        return acc;
      }
    }
  }
  return null;
}

/** Port de investments.py::detect_investment_contributions como función pura.
 * Idempotente vía hash `invmirror-`; una ref sin mapeo nunca se espeja a ciegas.
 * El origen excluía las cuentas por `bank` ∈ {efectivo, inversion, amex}; aquí,
 * como el esquema no admite esos valores, se excluyen por `kind === "inversion"`,
 * por `bank === "amex"` y por el `cashAccountId` que pasa el llamador. */
export function detectInvestmentContributions(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
  opts: { cashAccountId: string | null },
): InvestmentMirrorProposal[] {
  const invAccounts = accounts.filter((a) => a.kind === "inversion");
  const excludedAccountIds = new Set(
    accounts
      .filter((a) => a.kind === "inversion" || a.bank === "amex" || a.id === opts.cashAccountId)
      .map((a) => a.id),
  );
  const existingHashes = new Set(txs.map((t) => t.dedupHash));
  const proposals: InvestmentMirrorProposal[] = [];
  for (const tx of txs) {
    if (tx.amountCents >= 0n || tx.transferGroupId !== null) continue;
    if (excludedAccountIds.has(tx.accountId)) continue;
    const acc = matchInvestmentAccount(tx, invAccounts);
    if (acc === null) continue;
    const mirrorHash = `invmirror-${tx.dedupHash}`;
    if (existingHashes.has(mirrorHash)) continue;
    existingHashes.add(mirrorHash);
    proposals.push({
      chargeTxId: tx.id,
      investmentAccountId: acc.id,
      mirrorOpDate: tx.opDate,
      mirrorConcept: `Aportación a ${acc.name} — ${tx.provider ?? ""}`,
      mirrorProvider: acc.name,
      mirrorAmountCents: -tx.amountCents,
      mirrorDedupHash: mirrorHash,
    });
  }
  return proposals;
}
