import { error, json } from '@sveltejs/kit';

import { markVacationsSeen } from '$lib/server/vacations.server';
import type { RequestHandler } from './$types';

/**
 * «Ya he visto mis vacaciones hasta aquí». Camino propio y deliberadamente
 * estrecho, igual que el «he leído esta nota» de la Guía:
 *
 *  · No pasa por `/api/v1/sync`: no es un hecho del expediente laboral, no
 *    lleva recibo con actor y hora, y no significa conformidad con los días
 *    apuntados. Solo apaga un aviso.
 *  · No acepta membresía: `app.mark_vacations_seen` usa siempre la del
 *    contexto, así que nadie puede dar por vistas las vacaciones de otra
 *    persona ni manipulando el cuerpo.
 *  · El instante que se manda es el que la pantalla llegó a enseñar. La base lo
 *    acota a `now()` por arriba y a lo ya guardado por abajo, así que un
 *    cliente con la hora adelantada no puede silenciar por adelantado lo que le
 *    apunten mañana.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) error(401, 'Inicia sesión para continuar');
  if (!locals.user.householdIds.includes(params.householdId)) error(404, 'Hogar no encontrado');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    error(400, 'Cuerpo ilegible');
  }

  const raw = (body as { seenThrough?: unknown })?.seenThrough;
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    error(400, 'Se esperaba un instante');
  }
  // Sin instante utilizable se marca «hasta ahora», que es lo que la base pone
  // por omisión: alguien que abre la sección sin un solo periodo apuntado
  // también está mirando.
  const seenThrough =
    typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;

  const stored = await markVacationsSeen({ id: locals.user.id }, params.householdId, seenThrough);
  return json({ seenThrough: stored }, { headers: { 'cache-control': 'no-store' } });
};
