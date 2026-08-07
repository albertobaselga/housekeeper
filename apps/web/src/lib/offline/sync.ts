import { browser } from '$app/environment';
import { invalidateAll } from '$app/navigation';
import { writable } from 'svelte/store';
import { API_VERSION, MAX_SYNC_COMMANDS } from '@casa-clara/contracts';
import type { CriticalSnapshotV1, OutboxRecord } from './schema';
import {
  acknowledgeOutbox,
  deleteOfflineBlob,
  listOfflineBlobs,
  listOutbox,
  saveCriticalSnapshot,
  updateOutboxStatuses
} from './idb';
import { deriveSyncState, type SyncPresentation } from './sync-state';
import { verifySnapshotSignature } from './verify';

export const syncStatus = writable<SyncPresentation>(
  deriveSyncState({ online: true, pendingCount: 0 })
);

/**
 * Momento (epoch ms) del último flush que APLICÓ cambios en el servidor
 * (algún ACK accepted/duplicate). Las páginas lo observan para limpiar la
 * nota «guardado en este dispositivo» y reconciliar su estado optimista sin
 * intervención del usuario. Null hasta el primer flush con efecto.
 */
export const lastFlushAt = writable<number | null>(null);

let activeHouseholdId: string | null = null;
let flushInFlight = false;

function pendingRecords(records: OutboxRecord[]): OutboxRecord[] {
  return records.filter((record) => record.status === 'pending');
}

