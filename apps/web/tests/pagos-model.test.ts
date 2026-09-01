import { describe, expect, it } from 'vitest';

import type { SettlementView } from '../src/lib/employment/model';
import {
  anclaDeMes,
  anclaDeMesEnFragmento,
  aperturaExplicacion,
  buildPagoMesRows
} from '../src/lib/employment/pagos';

const HOGAR = '11111111-1111-4111-8111-111111111111';

function settlement(overrides: Partial<SettlementView> = {}): SettlementView {
  return {
    id: 's-1',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    periodLabel: 'Agosto 2026',
    dueOn: '2026-08-31',
    dueOnLabel: '31 de agosto de 2026',
    status: 'closed',
    statusLabel: 'Cerrada',
    salaryTotalCents: '120000',
    salaryTotalLabel: '1.200,00 €',
    reimbursementTotalCents: '0',
    reimbursementTotalLabel: '0,00 €',
    transferTotalCents: '120000',
    transferTotalLabel: '1.200,00 €',
    paidCents: '0',
    paidLabel: '0,00 €',
    pendingCents: '120000',
    pendingLabel: '1.200,00 €',
    fullyPaid: false,
    receiptConfirmed: false,
    receiptConfirmedAt: null,
    receiptNote: null,
    paymentStateLabel: 'Pendiente de pago',
    lines: [],
    payments: [],
    ...overrides
  };
}

function pago(overrides: Partial<SettlementView['payments'][number]> = {}) {
  return {
    id: 'pay-1',
    amountCents: '120000',
    amountLabel: '1.200,00 €',
    methodLabel: 'Transferencia',
    valueOn: '2026-09-03',
    valueOnLabel: '3 de septiembre de 2026',
    reference: '',
    ...overrides
  };
}

function fila(overrides: Partial<SettlementView> = {}) {
  const rows = buildPagoMesRows({ householdId: HOGAR, settlements: [settlement(overrides)] });
  return rows[0]!;
}

describe('la fila cerrada de un mes', () => {
  it('conserva el orden en que llegan las cuentas del servidor', () => {
    const rows = buildPagoMesRows({
      householdId: HOGAR,
      settlements: [
        settlement({ id: 's-ago', periodLabel: 'Agosto 2026' }),
        settlement({ id: 's-jul', periodLabel: 'Julio 2026' })
      ]
    });
    expect(rows.map((row) => row.periodLabel)).toEqual(['Agosto 2026', 'Julio 2026']);
  });

  it('ofrece la descarga sin desplegar, con «PDF» visible y el mes en el nombre', () => {
    const row = fila();
    expect(row.documentHref).toBe(`/api/v1/households/${HOGAR}/settlements/s-1/documento`);
    expect(row.documentLabel).toBe('Descargar el documento de pago de agosto 2026 (PDF)');
  });

  it('lleva el ancla de la liquidación, no la del mes', () => {
    expect(fila().anchorId).toBe('cuenta-s-1');
    expect(anclaDeMes('s-9')).toBe('cuenta-s-9');
  });

  it('una cuenta abierta no ofrece documento ni finge un total', () => {
    const row = fila({
      status: 'open',
      statusLabel: 'Abierta',
      paymentStateLabel: 'Periodo abierto',
      transferTotalCents: '0',
      transferTotalLabel: '0,00 €',
      pendingCents: '0',
      pendingLabel: '0,00 €'
    });
    expect(row.documentHref).toBeNull();
    expect(row.documentLabel).toBeNull();
    expect(row.amountLabel).toBe('');
    expect(row.supportLine).toBe('Vence el 31 de agosto de 2026');
  });
});

