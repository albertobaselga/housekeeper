import { error, json } from '@sveltejs/kit';

import { markGuideNoteRead } from '$lib/server/wiki.server';
import type { RequestHandler } from './$types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tope por llamada: el modo libro manda de una en una y arrastra lo pendiente. */
const MAX_PAGES = 200;

/**
 * «He leído esta nota». Camino propio y deliberadamente estrecho:
 *
 *  · No pasa por `/api/v1/sync`. Los comandos dejan recibo en
 *    `app.command_receipts` con actor y sello de tiempo, y eso reconstruiría
 *    el rastro por horas que la Guía evita por diseño (migración 0026).
 *  · No acepta membresía: la función de la base usa siempre la del contexto,
 *    así que nadie puede marcar por otro ni aunque manipule el cuerpo.
 *  · No devuelve nada del progreso ajeno. Solo cuántas notas se han apuntado.
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

  const raw = (body as { pageIds?: unknown })?.pageIds;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PAGES) {
    error(400, 'Se esperaba una lista de notas');
  }
  const pageIds = raw.filter((value): value is string => typeof value === 'string' && UUID_PATTERN.test(value));
  if (pageIds.length === 0) error(400, 'Ninguna nota identificable');

  let recorded = 0;
  for (const pageId of pageIds) {
    const marked = await markGuideNoteRead({ id: locals.user.id }, params.householdId, pageId);
    if (marked) recorded += 1;
  }

  return json({ recorded }, { headers: { 'cache-control': 'no-store' } });
};
