import { error } from '@sveltejs/kit';
import { readFinanceProviders } from '@housekeeper/server';

import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
  // limit: tope de filas del ranking de proveedores, nunca céntimos.
  const limit = Number(url.searchParams.get('limit') ?? '10');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) error(400, 'Parámetro limit inválido');
  return financeRead(locals, url, (client, householdId) =>
    readFinanceProviders(client, householdId, parseReadFilters(url), limit));
};
