import 'fake-indexeddb/auto';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { canonicalJson } from '@housekeeper/contracts';

import { listOutbox, queueOutbox } from '../src/lib/offline/idb';
import { createOutboxRecord } from '../src/lib/offline/schema';
import { performSyncFlush } from '../src/lib/offline/sync';
import { verifySnapshotSignature } from '../src/lib/offline/verify';
import { FIXTURE_HOUSEHOLD as HOUSEHOLD, envelopeFixture, snapshotFixture } from './helpers';

function databaseName(label: string): string {
  return `housekeeper-sync-${label}-${crypto.randomUUID()}`;
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body)
  } as unknown as Response;
}

describe('flush del outbox con ACK parcial', () => {
  it('elimina accepted/duplicate, marca conflict/rejected y conserva retryable', async () => {
    const name = databaseName('acks');
    const ids = [
      '22222222-0000-4000-8000-000000000001',
      '22222222-0000-4000-8000-000000000002',
      '22222222-0000-4000-8000-000000000003',
      '22222222-0000-4000-8000-000000000004',
      '22222222-0000-4000-8000-000000000005'
    ];
    for (const [index, id] of ids.entries()) {
      await queueOutbox(
        createOutboxRecord(envelopeFixture(id, `2026-08-07T08:0${index}:00.000Z`), {
          createdAt: `2026-08-07T08:0${index}:00.000Z`
        }),
        name
      );
    }

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        apiVersion: 1,
        acknowledgements: [
          { operationId: ids[0], status: 'accepted' },
          { operationId: ids[1], status: 'duplicate' },
          { operationId: ids[2], status: 'conflict', errorCode: 'revision_mismatch' },
          { operationId: ids[3], status: 'rejected', errorCode: 'not_allowed' },
          { operationId: ids[4], status: 'retryable' }
        ],
        nextCursor: '2026-08-07T09:00:00.000Z',
        snapshotVersion: null
      })
    );

    expect(await performSyncFlush(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('flushed');

    const [, request] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(request.body).commands).toHaveLength(5);

    const remaining = await listOutbox(HOUSEHOLD, name);
    expect(remaining.map((record) => [record.id, record.status])).toEqual([
      [ids[2], 'conflict'],
      [ids[3], 'rejected'],
      [ids[4], 'pending']
    ]);
    // El motivo del ACK queda guardado para el triaje humano por-acción.
    expect(remaining.map((record) => record.lastErrorCode)).toEqual([
      'revision_mismatch',
      'not_allowed',
      undefined
    ]);
  });

  it('entrega el mapa operationId→ack vía onAcks tras aplicar el ACK (API aditiva)', async () => {
    const name = databaseName('onacks');
    const ids = [
      '22222222-0000-4000-8000-000000000011',
      '22222222-0000-4000-8000-000000000012',
      '22222222-0000-4000-8000-000000000013'
    ];
    for (const [index, id] of ids.entries()) {
      await queueOutbox(
        createOutboxRecord(envelopeFixture(id, `2026-08-07T08:1${index}:00.000Z`), {
          createdAt: `2026-08-07T08:1${index}:00.000Z`
        }),
        name
      );
    }
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        apiVersion: 1,
        acknowledgements: [
          { operationId: ids[0], status: 'accepted' },
          { operationId: ids[1], status: 'rejected', errorCode: 'not_allowed' },
          { operationId: ids[2], status: 'conflict', errorCode: 'wiki_revision_conflict' },
          { operationId: 'no-es-un-string-valido', status: 42 }
        ],
        nextCursor: '2026-08-07T09:00:00.000Z',
        snapshotVersion: null
      })
    );

    const captured: { acks: ReadonlyMap<string, { status: string; errorCode?: string }> | null } = { acks: null };
    const result = await performSyncFlush(HOUSEHOLD, fetchMock as unknown as typeof fetch, name, {
      onAcks: (map) => {
        captured.acks = map;
      }
    });

    // El retorno histórico no cambia (API aditiva).
    expect(result).toBe('flushed');
    expect(captured.acks?.size).toBe(3);
    expect(captured.acks?.get(ids[0]!)).toEqual({ status: 'accepted' });
    expect(captured.acks?.get(ids[1]!)).toEqual({ status: 'rejected', errorCode: 'not_allowed' });
    expect(captured.acks?.get(ids[2]!)).toEqual({ status: 'conflict', errorCode: 'wiki_revision_conflict' });
    // Cuando se entrega el mapa, el outbox YA refleja lo que el mapa describe.
    const remaining = await listOutbox(HOUSEHOLD, name);
    expect(remaining.map((record) => [record.id, record.status])).toEqual([
      [ids[1], 'rejected'],
      [ids[2], 'conflict']
    ]);
  });

  it('no toca el outbox cuando la red falla o el servidor responde error', async () => {
    const name = databaseName('failure');
    const id = '22222222-0000-4000-8000-000000000006';
    await queueOutbox(createOutboxRecord(envelopeFixture(id, '2026-08-07T08:00:00.000Z')), name);

    const networkError = vi.fn().mockRejectedValue(new TypeError('offline'));
    expect(await performSyncFlush(HOUSEHOLD, networkError as unknown as typeof fetch, name)).toBe('failed');

    const serverError = vi.fn().mockResolvedValue(jsonResponse({}, false));
    expect(await performSyncFlush(HOUSEHOLD, serverError as unknown as typeof fetch, name)).toBe('failed');

    const [record] = await listOutbox(HOUSEHOLD, name);
    expect(record).toMatchObject({ id, status: 'pending' });
  });

  it('no llama a la red sin registros pendientes', async () => {
    const fetchMock = vi.fn();
    expect(await performSyncFlush(HOUSEHOLD, fetchMock as unknown as typeof fetch, databaseName('empty'))).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verificación Ed25519 del snapshot', () => {
  it('acepta la firma legítima y detecta manipulación', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyRaw = (publicKey.export({ format: 'jwk' }) as { x: string }).x;

    const unsigned = { ...snapshotFixture() } as Record<string, unknown>;
    delete unsigned.signature;
    const signature = nodeSign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64url');
    const snapshot = { ...snapshotFixture(), signature };

    expect(await verifySnapshotSignature(snapshot, publicKeyRaw)).toBe('valid');

    const tampered = {
      ...snapshot,
      payload: { ...snapshot.payload, today: { ...snapshot.payload.today, menu: 'alterado' } }
    };
    expect(await verifySnapshotSignature(tampered, publicKeyRaw)).toBe('invalid');
  });
});
