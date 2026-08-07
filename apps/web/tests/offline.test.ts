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
  saveOfflineBlob
} from '../src/lib/offline/idb';
import {
  OFFLINE_STORES,
  createOutboxRecord,
  isCriticalSnapshotV1,
  type CriticalSnapshotV1
} from '../src/lib/offline/schema';
import { deriveSyncState } from '../src/lib/offline/sync-state';

function databaseName(label: string): string {
  return `casa-clara-test-${label}-${crypto.randomUUID()}`;
}

function snapshot(): CriticalSnapshotV1 {
  return {
    schemaVersion: 1,
    householdId: 'casa-roble',
    revision: 'test-r1',
    savedAt: '2026-08-07T08:00:00.000Z',
    validUntil: '2026-08-08T08:00:00.000Z',
    payload: {
      today: { dateLabel: 'Viernes', nextEvent: '16:45 · Colegio', menu: 'Lentejas' },
      emergencyContacts: [{ id: '112', name: 'Emergencias', phone: '112', kind: 'emergency' }],
      safeNotes: ['Dato sintético']
    }
  };
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
    const value = snapshot();
    expect(isCriticalSnapshotV1(value)).toBe(true);
    await saveCriticalSnapshot(value, name);
    expect(await readCriticalSnapshot('casa-roble', name)).toEqual(value);
  });

  it('keeps outbox records until explicit server acknowledgement', async () => {
    const name = databaseName('outbox');
    const first = createOutboxRecord({
      id: 'op-1', householdId: 'casa-roble', idempotencyKey: 'idem-1',
      operation: 'routine.toggle', payload: { done: true }, createdAt: '2026-08-07T08:00:00.000Z'
    });
    const second = createOutboxRecord({
      id: 'op-2', householdId: 'casa-roble', idempotencyKey: 'idem-2',
      operation: 'content.write', payload: { title: 'Demo' }, createdAt: '2026-08-07T08:01:00.000Z'
    });
    await queueOutbox(second, name);
    await queueOutbox(first, name);
    expect((await listOutbox('casa-roble', name)).map((record) => record.id)).toEqual(['op-1', 'op-2']);

    expect(await acknowledgeOutbox(['op-1', 'op-2'], null, name)).toEqual({
      clearedIds: [], pendingIds: ['op-1', 'op-2']
    });
    expect(await acknowledgeOutbox(['op-1', 'op-2'], { ok: true, acknowledgedIds: ['op-1'] }, name)).toEqual({
      clearedIds: ['op-1'], pendingIds: ['op-2']
    });
    expect((await listOutbox('casa-roble', name)).map((record) => record.id)).toEqual(['op-2']);
  });

  it('persists attachment blobs independently from the outbox', async () => {
    const name = databaseName('blob');
    const blob = new Blob(['synthetic receipt'], { type: 'text/plain' });
    await saveOfflineBlob({ id: 'blob-1', householdId: 'casa-roble', contentType: blob.type, size: blob.size, createdAt: '2026-08-07T08:00:00.000Z', blob }, name);
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
});
