import type { CommandEnvelopeV1 } from '@housekeeper/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';

/**
 * Constructores de los dos comandos de ocurrencia —marcar y deshacer—, en
 * módulo propio y mínimo: son los únicos de comida que necesita la página
 * «Hoy», y separarlos de `food/commands.ts` evita arrastrar todo el chunk de
 * constructores al presupuesto de JavaScript inicial de Hoy (120 KB).
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export interface RoutineOccurrencePayload {
  action: 'complete' | 'uncomplete';
  routineId: string;
  dueOn: string;
}

export type RoutineCompletePayload = RoutineOccurrencePayload & { action: 'complete' };

function routineOccurrenceCommand(
  action: RoutineOccurrencePayload['action'],
  input: { householdId: string; routineId: string; dueOn: string },
  options: EnvelopeOptions
): CommandEnvelopeV1<RoutineOccurrencePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    // El handler del servidor vive bajo el agregado `routine` (rhythm.ts);
    // `routine_occurrence` provocaba rejected/unsupported_aggregate (bug
    // cazado por la batería e2e).
    aggregateType: 'routine',
    aggregateId: input.routineId,
    payload: {
      action,
      routineId: input.routineId,
      dueOn: input.dueOn
    } satisfies RoutineOccurrencePayload
  }) as CommandEnvelopeV1<RoutineOccurrencePayload>;
}

export function completeRoutine(
  input: { householdId: string; routineId: string; dueOn: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<RoutineOccurrencePayload> {
  return routineOccurrenceCommand('complete', input, options);
}

/**
 * Deshacer un marcado hecho por error (E5.1). Va al mismo agregado y con la
 * misma forma: identifica la ocurrencia por su fecha, sin motivo. El servidor
 * anota el completado como anulado —no lo borra— y devuelve la rutina al día
 * que le tocaba.
 */
export function uncompleteRoutine(
  input: { householdId: string; routineId: string; dueOn: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<RoutineOccurrencePayload> {
  return routineOccurrenceCommand('uncomplete', input, options);
}