describe('la línea de apoyo dice lo que el chip no dice', () => {
  it('sin ningún pago, cuándo vence', () => {
    expect(fila().supportLine).toBe('Vence el 31 de agosto de 2026');
  });

  it('con un pago parcial, cuánto queda', () => {
    const row = fila({
      paidCents: '100000',
      paidLabel: '1.000,00 €',
      pendingCents: '20000',
      pendingLabel: '200,00 €',
      paymentStateLabel: 'Pago parcial registrado',
      payments: [pago({ amountCents: '100000', amountLabel: '1.000,00 €' })]
    });
    expect(row.supportLine).toBe('Quedan 200,00 € · vence el 31 de agosto de 2026');
  });

  it('pagada, el día del último pago; el chip ya dice que falta la confirmación', () => {
    const row = fila({
      paidCents: '120000',
      paidLabel: '1.200,00 €',
      pendingCents: '0',
      pendingLabel: '0,00 €',
      fullyPaid: true,
      paymentStateLabel: 'Pagada · cobro sin confirmar',
      payments: [
        pago({ id: 'pay-2', valueOn: '2026-09-05', valueOnLabel: '5 de septiembre de 2026' }),
        pago({ id: 'pay-1', valueOn: '2026-09-03', valueOnLabel: '3 de septiembre de 2026' })
      ]
    });
    expect(row.supportLine).toBe('Pagada el 5 de septiembre de 2026');
    expect(row.chipTone).toBe('warning');
  });

  it('con el cobro confirmado, el chip se pone en verde y la nota baja al detalle', () => {
    const row = fila({
      paidCents: '120000',
      paidLabel: '1.200,00 €',
      pendingCents: '0',
      pendingLabel: '0,00 €',
      fullyPaid: true,
      receiptConfirmed: true,
      receiptConfirmedAt: '2026-09-06T08:00:00.000Z',
      receiptNote: 'Recibido completo',
      paymentStateLabel: 'Pagada y cobro confirmado',
      payments: [pago()]
    });
    expect(row.supportLine).toBe('Pagada el 3 de septiembre de 2026');
    expect(row.chipTone).toBe('success');
    expect(row.receiptNote).toBe('Recibido completo');
  });

});

// Pasa cuando todo el mes se compensó o cuando no hubo devengo. Con la tabla
// plegada, el distintivo de esa fila es lo primero que se lee del mes, así que
// no puede anunciar una deuda que no existe ni un plazo que no reclama a nadie.
describe('un mes cerrado sin nada que transferir', () => {
  const vacio = () =>
    fila({
      transferTotalCents: '0',
      transferTotalLabel: '0,00 €',
      pendingCents: '0',
      pendingLabel: '0,00 €',
      paymentStateLabel: 'Cerrada · nada que pagar'
    });

  it('no se pinta en el ámbar de lo que reclama algo, ni en el verde del cobro', () => {
    expect(vacio().chipTone).toBe('neutral');
  });

  it('no le anuncia un vencimiento: el distintivo ya lo dice entero', () => {
    expect(vacio().supportLine).toBe('');
  });

  it('sigue enseñando su importe y su documento, que es la constancia del cierre', () => {
    const row = vacio();
    expect(row.amountLabel).toBe('0,00 €');
    expect(row.documentHref).toBe(`/api/v1/households/${HOGAR}/settlements/s-1/documento`);
  });

  it('un mes con importe pendiente sí sigue reclamando', () => {
    expect(fila().chipTone).toBe('warning');
    expect(fila().supportLine).toBe('Vence el 31 de agosto de 2026');
  });

  it('una cuenta abierta a cero conserva su vencimiento: ahí sí queda mes por delante', () => {
    const row = fila({
      status: 'open',
      statusLabel: 'Abierta',
      paymentStateLabel: 'Periodo abierto',
      transferTotalCents: '0',
      transferTotalLabel: '0,00 €',
      pendingCents: '0',
      pendingLabel: '0,00 €'
    });
    expect(row.supportLine).toBe('Vence el 31 de agosto de 2026');
    expect(row.chipTone).toBe('warning');
  });
});

describe('el ancla que llega en el fragmento', () => {
  it('reconoce la de un mes', () => {
    expect(anclaDeMesEnFragmento('#cuenta-s-1')).toBe('cuenta-s-1');
    expect(anclaDeMesEnFragmento('cuenta-s-1')).toBe('cuenta-s-1');
  });

  it('ignora cualquier otro destino, y el prefijo a secas', () => {
    expect(anclaDeMesEnFragmento('')).toBeNull();
    expect(anclaDeMesEnFragmento('#anticipos-3')).toBeNull();
    expect(anclaDeMesEnFragmento('#cuenta-')).toBeNull();
  });
});

describe('la frase de empezar la cuenta', () => {
  const frase = aperturaExplicacion('Septiembre 2026');

  it('nombra el mes en minúscula, como el botón', () => {
    expect(frase).toContain('la cuenta de septiembre 2026');
  });

  it('avisa de que el vencimiento no se podrá cambiar', () => {
    expect(frase).toContain('ya no se puede cambiar');
  });

  it('dice que abrir la cuenta no congela el mes', () => {
    expect(frase).toContain('no congela nada');
    expect(frase).toContain('sigue entrando en la cuenta hasta que cierres el mes');
  });

  it('no repite la falsedad que sustituye', () => {
    expect(frase).not.toContain('deja de sumar');
    expect(frase).not.toContain('cierra a revisión');
  });
});
