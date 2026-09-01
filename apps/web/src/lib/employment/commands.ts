import type {
  AgreementSetVacationEntitlementPayloadV1,
  CommandEnvelopeV1,
  ExpenseResolvePayloadV1,
  ExpenseSubmitPayloadV1,
  ExtraWorkAcceptPayloadV1,
  ExtraWorkMarkPerformedPayloadV1,
  ExtraWorkRegisterPayloadV1,
  ExtraWorkResolvePayloadV1,
  ManualAdjustmentRecordPayloadV1,
  ManualAdjustmentVoidPayloadV1,
  PaymentRecordPayloadV1,
  SettlementClosePayloadV1,
  SettlementOpenPayloadV1,
  SettlementReceiptConfirmPayloadV1,
  VacationCarryOverPayloadV1,
  VacationCompensateCarryoverPayloadV1,
  VacationRecordPayloadV1,
  VacationRejectCarryoverPayloadV1,
  VacationVoidPayloadV1
} from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';
import { queueCommand, type QueueOutcome } from '$lib/offline/queue-command';

/**
 * Constructores puros de envelopes para las acciones del expediente laboral.
 * Cada uno produce un CommandEnvelopeV1 con el payload CONGELADO del contrato;
 * la validación zod vive en los tests (y en el servidor), nunca en el bundle
 * del navegador. `operationId`/`occurredAt` son inyectables para tests
 * deterministas.
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Convierte una cadena decimal en euros ("12", "12,5", "1.453,30") a céntimos
 * sin pasar por floats. Devuelve null si la entrada no es un importe positivo.
 */
export function parseEuroInput(value: string): string | null {
  const normalized = value.trim().replace(/\s|€/g, '');
  // Acepta coma o punto decimal; los separadores de millar "1.453,30" solo con coma decimal.
  const match = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:[.,](\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const units = match[1]!.replace(/\./g, '');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = BigInt(units) * 100n + BigInt(fraction === '' ? '0' : fraction);
  if (cents <= 0n) return null;
  return cents.toString();
}

export function registerExtra(
  input: {
    householdId: string;
    agreementId: string;
    /** Concepto del catálogo; el servidor deriva de él la tarifa y `kind`. */
    extraWorkTypeId?: string;
    kind: ExtraWorkRegisterPayloadV1['kind'];
    workedOn: string;
    durationMinutes: number;
    note?: string;
    /**
     * Compensación decidida en el mismo gesto, solo para quien administra: se
     * apunta una jornada que YA ocurrió y se cierra ahí. El importe lo sigue
     * congelando el concepto del catálogo; aquí solo viaja la decisión y el
     * motivo. Si el motivo llega vacío no se manda nada: el contrato lo exige y
     * el hecho se apunta como pendiente, que es lo honesto.
     */
    resolveNow?: {
      resolution: NonNullable<ExtraWorkRegisterPayloadV1['resolveNow']>['resolution'];
      reason: string;
    };
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ExtraWorkRegisterPayloadV1> {
  const note = trimmedOrUndefined(input.note);
  const reason = trimmedOrUndefined(input.resolveNow?.reason);
  const resolveNow =
    input.resolveNow && reason
      ? { resolveNow: { resolution: input.resolveNow.resolution, reason } }
      : {};
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'extra_work',
    payload: {
      action: 'register',
      agreementId: input.agreementId,
      ...(input.extraWorkTypeId ? { extraWorkTypeId: input.extraWorkTypeId } : {}),
      kind: input.kind,
      workedOn: input.workedOn,
      durationMinutes: input.durationMinutes,
      ...(note ? { note } : {}),
      ...resolveNow
    } satisfies ExtraWorkRegisterPayloadV1
  }) as CommandEnvelopeV1<ExtraWorkRegisterPayloadV1>;
}

export function acceptExtra(
  input: { householdId: string; extraWorkEventId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ExtraWorkAcceptPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'extra_work',
    aggregateId: input.extraWorkEventId,
    payload: {
      action: 'accept',
      extraWorkEventId: input.extraWorkEventId
    } satisfies ExtraWorkAcceptPayloadV1
  }) as CommandEnvelopeV1<ExtraWorkAcceptPayloadV1>;
}

export function markExtraPerformed(
  input: { householdId: string; extraWorkEventId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ExtraWorkMarkPerformedPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'extra_work',
    aggregateId: input.extraWorkEventId,
    payload: {
      action: 'mark_performed',
      extraWorkEventId: input.extraWorkEventId
    } satisfies ExtraWorkMarkPerformedPayloadV1
  }) as CommandEnvelopeV1<ExtraWorkMarkPerformedPayloadV1>;
}

