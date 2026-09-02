import { createLogger, errorCode, withAuthorizedTransaction } from '@housekeeper/server';

import { getDatabasePool } from '$lib/server/db.server';
import type { LayoutServerLoad } from './$types';

const log = createLogger('web:finanzas:layout');

/**
 * Contador de pendientes para el badge de Revisión (spec §8), compartido por
 * todas las pantallas del módulo. Se apoya en la RLS —no en
 * `requireFinanceAdmin`—: quien no tiene Finanzas concedido ya no ve fila
 * alguna, así que el conteo sale correcto sin repetir aquí el doble cerrojo.
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
            where household_id = $1 and status <> 'confirmada'`,
          [params.householdId]
        );
        return result.rows[0]?.pending ?? 0;
      }
    );
    return { pendingReviewCount };
  } catch (cause) {
    // El badge es un adorno: si no se puede contar, el módulo sigue navegable.
    // Se registra con su código estable pero NO se llama a `unreadable`, que
    // lanzaría 503 y tumbaría TODAS las pantallas de Finanzas por un contador.
    log.error('finanzas badge unavailable', { code: errorCode(cause) });
    return { pendingReviewCount: 0 };
  }
};
