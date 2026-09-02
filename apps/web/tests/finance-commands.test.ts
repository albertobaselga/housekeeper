import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código que llega al navegador no importa zod jamás (patrón access-commands).
import {
  commandEnvelopeSchema,
  financeCommandPayloadSchema,
  financeGrantPayloadSchema,
  financeRevokePayloadSchema,
  financeWritePayloadSchema
} from '@housekeeper/contracts/schemas';

import { financeCommand, financeGrantToggle, grantFinanceAccess, revokeFinanceAccess } from '../src/lib/finance/commands';
import { canLinkSelection } from '../src/lib/finance/link-transfers';
import { manualAmountCents } from '../src/lib/finance/manual-form';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000105',
  occurredAt: '2026-08-31T10:00:00.000Z'
};

describe('constructores de envelopes de concesión de Finanzas', () => {
  it('grantFinanceAccess valida contra el contrato y ancla la membresía', () => {
    const envelope = grantFinanceAccess({ householdId: HOUSEHOLD, membershipId: MEMBERSHIP }, OPTIONS);
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('finance');
    expect(envelope.aggregateId).toBe(MEMBERSHIP);
    expect(financeGrantPayloadSchema.parse(envelope.payload)).toEqual({
      kind: 'finance.grant.write',
      membershipId: MEMBERSHIP
    });
  });

  it('revokeFinanceAccess produce el payload congelado de revocación', () => {
    const envelope = revokeFinanceAccess({ householdId: HOUSEHOLD, membershipId: MEMBERSHIP }, OPTIONS);
    expect(financeRevokePayloadSchema.parse(envelope.payload)).toEqual({
      kind: 'finance.revoke.write',
      membershipId: MEMBERSHIP
    });
    expect(financeCommandPayloadSchema.parse(envelope.payload).kind).toBe('finance.revoke.write');
  });
});

/**
 * El interruptor de la tarjeta de Ajustes, probado donde se decide.
 *
 * Conceder y revocar son DOS comandos distintos y el único dato que elige entre
 * ellos es la concesión real de esa fila. Invertir esa correspondencia —el
 * defecto natural de un interruptor— dejaría una tarjeta que apaga Finanzas
 * cuando la persona pulsa «Activar» y al revés, y ninguna prueba de payloads lo
 * vería: los dos envelopes son válidos por separado. Por eso la elección no se
 * queda dentro del componente (que este banco de pruebas no puede montar: el
 * entorno de vitest es `node`, sin DOM), sino aquí.
 */
describe('financeGrantToggle elige el comando por el estado REAL de la fila', () => {
  it('a una cuenta CON Finanzas activado le toca revocar', () => {
    const envelope = financeGrantToggle(
      { householdId: HOUSEHOLD, membershipId: MEMBERSHIP, granted: true },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(financeCommandPayloadSchema.parse(envelope.payload)).toEqual({
      kind: 'finance.revoke.write',
      membershipId: MEMBERSHIP
    });
  });

  it('a una cuenta SIN Finanzas activado le toca conceder', () => {
    const envelope = financeGrantToggle(
      { householdId: HOUSEHOLD, membershipId: MEMBERSHIP, granted: false },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(financeCommandPayloadSchema.parse(envelope.payload)).toEqual({
      kind: 'finance.grant.write',
      membershipId: MEMBERSHIP
    });
  });

  it('el hogar y la membresía viajan intactos en las dos direcciones', () => {
    for (const granted of [true, false]) {
      const envelope = financeGrantToggle(
        { householdId: HOUSEHOLD, membershipId: MEMBERSHIP, granted },
        OPTIONS
      );
      expect(envelope.householdId, `granted=${granted}`).toBe(HOUSEHOLD);
      expect(envelope.aggregateType, `granted=${granted}`).toBe('finance');
      // El agregado es la membresía CONCERNIDA, no la de quien pulsa: sin esto
      // dos concesiones simultáneas compartirían identidad de agregado.
      expect(envelope.aggregateId, `granted=${granted}`).toBe(MEMBERSHIP);
    }
  });
});

// Nombres propios distintos de HOUSEHOLD/MEMBERSHIP/OPTIONS de arriba: son
// constantes de módulo y no se pueden redeclarar con los mismos nombres del
// brief (HH/TX1/TX2/OPTIONS) sin colisionar con las ya existentes.
const HH = '10000000-0000-4000-8000-000000000001';
const TX1 = 'ab300000-0000-4000-8000-000000000001';
const TX2 = 'ab300000-0000-4000-8000-000000000002';
const WRITE_OPTIONS = { operationId: '99999999-0000-4000-8000-000000000031', occurredAt: '2026-08-07T10:00:00.000Z' };

describe('constructor de envelopes de finanzas', () => {
  it('produce envelopes válidos contra el contrato, con el kind congelado', () => {
    const envelope = financeCommand(
      HH,
      { kind: 'finance.transaction.update', transactionId: TX1, status: 'confirmada' },
      WRITE_OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('finance');
    expect(financeWritePayloadSchema.parse(envelope.payload)).toMatchObject({ kind: 'finance.transaction.update' });
  });
});

describe('canLinkSelection (réplica cliente de finance.transfers.link)', () => {
  const rows = [
    { id: TX1, amountCents: '-5000', transferGroupId: null },
    { id: TX2, amountCents: '5000', transferGroupId: null }
  ];
  it('exige 2+, sin grupo previo y suma cero en bigint', () => {
    expect(canLinkSelection(rows, new Set([TX1]))).toMatchObject({ enabled: false });
    expect(canLinkSelection(rows, new Set([TX1, TX2]))).toEqual({ enabled: true, reason: null });
    expect(
      canLinkSelection([{ ...rows[0]!, transferGroupId: 'g' }, rows[1]!], new Set([TX1, TX2])).reason
    ).toBe('algún movimiento ya pertenece a un grupo');
    expect(
      canLinkSelection([rows[0]!, { ...rows[1]!, amountCents: '4999' }], new Set([TX1, TX2])).reason
    ).toBe('la selección no suma cero');
  });
});

describe('manualAmountCents', () => {
  it('firma el importe según el tipo y rechaza basura', () => {
    expect(manualAmountCents('12,50', 'gasto')).toBe('-1250');
    expect(manualAmountCents('12,50', 'ingreso')).toBe('1250');
    expect(manualAmountCents('0', 'gasto')).toBeNull();
    expect(manualAmountCents('abc', 'gasto')).toBeNull();
  });
});
