import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código de `commands.ts` que llega al navegador no importa zod jamás.
import {
  commandEnvelopeSchema,
  expenseResolvePayloadSchema,
  expenseSubmitPayloadSchema,
  extraWorkAcceptPayloadSchema,
  extraWorkMarkPerformedPayloadSchema,
  extraWorkRegisterPayloadSchema,
  extraWorkResolvePayloadSchema,
  manualAdjustmentRecordPayloadSchema,
  manualAdjustmentVoidPayloadSchema,
  paymentRecordPayloadSchema,
  settlementClosePayloadSchema,
  settlementOpenPayloadSchema,
  settlementReceiptConfirmPayloadSchema,
  weeklyReportSubmitPayloadSchema
} from '@casa-clara/contracts/schemas';

import {
  acceptExtra,
  closeSettlement,
  confirmReceipt,
  markExtraPerformed,
  openSettlement,
  parseEuroInput,
  queueEmploymentCommand,
  recordManualAdjustment,
  recordPayment,
  registerExtra,
  resolveExpense,
  resolveExtra,
  submitExpense,
  submitWeek,
  voidManualAdjustment
} from '../src/lib/employment/commands';
import { listOutbox } from '../src/lib/offline/idb';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const AGREEMENT = '12000000-0000-4000-8000-000000000001';
const ENTITY = '12400000-0000-4000-8000-000000000005';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000001',
  occurredAt: '2026-08-07T10:00:00.000Z'
};

