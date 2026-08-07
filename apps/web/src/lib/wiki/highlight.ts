/**
 * Segmenta un texto para destacar las apariciones del término buscado,
 * ignorando mayúsculas y acentos, sin generar HTML: la página pinta los
 * segmentos con interpolación (los aciertos dentro de <mark>).
 */

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

function foldChar(char: string): string {
  return char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es');
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .map((term) => [...term].map(foldChar).join(''));
  if (terms.length === 0 || !text) return [{ text, hit: false }];

  // Texto plegado carácter a carácter conservando el mapa de índices, para que
  // los acentos no desplacen los cortes.
  const chars = [...text];
  let folded = '';
  const map: number[] = [];
  chars.forEach((char, index) => {
    const foldedChar = foldChar(char);
    for (let i = 0; i < foldedChar.length; i++) map.push(index);
    folded += foldedChar;
  });

  const hits = new Array<boolean>(chars.length).fill(false);
  for (const term of terms) {
    let from = 0;
    while (true) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      const start = map[at]!;
      const end = map[Math.min(at + term.length - 1, map.length - 1)]!;
      for (let i = start; i <= end; i++) hits[i] = true;
      from = at + term.length;
    }
  }

  const segments: HighlightSegment[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.hit === hits[i]) last.text += chars[i];
    else segments.push({ text: chars[i]!, hit: hits[i]! });
  }
  return segments;
}
