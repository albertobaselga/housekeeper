import { describe, expect, it } from 'vitest';

// La validación zod del payload congelado vive AQUÍ, en el test: el código de
// `$lib/calendar/commands.ts` que llega al navegador no importa zod.
import { commandEnvelopeSchema, icsSourceUpsertPayloadSchema } from '@housekeeper/contracts/schemas';

import { upsertCalendarSource } from '../src/lib/calendar/commands';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const SOURCE = '61000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000031',
  occurredAt: '2026-08-08T10:00:00.000Z'
};

describe('constructor del envelope de calendario enlazado', () => {
  it('el alta valida contra el contrato y recorta etiqueta y enlace', () => {
    const envelope = upsertCalendarSource(
      {
        householdId: HOUSEHOLD,
        label: '  Cole de los niños ',
        url: ' https://calendario.example.com/cole.ics ',
        enabled: true
      },
      OPTIONS
    );

    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('ics_feed');
    expect(envelope.aggregateId).toBeNull();
    expect(envelope.operationId).toBe(OPTIONS.operationId);
    expect(icsSourceUpsertPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'upsert_source',
      label: 'Cole de los niños',
      url: 'https://calendario.example.com/cole.ics',
      enabled: true
    });
  });

  it('la edición lleva sourceId también como aggregateId y permite pausar', () => {
    const envelope = upsertCalendarSource(
      {
        householdId: HOUSEHOLD,
        sourceId: SOURCE,
        label: 'Cole de los niños',
        url: 'https://calendario.example.com/cole.ics',
        enabled: false
      },
      OPTIONS
    );

    expect(envelope.aggregateId).toBe(SOURCE);
    expect(icsSourceUpsertPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'upsert_source',
      sourceId: SOURCE,
      label: 'Cole de los niños',
      url: 'https://calendario.example.com/cole.ics',
      enabled: false
    });
  });

  it('el contrato rechaza enlaces que no sean https', () => {
    const envelope = upsertCalendarSource({
      householdId: HOUSEHOLD,
      label: 'Inseguro',
      url: 'http://calendario.example.com/cole.ics',
      enabled: true
    });
    expect(icsSourceUpsertPayloadSchema.safeParse(envelope.payload).success).toBe(false);
  });
});
