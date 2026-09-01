import type { Pool } from 'pg';

import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import { fixturesAllowed } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:finance-access');

/**
 * ¿Tiene esta persona Finanzas abierto en este hogar? Lee el cerrojo REAL
 * (app.finance_enabled(): rol family_admin Y concesión viva) bajo la misma
 * transacción autorizada que cualquier otra lectura. Falla CERRADO: sin
 * membresía o con avería, false — el módulo no se enseña por accidente. Sin
 * base de datos (demo por fixtures) devuelve true: la maqueta enseña Finanzas
 * como enseña el resto de módulos, y el rol ya filtró al no-admin.
 */
export async function financeAccessGranted(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<boolean> {
  if (!pool) return fixturesAllowed();
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const result = await client.query<{ enabled: boolean }>(
        'select app.finance_enabled() as enabled'
      );
      return Boolean(result.rows[0]?.enabled);
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('finance access check unavailable', { code: errorCode(cause) });
    }
    return false;
  }
}
