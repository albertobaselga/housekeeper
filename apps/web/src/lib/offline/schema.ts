import type { AggregateType, CommandEnvelopeV1, CriticalSnapshotV1 } from '@housekeeper/contracts';

export type { CommandEnvelopeV1, CriticalSnapshotV1 };

export function createCommandEnvelope(input: {
  householdId: string;
  aggregateType: AggregateType;
  payload: unknown;
  operationId?: string;
  aggregateId?: string | null;
  baseRevision?: number | null;
  occurredAt?: string;
}): CommandEnvelopeV1 {
  return {
    apiVersion: 1,
    operationId: input.operationId ?? crypto.randomUUID(),
    householdId: input.householdId,
    schemaVersion: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId ?? null,
    baseRevision: input.baseRevision ?? null,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    payload: input.payload
  };
}

export const OFFLINE_DB_NAME = 'housekeeper-web';
export const OFFLINE_DB_VERSION = 1;

export const OFFLINE_STORES = {
  criticalSnapshots: 'criticalSnapshots',
  outbox: 'outbox',
  blobs: 'blobs'
} as const;

export type OutboxStatus = 'pending' | 'conflict' | 'rejected';

/**
 * Foto capturada SIN conexión que este comando debe llevar enlazada. El
 * envelope no puede viajar con el identificador local (el contrato solo acepta
 * el del objeto ya subido), así que la referencia vive en el registro del
 * outbox: al recuperar la red la foto se sube primero y el identificador real
 * se escribe en `payloadField` antes de enviar el comando.
 *
 * Mientras esta marca esté puesta el comando NO sale, para que jamás quede un
 * gasto en el servidor con su justificante huérfano. La foto solo se borra del
 * dispositivo tras subirse (y entonces la marca se retira), así que la espera
 * siempre termina; si el almacén local se corrompiera y la foto desapareciera
 * sin subir, el comando quedaría esperando y se descarta desde el triaje.
 *
 * La espera tampoco puede ser eterna cuando la subida falla una y otra vez
 * (almacén caído o sin credenciales, fichero rechazado): tras
 * MAX_BLOB_UPLOAD_ATTEMPTS intentos —o al primer rechazo definitivo— el
 * registro pasa a `rejected` con `lastErrorCode` y aparece en el triaje con un
 * mensaje veraz, en vez de quedarse «pendiente» para siempre sin que nadie lo
 * note (ver blob-link.ts).
 */
export interface OutboxPendingBlob {
  /** Clave del blob en el almacén local de fotos. */
  id: string;
  /** Campo del payload donde va el identificador del objeto ya subido. */
  payloadField: string;
}

export interface OutboxRecord {
  /** Igual al operationId del envelope: clave idempotente extremo a extremo. */
  id: string;
  householdId: string;
  envelope: CommandEnvelopeV1;
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
  /** Código de error del último ACK conflict/rejected del servidor, si lo hubo. */
  lastErrorCode?: string;
  /** Foto local pendiente de subir y enlazar; ausente = nada que esperar. */
  pendingBlob?: OutboxPendingBlob;
  /** Intentos fallidos de subir `pendingBlob`; alimenta el corte del triaje. */
  blobAttempts?: number;
}

/**
 * Intentos de subida de una foto pendiente antes de dar el comando por
 * bloqueado y mandarlo al triaje. Cinco pasadas de flush cubren de sobra un
 * corte transitorio del almacén sin dejar el gasto atrapado.
 */
export const MAX_BLOB_UPLOAD_ATTEMPTS = 5;

export interface OfflineBlobRecord {
  id: string;
  householdId: string;
  contentType: string;
  size: number;
  createdAt: string;
  blob: Blob;
}

export function isCriticalSnapshotV1(value: unknown): value is CriticalSnapshotV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CriticalSnapshotV1>;
  return (
    candidate.apiVersion === 1 &&
    candidate.schemaVersion === 1 &&
    typeof candidate.householdId === 'string' &&
    candidate.householdId.length > 0 &&
    typeof candidate.membershipId === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.etag === 'string' &&
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.expiresAt === 'string' &&
    typeof candidate.signature === 'string' &&
    Boolean(candidate.payload && typeof candidate.payload === 'object')
  );
}

export function createOutboxRecord(
  envelope: CommandEnvelopeV1,
  overrides: Partial<
    Pick<OutboxRecord, 'createdAt' | 'attempts' | 'status' | 'pendingBlob' | 'blobAttempts'>
  > = {}
): OutboxRecord {
  if (!envelope.operationId.trim() || !envelope.householdId.trim()) {
    throw new TypeError('Outbox records require stable identifiers');
  }
  return {
    id: envelope.operationId,
    householdId: envelope.householdId,
    envelope,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    attempts: overrides.attempts ?? 0,
    status: overrides.status ?? 'pending',
    ...(overrides.pendingBlob ? { pendingBlob: overrides.pendingBlob } : {}),
    ...(overrides.blobAttempts ? { blobAttempts: overrides.blobAttempts } : {})
  };
}
