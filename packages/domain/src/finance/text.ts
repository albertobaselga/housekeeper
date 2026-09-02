/** Clase \s de Python 3 (módulo `re`, modo str) — NO es la de JavaScript:
 * incluye U+001C-U+001F y U+0085, y excluye U+FEFF. Los hashes de dedup migrados
 * se calcularon con esta clase, así que aquí va explícita y no la implícita de JS.
 * U+001C-U+001F SON espacio para Python y el hash de dedup migrado depende de
 * que aquí también lo sean: por eso la clase los lleva a propósito. */
// eslint-disable-next-line no-control-regex
const PY_SPACE_RX = /[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

/** Port fiel de backend/app/money.py::norm_text del origen home-finance.
 * NFKD + eliminación de marcas combinantes (Ñ→N, á→a) + colapso de
 * espacios + mayúsculas. Los hashes de dedup dependen de esta función.
 *
 * Dos notas de paridad con el origen:
 * - los espacios se colapsan con `PY_SPACE_RX` y el recorte final es
 *   `replace(/^ | $/g, "")`, no `.trim()`: tras el colapso solo puede quedar un
 *   espacio ASCII en cada extremo, y así el BOM (U+FEFF) sobrevive igual que en
 *   `str.strip()` de Python, que no lo considera espacio;
 * - la eliminación de diacríticos usa `\p{M}` mientras el origen usa
 *   `unicodedata.combining() != 0`. `\p{M}` cubre unas 1500 marcas de más (índicas,
 *   tailandesas); para el latín-1 extendido ambos conjuntos coinciden, y ese es el
 *   dominio de los extractos bancarios españoles. */
export function normText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(PY_SPACE_RX, " ")
    .replace(/^ | $/g, "")
    .toUpperCase();
}

/** Port de money.py::normalize_concept: colapso de espacios + recorte a 80; «—» si vacío.
 *
 * Dos notas de paridad con el origen (Task 99, punto 4), igual que en `normText`:
 * - `str.split()` sin argumentos de Python parte por `str.isspace()`, la clase
 *   `PY_SPACE_RX` (NEL/FS cuentan, el BOM no), no la `\s` de JavaScript;
 * - `[:80]` de Python corta por PUNTOS DE CÓDIGO, no por unidades UTF-16: un
 *   emoji (par sustituto) cuenta 1, no 2. `Array.from` itera por puntos de
 *   código; `.slice(0, 80)` sobre el string, en cambio, podría partir un par
 *   sustituto por la mitad. */
export function normalizeConcept(concept: string): string {
  const collapsed = concept
    .split(PY_SPACE_RX)
    .filter((part) => part.length > 0)
    .join(" ");
  // Recorte por puntos de código, como `[:80]` de Python (un emoji cuenta 1, no 2).
  return Array.from(collapsed).slice(0, 80).join("") || "—";
}

/** Diferencia a−b en días de calendario entre fechas ISO yyyy-mm-dd. Sin reloj. */
export function dayDiffIso(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000,
  );
}
