import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';

import { grantFinanceAccess } from '../src/lib/finance/commands';
import {
  createFinanceGrantDispatch,
  type FinanceGrantDispatch,
  type FinanceGrantDispatchOptions
} from '../src/lib/finance/grant-dispatch';
import type { QueueCommandResult } from '../src/lib/offline/queue-command';

/**
 * Que la tarjeta de Finanzas no pueda pintar antes de que el servidor conteste,
 * comprobado por CONDUCTA y no por el texto del fichero.
 *
 * Las dos rondas anteriores persiguieron la FORMA de escribir el gancho de
 * pintado (`apply:`, luego también `apply,`) con expresiones regulares sobre el
 * código, y siempre quedaba una forma más: la clave computada `['apply']`, una
 * constante intermedia, una propagación. Eso no se gana. Ahora el despacho
 * ELIGE las opciones que admite en vez de reenviar las que le den, así que la
 * pregunta deja de ser «¿cómo se escribió?» y pasa a ser «¿llega el gancho?».
 * La respuesta se mide aquí, ejecutándolo: da igual la sintaxis, y da igual que
 * alguien burle el tipo con un cast.
 */

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '11000000-0000-4000-8000-000000000001';

const SYNCED: QueueCommandResult = { outcome: 'synced', message: 'Guardado ✓' };
const REJECTED: QueueCommandResult = {
  outcome: 'rejected',
  errorCode: 'already_granted',
  message: 'No se pudo guardar el cambio.'
};

/**
 * Un despacho con la red y el almacén sustituidos por los inyectables que
 * `OptimisticActions` ya declara para tests, y la lista de tokens que llegó a
 * invalidar.
 */
function dispatchWith(result: QueueCommandResult): {
  dispatch: FinanceGrantDispatch;
  invalidated: string[];
} {
  const invalidated: string[] = [];
  const dispatch = createFinanceGrantDispatch(HOUSEHOLD, {
    queueCommandFn: async () => result,
    invalidateFn: async (token: string) => {
      invalidated.push(token);
    },
    listOutboxFn: async () => []
  });
  return { dispatch, invalidated };
}

/**
 * Las cuatro formas de entregar el gancho prohibido, coladas saltándose el
 * tipo. En compilación, cada una es un error distinto (`apply?: never` las
 * rechaza todas); en ejecución las tres primeras producen el MISMO objeto, y
 * eso es justo lo que hace que perseguir la sintaxis fuera una pelea perdida.
 */
function paintHooks(paint: () => void): FinanceGrantDispatchOptions[] {
  const shorthand = { apply: paint };
  return [
    { apply: paint } as unknown as FinanceGrantDispatchOptions,
    { ...shorthand } as unknown as FinanceGrantDispatchOptions,
    { ['apply']: paint } as unknown as FinanceGrantDispatchOptions,
    { apply: paint, revert: paint } as unknown as FinanceGrantDispatchOptions
  ];
}

describe('el despacho de concesiones de Finanzas no puede pintar antes del acuse', () => {
  const envelope = grantFinanceAccess({ householdId: HOUSEHOLD, membershipId: MEMBERSHIP });

  it('descarta el gancho de pintado aunque se cuele saltándose el tipo', async () => {
    let painted = 0;
    const paint = (): void => {
      painted += 1;
    };

    // Con el comando ACEPTADO, ningún gancho de pintado corre.
    for (const hooks of paintHooks(paint)) {
      expect(await dispatchWith(SYNCED).dispatch.run(envelope, hooks)).toBe('synced');
    }
    // Y con el comando RECHAZADO tampoco, que es el caso que de verdad importa:
    // si el pintado hubiera corrido, la fila habría dicho «Activado» de algo
    // que el servidor acaba de negar, y solo el `revert` —que aquí tampoco
    // llega— la habría devuelto a su sitio.
    for (const hooks of paintHooks(paint)) {
      expect(await dispatchWith(REJECTED).dispatch.run(envelope, hooks)).toBe('rejected');
    }

    expect(painted, 'un gancho de pintado optimista llegó a ejecutarse').toBe(0);
  });

  it('el gancho que SÍ admite corre solo cuando el servidor ha confirmado', async () => {
    let settled = 0;
    const settle = (): void => {
      settled += 1;
    };

    const accepted = dispatchWith(SYNCED);
    await accepted.dispatch.run(envelope, { settle });
    expect(settled, '`settle` no corrió tras un comando confirmado').toBe(1);
    // Y el refresco es el selectivo de la pantalla, no una recarga entera.
    expect(accepted.invalidated).toEqual(['cc:settings']);

    const rejected = dispatchWith(REJECTED);
    await rejected.dispatch.run(envelope, { settle });
    expect(settled, '`settle` corrió con un comando rechazado').toBe(1);
    expect(rejected.invalidated).toEqual([]);
  });

  it('la nota traduce los rechazos propios de la concesión', async () => {
    const { dispatch } = dispatchWith(REJECTED);
    await dispatch.run(envelope);
    // El mensaje del diccionario de la tarjeta, no el genérico de la casa. Los
    // cuatro códigos de `commands/finance.ts` viven DENTRO del despacho, así que
    // la página no puede olvidarse de pasarlos ni pasarlos mal.
    expect(get(dispatch.status)).toEqual({
      tone: 'error',
      text: 'Esa cuenta ya tiene Finanzas activado'
    });
  });
});
