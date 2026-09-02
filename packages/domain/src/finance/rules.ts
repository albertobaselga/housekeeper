import { normText } from "./text.js";
import type { FinanceRuleType, FinanceRuleView, FinanceTxView } from "./types.js";

/** Especificidad del origen: proveedor exacto > concepto contiene > código Norma 43. */
const SPECIFICITY: Record<FinanceRuleType, number> = {
  proveedor_exacto: 3,
  concepto_contiene: 2,
  codigo_norma43: 1,
};

function matches(rule: FinanceRuleView, tx: FinanceTxView): boolean {
  if (rule.ruleType === "proveedor_exacto") {
    return tx.provider !== null && normText(tx.provider) === normText(rule.pattern);
  }
  if (rule.ruleType === "concepto_contiene") {
    return normText(tx.concept).includes(normText(rule.pattern));
  }
  return tx.codeCommon === rule.pattern;
}

/** Primera regla que casa, ordenadas por (prioridad, especificidad) descendente
 * (port de rules_engine.apply_rules; el filtro status==="pendiente" lo aplica
 * el pipeline, no esta función). */
export function matchRule(
  tx: FinanceTxView,
  rules: readonly FinanceRuleView[],
): FinanceRuleView | null {
  const ordered = [...rules].sort(
    (a, b) => b.priority - a.priority || SPECIFICITY[b.ruleType] - SPECIFICITY[a.ruleType],
  );
  return ordered.find((r) => matches(r, tx)) ?? null;
}
