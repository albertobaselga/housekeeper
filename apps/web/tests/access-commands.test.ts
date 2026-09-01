import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código de `commands.ts` que llega al navegador no importa zod jamás.
import {
  commandEnvelopeSchema,
  membershipCommandPayloadSchema,
  membershipRevokePayloadSchema,
  membershipSetExpiryPayloadSchema
} from '@housekeeper/contracts/schemas';

import { revokeMembership, setMembershipExpiry } from '../src/lib/access/commands';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '11000000-0000-4000-8000-000000000004';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000005',
  occurredAt: '2026-08-07T10:00:00.000Z'
};

describe('constructores de envelopes de accesos (F4-03)', () => {
  it('setMembershipExpiry con fecha valida contra el contrato y ancla la membresía', () => {
    const envelope = setMembershipExpiry(
      { householdId: HOUSEHOLD, membershipId: MEMBERSHIP, expiresAt: '2030-06-01T08:00:00.000Z' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('membership');
    expect(envelope.aggregateId).toBe(MEMBERSHIP);
    expect(membershipSetExpiryPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'set_expiry',
      membershipId: MEMBERSHIP,
      expiresAt: '2030-06-01T08:00:00.000Z'
    });
  });

  it('setMembershipExpiry con null (quitar caducidad) entra en la unión discriminada', () => {
    const envelope = setMembershipExpiry(
      { householdId: HOUSEHOLD, membershipId: MEMBERSHIP, expiresAt: null },
      OPTIONS
    );
    expect(membershipCommandPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'set_expiry',
      membershipId: MEMBERSHIP,
      expiresAt: null
    });
    // Una fecha sin zona horaria viola el contrato congelado.
    expect(() =>
      membershipSetExpiryPayloadSchema.parse({
        action: 'set_expiry',
        membershipId: MEMBERSHIP,
        expiresAt: '2030-06-01T08:00:00'
      })
    ).toThrow();
  });

  it('revokeMembership produce el payload congelado de revocación', () => {
    const envelope = revokeMembership({ householdId: HOUSEHOLD, membershipId: MEMBERSHIP }, OPTIONS);
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('membership');
    expect(envelope.aggregateId).toBe(MEMBERSHIP);
    expect(membershipRevokePayloadSchema.parse(envelope.payload)).toEqual({
      action: 'revoke',
      membershipId: MEMBERSHIP
    });
    expect(membershipCommandPayloadSchema.parse(envelope.payload).action).toBe('revoke');
  });
});
