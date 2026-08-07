import type { AggregateType, CommandEnvelopeV1, CriticalSnapshotV1 } from '@casa-clara/contracts';

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

export const OFFLINE_DB_NAME = 'casa-clara-web';
export const OFFLINE_DB_VERSION = 1;

export const OFFLINE_STORES = {
  criticalSnapshots: 'criticalSnapshots',
  outbox: 'outbox',
  blobs: 'blobs'
} as const;

export type OutboxStatus = 'pending' | 'conflict' | 'rejected';

export interface OutboxRecord {
  /** Igual al operationId del envelope: clave idempotente extremo a extremo. */
  id: string;
  householdId: string;
  envelope: CommandEnvelopeV1;
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
}

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
  overrides: Partial<Pick<OutboxRecord, 'createdAt' | 'attempts' | 'status'>> = {}
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
    status: overrides.status ?? 'pending'
  };
}
