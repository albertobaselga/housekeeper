import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { API_VERSION, MAX_SYNC_COMMANDS } from '@casa-clara/contracts';
import type { CriticalSnapshotV1, OutboxRecord } from './schema';
import { acknowledgeOutbox, listOutbox, saveCriticalSnapshot, updateOutboxStatuses } from './idb';
import { deriveSyncState, type SyncPresentation } from './sync-state';
import { verifySnapshotSignature } from './verify';

export const syncStatus = writable<SyncPresentation>(
  deriveSyncState({ online: true, pendingCount: 0 })
);

let activeHouseholdId: string | null = null;
let flushInFlight = false;

function pendingRecords(records: OutboxRecord[]): OutboxRecord[] {
  return records.filter((record) => record.status === 'pending');
}

export async function refreshSyncStatus(overrides: { syncing?: boolean; conflict?: boolean } = {}): Promise<void> {
  if (!browser || !activeHouseholdId) return;
  try {
    const records = await listOutbox(activeHouseholdId);
    const conflict = records.some((record) => record.status !== 'pending');
    syncStatus.set(
      deriveSyncState({
        online: navigator.onLine,
        pendingCount: pendingRecords(records).length,
        conflict,
        ...overrides
      })
    );
  } catch {
    syncStatus.set(deriveSyncState({ online: navigator.onLine, pendingCount: 0, storageError: true }));
  }
}

interface SyncAckLike {
  operationId?: unknown;
  status?: unknown;
  errorCode?: unknown;
}

function ackIds(acks: SyncAckLike[], statuses: readonly string[]): string[] {
  return acks
    .filter((ack) => typeof ack.operationId === 'string' && statuses.includes(String(ack.status)))
    .map((ack) => String(ack.operationId));
}

/** Igual que ackIds pero conservando el errorCode del ACK para el triaje humano. */
function ackUpdates(
  acks: SyncAckLike[],
  statuses: readonly string[]
): { id: string; errorCode?: string }[] {
  return acks
    .filter((ack) => typeof ack.operationId === 'string' && statuses.includes(String(ack.status)))
    .map((ack) => ({
      id: String(ack.operationId),
      ...(typeof ack.errorCode === 'string' && ack.errorCode ? { errorCode: ack.errorCode } : {})
    }));
}

/**
 * Núcleo del envío: publica el outbox pendiente en /api/v1/sync y aplica el ACK
 * parcial. Solo accepted/duplicate se eliminan; conflict/rejected quedan marcados
 * para resolución humana; retryable y los errores de red permanecen pendientes.
 */
export async function performSyncFlush(
  householdId: string,
  fetchFn: typeof fetch,
  databaseName?: string
): Promise<'idle' | 'flushed' | 'failed'> {
  const batch = pendingRecords(await listOutbox(householdId, databaseName)).slice(0, MAX_SYNC_COMMANDS);
  if (!batch.length) return 'idle';
  try {
    const response = await fetchFn('/api/v1/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: API_VERSION, commands: batch.map((record) => record.envelope) })
    });
    if (!response.ok) return 'failed';
    const payload: unknown = await response.json();
    const acks = Array.isArray((payload as { acknowledgements?: unknown }).acknowledgements)
      ? (payload as { acknowledgements: SyncAckLike[] }).acknowledgements
      : [];
    await acknowledgeOutbox(
      batch.map((record) => record.id),
      { ok: true, acknowledgedIds: ackIds(acks, ['accepted', 'duplicate']) },
      databaseName
    );
    await updateOutboxStatuses(ackUpdates(acks, ['conflict']), 'conflict', databaseName);
    await updateOutboxStatuses(ackUpdates(acks, ['rejected']), 'rejected', databaseName);
    return 'flushed';
  } catch {
    // Sin red o servidor caído: el outbox queda intacto y se reintentará.
    return 'failed';
  }
}

export async function flushOutbox(fetchFn: typeof fetch = fetch): Promise<void> {
  if (!browser || !activeHouseholdId || flushInFlight) return;
  if (!navigator.onLine) {
    await refreshSyncStatus();
    return;
  }
  flushInFlight = true;
  try {
    await refreshSyncStatus({ syncing: true });
    await performSyncFlush(activeHouseholdId, fetchFn);
  } finally {
    flushInFlight = false;
    await refreshSyncStatus();
  }
}

export function startSyncMonitor(snapshot: CriticalSnapshotV1, snapshotPublicKey?: string): () => void {
  if (!browser) return () => undefined;
  activeHouseholdId = snapshot.householdId;
  const update = () => void refreshSyncStatus();
  const flush = () => void flushOutbox();
  window.addEventListener('online', flush);
  window.addEventListener('offline', update);

  void (async () => {
    try {
      if (snapshotPublicKey) {
        const verification = await verifySnapshotSignature(snapshot, snapshotPublicKey);
        // `invalid` significa manipulación: no se persiste. `unsupported` se
        // acepta porque el snapshot llegó por el propio canal autenticado.
        if (verification === 'invalid') {
          await refreshSyncStatus();
          return;
        }
      }
      await saveCriticalSnapshot(snapshot);
      await flushOutbox();
    } catch {
      syncStatus.set(deriveSyncState({ online: navigator.onLine, pendingCount: 0, storageError: true }));
    }
  })();

  return () => {
    window.removeEventListener('online', flush);
    window.removeEventListener('offline', update);
    activeHouseholdId = null;
  };
}
