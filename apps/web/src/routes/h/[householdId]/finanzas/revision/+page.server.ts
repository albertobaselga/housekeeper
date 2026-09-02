import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceRevision } from '$lib/server/finance.server';
import { getFinanceRevisionFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

/** Rango por defecto de la bandeja: los últimos 6 meses. */
function monthsAgoISO(months: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

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
