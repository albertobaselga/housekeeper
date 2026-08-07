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
  'expense'
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
      return week ? `Parte semanal de la semana del ${dateLabel(week)}` : 'Parte semanal';
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
          return 'Resolución de jornada extra';
        default:
          return 'Cambio en jornada extra';
      }
    case 'settlement':
      switch (action) {
        case 'open': {
          const periodStart = payloadField(envelope, 'periodStart');
          return periodStart
            ? `Apertura de liquidación (${periodStart.slice(0, 7)})`
            : 'Apertura de liquidación';
        }
        case 'close':
          return 'Cierre de liquidación';
        case 'confirm_receipt':
          return 'Confirmación de cobro';
        default:
          return 'Cambio en liquidación';
      }
    case 'payment': {
      const valueOn = payloadField(envelope, 'valueOn');
      return valueOn ? `Registro de pago del ${dateLabel(valueOn)}` : 'Registro de pago';
    }
    case 'expense':
      return action === 'resolve' ? 'Resolución de gasto' : 'Gasto enviado';
    default:
      return 'Cambio pendiente';
  }
}

const ERROR_CODE_LABELS: Record<string, string> = {
  week_already_reported: 'La semana ya fue enviada',
  agreement_not_found: 'El acuerdo no existe o no es visible',
  not_allowed: 'Tu rol no permite esta acción',
  invalid_payload: 'El servidor rechazó el contenido',
  extra_work_not_found: 'La jornada extra ya no existe',
  extra_work_not_requested: 'La jornada ya no admite aceptación',
  extra_work_not_resolvable: 'La jornada ya no admite resolución',
  settlement_not_found: 'La liquidación ya no existe',
  settlement_not_open: 'La liquidación ya no está abierta',
  settlement_not_closed: 'La liquidación no está cerrada',
  receipt_already_confirmed: 'El cobro ya estaba confirmado',
  unsupported_period: 'El periodo no es un mes natural'
};

/** Etiqueta humana del código de error del servidor; conserva el código crudo si es desconocido. */
export function describeErrorCode(code: string | undefined): string | null {
  if (!code) return null;
  return ERROR_CODE_LABELS[code] ?? code;
}

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
