import { dayDiffIso } from "./text.js";
import type {
  FinanceAccountView,
  FinanceTxView,
  RangeSummary,
  SummaryOptions,
} from "./types.js";

const PENDING_STATUSES = new Set(["pendiente", "sugerida_regla", "sugerida_agente"]);

function kindFor(t: FinanceTxView): "gasto" | "ingreso" {
  if (t.categoryKind === "gasto" || t.categoryKind === "ingreso") return t.categoryKind;
  return t.amountCents > 0n ? "ingreso" : "gasto";
}

const pad = (v: number, w: number): string => String(v).padStart(w, "0");
const iso = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const lastDayOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addDaysIso(date: string, days: number): string {
  const t = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days),
  );
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Port de reports._prev_range: bloques exactos de meses de calendario retroceden
 * alineados; el resto retrocede por número de días. */
export function prevRange(from: string, to: string): { from: string; to: string } {
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  const isCalendarMonths = from.slice(8, 10) === "01" && addDaysIso(to, 1).slice(8, 10) === "01";
  if (isCalendarMonths) {
    const span = (ty - fy) * 12 + (tm - fm) + 1;
    const endIdx = fy * 12 + (fm - 1) - 1;
    const startIdx = endIdx - span + 1;
    const sy = Math.floor(startIdx / 12);
    const sm = (((startIdx % 12) + 12) % 12) + 1;
    const ey = Math.floor(endIdx / 12);
    const em = (((endIdx % 12) + 12) % 12) + 1;
    return { from: iso(sy, sm, 1), to: iso(ey, em, lastDayOfMonth(ey, em)) };
  }
  const spanDays = dayDiffIso(to, from) + 1;
  return { from: addDaysIso(from, -spanDays), to: addDaysIso(from, -1) };
}

const sum = (xs: readonly FinanceTxView[]): bigint => xs.reduce((s, t) => s + t.amountCents, 0n);

function rate1(num: bigint, den: bigint): number | null {
  if (den === 0n) return null;
  return Math.round((Number(num) * 1000) / Number(den)) / 10;
}

const inRange = (t: FinanceTxView, from: string, to: string): boolean =>
  t.opDate >= from && t.opDate <= to;

function filteredTxs(
  txs: readonly FinanceTxView[],
  opts: SummaryOptions,
  from: string,
  to: string,
): FinanceTxView[] {
  const sel = opts.accountIds && opts.accountIds.length > 0 ? new Set(opts.accountIds) : null;
  const excl =
    opts.excludeEventIds && opts.excludeEventIds.length > 0 ? new Set(opts.excludeEventIds) : null;
  return txs.filter((t) => {
    if (!inRange(t, from, to)) return false;
    if (t.categoryKind === "transferencia") return false;
    if (sel !== null && !sel.has(t.accountId)) return false;
    const events = opts.eventIdsByTx?.get(t.id) ?? [];
    if (opts.eventId != null && !events.includes(opts.eventId)) return false;
    if (excl !== null && events.some((e) => excl.has(e))) return false;
    return true;
  });
}

/** Port de reports._crossing_transfer_legs (solo con filtro de cuentas). */
function crossingTransferLegs(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
  from: string,
  to: string,
  accountIds: readonly string[] | null | undefined,
): { incoming: FinanceTxView[]; outgoing: FinanceTxView[] } {
  if (!accountIds || accountIds.length === 0) return { incoming: [], outgoing: [] };
  const sel = new Set(accountIds);
  const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
  const inLegs = txs.filter(
    (t) =>
      inRange(t, from, to) &&
      sel.has(t.accountId) &&
      t.categoryKind === "transferencia" &&
      t.transferGroupId !== null,
  );
  if (inLegs.length === 0) return { incoming: [], outgoing: [] };
  const gids = new Set(inLegs.map((t) => t.transferGroupId as string));
  const groupAccs = new Map<string, { accountId: string; kind: string }[]>();
  for (const t of txs) {
    if (t.transferGroupId !== null && gids.has(t.transferGroupId)) {
      const list = groupAccs.get(t.transferGroupId) ?? [];
      list.push({ accountId: t.accountId, kind: kinds.get(t.accountId) ?? "" });
      groupAccs.set(t.transferGroupId, list);
    }
  }
  const incoming: FinanceTxView[] = [];
  const outgoing: FinanceTxView[] = [];
  for (const leg of inLegs) {
    const accs = groupAccs.get(leg.transferGroupId as string) ?? [];
    if (accs.every((a) => sel.has(a.accountId))) continue; // 100% interno al filtro
    if (accs.some((a) => a.kind === "inversion" && !sel.has(a.accountId))) continue; // cuenta en `inversion`
    (leg.amountCents > 0n ? incoming : outgoing).push(leg);
  }
  return { incoming, outgoing };
}

