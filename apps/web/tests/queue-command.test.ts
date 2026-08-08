import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { listOutbox } from '../src/lib/offline/idb';
import { queueCommand } from '../src/lib/offline/queue-command';
import { FIXTURE_HOUSEHOLD as HOUSEHOLD, envelopeFixture } from './helpers';

function databaseName(label: string): string {
  return `casa-clara-queue-command-${label}-${crypto.randomUUID()}`;
}

function ackResponse(operationId: string, status: string, errorCode?: string): Response {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        apiVersion: 1,
        acknowledgements: [{ operationId, status, ...(errorCode ? { errorCode } : {}) }],
        nextCursor: '2026-08-07T09:00:00.000Z',
        snapshotVersion: null
      })
  } as unknown as Response;
}

const OP = '33333333-0000-4000-8000-0000000000';

describe('queueCommand unificado: resultado veraz por ACK', () => {
  it("'synced' cuando el servidor acepta: el outbox queda vacío", async () => {
    const name = databaseName('synced');
    const envelope = envelopeFixture(`${OP}01`, '2026-08-07T08:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(envelope.operationId, 'accepted'));

    const result = await queueCommand(envelope, { fetchFn: fetchMock as unknown as typeof fetch, databaseName: name });

    expect(result).toEqual({ outcome: 'synced', message: 'Cambio sincronizado.' });
    expect(await listOutbox(HOUSEHOLD, name)).toHaveLength(0);
  });

  it("'synced' también con duplicate (idempotencia del servidor)", async () => {
    const name = databaseName('duplicate');
    const envelope = envelopeFixture(`${OP}02`, '2026-08-07T08:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(envelope.operationId, 'duplicate'));

    const result = await queueCommand(envelope, { fetchFn: fetchMock as unknown as typeof fetch, databaseName: name });

    expect(result.outcome).toBe('synced');
    expect(await listOutbox(HOUSEHOLD, name)).toHaveLength(0);
  });

  it("'queued' cuando la red falla: persiste pendiente y se anuncia como local", async () => {
    const name = databaseName('queued');
    const envelope = envelopeFixture(`${OP}03`, '2026-08-07T08:00:00.000Z');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));

    const result = await queueCommand(envelope, { fetchFn: fetchMock as unknown as typeof fetch, databaseName: name });

    expect(result.outcome).toBe('queued');
    expect(result.message).toContain('Guardado en este dispositivo');
    const [record] = await listOutbox(HOUSEHOLD, name);
    expect(record).toMatchObject({ id: envelope.operationId, status: 'pending' });
  });

  it("'queued' con ACK retryable: el servidor pide reintentar, sigue pendiente", async () => {
    const name = databaseName('retryable');
    const envelope = envelopeFixture(`${OP}04`, '2026-08-07T08:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(envelope.operationId, 'retryable'));

    const result = await queueCommand(envelope, { fetchFn: fetchMock as unknown as typeof fetch, databaseName: name });

    expect(result.outcome).toBe('queued');
    const [record] = await listOutbox(HOUSEHOLD, name);
    expect(record).toMatchObject({ id: envelope.operationId, status: 'pending' });
  });

  it("'rejected' YA NO se cuenta como «se sincronizará»: causa traducida y registro marcado", async () => {
    const name = databaseName('rejected');
    const envelope = envelopeFixture(`${OP}05`, '2026-08-07T08:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(envelope.operationId, 'rejected', 'not_allowed'));

    const result = await queueCommand(envelope, { fetchFn: fetchMock as unknown as typeof fetch, databaseName: name });

    expect(result).toEqual({
      outcome: 'rejected',
      errorCode: 'not_allowed',
      message: 'No se pudo guardar: Tu rol no permite esta acción.'
    });
    expect(result.message).not.toContain('se sincronizará');
    const [record] = await listOutbox(HOUSEHOLD, name);
    expect(record).toMatchObject({ id: envelope.operationId, status: 'rejected', lastErrorCode: 'not_allowed' });
  });

  it("'conflict' pide decisión humana con la causa traducida", async () => {
    const name = databaseName('conflict');
    const envelope = envelopeFixture(`${OP}06`, '2026-08-07T08:00:00.000Z');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ackResponse(envelope.operationId, 'conflict', 'wiki_revision_conflict'));

    const result = await queueCommand(envelope, { fetchFn: fetchMock as unknown as typeof fetch, databaseName: name });

    expect(result).toEqual({
      outcome: 'conflict',
      errorCode: 'wiki_revision_conflict',
      message: 'Conflicto con otro cambio: Otra persona guardó cambios mientras editabas; revisa su versión antes de guardar la tuya. Necesita tu decisión.'
    });
    const [record] = await listOutbox(HOUSEHOLD, name);
    expect(record).toMatchObject({ id: envelope.operationId, status: 'conflict' });
  });

  it("'rejected' con código desconocido conserva el código crudo en el mensaje", async () => {
    const name = databaseName('unknown-code');
    const envelope = envelopeFixture(`${OP}07`, '2026-08-07T08:00:00.000Z');
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(envelope.operationId, 'rejected', 'martian_error'));

    const result = await queueCommand(envelope, { fetchFn: fetchMock as unknown as typeof fetch, databaseName: name });

    expect(result.outcome).toBe('rejected');
    expect(result.message).toContain('martian_error');
  });

  it('sin fetchFn y sin navegador (node): offline-first, queda en cola', async () => {
    // Igual que los wrappers queue*Command en tests: browser === false hace
    // que flushOutbox no envíe nada y el comando espere al flush del monitor.
    const envelope = envelopeFixture(`${OP}08`, '2026-08-07T08:00:00.000Z');
    const result = await queueCommand(envelope);
    expect(result.outcome).toBe('queued');
    const records = await listOutbox(HOUSEHOLD);
    expect(records.some((record) => record.id === envelope.operationId && record.status === 'pending')).toBe(true);
  });
});
