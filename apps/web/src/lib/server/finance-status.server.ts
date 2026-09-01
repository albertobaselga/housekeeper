import type { Pool } from 'pg';

import { createLogger, withAuthorizedTransaction } from '@housekeeper/server';

import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:finance-status');

export interface FinanceStatus {
  accountCount: number;
  transactionCount: number;
}

/**
 * Conteos mínimos para las páginas esqueleto de Finanzas: cuántas cuentas y
 * movimientos ve ESTA membresía bajo RLS. El doble cerrojo manda: a un admin
 * sin concesión el layout ya no le deja llegar, y si llegara, la RLS le
 * devolvería ceros — «no hay datos» nunca miente. Null solo sin base o sin
 * membresía (la página lo traduce); una avería real sale como 503 honesto.
 */
export async function loadFinanceStatus(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceStatus | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const result = await client.query<{ accounts: string; transactions: string }>(
        `select
           (select count(*) from app.finance_accounts) as accounts,
           (select count(*) from app.finance_transactions) as transactions`
      );
      const row = result.rows[0];
      return {
        accountCount: Number(row?.accounts ?? 0),
        transactionCount: Number(row?.transactions ?? 0)
      } satisfies FinanceStatus;
    });
  } catch (cause) {
    return unreadable(log, 'finance status', cause);
  }
}
