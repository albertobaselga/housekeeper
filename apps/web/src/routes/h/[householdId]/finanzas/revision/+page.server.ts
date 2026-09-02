import { parseDateRange } from '$lib/finance/filters';
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceRevision } from '$lib/server/finance.server';
import { getFinanceRevisionFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  depends('cc:finance');
  // [FASE 5 · despacho de cierre, F5-I2 + F5-M3] `from`/`to` llegaban CRUDOS de
  // la URL a `op_date between $2 and $3`: un `?from=ayer` (o un `2026-13-40`,
  // que sí encaja en el patrón ISO) reventaba la consulta con 22007/22008, y
  // el `catch` del cargador lo confundía con una avería —503 en pantalla y un
  // `log.error` por visita— desde un enlace que cualquiera puede escribir. El
  // «hoy» por omisión sale además de la zona del hogar (`todayLocal()`), no de
  // UTC: de madrugada en Madrid, el `to` era ayer y los movimientos del día no
  // salían.
  const range = parseDateRange(url.searchParams);
  const revision = locals.user
    ? await loadFinanceRevision({ id: locals.user.id }, params.householdId, range)
    : null;
  if (revision) return { revision };
  return demoOrUnavailable(() => ({ revision: getFinanceRevisionFixture(range) }));
};