export function resolveExtra(
  input: {
    householdId: string;
    extraWorkEventId: string;
    resolution: ExtraWorkResolvePayloadV1['resolution'];
    reason: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ExtraWorkResolvePayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'extra_work',
    aggregateId: input.extraWorkEventId,
    payload: {
      action: 'resolve',
      extraWorkEventId: input.extraWorkEventId,
      resolution: input.resolution,
      reason: input.reason.trim()
    } satisfies ExtraWorkResolvePayloadV1
  }) as CommandEnvelopeV1<ExtraWorkResolvePayloadV1>;
}

export function openSettlement(
  input: {
    householdId: string;
    agreementId: string;
    periodStart: string;
    periodEnd: string;
    dueOn: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<SettlementOpenPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'settlement',
    payload: {
      action: 'open',
      agreementId: input.agreementId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      dueOn: input.dueOn
    } satisfies SettlementOpenPayloadV1
  }) as CommandEnvelopeV1<SettlementOpenPayloadV1>;
}

export function closeSettlement(
  input: { householdId: string; settlementId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<SettlementClosePayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'settlement',
    aggregateId: input.settlementId,
    payload: {
      action: 'close',
      settlementId: input.settlementId
    } satisfies SettlementClosePayloadV1
  }) as CommandEnvelopeV1<SettlementClosePayloadV1>;
}

export function recordPayment(
  input: {
    householdId: string;
    settlementId: string;
    amountCents: string;
    method: PaymentRecordPayloadV1['method'];
    valueOn: string;
    reference?: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<PaymentRecordPayloadV1> {
  const reference = trimmedOrUndefined(input.reference);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'payment',
    payload: {
      settlementId: input.settlementId,
      amountCents: input.amountCents,
      method: input.method,
      valueOn: input.valueOn,
      ...(reference ? { reference } : {})
    } satisfies PaymentRecordPayloadV1
  }) as CommandEnvelopeV1<PaymentRecordPayloadV1>;
}

export function confirmReceipt(
  input: { householdId: string; settlementId: string; note?: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<SettlementReceiptConfirmPayloadV1> {
  const note = trimmedOrUndefined(input.note);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'settlement',
    aggregateId: input.settlementId,
    payload: {
      action: 'confirm_receipt',
      settlementId: input.settlementId,
      ...(note ? { note } : {})
    } satisfies SettlementReceiptConfirmPayloadV1
  }) as CommandEnvelopeV1<SettlementReceiptConfirmPayloadV1>;
}

export function submitExpense(
  input: {
    householdId: string;
    agreementId: string;
    incurredOn: string;
    description: string;
    amountCents: string;
    /** storageObjectId del justificante ya subido (opcional en el contrato). */
    receiptStorageObjectId?: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ExpenseSubmitPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'expense',
    payload: {
      agreementId: input.agreementId,
      incurredOn: input.incurredOn,
      description: input.description.trim(),
      amountCents: input.amountCents,
      ...(input.receiptStorageObjectId ? { receiptStorageObjectId: input.receiptStorageObjectId } : {})
    } satisfies ExpenseSubmitPayloadV1
  }) as CommandEnvelopeV1<ExpenseSubmitPayloadV1>;
}

export function resolveExpense(
  input: {
    householdId: string;
    expenseId: string;
    resolution: ExpenseResolvePayloadV1['resolution'];
    reason: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ExpenseResolvePayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'expense',
    aggregateId: input.expenseId,
    payload: {
      action: 'resolve',
      expenseId: input.expenseId,
      resolution: input.resolution,
      reason: input.reason.trim()
    } satisfies ExpenseResolvePayloadV1
  }) as CommandEnvelopeV1<ExpenseResolvePayloadV1>;
}

export function recordVacation(
  input: {
    householdId: string;
    agreementId: string;
    startsOn: string;
    endsOn: string;
    note?: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<VacationRecordPayloadV1> {
  const note = trimmedOrUndefined(input.note);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'leave_request',
    payload: {
      action: 'record',
      agreementId: input.agreementId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      ...(note ? { note } : {})
    } satisfies VacationRecordPayloadV1
  }) as CommandEnvelopeV1<VacationRecordPayloadV1>;
}

export function voidVacation(
  input: { householdId: string; vacationPeriodId: string; reason: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<VacationVoidPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'leave_request',
    aggregateId: input.vacationPeriodId,
    payload: {
      action: 'void',
      vacationPeriodId: input.vacationPeriodId,
      reason: input.reason.trim()
    } satisfies VacationVoidPayloadV1
  }) as CommandEnvelopeV1<VacationVoidPayloadV1>;
}

/**
 * Las tres salidas de un año de contrato que se cerró con días sin disfrutar.
 *
 * Ninguna manda los días ni el importe: el servidor los recalcula al decidir y
 * los congela en la fila. Aquí sólo viaja QUÉ año y QUÉ se decide, que es lo
 * único que pone la persona.
 *
 * `aggregateId` es el acuerdo y no el arrastre, porque el arrastre todavía no
 * existe: la fila se escribe justo al decidir.
 */
