import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceAjustes } from '$lib/server/finance.server';
import { getFinanceAjustesFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params }) => {
  depends('cc:finance');
  const ajustes = locals.user ? await loadFinanceAjustes({ id: locals.user.id }, params.householdId) : null;
  if (ajustes) return { ajustes };
  return demoOrUnavailable(() => ({ ajustes: getFinanceAjustesFixture() }));
};
