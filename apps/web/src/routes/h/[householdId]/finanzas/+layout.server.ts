import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@housekeeper/server';

import { getDatabasePool } from '$lib/server/db.server';
import type { LayoutServerLoad } from './$types';

const log = createLogger('web:finanzas:layout');

/**
 * Contador de pendientes para el badge de Revisión (spec §8), compartido por
 * todas las pantallas del módulo. Se apoya en la RLS —no en
 * `requireFinanceAdmin`—: quien no tiene Finanzas concedido ya no ve fila
 * alguna, así que el conteo sale correcto sin repetir aquí el doble cerrojo.
 *
 * [FASE 5, T10 · corrección Minor 2] Misma ventana de 6 meses que
 * `revision/+page.server.ts` (`monthsAgoISO(6)`): sin este filtro, un hogar
 * con pendientes de hace más de 6 meses veía el badge en «7» y, al pulsar,
 * «Nada que revisar en este periodo ✨» — el badge prometía lo que la bandeja
 * no enseñaba. Se calcula en SQL (`current_date - interval '6 months'`) para
 * no duplicar el cálculo de fecha de la página.
 */
export const load: LayoutServerLoad = async ({ depends, locals, params }) => {
  depends('cc:finance');
  const pool = getDatabasePool();
  if (!pool || !locals.user) return { pendingReviewCount: 0 };
  try {
    const pendingReviewCount = await withAuthorizedTransaction(
      pool,
      { userId: locals.user.id },
      params.householdId,
      async (client) => {
        const result = await client.query<{ pending: number }>(
          `select count(*)::int as pending
             from app.finance_transactions
            where household_id = $1 and status <> 'confirmada'
              and op_date >= (current_date - interval '6 months')`,
          [params.householdId]
        );
        return result.rows[0]?.pending ?? 0;
      }
    );
    return { pendingReviewCount };
  } catch (cause) {
    // El badge es un adorno: si no se puede contar, el módulo sigue navegable.
    // NO se llama a `unreadable`, que lanzaría 503 y tumbaría TODAS las
    // pantallas de Finanzas por un contador.
    //
    // [FASE 5, T10 · corrección Minor 3] «Sin membresía viva»
    // (`AuthorizationError`) es un estado normal, no una avería — mismo
    // criterio que `finance-access.server.ts`: se registra con `log.error`
    // (y su código estable) solo cuando la causa NO es esa, para que el ruido
    // acumulado no tape la avería que sí importa.
    if (!(cause instanceof AuthorizationError)) {
      log.error('finanzas badge unavailable', { code: errorCode(cause) });
    }
    return { pendingReviewCount: 0 };
  }
};