export async function refreshSyncStatus(overrides: { syncing?: boolean; conflict?: boolean } = {}): Promise<void> {
  if (!browser || !activeHouseholdId) return;
  try {
    const records = await listOutbox(activeHouseholdId);
    // «Pendiente de red» (ámbar) y «necesita tu decisión» (rojo) son cosas
    // distintas: lo segundo se cuenta aparte para que la píldora sea veraz.
    const attentionCount = records.filter(
      (record) => record.status === 'rejected' || record.status === 'conflict'
    ).length;
    syncStatus.set(
      deriveSyncState({
        online: navigator.onLine,
        pendingCount: pendingRecords(records).length,
        conflict: attentionCount > 0,
        attentionCount,
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

/** ACK por operación tal y como lo devolvió /api/v1/sync, ya tipado. */
export interface SyncCommandAck {
  status: 'accepted' | 'duplicate' | 'conflict' | 'rejected' | 'retryable';
  errorCode?: string;
}

const ACK_STATUSES: readonly SyncCommandAck['status'][] = [
  'accepted',
  'duplicate',
  'conflict',
  'rejected',
  'retryable'
];

/** operationId → ack tipado; los acks malformados se descartan. */
function ackMap(acks: SyncAckLike[]): Map<string, SyncCommandAck> {
  const map = new Map<string, SyncCommandAck>();
  for (const ack of acks) {
    if (typeof ack.operationId !== 'string') continue;
    const status = String(ack.status) as SyncCommandAck['status'];
    if (!ACK_STATUSES.includes(status)) continue;
    map.set(ack.operationId, {
      status,
      ...(typeof ack.errorCode === 'string' && ack.errorCode ? { errorCode: ack.errorCode } : {})
    });
  }
  return map;
}

/** ¿Algún ACK confirmó que el servidor aplicó (o ya tenía) el cambio? */
export function acksApplied(acks: ReadonlyMap<string, SyncCommandAck>): boolean {
  for (const ack of acks.values()) {
    if (ack.status === 'accepted' || ack.status === 'duplicate') return true;
  }
  return false;
}

/** Mapeo blob local → objeto de almacenamiento confirmado por el servidor. */
export interface BlobUploadMapping {
  blobId: string;
  storageObjectId: string;
}

/**
 * Vacía el store de blobs (fotos de tickets capturadas offline): sube cada uno
 * a la ruta de adjuntos del hogar y SOLO tras un 2xx lo borra de IndexedDB.
 * Cualquier error —red, 413/415, 422 de cuarentena, 5xx— conserva el blob
 * local para reintentarlo o para que la persona decida ("las fotos permanecen
 * locales hasta subida y ACK completos"). El mapeo blobId→storageObjectId se
 * expone vía callback opcional; el enlazado con el gasto que referencie el
 * blob queda documentado como hueco para la siguiente ronda.
 */
export async function flushBlobs(
  householdId: string,
  fetchFn: typeof fetch,
  databaseName?: string,
  onUploaded?: (mapping: BlobUploadMapping) => void | Promise<void>
): Promise<'idle' | 'flushed' | 'failed'> {
  const blobs = await listOfflineBlobs(householdId, databaseName);
  if (!blobs.length) return 'idle';
  let uploaded = 0;
  let failed = 0;
  for (const record of blobs) {
    try {
      const response = await fetchFn(`/api/v1/households/${householdId}/attachments`, {
        method: 'POST',
        headers: { 'content-type': record.contentType, 'x-attachment-name': record.id },
        body: record.blob
      });
      if (!response.ok) {
        failed += 1;
        continue;
      }
      const payload: unknown = await response.json();
      const storageObjectId = (payload as { storageObjectId?: unknown }).storageObjectId;
      if (typeof storageObjectId !== 'string' || !storageObjectId) {
        failed += 1;
        continue;
      }
      await onUploaded?.({ blobId: record.id, storageObjectId });
      // El borrado va DETRÁS del callback: si el consumidor no pudo anotar el
      // mapeo, el blob sigue local y la siguiente pasada será idempotente.
      await deleteOfflineBlob(record.id, databaseName);
      uploaded += 1;
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) return 'failed';
  return uploaded > 0 ? 'flushed' : 'idle';
}

/**
 * Núcleo del envío: primero los blobs (las fotos viajan antes que los comandos
 * que las referencian), después publica el outbox pendiente en /api/v1/sync y
 * aplica el ACK parcial. Solo accepted/duplicate se eliminan; conflict/rejected
 * quedan marcados para resolución humana; retryable y los errores de red
 * permanecen pendientes.
 *
 * API aditiva: `options.onAcks` recibe el mapa operationId→ack REAL del
 * servidor tras aplicarlo al outbox. Lo consume `queueCommand` para dar un
 * resultado veraz por acción (un rejected jamás se anuncia como «se
 * sincronizará»). El retorno de siempre no cambia.
 */
export async function performSyncFlush(
  householdId: string,
  fetchFn: typeof fetch,
  databaseName?: string,
  options: {
    onBlobUploaded?: (mapping: BlobUploadMapping) => void | Promise<void>;
    onAcks?: (acks: ReadonlyMap<string, SyncCommandAck>) => void;
  } = {}
): Promise<'idle' | 'flushed' | 'failed'> {
  // Los blobs que fallen se conservan y se reintentarán en la próxima pasada;
  // los comandos siguen su curso (hoy ninguno referencia blobs: hueco anotado).
  const blobResult = await flushBlobs(householdId, fetchFn, databaseName, options.onBlobUploaded);
  const batch = pendingRecords(await listOutbox(householdId, databaseName)).slice(0, MAX_SYNC_COMMANDS);
  if (!batch.length) return blobResult;
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
    // El mapa se entrega DESPUÉS de aplicar el ACK: cuando el consumidor lo
    // lea, el outbox ya refleja el estado que el mapa describe.
    options.onAcks?.(ackMap(acks));
    return 'flushed';
  } catch {
    // Sin red o servidor caído: el outbox queda intacto y se reintentará.
    return 'failed';
  }
}

/**
 * Flush desde el navegador. Devuelve el mapa operationId→ack cuando el envío
 * llegó a producirse (puede ser vacío si no había comandos) o null si no hubo
 * intento (sin navegador, sin hogar activo, offline, flush ya en vuelo o fallo
 * de red): con null el llamador debe decidir mirando el outbox, no inventar.
 */
export async function flushOutbox(
  fetchFn: typeof fetch = fetch
): Promise<ReadonlyMap<string, SyncCommandAck> | null> {
  if (!browser || !activeHouseholdId || flushInFlight) return null;
  if (!navigator.onLine) {
    await refreshSyncStatus();
    return null;
  }
  flushInFlight = true;
  try {
    await refreshSyncStatus({ syncing: true });
    const captured: { acks: ReadonlyMap<string, SyncCommandAck> | null } = { acks: null };
    await performSyncFlush(activeHouseholdId, fetchFn, undefined, {
      onAcks: (map) => {
        captured.acks = map;
      }
    });
    if (captured.acks && acksApplied(captured.acks)) lastFlushAt.set(Date.now());
    return captured.acks;
  } finally {
    flushInFlight = false;
    await refreshSyncStatus();
  }
}

export function startSyncMonitor(snapshot: CriticalSnapshotV1, snapshotPublicKey?: string): () => void {
  if (!browser) return () => undefined;
  activeHouseholdId = snapshot.householdId;
  const update = () => void refreshSyncStatus();
  // Reconexión honesta: si el flush disparado por `online` aplicó cambios en
  // el servidor, se re-ejecutan los loads (invalidateAll) para que la UI
  // refleje lo sincronizado sin intervención; `lastFlushAt` permite además a
  // cada página limpiar su nota «guardado en este dispositivo».
  const flush = () =>
    void flushOutbox().then((acks) => {
      if (acks && acksApplied(acks)) return invalidateAll();
    });
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
