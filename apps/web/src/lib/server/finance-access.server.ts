import type { Pool } from 'pg';

import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@housekeeper/server';

import { fixturesAllowed, unreadable } from './data-source.server';
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

export interface FinanceGrantView {
  membershipId: string;
  name: string;
  granted: boolean;
  /** La membresía de quien mira: puede desactivarse a sí misma (spec §4). */
  isSelf: boolean;
}

export interface FinanceGrantOverview {
  householdId: string;
  admins: FinanceGrantView[];
}

/**
 * Membresías family_admin vivas del hogar con su estado de concesión, para la
 * tarjeta «Finanzas» de Ajustes. La RLS de finance_module_grants deja leer las
 * concesiones a cualquier admin del hogar; para el resto de roles, null.
 */
export async function loadFinanceGrantOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceGrantOverview | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') return null;
      const result = await client.query<{ id: string; displayName: string | null; granted: boolean }>(
        `select m.id,
                p.display_name as "displayName",
                exists (
                  select 1 from app.finance_module_grants as g
                   where g.household_id = m.household_id
                     and g.membership_id = m.id
                     and g.revoked_at is null
                ) as granted
           from app.household_memberships as m
           left join app.user_profiles as p on p.user_id = m.user_id
          where m.household_id = $1 and m.role = 'family_admin' and m.revoked_at is null
          order by m.created_at, m.id`,
        [householdId]
      );
      return {
        householdId,
        admins: result.rows.map((row) => ({
          membershipId: row.id,
          name: row.displayName ?? 'Perfil sin nombre',
          granted: row.granted,
          isSelf: row.id === membership.id
        }))
      } satisfies FinanceGrantOverview;
    });
  } catch (cause) {
    return unreadable(log, 'finance grant overview', cause);
  }
}
