import type { CommandEnvelopeV1 } from '@casa-clara/contracts';
import type { Writable } from 'svelte/store';

import {
  OptimisticActions,
  type ActionFeedback,
  type OptimisticActionsOptions
} from '$lib/offline/optimistic';
import type { QueueOutcome } from '$lib/offline/queue-command';

/**
 * El despacho de la tarjeta de concesiones de Finanzas (Ajustes del hogar).
 *
 * Existe por una razón concreta: esta tarjeta **no puede pintar antes de que el
 * servidor conteste**. Decir «Activado» de una cuenta cuya concesión el
 * servidor acaba de rechazar es la mentira exacta que el módulo entero está
 * montado para no contar — quien no tiene Finanzas concedido no ve el módulo ni
 * una sola cifra, y la pantalla que lo concede no puede ser la que se lo
 * invente.
 *
 * `OptimisticActions` ofrece ese pintado por diseño (`apply` pinta antes del
 * envío y `revert` lo deshace ante un rechazo), y le sirve bien al resto de la
 * casa. Aquí ese par se cierra de dos maneras, y la segunda es la que manda:
 *
 * 1. Por tipos: `apply` y `revert` están declarados `never`, así que entregar
 *    cualquiera de los dos no compila —da igual la forma: `apply:`, la
 *    abreviada `{ apply }`, la clave computada `{ ['apply']: … }` o una
 *    propagación— y `pnpm check`, que corre en todos los controles, lo caza.
 * 2. Por construcción, que es lo que de verdad lo garantiza: `run` no reenvía
 *    las opciones que recibe, sino que **elige** las dos que esta tarjeta
 *    admite. Aunque alguien burle el tipo con un `as any`, el gancho de pintado
 *    no llega a `OptimisticActions`: no hay camino.
 *
 * Lo que queda igual que en el resto de la casa: el acuse veraz por ACK, el
 * token de invalidación selectivo y la reconciliación diferida.
 */

/** Rechazos propios de la concesión (códigos de `commands/finance.ts`). */
const FINANCE_MESSAGES: Readonly<Record<string, string>> = {
  already_granted: 'Esa cuenta ya tiene Finanzas activado',
  not_granted: 'Esa cuenta no tiene Finanzas activado',
  grant_target_not_admin: 'Finanzas solo se concede a la familia administradora',
  membership_not_found: 'Ese acceso ya no existe'
};

/** Token declarado con `depends()` en el `+page.server.ts` de Ajustes. */
const INVALIDATE_TOKEN = 'cc:settings';

export interface FinanceGrantDispatchOptions {
  /** Prohibido: pintar antes del acuse. Ver la cabecera de este módulo. */
  apply?: never;
  /** Prohibido: sin pintado no hay nada que deshacer. */
  revert?: never;
  /**
   * Datos frescos ya confirmados. Corre DESPUÉS del acuse del servidor y del
   * refresco selectivo, así que no puede adelantar ningún estado.
   */
  settle?: () => void;
}

export interface FinanceGrantDispatch {
  /** Nota unificada para `<ActionStatus>`, con el mensaje veraz por outcome. */
  status: Writable<ActionFeedback | null>;
  /** Reconciliación diferida; llamar dentro de un `$effect` (devuelve el cese). */
  start: () => () => void;
  run: (envelope: CommandEnvelopeV1, options?: FinanceGrantDispatchOptions) => Promise<QueueOutcome>;
}

export function createFinanceGrantDispatch(
  options: Omit<OptimisticActionsOptions, 'invalidateToken'>
): FinanceGrantDispatch {
  const optimistic = new OptimisticActions({ ...options, invalidateToken: INVALIDATE_TOKEN });
  return {
    status: optimistic.status,
    start: () => optimistic.start(),
    run: (envelope, given = {}) =>
      // Los ganchos se ELIGEN, no se reenvían: esta línea es la garantía.
      optimistic.run(envelope, { messageOverrides: FINANCE_MESSAGES, settle: given.settle })
  };
}