describe('constructores de envelopes del expediente laboral', () => {
  it('submitWeek produce un envelope time_entry válido', () => {
    const envelope = submitWeek(
      {
        householdId: HOUSEHOLD,
        agreementId: AGREEMENT,
        weekStartsOn: '2026-08-03',
        entries: [{ workedOn: '2026-08-03', startedAt: '09:00', endedAt: '17:00', regularMinutes: 480 }]
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('time_entry');
    expect(envelope.aggregateId).toBeNull();
    expect(envelope.operationId).toBe(OPTIONS.operationId);
    expect(envelope.occurredAt).toBe(OPTIONS.occurredAt);
    expect(weeklyReportSubmitPayloadSchema.parse(envelope.payload)).toBeTruthy();
  });

  it('registerExtra valida contra el payload congelado y omite la nota vacía', () => {
    const envelope = registerExtra(
      {
        householdId: HOUSEHOLD,
        agreementId: AGREEMENT,
        kind: 'worked_rest_day',
        workedOn: '2026-08-09',
        durationMinutes: 480,
        note: '  '
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('extra_work');
    expect(extraWorkRegisterPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'register',
      agreementId: AGREEMENT,
      kind: 'worked_rest_day',
      workedOn: '2026-08-09',
      durationMinutes: 480
    });
  });

  it('acceptExtra y markExtraPerformed anclan el aggregateId al evento', () => {
    const accept = acceptExtra({ householdId: HOUSEHOLD, extraWorkEventId: ENTITY }, OPTIONS);
    expect(commandEnvelopeSchema.parse(accept)).toBeTruthy();
    expect(accept.aggregateId).toBe(ENTITY);
    expect(extraWorkAcceptPayloadSchema.parse(accept.payload)).toBeTruthy();

    const performed = markExtraPerformed({ householdId: HOUSEHOLD, extraWorkEventId: ENTITY }, OPTIONS);
    expect(commandEnvelopeSchema.parse(performed)).toBeTruthy();
    expect(performed.aggregateId).toBe(ENTITY);
    expect(extraWorkMarkPerformedPayloadSchema.parse(performed.payload)).toBeTruthy();
  });

  it('resolveExtra exige motivo y resolución del contrato', () => {
    const envelope = resolveExtra(
      { householdId: HOUSEHOLD, extraWorkEventId: ENTITY, resolution: 'time_off', reason: ' Descanso pactado ' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    const payload = extraWorkResolvePayloadSchema.parse(envelope.payload);
    expect(payload.resolution).toBe('time_off');
    expect(payload.reason).toBe('Descanso pactado');
  });

  it('openSettlement y closeSettlement cumplen el contrato de settlement', () => {
    const open = openSettlement(
      {
        householdId: HOUSEHOLD,
        agreementId: AGREEMENT,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        dueOn: '2026-08-31'
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(open)).toBeTruthy();
    expect(open.aggregateType).toBe('settlement');
    expect(settlementOpenPayloadSchema.parse(open.payload)).toBeTruthy();

    const close = closeSettlement({ householdId: HOUSEHOLD, settlementId: ENTITY }, OPTIONS);
    expect(commandEnvelopeSchema.parse(close)).toBeTruthy();
    expect(close.aggregateId).toBe(ENTITY);
    expect(settlementClosePayloadSchema.parse(close.payload)).toBeTruthy();
  });

  it('recordPayment viaja como céntimos en cadena, nunca floats', () => {
    const envelope = recordPayment(
      {
        householdId: HOUSEHOLD,
        settlementId: ENTITY,
        amountCents: '72500',
        method: 'bizum',
        valueOn: '2026-08-07',
        reference: ''
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('payment');
    const payload = paymentRecordPayloadSchema.parse(envelope.payload);
    expect(payload.amountCents).toBe('72500');
    expect(payload).not.toHaveProperty('reference');
  });

  it('confirmReceipt admite nota opcional', () => {
    const withNote = confirmReceipt(
      { householdId: HOUSEHOLD, settlementId: ENTITY, note: 'Recibido completo' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(withNote)).toBeTruthy();
    expect(settlementReceiptConfirmPayloadSchema.parse(withNote.payload).note).toBe('Recibido completo');

    const bare = confirmReceipt({ householdId: HOUSEHOLD, settlementId: ENTITY }, OPTIONS);
    expect(settlementReceiptConfirmPayloadSchema.parse(bare.payload)).not.toHaveProperty('note');
  });

  it('submitExpense y resolveExpense cumplen los payloads de gasto', () => {
    const submit = submitExpense(
      {
        householdId: HOUSEHOLD,
        agreementId: AGREEMENT,
        incurredOn: '2026-08-05',
        description: ' Farmacia ',
        amountCents: '1250'
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(submit)).toBeTruthy();
    expect(submit.aggregateType).toBe('expense');
    const submitPayload = expenseSubmitPayloadSchema.parse(submit.payload);
    expect(submitPayload.description).toBe('Farmacia');
    expect(submitPayload.amountCents).toBe('1250');

    const resolve = resolveExpense(
      { householdId: HOUSEHOLD, expenseId: ENTITY, resolution: 'rejected', reason: 'Sin justificante' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(resolve)).toBeTruthy();
    expect(resolve.aggregateId).toBe(ENTITY);
    expect(expenseResolvePayloadSchema.parse(resolve.payload).resolution).toBe('rejected');
  });

  it('genera operationId y occurredAt válidos cuando no se inyectan', () => {
    const envelope = acceptExtra({ householdId: HOUSEHOLD, extraWorkEventId: ENTITY });
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
  });
});

describe('conceptos apuntados a mano', () => {
  it('el signo es una decisión aparte del importe y viaja ya aplicado', () => {
    const suma = recordManualAdjustment({
      householdId: HOUSEHOLD,
      agreementId: AGREEMENT,
      period: '2026-09',
      label: '  Gratificación de verano  ',
      reason: '  Acordada el 2 de septiembre  ',
      amountCents: '15000',
      direction: 'adds',
      addsToPay: true
    });
    expect(commandEnvelopeSchema.parse(suma).aggregateType).toBe('manual_adjustment');
    expect(manualAdjustmentRecordPayloadSchema.parse(suma.payload)).toEqual({
      action: 'record',
      agreementId: AGREEMENT,
      period: '2026-09',
      // Sin los espacios con los que se teclea: la etiqueta es un título.
      label: 'Gratificación de verano',
      reason: 'Acordada el 2 de septiembre',
      amountCents: '15000',
      addsToPay: true
    });

    const resta = recordManualAdjustment({
      householdId: HOUSEHOLD,
      agreementId: AGREEMENT,
      period: '2026-09',
      label: 'Descuento acordado',
      reason: 'Rotura de la vitrocerámica, a medias',
      // El formulario nunca manda un menos: manda la magnitud y la dirección.
      amountCents: '5000',
      direction: 'subtracts',
      addsToPay: true
    });
    expect(manualAdjustmentRecordPayloadSchema.parse(resta.payload)).toMatchObject({
      amountCents: '-5000'
    });
  });

  it('el que no es dinero para ella viaja con addsToPay en falso', () => {
    const envelope = recordManualAdjustment({
      householdId: HOUSEHOLD,
      agreementId: AGREEMENT,
      period: '2026-09',
      label: 'Anticipo devuelto en mano',
      reason: 'Devolvió 200 € en efectivo',
      amountCents: '20000',
      direction: 'subtracts',
      addsToPay: false
    });
    expect(manualAdjustmentRecordPayloadSchema.parse(envelope.payload)).toMatchObject({
      amountCents: '-20000',
      addsToPay: false
    });
  });

  it('anular nombra el concepto en el aggregateId y exige motivo', () => {
    const envelope = voidManualAdjustment({
      householdId: HOUSEHOLD,
      manualAdjustmentId: ENTITY,
      reason: '  Se apuntó dos veces  '
    });
    expect(commandEnvelopeSchema.parse(envelope).aggregateId).toBe(ENTITY);
    expect(manualAdjustmentVoidPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'void',
      manualAdjustmentId: ENTITY,
      reason: 'Se apuntó dos veces'
    });
  });

  it('el esquema rechaza el importe cero: no es un concepto, es un apunte a medias', () => {
    const envelope = recordManualAdjustment({
      householdId: HOUSEHOLD,
      agreementId: AGREEMENT,
      period: '2026-09',
      label: 'Nada',
      reason: 'Nada',
      amountCents: '0',
      direction: 'adds',
      addsToPay: true
    });
    expect(manualAdjustmentRecordPayloadSchema.safeParse(envelope.payload).success).toBe(false);
  });
});

describe('parseEuroInput: euros a céntimos sin floats', () => {
  it('acepta enteros, coma o punto decimal y separador de millar', () => {
    expect(parseEuroInput('12')).toBe('1200');
    expect(parseEuroInput('12,5')).toBe('1250');
    expect(parseEuroInput('12.50')).toBe('1250');
    expect(parseEuroInput('1.453,30')).toBe('145330');
    expect(parseEuroInput(' 12,50 € ')).toBe('1250');
    // Por encima de 2^53 céntimos seguiría siendo exacto.
    expect(parseEuroInput('90071992547409931,12')).toBe('9007199254740993112');
  });

  it('rechaza importes vacíos, negativos, cero o con más de dos decimales', () => {
    expect(parseEuroInput('')).toBeNull();
    expect(parseEuroInput('abc')).toBeNull();
    expect(parseEuroInput('-3')).toBeNull();
    expect(parseEuroInput('0')).toBeNull();
    expect(parseEuroInput('0,00')).toBeNull();
    expect(parseEuroInput('12,345')).toBeNull();
    expect(parseEuroInput('1,453.30')).toBeNull();
  });
});

describe('queueEmploymentCommand', () => {
  it('persiste primero en el outbox y queda pendiente sin navegador', async () => {
    // En node `browser` es false: flushOutbox no envía nada y el comando debe
    // quedarse en el outbox (offline-first) esperando al flush del navegador.
    const householdId = crypto.randomUUID();
    const envelope = acceptExtra({ householdId, extraWorkEventId: ENTITY });
    const outcome = await queueEmploymentCommand(envelope);
    expect(outcome).toBe('queued');
    const records = await listOutbox(householdId);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(envelope.operationId);
    expect(records[0]!.status).toBe('pending');
    expect(records[0]!.envelope).toEqual(envelope);
  });
});
