import { readFinanceBreakdown } from '@housekeeper/server';

import { financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, (client, householdId) => readFinanceBreakdown(client, householdId, parseReadFilters(url)));
