import type {
  CommandEnvelopeV1,
  ExpenseResolvePayloadV1,
  ExpenseSubmitPayloadV1,
  ExtraWorkAcceptPayloadV1,
  ExtraWorkMarkPerformedPayloadV1,
  ExtraWorkRegisterPayloadV1,
  ExtraWorkResolvePayloadV1,
  PaymentRecordPayloadV1,
  SettlementClosePayloadV1,
  SettlementOpenPayloadV1,
  SettlementReceiptConfirmPayloadV1,
  WeeklyReportSubmitPayloadV1
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

export function submitWeek(
  input: {
    householdId: string;
    agreementId: string;
    weekStartsOn: string;
    entries: WeeklyReportSubmitPayloadV1['entries'];
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<WeeklyReportSubmitPayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'time_entry',
    payload: {
      action: 'submit_week',
      agreementId: input.agreementId,
      weekStartsOn: input.weekStartsOn,
      entries: input.entries
    } satisfies WeeklyReportSubmitPayloadV1
  }) as CommandEnvelopeV1<WeeklyReportSubmitPayloadV1>;
}

export function registerExtra(
  input: {
    householdId: string;
    agreementId: string;
    kind: ExtraWorkRegisterPayloadV1['kind'];
    workedOn: string;
    durationMinutes: number;
    note?: string;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<ExtraWorkRegisterPayloadV1> {
  const note = trimmedOrUndefined(input.note);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'extra_work',
    payload: {
      action: 'register',
      agreementId: input.agreementId,
      kind: input.kind,
      workedOn: input.workedOn,
      durationMinutes: input.durationMinutes,
      ...(note ? { note } : {})
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
      amountCents: input.amountCents
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
