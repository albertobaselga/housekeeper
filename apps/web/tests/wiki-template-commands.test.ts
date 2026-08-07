import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código de `commands.ts` que llega al navegador no importa zod jamás.
import {
  commandEnvelopeSchema,
  wikiSpaceClonePayloadSchema,
  wikiSpaceCommandPayloadSchema,
  wikiSpaceSetTemplatePayloadSchema
} from '@casa-clara/contracts/schemas';

import { cloneWikiTemplate, setWikiSpaceTemplate } from '../src/lib/wiki/commands';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const SPACE = '30000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000003',
  occurredAt: '2026-08-07T10:00:00.000Z'
};

describe('constructores de envelopes de plantillas wiki', () => {
  it('setWikiSpaceTemplate ancla aggregateId y valida contra el contrato', () => {
    const envelope = setWikiSpaceTemplate(
      { householdId: HOUSEHOLD, spaceId: SPACE, isTemplate: true },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('wiki_space');
    expect(envelope.aggregateId).toBe(SPACE);
    expect(envelope.operationId).toBe(OPTIONS.operationId);
    expect(wikiSpaceSetTemplatePayloadSchema.parse(envelope.payload)).toEqual({
      action: 'set_template',
      spaceId: SPACE,
      isTemplate: true
    });
    // El discriminated union del comando de espacios también lo acepta.
    expect(wikiSpaceCommandPayloadSchema.parse(envelope.payload).action).toBe('set_template');
  });

  it('cloneWikiTemplate produce el payload congelado y omite el slug vacío', () => {
    const envelope = cloneWikiTemplate(
      { householdId: HOUSEHOLD, templateSpaceId: SPACE, name: '  Manual clonado  ', slug: ' ' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('wiki_space');
    expect(envelope.aggregateId).toBeNull();
    expect(wikiSpaceClonePayloadSchema.parse(envelope.payload)).toEqual({
      action: 'clone_template',
      templateSpaceId: SPACE,
      name: 'Manual clonado'
    });
  });

  it('cloneWikiTemplate conserva un slug explícito válido', () => {
    const envelope = cloneWikiTemplate(
      { householdId: HOUSEHOLD, templateSpaceId: SPACE, name: 'Manual', slug: 'manual-nuevo' },
      OPTIONS
    );
    const payload = wikiSpaceClonePayloadSchema.parse(envelope.payload);
    expect(payload.slug).toBe('manual-nuevo');
  });

  it('genera operationId y occurredAt válidos cuando no se inyectan', () => {
    const envelope = cloneWikiTemplate({
      householdId: HOUSEHOLD,
      templateSpaceId: SPACE,
      name: 'Manual'
    });
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
  });
});
