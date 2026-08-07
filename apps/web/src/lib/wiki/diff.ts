/**
 * Diff de líneas hecho a mano (sin dependencias), estilo unified minimalista:
 * cada línea sale como contexto, añadida o eliminada. Se calcula en el
 * servidor entre dos revisiones de una página.
 */

export interface WikiDiffLine {
  type: 'context' | 'added' | 'removed';
  text: string;
}

function lcsDiff(before: string[], after: string[]): WikiDiffLine[] {
  // DP clásico de subsecuencia común más larga con backtracking.
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        before[i] === after[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const out: WikiDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      out.push({ type: 'context', text: before[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      out.push({ type: 'removed', text: before[i]! });
      i++;
    } else {
      out.push({ type: 'added', text: after[j]! });
      j++;
    }
  }
  while (i < before.length) out.push({ type: 'removed', text: before[i++]! });
  while (j < after.length) out.push({ type: 'added', text: after[j++]! });
  return out;
}

export function diffLines(before: string, after: string): WikiDiffLine[] {
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');

  // Recorta prefijo y sufijo comunes: mantiene el DP pequeño incluso en
  // cuerpos largos con un cambio local.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle =
    middleA.length * middleB.length > 500_000
      ? [
          ...middleA.map((text): WikiDiffLine => ({ type: 'removed', text })),
          ...middleB.map((text): WikiDiffLine => ({ type: 'added', text }))
        ]
      : lcsDiff(middleA, middleB);

  return [
    ...a.slice(0, start).map((text): WikiDiffLine => ({ type: 'context', text })),
    ...middle,
    ...a.slice(endA).map((text): WikiDiffLine => ({ type: 'context', text }))
  ];
}

export function diffCounts(lines: readonly WikiDiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'added') added++;
    else if (line.type === 'removed') removed++;
  }
  return { added, removed };
}
