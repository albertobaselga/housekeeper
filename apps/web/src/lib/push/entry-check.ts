/**
 * Qué hacer con los avisos AL ENTRAR en el hogar, decidido puro y sin tocar el
 * DOM.
 *
 * Solo importa el TIPO de `subscribe.ts` (se borra en la compilación: no
 * arrastra el módulo que toca `Notification`/`PushManager` a quien solo quiera
 * esta decisión), así que la prueba unitaria no necesita simular un
 * navegador.
 */
import type { EnableResult, PushAvailability } from './subscribe';

export type EntryPushAction =
  /** Nada que hacer o nada que decir: nunca dos peticiones a la vez. */
  | 'none'
  /** Permiso ya concedido pero sin suscripción viva: reparar sin preguntar. */
  | 'self-heal'
  /** Permiso por decidir: banner propio, descartable, con botón «Activar». */
  | 'offer';

/**
 * `blocked`, `needs-home-screen` y `unsupported` devuelven siempre `'none'`:
 * el primero por la regla de silencio del §0.5 (ya lo explica «Tu cuenta»), el
 * segundo porque lo cubre el banner de instalación (nunca los dos a la vez), y
 * el tercero porque no hay nada que ofrecer.
 */
export function entryPushAction(
  availability: PushAvailability,
  hasLiveSubscription: boolean,
  dismissed: boolean
): EntryPushAction {
  if (availability.kind !== 'available') return 'none';
  if (availability.permission === 'granted') {
    return hasLiveSubscription ? 'none' : 'self-heal';
  }
  return dismissed ? 'none' : 'offer';
}

/**
 * Qué hacer tras pulsar «Activar», decidido puro a partir del resultado de
 * `enablePush` (no se descarta el resultado: antes se ignoraba y toda pantalla
 * quedaba en silencio de vuelta, tanto si funcionó como si no).
 *
 *   · `ok: true` → listo, nada más que decir.
 *   · `reason: 'failed'` → contratiempo del momento (sin red, el servidor no
 *     contestó): vuelve al ofrecimiento, con una línea reintentable. El
 *     permiso del navegador sigue por decidir, así que ofrecer de nuevo es
 *     honesto.
 *   · `reason: 'denied'` → la persona (o el navegador) acaba de bloquearlo
 *     tocando «Activar»: no hay reintento posible desde aquí —§0.5, el
 *     permiso jamás se dispara solo—, así que se remite a Tu cuenta y calla
 *     (la política de silencio de `blocked` no cambia).
 */
export type PushActivationOutcome = 'done' | 'retry' | 'blocked';

export function afterActivate(result: EnableResult): PushActivationOutcome {
  if (result.ok) return 'done';
  return result.reason === 'denied' ? 'blocked' : 'retry';
}
