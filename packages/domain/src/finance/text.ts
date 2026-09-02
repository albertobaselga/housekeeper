/** Port fiel de backend/app/money.py::norm_text del origen home-finance.
 * NFKD + eliminación de marcas combinantes (Ñ→N, á→a) + colapso de
 * espacios + mayúsculas. Los hashes de dedup dependen de esta función. */
export function normText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Port de money.py::normalize_concept: colapso de espacios + recorte a 80; «—» si vacío. */
export function normalizeConcept(concept: string): string {
  const collapsed = concept
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
  return collapsed.slice(0, 80) || "—";
}

/** Diferencia a−b en días de calendario entre fechas ISO yyyy-mm-dd. Sin reloj. */
export function dayDiffIso(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000,
  );
}
