import { dayDiffIso, normText } from "./text.js";
import type { FinanceAccountView, FinanceTxView, TransferProposal } from "./types.js";

const KEYWORDS = ["TRANSFERENCIA", "TRASPASO"] as const;

function allAliases(accounts: readonly FinanceAccountView[]): Set<string> {
  const aliases = new Set<string>();
  for (const acc of accounts) for (const a of acc.ownerAliases) aliases.add(normText(a));
  return aliases;
}

function isKeywordTransfer(tx: FinanceTxView, aliases: ReadonlySet<string>): boolean {
  const concept = normText(tx.concept);
  return (
    KEYWORDS.some((k) => concept.includes(k)) &&
    [...aliases].some((a) => concept.includes(a))
  );
}

function hasKeyword(tx: FinanceTxView): boolean {
  const concept = normText(tx.concept);
  return KEYWORDS.some((k) => concept.includes(k));
}

/** Patas con transfer_group_id pero solas en su grupo (huérfanas de un traspaso). */
function loneLegs(txs: readonly FinanceTxView[]): FinanceTxView[] {
  const counts = new Map<string, number>();
  for (const t of txs) {
    if (t.transferGroupId !== null) counts.set(t.transferGroupId, (counts.get(t.transferGroupId) ?? 0) + 1);
  }
  return txs.filter((t) => t.transferGroupId !== null && counts.get(t.transferGroupId) === 1);
}

/** Port de transfers.py::detect_transfers como función pura: recibe TODAS las
 * transacciones del hogar y devuelve propuestas de cruce; los uuid de grupo
 * nuevos los pone el servidor (existingGroupId solo si reutiliza una huérfana). */
export function detectTransferPairs(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
): TransferProposal[] {
  const aliases = allAliases(accounts);
  const lone = loneLegs(txs);
  const loneIds = new Set(lone.map((t) => t.id));
  const base = txs.filter(
    (t) =>
      t.transferGroupId === null &&
      (t.status === "pendiente" || t.status === "sugerida_regla") &&
      (t.categoryId === null || t.categoryKind === "transferencia"),
  );
  const extra = txs.filter(
    (t) => t.transferGroupId === null && t.status !== "confirmada" && hasKeyword(t),
  );
  const byId = new Map<string, FinanceTxView>();
  for (const t of [...base, ...extra]) byId.set(t.id, t);
  const sortedBase = [...byId.values()].sort(
    (a, b) => a.opDate.localeCompare(b.opDate) || a.id.localeCompare(b.id),
  );
  const reclaimable = txs.filter(
    (t) =>
      t.transferGroupId === null &&
      t.status === "confirmada" &&
      t.categoryKind === "ingreso" &&
      isKeywordTransfer(t, aliases),
  );
  const candidates = [...sortedBase, ...lone, ...reclaimable];

  const proposals: TransferProposal[] = [];
  const used = new Set<string>();
  for (const tx of candidates) {
    if (used.has(tx.id)) continue;
    for (const other of candidates) {
      if (
        other.id !== tx.id &&
        !used.has(other.id) &&
        other.accountId !== tx.accountId &&
        other.amountCents === -tx.amountCents &&
        Math.abs(dayDiffIso(other.opDate, tx.opDate)) <= 3
      ) {
        const existingGroupId = loneIds.has(tx.id)
          ? tx.transferGroupId
          : loneIds.has(other.id)
            ? other.transferGroupId
            : null;
        const status =
          isKeywordTransfer(tx, aliases) || isKeywordTransfer(other, aliases)
            ? "confirmada"
            : "sugerida_regla";
        proposals.push({ legIds: [tx.id, other.id], existingGroupId, status });
        used.add(tx.id);
        used.add(other.id);
        break;
      }
    }
  }
  return proposals;
}
