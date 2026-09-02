import { isUuid, monthsAgoISO } from '$lib/finance/filters';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceEventos } from '$lib/server/finance.server';
import { getFinanceEventosFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  depends('cc:finance');
  const range = {
    from: url.searchParams.get('from') ?? monthsAgoISO(6),
    to: url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10)
  };
  const open = url.searchParams.get('open');
  const openId = open && isUuid(open) ? open : null;
  const eventos = locals.user
    ? await loadFinanceEventos({ id: locals.user.id }, params.householdId, range, openId)
    : null;
  if (eventos) return { eventos };
  return demoOrUnavailable(() => ({ eventos: getFinanceEventosFixture(range) }));
};