export function carryOverVacationDays(
  input: { householdId: string; agreementId: string; sourceYearIndex: number },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<VacationCarryOverPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'leave_request',
    aggregateId: input.agreementId,
    payload: {
      action: 'carry_over',
      agreementId: input.agreementId,
      sourceYearIndex: input.sourceYearIndex
    } satisfies VacationCarryOverPayloadV1
  }) as CommandEnvelopeV1<VacationCarryOverPayloadV1>;
}

/**
 * Pagar los días. `period` es el mes que se PIDE; si ya está cerrado, el
 * servidor imputa el concepto al primer mes abierto y lo deja dicho en la fila,
 * igual que cualquier concepto. Aquí no se adivina, porque el navegador no sabe
 * (ni puede saber sin carreras) qué meses están cerrados en este instante.
 */
export function compensateVacationCarryover(
  input: {
    householdId: string;
    agreementId: string;
    sourceYearIndex: number;
    period: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<VacationCompensateCarryoverPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'leave_request',
    aggregateId: input.agreementId,
    payload: {
      action: 'compensate_carryover',
      agreementId: input.agreementId,
      sourceYearIndex: input.sourceYearIndex,
      period: input.period
    } satisfies VacationCompensateCarryoverPayloadV1
  }) as CommandEnvelopeV1<VacationCompensateCarryoverPayloadV1>;
}

export function rejectVacationCarryover(
  input: {
    householdId: string;
    agreementId: string;
    sourceYearIndex: number;
    reason: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<VacationRejectCarryoverPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'leave_request',
    aggregateId: input.agreementId,
    payload: {
      action: 'reject_carryover',
      agreementId: input.agreementId,
      sourceYearIndex: input.sourceYearIndex,
      reason: input.reason.trim()
    } satisfies VacationRejectCarryoverPayloadV1
  }) as CommandEnvelopeV1<VacationRejectCarryoverPayloadV1>;
}

/**
 * Concepto apuntado a mano. El importe llega en céntimos POSITIVOS desde el
 * formulario y el signo es una decisión aparte («suma» / «resta»), porque un
 * campo de dinero con un menos delante se teclea mal y se lee peor.
 *
 * El `period` que se envía es el que se PIDE. Si ese mes ya está cerrado el
 * servidor imputa el concepto al primer mes abierto posterior y guarda la nota
 * que lo explica: aquí no se adivina, porque el cliente no sabe (ni puede
 * saber sin carreras) qué meses están cerrados en el instante de escribir.
 */
export function recordManualAdjustment(
  input: {
    householdId: string;
    agreementId: string;
    period: string;
    label: string;
    reason: string;
    /** Céntimos en positivo; `direction` decide el signo que viaja. */
    amountCents: string;
    direction: 'adds' | 'subtracts';
    addsToPay: boolean;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ManualAdjustmentRecordPayloadV1> {
  const magnitude = BigInt(input.amountCents);
  const signed = input.direction === 'subtracts' ? -magnitude : magnitude;
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'manual_adjustment',
    payload: {
      action: 'record',
      agreementId: input.agreementId,
      period: input.period,
      label: input.label.trim(),
      reason: input.reason.trim(),
      amountCents: signed.toString(),
      addsToPay: input.addsToPay
    } satisfies ManualAdjustmentRecordPayloadV1
  }) as CommandEnvelopeV1<ManualAdjustmentRecordPayloadV1>;
}

export function voidManualAdjustment(
  input: { householdId: string; manualAdjustmentId: string; reason: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ManualAdjustmentVoidPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'manual_adjustment',
    aggregateId: input.manualAdjustmentId,
    payload: {
      action: 'void',
      manualAdjustmentId: input.manualAdjustmentId,
      reason: input.reason.trim()
    } satisfies ManualAdjustmentVoidPayloadV1
  }) as CommandEnvelopeV1<ManualAdjustmentVoidPayloadV1>;
}

export function setVacationEntitlement(
  input: {
    householdId: string;
    agreementId: string;
    annualVacationDays: number;
    effectiveFrom: string;
    reason: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<AgreementSetVacationEntitlementPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'agreement',
    aggregateId: input.agreementId,
    payload: {
      action: 'set_vacation_entitlement',
      agreementId: input.agreementId,
      annualVacationDays: input.annualVacationDays,
      effectiveFrom: input.effectiveFrom,
      reason: input.reason.trim()
    } satisfies AgreementSetVacationEntitlementPayloadV1
  }) as CommandEnvelopeV1<AgreementSetVacationEntitlementPayloadV1>;
}

export type { QueueOutcome };

/**
 * Delegado del encolado unificado (`$lib/offline/queue-command`): conserva la
 * firma histórica devolviendo solo el outcome ('synced' | 'queued' |
 * 'rejected' | 'conflict'). Para el mensaje veraz completo (causa traducida de
 * un rejected/conflict) llama a `queueCommand` directamente.
 */
export async function queueEmploymentCommand(envelope: CommandEnvelopeV1): Promise<QueueOutcome> {
  return (await queueCommand(envelope)).outcome;
}
