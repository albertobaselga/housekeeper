import type { Pool } from 'pg';

import type { Role } from '@casa-clara/contracts';
import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import { getDatabasePool } from './db.server';

const log = createLogger('web:access');

export interface MembershipAccessView {
  id: string;
  name: string;
  role: Role;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** La membresía del propio administrador: se muestra sin acciones. */
  isSelf: boolean;
}

export interface AccessOverview {
  householdId: string;
  memberships: MembershipAccessView[];
}

/**
 * Membresías del hogar con nombre de perfil y estado (starts/expires/revoked)
 * para la sección "Accesos del hogar". La política memberships_admin_read solo
 * concede esta lectura al family_admin (y user_profiles_admin_read le presta
 * los nombres); para cualquier otro rol la función devuelve null y la página
 * de ajustes cae a la fixture actual. Devuelve null también sin pool o sin
 * membresía autorizada.
 */
export async function loadAccessOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<AccessOverview | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      // El gate de rol es deliberadamente redundante con la RLS: para un rol
      // no administrador la política solo dejaría ver su propia fila, y esta
      // vista o es completa o no es.
      if (membership.role !== 'family_admin') return null;
      const result = await client.query<{
        id: string;
        role: Role;
        displayName: string | null;
        startsAt: Date;
        expiresAt: Date | null;
        revokedAt: Date | null;
      }>(
        `select m.id,
                m.role::text as "role",
                p.display_name as "displayName",
                m.starts_at as "startsAt",
                m.expires_at as "expiresAt",
                m.revoked_at as "revokedAt"
           from app.household_memberships as m
           left join app.user_profiles as p on p.user_id = m.user_id
          where m.household_id = $1
          order by m.created_at, m.id`,
        [householdId]
      );
      return {
        householdId,
        memberships: result.rows.map((row) => ({
          id: row.id,
          name: row.displayName ?? 'Perfil sin nombre',
          role: row.role,
          startsAt: row.startsAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          isSelf: row.id === membership.id
        }))
      } satisfies AccessOverview;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('access overview unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}
