import { normText, normalizeConcept } from "./text.js";
import type {
  EventAssignmentProposal,
  FinanceCategoryView,
  FinanceEventRuleView,
  FinanceProviderAliasView,
  FinanceTxView,
} from "./types.js";

function matchByProvider(
  txs: readonly FinanceTxView[],
  aliases: readonly FinanceProviderAliasView[],
  providerNorm: string,
  conceptNorm: string | null,
): FinanceTxView[] {
  const accepted = new Set([providerNorm]);
  for (const alias of aliases) {
    if (normText(alias.display) === providerNorm) accepted.add(alias.providerNorm);
  }
  return txs.filter((t) => {
    if (t.transferGroupId !== null) return false;
    if (!accepted.has(normText(t.provider ?? ""))) return false;
    if (conceptNorm !== null && normText(normalizeConcept(t.concept)) !== conceptNorm) return false;
    return true;
  });
}

function matchByCategory(
  txs: readonly FinanceTxView[],
  categories: readonly FinanceCategoryView[],
  categoryId: string,
): FinanceTxView[] {
  const targets = new Set([categoryId]);
  for (const c of categories) if (c.parentId === categoryId) targets.add(c.id);
  return txs.filter(
    (t) => t.transferGroupId === null && t.categoryId !== null && targets.has(t.categoryId),
  );
}

/** Port de event_rules.py::apply_event_rules como función pura: devuelve solo
 * las asignaciones NUEVAS (idempotente por par transacción-evento). */
export function matchEventRules(
  txs: readonly FinanceTxView[],
  rules: readonly FinanceEventRuleView[],
  opts: {
    categories: readonly FinanceCategoryView[];
    aliases: readonly FinanceProviderAliasView[];
    existingAssignments: ReadonlySet<string>;
  },
): EventAssignmentProposal[] {
  const seen = new Set(opts.existingAssignments);
  const proposals: EventAssignmentProposal[] = [];
  for (const rule of rules) {
    const matched =
      rule.categoryId !== null
        ? matchByCategory(txs, opts.categories, rule.categoryId)
        // `provider_norm` es NULLABLE: si la regla no es de categoría, el CHECK
        // del esquema garantiza que viene informado; el `?? ""` solo satisface a TS.
        : matchByProvider(txs, opts.aliases, rule.providerNorm ?? "", rule.conceptNorm);
    for (const t of matched) {
      const key = `${t.id}:${rule.eventId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push({ txId: t.id, eventId: rule.eventId });
    }
  }
  return proposals;
}
