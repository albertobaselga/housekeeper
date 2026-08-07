const DB_NAME = "casa-clara";
const DB_VERSION = 1;
const OUTBOX_STORE = "outbox";
const SNAPSHOT_STORE = "snapshots";

function storageError(message, cause) {
  return new Error(message, cause ? { cause } : undefined);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(storageError("IndexedDB no está disponible"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        const outbox = database.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
        outbox.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(storageError("No se pudo abrir IndexedDB", request.error));
    request.onblocked = () => {
      blocked = true;
      reject(storageError("La actualización de IndexedDB está bloqueada por otra pestaña"));
    };
  });
}

async function runTransaction(storeName, mode, operation) {
  const database = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;

      try {
        request = operation(store);
      } catch (error) {
        transaction.abort();
        reject(storageError(`No se pudo iniciar la transacción de ${storeName}`, error));
        return;
      }

      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(storageError(`Falló la transacción de ${storeName}`, transaction.error));
      transaction.onabort = () => reject(storageError(`Se canceló la transacción de ${storeName}`, transaction.error));
    });
  } finally {
    database.close();
  }
}

function requireRecordKey(value, label) {
  const key = String(value || "").trim();
  if (!key) throw new TypeError(`${label} requiere un identificador no vacío`);
  return key;
}

export async function queueOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new TypeError("La operación de outbox debe ser un objeto");
  }

  const record = {
    ...operation,
    id: requireRecordKey(operation.id, "La operación de outbox"),
    createdAt: operation.createdAt || new Date().toISOString(),
    attempts: Number(operation.attempts || 0),
  };

  await runTransaction(OUTBOX_STORE, "readwrite", (store) => store.put(record));
  return record;
}

export async function listQueuedOperations() {
  const records = await runTransaction(OUTBOX_STORE, "readonly", (store) => store.getAll());
  return records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Elimina exclusivamente operaciones confirmadas por el servidor.
 * `acknowledgement` debe ser la respuesta validada del backend:
 * `{ ok: true, acknowledgedIds: ["operation-id"] }`.
 * Sin ACK la función no modifica IndexedDB.
 */
export async function clearQueuedOperations(ids = [], acknowledgement = null) {
  const requestedIds = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  const acknowledgedIds = acknowledgement?.ok === true && Array.isArray(acknowledgement.acknowledgedIds)
    ? new Set(acknowledgement.acknowledgedIds.map((id) => String(id || "").trim()).filter(Boolean))
    : new Set();
  const clearedIds = requestedIds.filter((id) => acknowledgedIds.has(id));
  const pendingIds = requestedIds.filter((id) => !acknowledgedIds.has(id));

  if (!clearedIds.length) {
    return { clearedIds, pendingIds, acknowledged: false };
  }

  await runTransaction(OUTBOX_STORE, "readwrite", (store) => {
    clearedIds.forEach((id) => store.delete(id));
  });

  return { clearedIds, pendingIds, acknowledged: pendingIds.length === 0 };
}

export async function saveCriticalSnapshot(key, payload, { version = 1 } = {}) {
  const snapshot = {
    key: requireRecordKey(key, "El snapshot crítico"),
    version,
    payload,
    savedAt: new Date().toISOString(),
  };

  await runTransaction(SNAPSHOT_STORE, "readwrite", (store) => store.put(snapshot));
  return snapshot;
}

export async function getCriticalSnapshot(key) {
  const snapshotKey = requireRecordKey(key, "El snapshot crítico");
  return (await runTransaction(SNAPSHOT_STORE, "readonly", (store) => store.get(snapshotKey))) || null;
}
