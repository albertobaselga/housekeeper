import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código que llega al navegador no importa zod jamás (patrón access-commands).
import {
  commandEnvelopeSchema,
  financeCommandPayloadSchema,
  financeGrantPayloadSchema,
  financeRevokePayloadSchema
} from '@casa-clara/contracts/schemas';

import { financeGrantToggle, grantFinanceAccess, revokeFinanceAccess } from '../src/lib/finance/commands';

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
