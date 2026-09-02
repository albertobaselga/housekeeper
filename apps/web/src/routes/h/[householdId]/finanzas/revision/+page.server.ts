import { monthsAgoISO } from '$lib/finance/filters';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceRevision } from '$lib/server/finance.server';
import { getFinanceRevisionFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  depends('cc:finance');
  const range = {
    from: url.searchParams.get('from') ?? monthsAgoISO(6),
    to: url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10)
  };
  const revision = locals.user
    ? await loadFinanceRevision({ id: locals.user.id }, params.householdId, range)
    : null;
  if (revision) return { revision };
  return demoOrUnavailable(() => ({ revision: getFinanceRevisionFixture(range) }));
};
