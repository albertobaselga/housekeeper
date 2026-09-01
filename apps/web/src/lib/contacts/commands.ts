import type { CommandEnvelopeV1 } from '@housekeeper/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';
import type { ContactKind } from './kinds';

export type { ContactKind };

/**
 * Constructores puros de envelopes del agregado `contact` (payloads CONGELADOS
 * de contactCommandPayloadSchema en @housekeeper/contracts/schemas: upsert y
 * archive). La validación zod vive en los tests y en el servidor, nunca en el
 * bundle del navegador. `operationId`/`occurredAt` son inyectables para tests
 * deterministas (mismo patrón que $lib/food/commands).
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export interface ContactUpsertPayload {
  action: 'upsert';
  contactId?: string;
  name: string;
  roleLabel?: string;
  phone: string;
  kind: ContactKind;
  featured: boolean;
  notes?: string;
}

export interface ContactArchivePayload {
  action: 'archive';
  contactId: string;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function upsertContact(
  input: {
    householdId: string;
    contactId?: string;
    name: string;
    roleLabel?: string;
    phone: string;
    kind: ContactKind;
    featured: boolean;
    notes?: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ContactUpsertPayload> {
  const roleLabel = trimmedOrUndefined(input.roleLabel);
  const notes = trimmedOrUndefined(input.notes);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'contact',
    aggregateId: input.contactId ?? null,
    payload: {
      action: 'upsert',
      ...(input.contactId ? { contactId: input.contactId } : {}),
      name: input.name.trim(),
      ...(roleLabel ? { roleLabel } : {}),
      phone: input.phone.trim(),
      kind: input.kind,
      featured: input.featured,
      ...(notes ? { notes } : {})
    } satisfies ContactUpsertPayload
  }) as CommandEnvelopeV1<ContactUpsertPayload>;
}

export function archiveContact(
  input: { householdId: string; contactId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ContactArchivePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'contact',
    aggregateId: input.contactId,
    payload: { action: 'archive', contactId: input.contactId } satisfies ContactArchivePayload
  }) as CommandEnvelopeV1<ContactArchivePayload>;
}
