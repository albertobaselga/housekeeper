import { readFinanceTransactions, type FinanceTransactionsPage } from '@housekeeper/server';

import { financeRead, hasIdsSelection, parseTransactionsQuery } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

/**
 * Ruling R21: `ids=`/`group_ids=` PRESENTES pero vacíos (el panel de detalle
 * sin selección, api.ts:99-102) son «sin coincidencias», nunca «sin filtro».
 * `parseTransactionsQuery` ya desactiva el rango cuando cualquiera de los dos
 * está presente (mira api.ts:99-102); si además los dos quedan vacíos tras el
 * parseo, la respuesta es la página vacía canónica sin tocar
 * `finance_transactions` — pero SIN saltarse el cerrojo de autorización, que
 * sigue viviendo dentro de `financeRead`. `hasIdsSelection` es la misma regla
 * de presencia que usa `parseTransactionsQuery`: una sola definición en vez de
 * mirar `url.searchParams.has(...)` por duplicado aquí y allí.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const idsSelection = hasIdsSelection(url);
  return financeRead(locals, url, (client, householdId): Promise<FinanceTransactionsPage> => {
    const query = parseTransactionsQuery(url);
    if (idsSelection && query.ids.length === 0 && query.groupIds.length === 0) {
      return Promise.resolve({ total: 0, sumCents: '0', limit: query.limit, offset: query.offset, rows: [] });
    }
    return readFinanceTransactions(client, householdId, query);
  });
};
