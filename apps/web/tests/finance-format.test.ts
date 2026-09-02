import { describe, expect, it } from 'vitest';

import {
  axisEuro, bucketLabel, deltaPct, formatCents, formatPct, summarizeTxs
} from '../src/lib/finance/format';

describe('formato de finanzas', () => {
  it('formatCents reexportado: la misma función de la casa', () => {
    expect(formatCents('145330')).toBe('1.453,30 €');
    expect(formatCents('-4550', { signed: true })).toBe('−45,50 €');
  });

  it('formatPct: es-ES con — para null', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(12.3)).toBe('12,3 %');
  });

  it('bucketLabel (contrato del original format.ts): año, trimestre y mes corto', () => {
    expect(bucketLabel('2026')).toBe('2026');
    expect(bucketLabel('2026-T2')).toBe('2026 T2');
    expect(bucketLabel('2026-05')).toBe('may 26');
  });

  it('deltaPct: porcentaje redondeado contra el periodo anterior, null sin previo', () => {
    expect(deltaPct(110n, 100n)).toBe(10);
    expect(deltaPct(-150n, -100n)).toBe(-50);
    expect(deltaPct(50n, 0n)).toBeNull();
  });

  it('axisEuro: unidades con puntos de millar y sin decimales', () => {
    expect(axisEuro(120000n)).toBe('1.200 €');
    expect(axisEuro(-120000n)).toBe('−1.200 €');
    expect(axisEuro(0n)).toBe('0 €');
  });

  it('summarizeTxs: recuento, total y ticket medio en céntimos', () => {
    const figures = summarizeTxs([{ amountCents: '-3000' }, { amountCents: '-1000' }]);
    expect(figures).toEqual({ count: 2, totalCents: -4000n, ticketCents: -2000n });
    expect(summarizeTxs([]).ticketCents).toBe(0n);
  });
});
