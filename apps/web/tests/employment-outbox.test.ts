import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import { commandEnvelopeSchema } from '@casa-clara/contracts/schemas';

import {
  openSettlement,
  recordPayment,
  registerExtra,
  resolveExpense,
  submitWeek
} from '../src/lib/employment/commands';
import {
  describeEmploymentCommand,
  describeErrorCode,
  retryEnvelope,
  triageableEmploymentRecords
} from '../src/lib/employment/outbox';
import {
  discardOutboxRecord,
  listOutbox,
  queueOutbox,
  updateOutboxStatuses
} from '../src/lib/offline/idb';
import { createOutboxRecord } from '../src/lib/offline/schema';
import { FIXTURE_HOUSEHOLD as HOUSEHOLD, envelopeFixture } from './helpers';

const AGREEMENT = '12000000-0000-4000-8000-000000000001';
const ENTITY = '12400000-0000-4000-8000-000000000005';

function databaseName(label: string): string {
  return `casa-clara-outbox-${label}-${crypto.randomUUID()}`;
}

describe('descripciones humanas de comandos del expediente', () => {
  it('mapea aggregateType + action a texto legible', () => {
    expect(
      describeEmploymentCommand(
        submitWeek({
          householdId: HOUSEHOLD,
          agreementId: AGREEMENT,
          weekStartsOn: '2026-08-03',
          entries: [{ workedOn: '2026-08-03', regularMinutes: 480 }]
        })
      )
    ).toBe('Días trabajados de la semana del 3 ago 2026');
    expect(
      describeEmploymentCommand(
        registerExtra({
          householdId: HOUSEHOLD,
          agreementId: AGREEMENT,
          kind: 'overtime',
          workedOn: '2026-08-05',
          durationMinutes: 90
        })
      )
    ).toBe('Registro de jornada extra del 5 ago 2026');
    expect(
      describeEmploymentCommand(
        openSettlement({
          householdId: HOUSEHOLD,
          agreementId: AGREEMENT,
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          dueOn: '2026-08-31'
        })
      )
    ).toBe('Apertura de la cuenta del mes (2026-08)');
    expect(
      describeEmploymentCommand(
        recordPayment({
          householdId: HOUSEHOLD,
          settlementId: ENTITY,
          amountCents: '72500',
          method: 'bizum',
          valueOn: '2026-08-07'
        })
      )
    ).toBe('Registro de pago del 7 ago 2026');
    expect(
      describeEmploymentCommand(
        resolveExpense({
          householdId: HOUSEHOLD,
          expenseId: ENTITY,
          resolution: 'approved',
          reason: 'Con justificante'
        })
      )
    ).toBe('Decisión sobre un gasto');
    // El fixture genérico es un gasto sin action: descripción de envío.
    expect(describeEmploymentCommand(envelopeFixture(crypto.randomUUID(), '2026-08-07T08:00:00.000Z'))).toBe(
      'Gasto enviado'
    );
  });

  it('traduce códigos de error conocidos y conserva los desconocidos', () => {
    expect(describeErrorCode('week_already_reported')).toBe('La semana ya fue enviada');
    expect(describeErrorCode('not_allowed')).toBe('Tu rol no permite esta acción');
    expect(describeErrorCode('algo_nuevo')).toBe('algo_nuevo');
    expect(describeErrorCode(undefined)).toBeNull();
  });
});

describe('triaje del outbox: conflict/rejected con código de error', () => {
  it('updateOutboxStatuses guarda el lastErrorCode cuando el ACK lo trae', async () => {
    const name = databaseName('codes');
    const record = createOutboxRecord(envelopeFixture('33333333-0000-4000-8000-000000000001', '2026-08-07T08:00:00.000Z'));
    await queueOutbox(record, name);
    await updateOutboxStatuses([{ id: record.id, errorCode: 'week_already_reported' }], 'rejected', name);
    const [stored] = await listOutbox(HOUSEHOLD, name);
    expect(stored).toMatchObject({ status: 'rejected', lastErrorCode: 'week_already_reported' });

    // La firma antigua (solo ids) sigue funcionando y no borra el código previo.
    await updateOutboxStatuses([record.id], 'conflict', name);
    const [again] = await listOutbox(HOUSEHOLD, name);
    expect(again).toMatchObject({ status: 'conflict', lastErrorCode: 'week_already_reported' });
  });

  it('solo lista registros conflict/rejected de agregados del expediente', async () => {
    const pending = createOutboxRecord(envelopeFixture('33333333-0000-4000-8000-000000000002', '2026-08-07T08:00:00.000Z'));
    const rejected = createOutboxRecord(envelopeFixture('33333333-0000-4000-8000-000000000003', '2026-08-07T08:01:00.000Z'), {
      status: 'rejected'
    });
    const wiki = createOutboxRecord(
      {
        ...envelopeFixture('33333333-0000-4000-8000-000000000004', '2026-08-07T08:02:00.000Z'),
        aggregateType: 'wiki_page'
      },
      { status: 'conflict' }
    );
    expect(triageableEmploymentRecords([pending, rejected, wiki]).map((record) => record.id)).toEqual([
      rejected.id
    ]);
  });

  it('discardOutboxRecord elimina el registro elegido y deja el resto intacto', async () => {
    const name = databaseName('discard');
    const keep = createOutboxRecord(envelopeFixture('33333333-0000-4000-8000-000000000005', '2026-08-07T08:00:00.000Z'));
    const drop = createOutboxRecord(envelopeFixture('33333333-0000-4000-8000-000000000006', '2026-08-07T08:01:00.000Z'), {
      status: 'conflict'
    });
    await queueOutbox(keep, name);
    await queueOutbox(drop, name);
    await discardOutboxRecord(drop.id, name);
    expect((await listOutbox(HOUSEHOLD, name)).map((record) => record.id)).toEqual([keep.id]);
  });

  it('reintentar = copia con operationId NUEVO que sustituye al registro viejo', async () => {
    const name = databaseName('retry');
    const original = createOutboxRecord(
      envelopeFixture('33333333-0000-4000-8000-000000000007', '2026-08-07T08:00:00.000Z'),
      { status: 'conflict' }
    );
    await queueOutbox(original, name);

    const copy = retryEnvelope(original.envelope);
    expect(copy.operationId).not.toBe(original.envelope.operationId);
    expect(copy).toEqual({ ...original.envelope, operationId: copy.operationId });
    expect(commandEnvelopeSchema.parse(copy)).toBeTruthy();

    await discardOutboxRecord(original.id, name);
    await queueOutbox(createOutboxRecord(copy), name);

    const records = await listOutbox(HOUSEHOLD, name);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: copy.operationId, status: 'pending' });
    expect(records[0]!.envelope.payload).toEqual(original.envelope.payload);
  });
});
