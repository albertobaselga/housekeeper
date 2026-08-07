import { describe, expect, it } from 'vitest';

import { diffCounts, diffLines } from '../src/lib/wiki/diff';

describe('diff de líneas estilo unified minimalista', () => {
  it('marca líneas añadidas y eliminadas conservando el contexto', () => {
    const before = 'uno\ndos\ntres\ncuatro';
    const after = 'uno\ndos nuevos\ntres\ncinco\ncuatro';
    const diff = diffLines(before, after);
    expect(diff).toEqual([
      { type: 'context', text: 'uno' },
      { type: 'removed', text: 'dos' },
      { type: 'added', text: 'dos nuevos' },
      { type: 'context', text: 'tres' },
      { type: 'added', text: 'cinco' },
      { type: 'context', text: 'cuatro' }
    ]);
    expect(diffCounts(diff)).toEqual({ added: 2, removed: 1 });
  });

  it('sin cambios: todo es contexto', () => {
    const diff = diffLines('a\nb', 'a\nb');
    expect(diff.every((line) => line.type === 'context')).toBe(true);
    expect(diffCounts(diff)).toEqual({ added: 0, removed: 0 });
  });

  it('documento nuevo: todas añadidas', () => {
    const diff = diffLines('', 'a\nb');
    // La cadena vacía es una línea vacía eliminada frente a dos añadidas.
    expect(diff.filter((line) => line.type === 'added').map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('normaliza finales de línea CRLF', () => {
    const diff = diffLines('a\r\nb', 'a\nb');
    expect(diff.every((line) => line.type === 'context')).toBe(true);
  });

  it('cuerpos largos con un cambio local siguen siendo exactos', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `línea ${i}`);
    const before = lines.join('\n');
    const changed = [...lines];
    changed[1500] = 'línea cambiada';
    const diff = diffLines(before, changed.join('\n'));
    expect(diffCounts(diff)).toEqual({ added: 1, removed: 1 });
    expect(diff.find((line) => line.type === 'added')?.text).toBe('línea cambiada');
  });
});
