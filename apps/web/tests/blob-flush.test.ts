import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { listOfflineBlobs, queueOutbox, readOfflineBlob, saveOfflineBlob } from '../src/lib/offline/idb';
import { createOutboxRecord, type OfflineBlobRecord } from '../src/lib/offline/schema';
import { flushBlobs, performSyncFlush, type BlobUploadMapping } from '../src/lib/offline/sync';
import { FIXTURE_HOUSEHOLD as HOUSEHOLD, envelopeFixture } from './helpers';

function databaseName(label: string): string {
  return `casa-clara-blobs-${label}-${crypto.randomUUID()}`;
}

function blobRecord(id: string, createdAt: string): OfflineBlobRecord {
  const blob = new Blob([`foto sintética ${id}`], { type: 'image/jpeg' });
  return { id, householdId: HOUSEHOLD, contentType: 'image/jpeg', size: blob.size, createdAt, blob };
}

function attachmentResponse(storageObjectId: string): Response {
  return {
    ok: true,
    json: () => Promise.resolve({ apiVersion: 1, storageObjectId, sha256: 'a'.repeat(64) })
  } as unknown as Response;
}

describe('flushBlobs: el outbox de fotos', () => {
  it('sube cada blob, expone el mapeo por callback y SOLO el 2xx borra de IndexedDB', async () => {
    const name = databaseName('happy');
    await saveOfflineBlob(blobRecord('blob-1', '2026-08-07T08:00:00.000Z'), name);
    await saveOfflineBlob(blobRecord('blob-2', '2026-08-07T08:01:00.000Z'), name);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(attachmentResponse('so-0000-1'))
      .mockResolvedValueOnce(attachmentResponse('so-0000-2'));
    const mappings: BlobUploadMapping[] = [];

    const result = await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name, (mapping) => {
      mappings.push(mapping);
    });

    expect(result).toBe('flushed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe(`/api/v1/households/${HOUSEHOLD}/attachments`);
    expect((firstInit.headers as Record<string, string>)['content-type']).toBe('image/jpeg');
    expect((firstInit.headers as Record<string, string>)['x-attachment-name']).toBe('blob-1');

    // El mapeo blobId→storageObjectId queda expuesto para el enlazado futuro.
    expect(mappings).toEqual([
      { blobId: 'blob-1', storageObjectId: 'so-0000-1' },
      { blobId: 'blob-2', storageObjectId: 'so-0000-2' }
    ]);
    expect(await listOfflineBlobs(HOUSEHOLD, name)).toHaveLength(0);
  });

  it('un 5xx conserva el blob local intacto para reintentar', async () => {
    const name = databaseName('server-error');
    await saveOfflineBlob(blobRecord('blob-1', '2026-08-07T08:00:00.000Z'), name);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

    expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('failed');
    expect(await readOfflineBlob('blob-1', name)).not.toBeNull();
  });

  it('sin red (fetch lanza) el blob también se conserva', async () => {
    const name = databaseName('offline');
    await saveOfflineBlob(blobRecord('blob-1', '2026-08-07T08:00:00.000Z'), name);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('failed to fetch'));

    expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('failed');
    expect(await readOfflineBlob('blob-1', name)).not.toBeNull();
  });

  it('sin blobs pendientes no toca la red', async () => {
    const fetchMock = vi.fn();
    expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, databaseName('empty'))).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('performSyncFlush sube las fotos ANTES que los comandos del outbox', async () => {
    const name = databaseName('order');
    await saveOfflineBlob(blobRecord('blob-1', '2026-08-07T08:00:00.000Z'), name);
    const operationId = '22222222-0000-4000-8000-000000000010';
    await queueOutbox(createOutboxRecord(envelopeFixture(operationId, '2026-08-07T08:02:00.000Z')), name);

    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/attachments')) return Promise.resolve(attachmentResponse('so-0000-9'));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            apiVersion: 1,
            acknowledgements: [{ operationId, status: 'accepted' }],
            nextCursor: null,
            snapshotVersion: null
          })
      } as unknown as Response);
    });

    expect(await performSyncFlush(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('flushed');
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([`/api/v1/households/${HOUSEHOLD}/attachments`, '/api/v1/sync']);
    expect(await listOfflineBlobs(HOUSEHOLD, name)).toHaveLength(0);
  });
});
