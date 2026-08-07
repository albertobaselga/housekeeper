export const OFFLINE_DB_NAME = 'casa-clara-web';
export const OFFLINE_DB_VERSION = 1;

export const OFFLINE_STORES = {
  criticalSnapshots: 'criticalSnapshots',
  outbox: 'outbox',
  blobs: 'blobs'
} as const;

export interface CriticalSnapshotPayload {
  today: {
    dateLabel: string;
    nextEvent: string;
    menu: string;
  };
  emergencyContacts: Array<{
    id: string;
    name: string;
    phone: string;
    kind: string;
  }>;
  safeNotes: string[];
}

export interface CriticalSnapshotV1 {
  schemaVersion: 1;
  householdId: string;
  revision: string;
  savedAt: string;
  validUntil: string;
  payload: CriticalSnapshotPayload;
}

export interface OutboxRecord {
  id: string;
  householdId: string;
  idempotencyKey: string;
  operation: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
  status: 'pending' | 'conflict';
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
    candidate.schemaVersion === 1 &&
    typeof candidate.householdId === 'string' &&
    candidate.householdId.length > 0 &&
    typeof candidate.revision === 'string' &&
    typeof candidate.savedAt === 'string' &&
    typeof candidate.validUntil === 'string' &&
    Boolean(candidate.payload && typeof candidate.payload === 'object')
  );
}

export function createOutboxRecord(
  input: Omit<OutboxRecord, 'createdAt' | 'attempts' | 'status'> &
    Partial<Pick<OutboxRecord, 'createdAt' | 'attempts' | 'status'>>
): OutboxRecord {
  if (!input.id.trim() || !input.householdId.trim() || !input.idempotencyKey.trim()) {
    throw new TypeError('Outbox records require stable identifiers');
  }
  return {
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
    attempts: input.attempts ?? 0,
    status: input.status ?? 'pending'
  };
}
