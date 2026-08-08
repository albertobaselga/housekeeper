import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { isBlockedByAttachment, triageableRecords } from '../src/lib/components/outbox-triage';
import { listOfflineBlobs, listOutbox, queueOutbox, readOfflineBlob, saveOfflineBlob } from '../src/lib/offline/idb';
import {
  createOutboxRecord,
  MAX_BLOB_UPLOAD_ATTEMPTS,
  type OfflineBlobRecord
} from '../src/lib/offline/schema';
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

// Ola D-2: la foto capturada SIN conexión acaba enlazada al gasto sola. El
// comando espera en el outbox a que la foto suba y sale ya con el
// identificador real dentro; nunca se crea un gasto con la foto huérfana.
describe('re-enlace diferido foto → gasto', () => {
  const operationId = '22222222-0000-4000-8000-000000000030';

  function pendingExpense(name: string, blobId: string): Promise<unknown> {
    return queueOutbox(
      createOutboxRecord(envelopeFixture(operationId, '2026-08-07T09:00:00.000Z'), {
        pendingBlob: { id: blobId, payloadField: 'receiptStorageObjectId' }
      }),
      name
    );
  }

  function syncMock(seen: unknown[]) {
    return vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/attachments')) return Promise.resolve(attachmentResponse('so-1111-1'));
      seen.push(JSON.parse(String(init?.body)));
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
  }

  it('al volver la red la foto sube y su identificador entra en el comando', async () => {
    const name = databaseName('relink');
    await saveOfflineBlob(blobRecord('blob-ticket', '2026-08-07T08:59:00.000Z'), name);
    await pendingExpense(name, 'blob-ticket');

    const seen: unknown[] = [];
    expect(await performSyncFlush(HOUSEHOLD, syncMock(seen) as unknown as typeof fetch, name)).toBe('flushed');

    const [body] = seen as [{ commands: Array<{ payload: Record<string, unknown> }> }];
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]!.payload.receiptStorageObjectId).toBe('so-1111-1');
    expect(await listOfflineBlobs(HOUSEHOLD, name)).toHaveLength(0);
    expect(await listOutbox(HOUSEHOLD, name)).toHaveLength(0);
  });

  it('si la foto no sube, el gasto ESPERA: nada de justificantes huérfanos', async () => {
    const name = databaseName('hold');
    await saveOfflineBlob(blobRecord('blob-ticket', '2026-08-07T08:59:00.000Z'), name);
    await pendingExpense(name, 'blob-ticket');

    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/attachments')) return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
      throw new Error('El comando no debería haber salido sin su foto');
    });

    expect(await performSyncFlush(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('failed');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`/api/v1/households/${HOUSEHOLD}/attachments`]);
    // Foto y comando siguen esperando juntos, listos para el próximo intento.
    expect(await readOfflineBlob('blob-ticket', name)).not.toBeNull();
    const [record] = await listOutbox(HOUSEHOLD, name);
    expect(record!.pendingBlob).toEqual({ id: 'blob-ticket', payloadField: 'receiptStorageObjectId' });

    // Segundo intento con red: sube y el comando sale ya completo.
    const seen: unknown[] = [];
    expect(await performSyncFlush(HOUSEHOLD, syncMock(seen) as unknown as typeof fetch, name)).toBe('flushed');
    const [body] = seen as [{ commands: Array<{ payload: Record<string, unknown> }> }];
    expect(body.commands[0]!.payload.receiptStorageObjectId).toBe('so-1111-1');
  });

  it('el resto de comandos del outbox siguen saliendo sin esperar a la foto', async () => {
    const name = databaseName('otros');
    await saveOfflineBlob(blobRecord('blob-ticket', '2026-08-07T08:59:00.000Z'), name);
    await pendingExpense(name, 'blob-ticket');
    const otro = '22222222-0000-4000-8000-000000000031';
    await queueOutbox(createOutboxRecord(envelopeFixture(otro, '2026-08-07T09:01:00.000Z')), name);

    const seen: unknown[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/attachments')) return Promise.resolve({ ok: false, status: 503 } as unknown as Response);
      seen.push(JSON.parse(String(init?.body)));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            apiVersion: 1,
            acknowledgements: [{ operationId: otro, status: 'accepted' }],
            nextCursor: null,
            snapshotVersion: null
          })
      } as unknown as Response);
    });

    await performSyncFlush(HOUSEHOLD, fetchMock as unknown as typeof fetch, name);
    const [body] = seen as [{ commands: Array<{ operationId: string }> }];
    expect(body.commands.map((command) => command.operationId)).toEqual([otro]);
  });
});

