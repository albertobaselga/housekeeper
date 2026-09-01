import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceStatus } from '$lib/server/finance-status.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const status = locals.user
    ? await loadFinanceStatus({ id: locals.user.id }, params.householdId)
    : null;
  if (status) return { status };
  // Sin base de datos, la demo enseña el esqueleto vacío; con base y avería,
  // 503 honesto (regla de data-source.server.ts).
  return demoOrUnavailable(() => ({ status: { accountCount: 0, transactionCount: 0 } }));
};
