import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';

const guion = fileURLToPath(new URL('./cargar-ts.mjs', import.meta.url));
const FILA_SONDA = {
  bankRef: '00490001512345678901', opDate: '2026-01-10', amountCents: -2550n,
  concept: 'COMPRA SONDA', balanceCents: 150000n, dedupRef: null
};

describe('cargar-ts', () => {
  it('carga computeDedupHash con node a pelo y coincide con vitest', () => {
    const salida = execFileSync(process.execPath, [guion], { encoding: 'utf8' }).trim();
    const esperado = computeDedupHash(FILA_SONDA);
    expect(esperado).toMatch(/^[0-9a-f]{64}$/);
    expect(salida.split('\n').at(-1)).toBe(esperado);
  });
});