// Despliegue serverless: el ClamAV del hogar vive en otro host y puede caerse.
// Antes, un 503 persistente dejaba el gasto con `pendingBlob` y estado
// `pending` PARA SIEMPRE: no salía, no aparecía en el triaje y la píldora lo
// contaba como «pendiente de red». Ahora la espera tiene fin y es visible.
describe('la espera de una foto que nunca sube acaba en el triaje', () => {
  const operationId = '22222222-0000-4000-8000-000000000040';

  function pendingExpense(name: string, blobId: string): Promise<unknown> {
    return queueOutbox(
      createOutboxRecord(envelopeFixture(operationId, '2026-08-07T09:00:00.000Z'), {
        pendingBlob: { id: blobId, payloadField: 'receiptStorageObjectId' }
      }),
      name
    );
  }

  async function setUp(label: string): Promise<string> {
    const name = databaseName(label);
    await saveOfflineBlob(blobRecord('blob-ticket', '2026-08-07T08:59:00.000Z'), name);
    await pendingExpense(name, 'blob-ticket');
    return name;
  }

  it('el antivirus caído (503) bloquea el gasto tras MAX_BLOB_UPLOAD_ATTEMPTS pasadas, no antes', async () => {
    const name = await setUp('clamav-down');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    for (let pass = 1; pass < MAX_BLOB_UPLOAD_ATTEMPTS; pass += 1) {
      expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('failed');
      const [waiting] = await listOutbox(HOUSEHOLD, name);
      expect(waiting!.status).toBe('pending');
      expect(waiting!.blobAttempts).toBe(pass);
    }

    expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('failed');
    const [blocked] = await listOutbox(HOUSEHOLD, name);
    expect(blocked!.status).toBe('rejected');
    expect(blocked!.lastErrorCode).toBe('attachment_upload_blocked');
    // La foto NO se borra: «Reintentar» en el triaje tiene algo que subir.
    expect(await readOfflineBlob('blob-ticket', name)).not.toBeNull();
    expect(triageableRecords(await listOutbox(HOUSEHOLD, name))).toHaveLength(1);
    expect(isBlockedByAttachment(blocked!)).toBe(true);

    // Y deja de reintentarse solo: espera la decisión de la persona.
    const before = fetchMock.mock.calls.length;
    expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('idle');
    expect(fetchMock.mock.calls).toHaveLength(before);
  });

  it('un rechazo definitivo (422 en cuarentena) bloquea a la primera', async () => {
    const name = await setUp('quarantine');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422 } as unknown as Response);

    expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('failed');
    const [blocked] = await listOutbox(HOUSEHOLD, name);
    expect(blocked!.status).toBe('rejected');
    expect(blocked!.lastErrorCode).toBe('attachment_rejected');
    expect(isBlockedByAttachment(blocked!)).toBe(true);
  });

  it('un blob sin comando que lo espere no bloquea nada y se sigue reintentando', async () => {
    const name = databaseName('huerfano');
    await saveOfflineBlob(blobRecord('blob-suelto', '2026-08-07T08:59:00.000Z'), name);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    for (let pass = 0; pass <= MAX_BLOB_UPLOAD_ATTEMPTS; pass += 1) {
      expect(await flushBlobs(HOUSEHOLD, fetchMock as unknown as typeof fetch, name)).toBe('failed');
    }
    expect(await listOutbox(HOUSEHOLD, name)).toHaveLength(0);
    expect(await readOfflineBlob('blob-suelto', name)).not.toBeNull();
  });
});
