// El ÚNICO endpoint que parsea `dims` y `dupev` (contrato del doc de
// interfaces). Ambos se validan aquí y se devuelven junto a las filas: quien
// pinta el pivot (fase 6) llama después a buildPivotTree(rows, dims,
// { monthsCount: months.length, dupEventIds }).
import { readFinancePivot, serializePivotRows } from '@housekeeper/server';

import { parseDims } from '$lib/finance/pivot-state';
import { csvUuids, financeRead, parseReadFilters } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

// m11: `dims`/`dupev` se validan DENTRO del closure de `financeRead` (antes
// se validaban antes de llamarlo), para que un anónimo reciba el 401 de
// `requireFinanceRequest` en vez de un 400 adelantado al guard de sesión/hogar.
export const GET: RequestHandler = async ({ locals, url }) =>
  financeRead(locals, url, async (client, householdId) => {
    const dims = parseDims(url.searchParams.get('dims'));
    // Única definición de «lista de uuids separados por comas, cada uno
    // validado»: antes se repetía aquí a mano (split/trim/filter + un `for` con
    // `isUuid`) lo que `csvUuids` ya hace para `acc`/`ev`/`exev`/`ids`/`group_ids`.
    const dupEventIds = csvUuids(url.searchParams.get('dupev'), 'dupev');
    const { months, rows } = await readFinancePivot(client, householdId, parseReadFilters(url));
    // Los bigint no viajan por JSON: céntimos como cadena, como en todo el módulo.
    return { months, dims, dupEventIds, rows: serializePivotRows(rows) };
  });