/** Port de reports._investment_legs: con filtro, sigue a la cuenta del CARGO. */
function investmentLegs(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
  from: string,
  to: string,
  accountIds: readonly string[] | null | undefined,
): FinanceTxView[] {
  const invIds = new Set(accounts.filter((a) => a.kind === "inversion").map((a) => a.id));
  const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
  const legs = txs.filter(
    (t) => invIds.has(t.accountId) && t.amountCents > 0n && inRange(t, from, to),
  );
  if (!accountIds || accountIds.length === 0) return legs;
  const sel = new Set(accountIds);
  const gids = new Set(
    legs.filter((l) => l.transferGroupId !== null).map((l) => l.transferGroupId as string),
  );
  const chargeInSel = new Set<string>();
  for (const t of txs) {
    if (
      t.transferGroupId !== null &&
      gids.has(t.transferGroupId) &&
      t.amountCents < 0n &&
      kinds.get(t.accountId) !== "inversion" &&
      sel.has(t.accountId)
    ) {
      chargeInSel.add(t.transferGroupId);
    }
  }
  return legs.filter(
    (l) =>
      (l.transferGroupId !== null && chargeInSel.has(l.transferGroupId)) ||
      (l.transferGroupId === null && sel.has(l.accountId)),
  );
}

function summarize(
  txs: readonly FinanceTxView[],
  opts: SummaryOptions,
  from: string,
  to: string,
  withPrev: boolean,
): RangeSummary {
  const cur = filteredTxs(txs, opts, from, to);
  const gastos = cur.filter((t) => kindFor(t) === "gasto");
  const ingresos = cur.filter((t) => kindFor(t) === "ingreso");
  const { incoming, outgoing } = crossingTransferLegs(txs, opts.accounts, from, to, opts.accountIds);
  const receivedContributionsCents = sum(incoming);
  const outgoingTransfersCents = sum(outgoing);
  const incomeCents = sum(ingresos) + receivedContributionsCents;
  const expenseCents = sum(gastos);
  const savingsCents = incomeCents + expenseCents;
  const recurringExpenseCents = sum(gastos.filter((t) => t.recurrence === "recurrente"));
  const extraordinaryExpenseCents = sum(gastos.filter((t) => t.recurrence === "extraordinario"));
  const unclassifiedExpenseCents = sum(gastos.filter((t) => t.recurrence === null));
  const investedCents = sum(investmentLegs(txs, opts.accounts, from, to, opts.accountIds));
  const freeCashFlowCents = savingsCents - investedCents;
  const pendingCount = txs.filter(
    (t) =>
      PENDING_STATUSES.has(t.status) &&
      (!opts.accountIds || opts.accountIds.length === 0 || opts.accountIds.includes(t.accountId)),
  ).length;
  let prev: RangeSummary | null = null;
  if (withPrev) {
    const p = prevRange(from, to);
    prev = summarize(txs, opts, p.from, p.to, false);
  }
  return {
    incomeCents,
    expenseCents,
    recurringExpenseCents,
    extraordinaryExpenseCents,
    unclassifiedExpenseCents,
    savingsCents,
    netSavingsRate: rate1(savingsCents, incomeCents),
    grossSavingsRate: rate1(incomeCents + recurringExpenseCents, incomeCents),
    investedCents,
    investmentRate: rate1(investedCents, incomeCents),
    freeCashFlowCents,
    opsCashFlowCents: freeCashFlowCents + investedCents,
    receivedContributionsCents,
    outgoingTransfersCents,
    pendingCount,
    prev,
  };
}

/** Port de reports.range_summary. Recibe TODAS las transacciones del hogar
 * (el filtrado interno hace falta para el periodo anterior, los cruces de
 * transferencias y el contador global de pendientes). */
export function computeRangeSummary(
  txs: readonly FinanceTxView[],
  opts: SummaryOptions,
): RangeSummary {
  return summarize(txs, opts, opts.from, opts.to, true);
}
