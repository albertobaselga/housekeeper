import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import type { CriticalSnapshotV1 } from './schema';
import { listOutbox, saveCriticalSnapshot } from './idb';
import { deriveSyncState, type SyncPresentation } from './sync-state';

export const syncStatus = writable<SyncPresentation>(
  deriveSyncState({ online: true, pendingCount: 0 })
);

let activeHouseholdId: string | null = null;

export async function refreshSyncStatus(overrides: { syncing?: boolean; conflict?: boolean } = {}): Promise<void> {
  if (!browser || !activeHouseholdId) return;
  try {
    const pendingCount = (await listOutbox(activeHouseholdId)).length;
    syncStatus.set(deriveSyncState({ online: navigator.onLine, pendingCount, ...overrides }));
  } catch {
    syncStatus.set(deriveSyncState({ online: navigator.onLine, pendingCount: 0, storageError: true }));
  }
}

export function startSyncMonitor(snapshot: CriticalSnapshotV1): () => void {
  if (!browser) return () => undefined;
  activeHouseholdId = snapshot.householdId;
  const update = () => void refreshSyncStatus();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);

  saveCriticalSnapshot(snapshot)
    .then(update)
    .catch(() => syncStatus.set(deriveSyncState({ online: navigator.onLine, pendingCount: 0, storageError: true })));

  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
    activeHouseholdId = null;
  };
}
