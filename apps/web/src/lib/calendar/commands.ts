import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';

/**
 * Constructor puro del envelope `ics_feed.upsert_source` (payload CONGELADO de
 * icsSourceUpsertPayloadSchema en @casa-clara/contracts/schemas): alta/edición
 * de un calendario enlazado por URL. La UI habla de «calendario enlazado»; el
 * tecnicismo ICS vive solo en el contrato. `operationId`/`occurredAt` son
 * inyectables para tests deterministas (mismo patrón que $lib/contacts).
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export interface CalendarSourceUpsertPayload {
  action: 'upsert_source';
  sourceId?: string;
  url: string;
  label: string;
  enabled: boolean;
}

export function upsertCalendarSource(
  input: {
    householdId: string;
    sourceId?: string;
    url: string;
    label: string;
    enabled: boolean;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<CalendarSourceUpsertPayload> {
  const payload: CalendarSourceUpsertPayload = {
    action: 'upsert_source',
    url: input.url.trim(),
    label: input.label.trim(),
    enabled: input.enabled
  };
  if (input.sourceId) payload.sourceId = input.sourceId;
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'ics_feed',
    aggregateId: input.sourceId ?? null,
    payload
  }) as CommandEnvelopeV1<CalendarSourceUpsertPayload>;
}
