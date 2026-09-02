import { error } from '@sveltejs/kit';
import { readFinanceEventDetail } from '@housekeeper/server';

import { isUuid } from '$lib/finance/filters';
import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url, params }) => {
  if (!isUuid(params.id)) error(404, 'Evento no encontrado');
  return financeRead(locals, url, async (client, householdId) => {
    const detail = await readFinanceEventDetail(client, householdId, params.id, parseReadFilters(url));
    if (!detail) error(404, 'Evento no encontrado');
    return detail;
  });
};
