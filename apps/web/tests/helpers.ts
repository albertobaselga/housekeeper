import type { CommandEnvelopeV1, CriticalSnapshotV1 } from '../src/lib/offline/schema';

export const FIXTURE_HOUSEHOLD = '10000000-0000-4000-8000-000000000001';

export function snapshotFixture(): CriticalSnapshotV1 {
  return {
    apiVersion: 1,
    schemaVersion: 1,
    householdId: FIXTURE_HOUSEHOLD,
    membershipId: '11000000-0000-4000-8000-000000000003',
    version: 'test-r1',
    etag: 'a'.repeat(64),
    cursor: '2026-08-07T08:00:00.000Z',
    generatedAt: '2026-08-07T08:00:00.000Z',
    expiresAt: '2026-08-08T08:00:00.000Z',
    signature: 'unsigned-test',
    payload: {
      emergency: [{ id: 'note', title: 'Nota', body: 'Dato sintético' }],
      contacts: [{ id: '112', name: 'Emergencias', phone: '112', kind: 'emergency' }],
      dietaryFlags: [],
      today: { dateLabel: 'Viernes', nextEvent: '16:45 · Colegio', menu: 'Lentejas' },
      wikiPages: []
    }
  };
}

export function envelopeFixture(operationId: string, occurredAt: string): CommandEnvelopeV1 {
  return {
    apiVersion: 1,
    operationId,
    householdId: FIXTURE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType: 'expense',
    aggregateId: null,
    baseRevision: null,
    occurredAt,
    payload: {
      agreementId: '12000000-0000-4000-8000-000000000001',
      incurredOn: '2026-08-05',
      description: 'Gasto sintético',
      amountCents: '1275'
    }
  };
}
