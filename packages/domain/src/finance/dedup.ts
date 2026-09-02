import { normText } from "./text.js";

/** Cadena canónica a hashear (port de money.py::dedup_hash SIN el sha256; el
 * sha256 lo aplica packages/server). COMPATIBILIDAD con los datos migrados:
 * un saldo null se serializa como "None" (así lo hacía el f-string de Python). */
export function dedupKey(row: {
  bankRef: string;
  opDate: string;
  amountCents: bigint;
  concept: string;
  balanceCents: bigint | null;
  dedupRef: string | null;
}): string {
  const balance = row.balanceCents === null ? "None" : String(row.balanceCents);
  const base = `${row.bankRef}|${row.opDate}|${String(row.amountCents)}|${normText(row.concept)}|${balance}`;
  return row.dedupRef === null ? base : `${base}|${row.dedupRef}`;
}
