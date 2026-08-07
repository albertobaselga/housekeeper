import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';
import { queueCommand, type QueueOutcome } from '$lib/offline/queue-command';

/**
 * Constructores puros de envelopes para la gestión de accesos (F4-03).
 * Producen los payloads CONGELADOS de @casa-clara/contracts/schemas
 * (membershipSetExpiry y membershipRevoke). La validación zod vive en los
 * tests y en el servidor, nunca en el bundle del navegador; los tipos locales
 * replican el contrato porque el índice de contracts no exporta interfaces de
 * membresía. `operationId`/`occurredAt` son inyectables para tests
 * deterministas.
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export interface MembershipSetExpiryPayload {
  action: 'set_expiry';
  membershipId: string;
  /** ISO-8601 con zona horaria, o null para retirar la caducidad. */
  expiresAt: string | null;
}

export interface MembershipRevokePayload {
  action: 'revoke';
  membershipId: string;
}

export function setMembershipExpiry(
  input: { householdId: string; membershipId: string; expiresAt: string | null },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MembershipSetExpiryPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'membership',
    aggregateId: input.membershipId,
    payload: {
      action: 'set_expiry',
      membershipId: input.membershipId,
      expiresAt: input.expiresAt
    } satisfies MembershipSetExpiryPayload
  }) as CommandEnvelopeV1<MembershipSetExpiryPayload>;
}

export function revokeMembership(
  input: { householdId: string; membershipId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<MembershipRevokePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'membership',
    aggregateId: input.membershipId,
    payload: {
      action: 'revoke',
      membershipId: input.membershipId
    } satisfies MembershipRevokePayload
  }) as CommandEnvelopeV1<MembershipRevokePayload>;
}

export type { QueueOutcome };

/**
 * Delegado del encolado unificado (`$lib/offline/queue-command`): conserva la
 * firma histórica devolviendo solo el outcome ('synced' | 'queued' |
 * 'rejected' | 'conflict'). Para el mensaje veraz completo (causa traducida de
 * un rejected/conflict) llama a `queueCommand` directamente.
 */
export async function queueAccessCommand(envelope: CommandEnvelopeV1): Promise<QueueOutcome> {
  return (await queueCommand(envelope)).outcome;
}
