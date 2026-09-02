import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceImportar } from '$lib/server/finance.server';
import { getFinanceImportarFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params }) => {
  depends('cc:finance');
  const importar = locals.user ? await loadFinanceImportar({ id: locals.user.id }, params.householdId) : null;
  if (importar) return { importar };
  return demoOrUnavailable(() => ({ importar: getFinanceImportarFixture() }));
};
