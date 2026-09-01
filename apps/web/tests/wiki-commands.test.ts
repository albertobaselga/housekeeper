import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código de `commands.ts` que llega al navegador no importa zod jamás.
import {
  commandEnvelopeSchema,
  wikiPageCreatePayloadSchema,
  wikiPageEditPayloadSchema,
  wikiPageSetStatePayloadSchema,
  wikiSpaceCreatePayloadSchema
} from '@housekeeper/contracts/schemas';

import {
  createWikiPage,
  createWikiSpace,
  editWikiPage,
  parseTermList,
  queueWikiCommand,
  setWikiPageState
} from '../src/lib/wiki/commands';
import { listOutbox } from '../src/lib/offline/idb';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const SPACE = '30000000-0000-4000-8000-000000000001';
const PAGE = '31000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000002',
  occurredAt: '2026-08-07T10:00:00.000Z'
};

describe('constructores de envelopes de la wiki', () => {
  it('createWikiSpace produce el payload congelado y omite opcionales vacíos', () => {
    const envelope = createWikiSpace(
      { householdId: HOUSEHOLD, name: '  Equipamiento  ', slug: '', description: ' ' },
      OPTIONS
    );
    expect(envelope.aggregateType).toBe('wiki_space');
    expect(envelope.aggregateId).toBeNull();
    expect(envelope.baseRevision).toBeNull();
    expect(envelope.operationId).toBe(OPTIONS.operationId);
    expect(wikiSpaceCreatePayloadSchema.parse(envelope.payload)).toEqual({
      action: 'create',
      name: 'Equipamiento'
    });
  });

  it('createWikiPage valida contra el contrato con tags, alias y publish', () => {
    const envelope = createWikiPage(
      {
        householdId: HOUSEHOLD,
        spaceId: SPACE,
        title: ' Lavadora ',
        bodyMarkdown: 'Programa corto a 40°.',
        tags: [' colada ', ''],
        aliases: ['lavadora'],
        publish: true
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('wiki_page');
    expect(wikiPageCreatePayloadSchema.parse(envelope.payload)).toEqual({
      action: 'create',
      spaceId: SPACE,
      title: 'Lavadora',
      bodyMarkdown: 'Programa corto a 40°.',
      tags: ['colada'],
      aliases: ['lavadora'],
      publish: true
    });
  });

  it('createWikiPage nombra el apartado por slug cuando el hogar aún no lo tiene', () => {
    const envelope = createWikiPage(
      {
        householdId: HOUSEHOLD,
        spaceSlug: 'general',
        spaceName: 'General',
        title: 'Primera instrucción',
        bodyMarkdown: 'Escrita sin conexión.'
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(wikiPageCreatePayloadSchema.parse(envelope.payload)).toEqual({
      action: 'create',
      spaceSlug: 'general',
      spaceName: 'General',
      title: 'Primera instrucción',
      bodyMarkdown: 'Escrita sin conexión.'
    });
  });

  it('editWikiPage ancla aggregateId y viaja con baseRevision en el envelope', () => {
    const envelope = editWikiPage(
      {
        householdId: HOUSEHOLD,
        pageId: PAGE,
        baseRevision: 2,
        title: 'Lavadora · programa corto',
        bodyMarkdown: 'Cuerpo nuevo.',
        summary: ' Aclarado el detergente ',
        tags: ['colada'],
        aliases: []
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateId).toBe(PAGE);
    expect(envelope.baseRevision).toBe(2);
    const payload = wikiPageEditPayloadSchema.parse(envelope.payload);
    expect(payload.summary).toBe('Aclarado el detergente');
    expect(payload).not.toHaveProperty('aliases');
  });

  it('setWikiPageState exige status o pinned y admite ambos', () => {
    const publish = setWikiPageState(
      { householdId: HOUSEHOLD, pageId: PAGE, status: 'published' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(publish)).toBeTruthy();
    expect(publish.aggregateId).toBe(PAGE);
    expect(wikiPageSetStatePayloadSchema.parse(publish.payload)).toEqual({
      action: 'set_state',
      pageId: PAGE,
      status: 'published'
    });

    const pin = setWikiPageState({ householdId: HOUSEHOLD, pageId: PAGE, pinned: true }, OPTIONS);
    expect(wikiPageSetStatePayloadSchema.parse(pin.payload).pinned).toBe(true);

    // Un set_state vacío viola el contrato: el schema lo rechaza.
    expect(() =>
      wikiPageSetStatePayloadSchema.parse({ action: 'set_state', pageId: PAGE })
    ).toThrow();
  });

  it('genera operationId y occurredAt válidos cuando no se inyectan', () => {
    const envelope = createWikiPage({
      householdId: HOUSEHOLD,
      spaceId: SPACE,
      title: 'Caldera',
      bodyMarkdown: 'Presión entre 1 y 1,5 bar.'
    });
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
  });

  it('parseTermList divide por comas, recorta y limita a 20 términos', () => {
    expect(parseTermList(' colada , lavadora ,, ')).toEqual(['colada', 'lavadora']);
    expect(parseTermList(Array.from({ length: 30 }, (_, i) => `t${i}`).join(','))).toHaveLength(20);
    expect(parseTermList('')).toEqual([]);
  });
});

describe('queueWikiCommand', () => {
  it('persiste primero en el outbox y queda pendiente sin navegador', async () => {
    // En node `browser` es false: flushOutbox no envía nada y el comando debe
    // quedarse en el outbox (offline-first) esperando al flush del navegador.
    const householdId = crypto.randomUUID();
    const envelope = setWikiPageState({ householdId, pageId: PAGE, pinned: true });
    const outcome = await queueWikiCommand(envelope);
    expect(outcome).toBe('queued');
    const records = await listOutbox(householdId);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(envelope.operationId);
    expect(records[0]!.status).toBe('pending');
    expect(records[0]!.envelope).toEqual(envelope);
  });
});
