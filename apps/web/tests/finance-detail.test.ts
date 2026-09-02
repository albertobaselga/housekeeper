import { describe, expect, it } from 'vitest';

import { detailCards, ledgerRowMeta, originRows } from '../src/lib/finance/detail';

import type { FinanceTxDto } from '@housekeeper/server';
import type { FinanceDetailMode } from '../src/lib/finance/api';

function tx(overrides: Partial<FinanceTxDto> = {}): FinanceTxDto {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    accountName: 'Cuenta corriente',
    opDate: '2026-05-12',
    valueDate: '2026-05-13',
    concept: 'Compra supermercado',
    provider: 'mercadona',
    providerNorm: 'mercadona',
    providerDisplay: 'Mercadona',
    amountCents: '-4550',
    balanceCents: '150000',
    codeCommon: 'COMMON1',
    codeOwn: 'OWN1',
    categoryId: 'cat-1',
    categoryName: 'Alimentación',
    status: 'confirmada',
    transferGroupId: null,
    recurrence: null,
    recurrenceManual: false,
    bankCategory: 'Supermercados',
    eventIds: [],
    raw: null,
    ...overrides
  };
}

describe('ledgerRowMeta (fila del ledger)', () => {
  it('compone fecha·cuenta · categoría · eventos · recurrencia · estado', () => {
    const row = tx({
      categoryName: 'Alimentación',
      recurrence: 'recurrente',
      status: 'confirmada',
      eventIds: ['ev-1', 'ev-2']
    });
    const meta = ledgerRowMeta(row, { 'ev-1': 'Boda Juan', 'ev-2': 'Viaje' });
    expect(meta).toBe('12 may 2026 · Cuenta corriente · Alimentación · Boda Juan, Viaje · ♻ · confirmada');
  });

  it('sin categoría, sin eventos y sin recurrencia: omite esos huecos sin dejar separadores sueltos', () => {
    const row = tx({ categoryName: null, recurrence: null, eventIds: [], status: 'pendiente' });
    expect(ledgerRowMeta(row, {})).toBe('12 may 2026 · Cuenta corriente · Sin categorizar · pendiente');
  });

  it('un id de evento sin nombre conocido no deja un hueco vacío en la lista', () => {
    const row = tx({ eventIds: ['ev-desconocido'] });
    expect(ledgerRowMeta(row, {})).not.toContain('· · ');
  });

  it('traduce cada estado bruto a su etiqueta (regla/agente), y conserva el bruto si no hay etiqueta', () => {
    expect(ledgerRowMeta(tx({ status: 'sugerida_regla' }), {})).toContain('regla');
    expect(ledgerRowMeta(tx({ status: 'sugerida_agente' }), {})).toContain('agente');
    expect(ledgerRowMeta(tx({ status: 'archivada' }), {})).toContain('archivada');
  });
});

describe('originRows («Datos del origen»)', () => {
  it('con raw propio no vacío: sus entradas, etiquetadas como origen directo', () => {
    const row = tx({ raw: { fichero: 'extracto.csv', linea: '42' } });
    expect(originRows(row)).toEqual({
      label: 'Datos del origen',
      rows: [
        ['fichero', 'extracto.csv'],
        ['linea', '42']
      ]
    });
  });

  it('raw es NOT NULL DEFAULT \'{}\' (Ruling R11): un objeto vacío no cuenta como origen propio', () => {
    const row = tx({ raw: {} });
    expect(originRows(row)).toEqual({
      label: 'Detalles',
      rows: [
        ['Fecha valor', '2026-05-13'],
        ['Saldo', '1.500,00 €'],
        ['Concepto común', 'COMMON1'],
        ['Concepto propio', 'OWN1'],
        ['Categoría banco', 'Supermercados']
      ]
    });
  });

  it('espejo sin raw con cargo emparejado: usa el raw del emparejado y lo rotula como tal', () => {
    const mirror = tx({ id: 'tx-mirror', raw: null, transferGroupId: 'grupo-1' });
    const partner = tx({ id: 'tx-partner', raw: { fichero: 'origen.csv' } });
    expect(originRows(mirror, partner)).toEqual({
      label: 'Datos del origen (cargo emparejado)',
      rows: [['fichero', 'origen.csv']]
    });
  });

  it('sin raw, sin emparejado y sin campos sueltos: no hay nada que mostrar', () => {
    const row = tx({
      raw: null,
      valueDate: null,
      balanceCents: null,
      codeCommon: null,
      codeOwn: null,
      bankCategory: null
    });
    expect(originRows(row)).toBeNull();
  });

  it('un emparejado sin raw tampoco cuenta como origen: cae a los campos sueltos del propio', () => {
    const mirror = tx({ id: 'tx-mirror', raw: null, transferGroupId: 'grupo-1' });
    const partnerSinRaw = tx({ id: 'tx-partner', raw: {} });
    const origin = originRows(mirror, partnerSinRaw);
    expect(origin?.label).toBe('Detalles');
  });
});

describe('detailCards (derivación de filas del panel según el modo)', () => {
  it('modo movimiento: la propia transacción, sin depender de lo traído por fetch', () => {
    const row = tx();
    const mode: FinanceDetailMode = { kind: 'movimiento', tx: row };
    expect(detailCards(mode, null)).toEqual([row]);
  });

  it('modo ids/grupo: lo que haya llegado por fetch (o vacío si aún no llegó)', () => {
    const rows = [tx({ id: 'a' }), tx({ id: 'b' })];
    const mode: FinanceDetailMode = { kind: 'ids', ids: ['a', 'b'], label: 'Selección' };
    expect(detailCards(mode, rows)).toEqual(rows);
    expect(detailCards(mode, null)).toEqual([]);
  });

  it('sin modo (panel cerrado): ninguna tarjeta', () => {
    expect(detailCards(null, [tx()])).toEqual([]);
  });
});
