import { error, json } from '@sveltejs/kit';
import { syncRequestSchema } from '@housekeeper/contracts/schemas';
import {
  CommandRejectedError,
  accessCommandHandlers,
  contactCommandHandlers,
  couponCommandHandlers,
  employmentCommandHandlers,
  financeCommandHandlers,
  foodCommandHandlers,
  processSyncBatch,
  rhythmCommandHandlers,
  submitExpenseHandler,
  wikiCommandHandlers,
  type CommandHandlers
} from '@housekeeper/server';

import { getDatabasePool } from '$lib/server/db.server';
import type { RequestHandler } from './$types';

const handlers: CommandHandlers = {
  ...employmentCommandHandlers,
  ...wikiCommandHandlers,
  ...foodCommandHandlers,
  ...rhythmCommandHandlers,
  ...accessCommandHandlers,
  ...financeCommandHandlers,
  ...contactCommandHandlers,
  ...couponCommandHandlers,
  expense: submitExpenseHandler
};

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

  // Cada sobre se valida dentro, uno a uno. Solo uno sin `operationId` que se
  // pueda identificar no tiene a quién devolverle su rechazo: ese tumba el lote,
  // como antes, con el mismo 422.
  let result;
  try {
    result = await processSyncBatch(pool, { userId: locals.user.id }, parsed.data.commands, handlers);
  } catch (cause) {
    if (cause instanceof CommandRejectedError && cause.errorCode === 'invalid_envelope') {
      error(422, 'Petición de sincronización inválida');
    }
    throw cause;
  }
  return json(result, { headers: { 'cache-control': 'no-store' } });
};
