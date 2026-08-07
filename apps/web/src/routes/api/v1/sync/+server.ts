import { error, json } from '@sveltejs/kit';
import { syncRequestSchema } from '@casa-clara/contracts/schemas';
import {
  employmentCommandHandlers,
  processSyncBatch,
  submitExpenseHandler,
  type CommandHandlers
} from '@casa-clara/server';

import { getDatabasePool } from '$lib/server/db.server';
import type { RequestHandler } from './$types';

const handlers: CommandHandlers = { ...employmentCommandHandlers, expense: submitExpenseHandler };

export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para sincronizar');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) error(403, 'Origen no permitido');

  const pool = getDatabasePool();
  if (!pool) error(503, 'La sincronización requiere la base de datos del hogar');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    error(400, 'El cuerpo debe ser JSON');
  }
  const parsed = syncRequestSchema.safeParse(body);
  if (!parsed.success) error(422, 'Petición de sincronización inválida');

  const result = await processSyncBatch(pool, { userId: locals.user.id }, parsed.data.commands, handlers);
  return json(result, { headers: { 'cache-control': 'no-store' } });
};
