import type { AggregateType, CommandEnvelopeV1 } from '@casa-clara/contracts';

import type { OutboxRecord } from '$lib/offline/schema';
import { dateLabel } from '$lib/employment/model';

/**
 * Triaje del outbox para el expediente laboral: registros conflict/rejected de
 * los agregados del expediente que requieren decisión humana (descartar o
 * reintentar con un operationId nuevo).
 */

export const EMPLOYMENT_AGGREGATES: readonly AggregateType[] = [
  'time_entry',
  'extra_work',
  'settlement',
  'payment',
  'expense',
  'leave_request',
  'agreement'
];

/** Registros que la sección "Cambios sin sincronizar" debe listar. */
export function triageableEmploymentRecords(records: readonly OutboxRecord[]): OutboxRecord[] {
  return records.filter(
    (record) =>
      record.status !== 'pending' &&
      (EMPLOYMENT_AGGREGATES as readonly string[]).includes(record.envelope.aggregateType)
  );
}

function payloadField(envelope: CommandEnvelopeV1, field: string): string | null {
  const payload = envelope.payload;
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * Descripción humana del comando a partir de aggregateType + action del
 * envelope. Nunca lanza: un comando desconocido degrada a una etiqueta genérica.
 */
export function describeEmploymentCommand(envelope: CommandEnvelopeV1): string {
  const action = payloadField(envelope, 'action');
  switch (envelope.aggregateType) {
    case 'time_entry': {
      const week = payloadField(envelope, 'weekStartsOn');
      return week ? `Días trabajados de la semana del ${dateLabel(week)}` : 'Días trabajados de la semana';
    }
    case 'extra_work':
      switch (action) {
        case 'register': {
          const workedOn = payloadField(envelope, 'workedOn');
          return workedOn
            ? `Registro de jornada extra del ${dateLabel(workedOn)}`
            : 'Registro de jornada extra';
        }
        case 'accept':
          return 'Aceptación de jornada extra';
        case 'mark_performed':
          return 'Jornada extra marcada como realizada';
        case 'resolve':
          return 'Decisión de compensación de jornada extra';
        default:
          return 'Cambio en jornada extra';
      }
    case 'settlement':
      switch (action) {
        case 'open': {
          const periodStart = payloadField(envelope, 'periodStart');
          return periodStart
            ? `Apertura de la cuenta del mes (${periodStart.slice(0, 7)})`
            : 'Apertura de la cuenta del mes';
        }
        case 'close':
          return 'Cierre de la cuenta del mes';
        case 'confirm_receipt':
          return 'Confirmación de cobro';
        default:
          return 'Cambio en la cuenta del mes';
      }
    case 'payment': {
      const valueOn = payloadField(envelope, 'valueOn');
      return valueOn ? `Registro de pago del ${dateLabel(valueOn)}` : 'Registro de pago';
    }
    case 'expense':
      return action === 'resolve' ? 'Decisión sobre un gasto' : 'Gasto enviado';
    case 'leave_request': {
      if (action === 'void') return 'Anulación de un periodo de vacaciones';
      const startsOn = payloadField(envelope, 'startsOn');
      return startsOn
        ? `Vacaciones apuntadas desde el ${dateLabel(startsOn)}`
        : 'Vacaciones apuntadas';
    }
    case 'agreement':
      return action === 'set_vacation_entitlement'
        ? 'Cambio de los días de vacaciones del contrato'
        : 'Cambio en el contrato';
    default:
      return 'Cambio pendiente';
  }
}

// El diccionario de códigos de error vive ahora en el módulo compartido
// `$lib/offline/error-codes` (lo usa también el queueCommand unificado); se
// reexporta aquí para no romper los imports existentes del triaje laboral.
export { describeErrorCode } from '$lib/offline/error-codes';

/**
 * Copia del envelope lista para reintentar: MISMOS hechos, operationId NUEVO
 * (el original ya fue consumido por el servidor con conflict/rejected).
 */
export function retryEnvelope(
  envelope: CommandEnvelopeV1,
  operationId: string = crypto.randomUUID()
): CommandEnvelopeV1 {
  return { ...envelope, operationId };
}
