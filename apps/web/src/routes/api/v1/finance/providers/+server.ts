import { readFinanceProviders } from '@housekeeper/server';

import { financeRead, intParam, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
  // limit: tope de filas del ranking de proveedores, nunca céntimos. Política
  // 'reject' (m1): mismo comportamiento visible que antes (400 fuera de 1–50).
  const limit = intParam(url, 'limit', 10, 1, 50, { onOutOfRange: 'reject' });
  return financeRead(locals, url, (client, householdId) =>
    readFinanceProviders(client, householdId, parseReadFilters(url), limit));
};
