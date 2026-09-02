// Lo consume la pantalla Analítica de la fase 6; se crea aquí porque aquí vive
// su lectura (readFinanceAnalytics) y el doc de interfaces lo exige en la lista.
import { readFinanceAnalytics } from '@housekeeper/server';

import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, (client, householdId) => readFinanceAnalytics(client, householdId, parseReadFilters(url)));
