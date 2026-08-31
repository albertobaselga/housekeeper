import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  acknowledgeOutbox,
  listOutbox,
  openOfflineDatabase,
  queueOutbox,
  readCriticalSnapshot,
  readOfflineBlob,
  saveCriticalSnapshot,
  saveOfflineBlob,
  updateOutboxStatuses
} from '../src/lib/offline/idb';
import { OFFLINE_STORES, createOutboxRecord, isCriticalSnapshotV1 } from '../src/lib/offline/schema';
import { deriveSyncState } from '../src/lib/offline/sync-state';
import { FIXTURE_HOUSEHOLD as HOUSEHOLD, envelopeFixture, snapshotFixture } from './helpers';

function databaseName(label: string): string {
  return `housekeeper-test-${label}-${crypto.randomUUID()}`;
}

describe('offline database', () => {
  it('creates the snapshot, outbox and blob stores', async () => {
    const database = await openOfflineDatabase(databaseName('stores'));
    expect([...database.objectStoreNames]).toEqual([
      OFFLINE_STORES.blobs,
      OFFLINE_STORES.criticalSnapshots,
      OFFLINE_STORES.outbox
    ]);
    database.close();
  });

  it('round-trips a versioned critical snapshot', async () => {
    const name = databaseName('snapshot');
    const value = snapshotFixture();
    expect(isCriticalSnapshotV1(value)).toBe(true);
    await saveCriticalSnapshot(value, name);
    expect(await readCriticalSnapshot(HOUSEHOLD, name)).toEqual(value);
  });

  it('keeps outbox records until explicit server acknowledgement', async () => {
    const name = databaseName('outbox');
    const first = createOutboxRecord(envelopeFixture('11111111-0000-4000-8000-000000000001', '2026-08-07T08:00:00.000Z'), {
      createdAt: '2026-08-07T08:00:00.000Z'
    });
    const second = createOutboxRecord(envelopeFixture('11111111-0000-4000-8000-000000000002', '2026-08-07T08:01:00.000Z'), {
      createdAt: '2026-08-07T08:01:00.000Z'
    });
    await queueOutbox(second, name);
    await queueOutbox(first, name);
    expect((await listOutbox(HOUSEHOLD, name)).map((record) => record.id)).toEqual([first.id, second.id]);

    expect(await acknowledgeOutbox([first.id, second.id], null, name)).toEqual({
      clearedIds: [],
      pendingIds: [first.id, second.id]
    });
    expect(await acknowledgeOutbox([first.id, second.id], { ok: true, acknowledgedIds: [first.id] }, name)).toEqual({
      clearedIds: [first.id],
      pendingIds: [second.id]
    });
    expect((await listOutbox(HOUSEHOLD, name)).map((record) => record.id)).toEqual([second.id]);
  });

  it('marks conflicting records for human resolution without deleting them', async () => {
    const name = databaseName('conflict');
    const record = createOutboxRecord(envelopeFixture('11111111-0000-4000-8000-000000000003', '2026-08-07T08:00:00.000Z'));
    await queueOutbox(record, name);
    await updateOutboxStatuses([record.id], 'conflict', name);
    const [stored] = await listOutbox(HOUSEHOLD, name);
    expect(stored.status).toBe('conflict');
    expect(stored.envelope).toEqual(record.envelope);
  });

  it('persists attachment blobs independently from the outbox', async () => {
    const name = databaseName('blob');
    const blob = new Blob(['synthetic receipt'], { type: 'text/plain' });
    await saveOfflineBlob(
      { id: 'blob-1', householdId: HOUSEHOLD, contentType: blob.type, size: blob.size, createdAt: '2026-08-07T08:00:00.000Z', blob },
      name
    );
    const stored = await readOfflineBlob('blob-1', name);
    expect(stored?.contentType).toBe('text/plain');
    expect(await stored?.blob.text()).toBe('synthetic receipt');
  });
});

describe('visible sync states', () => {
  it('describes saved, pending, offline, syncing, conflict and error states', () => {
    expect(deriveSyncState({ online: true, pendingCount: 0 }).phase).toBe('saved');
    expect(deriveSyncState({ online: true, pendingCount: 2 }).phase).toBe('pending');
    expect(deriveSyncState({ online: false, pendingCount: 2 })).toMatchObject({ phase: 'offline', label: 'Sin conexión · 2 pendientes' });
    expect(deriveSyncState({ online: true, pendingCount: 2, syncing: true }).phase).toBe('syncing');
    expect(deriveSyncState({ online: true, pendingCount: 0, conflict: true }).phase).toBe('conflict');
    expect(deriveSyncState({ online: true, pendingCount: 0, storageError: true }).phase).toBe('error');
  });

  it('separa «pendiente de red» (ámbar) de «necesita tu decisión» (rojo con conteo)', () => {
    // Pendiente de red: se resolverá solo, copy en clave de espera.
    expect(deriveSyncState({ online: true, pendingCount: 1 })).toMatchObject({
      phase: 'pending',
      label: '1 cambio pendiente',
      detail: 'Guardado en este dispositivo; falta que llegue a la casa.'
    });
    // Rechazado/conflicto: NO se reenviará solo; el conteo afina el copy.
    expect(deriveSyncState({ online: true, pendingCount: 0, conflict: true, attentionCount: 1 })).toMatchObject({
      phase: 'conflict',
      label: 'Necesita tu decisión · 1',
      detail: 'Hay 1 cambio rechazado o en conflicto que no se aplicará solo.'
    });
    expect(deriveSyncState({ online: true, pendingCount: 2, conflict: true, attentionCount: 3 })).toMatchObject({
      phase: 'conflict',
      label: 'Necesita tu decisión · 3',
      detail: 'Hay 3 cambios rechazados o en conflicto que no se aplicarán solos.'
    });
    // Compatibilidad: conflict sin conteo sigue siendo rojo con copy genérico.
    expect(deriveSyncState({ online: true, pendingCount: 0, conflict: true })).toMatchObject({
      phase: 'conflict',
      label: 'Necesita tu decisión'
    });
  });
});
