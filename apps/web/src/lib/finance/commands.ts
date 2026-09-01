import type { CommandEnvelopeV1 } from '@housekeeper/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';

/**
 * Constructores puros de los envelopes de concesión de Finanzas (spec §4).
 * Producen los payloads CONGELADOS de @housekeeper/contracts/schemas
 * (financeGrantPayloadSchema / financeRevokePayloadSchema); la validación zod
 * vive en los tests y en el servidor, nunca en el bundle del navegador.
 * Patrón calcado de $lib/access/commands.ts.
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export interface FinanceGrantPayload {
  kind: 'finance.grant.write';
  membershipId: string;
}

export interface FinanceRevokePayload {
  kind: 'finance.revoke.write';
  membershipId: string;
}

export function grantFinanceAccess(
  input: { householdId: string; membershipId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<FinanceGrantPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'finance',
    aggregateId: input.membershipId,
    payload: {
      kind: 'finance.grant.write',
      membershipId: input.membershipId
    } satisfies FinanceGrantPayload
  }) as CommandEnvelopeV1<FinanceGrantPayload>;
}

export function revokeFinanceAccess(
  input: { householdId: string; membershipId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<FinanceRevokePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'finance',
    aggregateId: input.membershipId,
    payload: {
      kind: 'finance.revoke.write',
      membershipId: input.membershipId
    } satisfies FinanceRevokePayload
  }) as CommandEnvelopeV1<FinanceRevokePayload>;
}

/**
 * El comando que le toca a UNA fila de la tarjeta de Ajustes según su concesión
 * real: activada, se revoca; apagada, se concede. Vive aquí y no dentro del
 * componente para que la correspondencia sea comprobable — invertirla es el
 * defecto natural de un interruptor y los dos envelopes son válidos por
 * separado, así que ninguna prueba de payloads lo vería.
 */
export function financeGrantToggle(
  input: { householdId: string; membershipId: string; granted: boolean },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<FinanceGrantPayload | FinanceRevokePayload> {
  return input.granted ? revokeFinanceAccess(input, options) : grantFinanceAccess(input, options);
}
