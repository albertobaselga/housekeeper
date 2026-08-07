import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';

/**
 * Constructor del comando `routine.complete`, en módulo propio y mínimo:
 * es el único constructor de comida que necesita la página «Hoy», y separarlo
 * de `food/commands.ts` evita arrastrar todo el chunk de constructores al
 * presupuesto de JavaScript inicial de Hoy (120 KB).
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export interface RoutineCompletePayload {
  action: 'complete';
  routineId: string;
  dueOn: string;
}

export function completeRoutine(
  input: { householdId: string; routineId: string; dueOn: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<RoutineCompletePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    // El handler del servidor vive bajo el agregado `routine` (rhythm.ts);
    // `routine_occurrence` provocaba rejected/unsupported_aggregate (bug
    // cazado por la batería e2e).
    aggregateType: 'routine',
    aggregateId: input.routineId,
    payload: {
      action: 'complete',
      routineId: input.routineId,
      dueOn: input.dueOn
    } satisfies RoutineCompletePayload
  }) as CommandEnvelopeV1<RoutineCompletePayload>;
}
