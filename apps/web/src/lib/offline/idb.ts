import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_STORES,
  isCriticalSnapshotV1,
  type CriticalSnapshotV1,
  type OfflineBlobRecord,
  type OutboxRecord
} from './schema';

function requireIndexedDb(): IDBFactory {
  if (!globalThis.indexedDB) throw new Error('IndexedDB is not available');
  return globalThis.indexedDB;
}

export function openOfflineDatabase(name = OFFLINE_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = requireIndexedDb().open(name, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(OFFLINE_STORES.criticalSnapshots)) {
        database.createObjectStore(OFFLINE_STORES.criticalSnapshots, { keyPath: 'householdId' });
      }

      if (!database.objectStoreNames.contains(OFFLINE_STORES.outbox)) {
        const outbox = database.createObjectStore(OFFLINE_STORES.outbox, { keyPath: 'id' });
        outbox.createIndex('householdId', 'householdId', { unique: false });
        outbox.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!database.objectStoreNames.contains(OFFLINE_STORES.blobs)) {
        const blobs = database.createObjectStore(OFFLINE_STORES.blobs, { keyPath: 'id' });
        blobs.createIndex('householdId', 'householdId', { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another tab'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function withStore<T>(
  storeName: (typeof OFFLINE_STORES)[keyof typeof OFFLINE_STORES],
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  databaseName?: string
): Promise<T> {
  const database = await openOfflineDatabase(databaseName);
  try {
    const transaction = database.transaction(storeName, mode);
    return await requestResult(operation(transaction.objectStore(storeName)));
  } finally {
    database.close();
  }
}

export async function saveCriticalSnapshot(
  snapshot: CriticalSnapshotV1,
  databaseName?: string
): Promise<CriticalSnapshotV1> {
  if (!isCriticalSnapshotV1(snapshot)) throw new TypeError('Invalid CriticalSnapshotV1');
  await withStore(OFFLINE_STORES.criticalSnapshots, 'readwrite', (store) => store.put(snapshot), databaseName);
  return snapshot;
}

export async function readCriticalSnapshot(
  householdId: string,
  databaseName?: string
): Promise<CriticalSnapshotV1 | null> {
  const result = await withStore<unknown>(
    OFFLINE_STORES.criticalSnapshots,
    'readonly',
    (store) => store.get(householdId),
    databaseName
  );
  return isCriticalSnapshotV1(result) ? result : null;
}

export async function queueOutbox(record: OutboxRecord, databaseName?: string): Promise<OutboxRecord> {
  await withStore(OFFLINE_STORES.outbox, 'readwrite', (store) => store.put(record), databaseName);
  return record;
}

export async function listOutbox(householdId?: string, databaseName?: string): Promise<OutboxRecord[]> {
  const records = await withStore<OutboxRecord[]>(
    OFFLINE_STORES.outbox,
    'readonly',
    (store) => householdId ? store.index('householdId').getAll(householdId) : store.getAll(),
    databaseName
  );
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Removes only IDs explicitly acknowledged by a server response. */
export async function acknowledgeOutbox(
  requestedIds: string[],
  acknowledgement: { ok: true; acknowledgedIds: string[] } | null,
  databaseName?: string
): Promise<{ clearedIds: string[]; pendingIds: string[] }> {
  const allowed = new Set(acknowledgement?.ok ? acknowledgement.acknowledgedIds : []);
  const uniqueRequested = [...new Set(requestedIds.filter(Boolean))];
  const clearedIds = uniqueRequested.filter((id) => allowed.has(id));
  const pendingIds = uniqueRequested.filter((id) => !allowed.has(id));

  if (!clearedIds.length) return { clearedIds, pendingIds };

  const database = await openOfflineDatabase(databaseName);
  try {
    const transaction = database.transaction(OFFLINE_STORES.outbox, 'readwrite');
    const store = transaction.objectStore(OFFLINE_STORES.outbox);
    for (const id of clearedIds) store.delete(id);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not acknowledge outbox'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Outbox acknowledgement aborted'));
    });
  } finally {
    database.close();
  }

  return { clearedIds, pendingIds };
}

/** Actualización por registro: id más el código de error del ACK, si viajó. */
export type OutboxStatusUpdate = string | { id: string; errorCode?: string };

/** Marca registros de outbox que requieren resolución humana (conflict/rejected). */
export async function updateOutboxStatuses(
  ids: OutboxStatusUpdate[],
  status: OutboxRecord['status'],
  databaseName?: string
): Promise<void> {
  if (!ids.length) return;
  const database = await openOfflineDatabase(databaseName);
  try {
    const transaction = database.transaction(OFFLINE_STORES.outbox, 'readwrite');
    const store = transaction.objectStore(OFFLINE_STORES.outbox);
    for (const update of ids) {
      const { id, errorCode } = typeof update === 'string' ? { id: update, errorCode: undefined } : update;
      const record = await requestResult<OutboxRecord | undefined>(store.get(id));
      if (record) store.put({ ...record, status, ...(errorCode ? { lastErrorCode: errorCode } : {}) });
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not update outbox statuses'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Outbox status update aborted'));
    });
  } finally {
    database.close();
  }
}

/**
 * Borra un registro del outbox por decisión explícita del usuario (descartar
 * un conflict/rejected o sustituirlo por una copia con operationId nuevo).
 */
export async function discardOutboxRecord(id: string, databaseName?: string): Promise<void> {
  await withStore(OFFLINE_STORES.outbox, 'readwrite', (store) => store.delete(id), databaseName);
}

export async function saveOfflineBlob(record: OfflineBlobRecord, databaseName?: string): Promise<void> {
  if (record.size !== record.blob.size) throw new TypeError('Blob size metadata does not match payload');
  await withStore(OFFLINE_STORES.blobs, 'readwrite', (store) => store.put(record), databaseName);
}

export async function readOfflineBlob(id: string, databaseName?: string): Promise<OfflineBlobRecord | null> {
  return (await withStore<OfflineBlobRecord | undefined>(
    OFFLINE_STORES.blobs,
    'readonly',
    (store) => store.get(id),
    databaseName
  )) ?? null;
}

/** Blobs pendientes de subir, en orden de captura (createdAt ascendente). */
export async function listOfflineBlobs(householdId?: string, databaseName?: string): Promise<OfflineBlobRecord[]> {
  const records = await withStore<OfflineBlobRecord[]>(
    OFFLINE_STORES.blobs,
    'readonly',
    (store) => (householdId ? store.index('householdId').getAll(householdId) : store.getAll()),
    databaseName
  );
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Borra un blob SOLO tras el 2xx del servidor: hasta entonces vive local. */
export async function deleteOfflineBlob(id: string, databaseName?: string): Promise<void> {
  await withStore(OFFLINE_STORES.blobs, 'readwrite', (store) => store.delete(id), databaseName);
}
