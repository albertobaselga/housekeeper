import { normText } from "./text.js";
import type { FinanceTxView, RecurrenceVerdict } from "./types.js";

const REF_RX = /\d{4,}|\b\d+[-/]\d+\b/g;
const RECEIPT_RX = /\bRECIBO\b|\bNOMINA\b|\bCUOTA\b|\bPRESTAMO\b/;

/** Port de recurrence.py::fingerprint: proveedor normalizado sin referencias;
 * sin letras, cae a "{código o ??}|{tramo de 50 €}". */
export function recurrenceFingerprint(
  provider: string | null,
  codeCommon: string | null,
  amountCents: bigint,
): string {
  const base = normText(provider ?? "")
    .replace(REF_RX, "")
    .trim()
    .replace(/\s{2,}/g, " ");
  if (base !== "" && /[A-Z]/.test(base)) return base;
  const abs = amountCents < 0n ? -amountCents : amountCents;
  return `${codeCommon ?? "??"}|${abs / 5000n}`;
}

/** Mediana ×2 (siempre entera) de una lista de bigints.
 * Precondición: `values` no vacío (ambas llamadas ocurren tras comprobar `months.size >= 2`,
 * que implica `txs.length >= 2`). */
function median2(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new RangeError("median2: se requiere al menos un valor");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? 2n * (sorted[mid] as bigint)
    : (sorted[mid - 1] as bigint) + (sorted[mid] as bigint);
}

/** Port de recurrence.py::is_recurrent_group con mediana exacta en bigint:
 * medAbsDev/med ≤ 0.35  ⇔  median2(|2a−med2|)·100 ≤ med2·70. */
export function isRecurrentGroup(txs: readonly FinanceTxView[]): boolean {
  const months = new Set(txs.map((t) => t.opDate.slice(0, 7)));
  if (months.size >= 3) return true;
  if (months.size < 2) return false;
  const amounts = txs.map((t) => (t.amountCents < 0n ? -t.amountCents : t.amountCents));
  const med2 = median2(amounts);
  const devs = amounts.map((a) => {
    const d = 2n * a - med2;
    return d < 0n ? -d : d;
  });
  const stable = med2 > 0n && median2(devs) * 100n <= med2 * 70n;
  const days = txs.map((t) => Number(t.opDate.slice(8, 10)));
  const maxD = Math.max(...days);
  const minD = Math.min(...days);
  const dayClose = maxD - minD <= 4 || minD + 31 - maxD <= 4; // wrap fin de mes
  const receipt = txs.some(
    (t) => t.codeCommon === "03" || t.codeCommon === "05" || RECEIPT_RX.test(normText(t.concept)),
  );
  return stable || dayClose || receipt;
}

/** Port de recurrence.py::detect_recurrence: agrupa TODAS las no-transferencia
 * por (huella, signo); la evidencia incluye manuales, pero el veredicto solo se
 * devuelve para filas elegibles (sin decisión manual, sin grupo) cuyo valor cambia. */
export function assessRecurrence(txs: readonly FinanceTxView[]): RecurrenceVerdict[] {
  const groups = new Map<string, FinanceTxView[]>();
  for (const t of txs) {
    if (t.transferGroupId !== null) continue;
    const key = `${recurrenceFingerprint(t.provider, t.codeCommon, t.amountCents)}\u0000${t.amountCents > 0n}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  const verdicts: RecurrenceVerdict[] = [];
  for (const groupTxs of groups.values()) {
    const verdict = isRecurrentGroup(groupTxs) ? "recurrente" : "extraordinario";
    for (const t of groupTxs) {
      // t.transferGroupId ya está descartado al agrupar (bucle anterior); se repite aquí
      // como red de seguridad fiel al original Python, aunque hoy sea inalcanzable.
      if (t.recurrenceManual || t.transferGroupId !== null) continue;
      if (t.recurrence !== verdict) verdicts.push({ txId: t.id, recurrence: verdict });
    }
  }
  return verdicts;
}
