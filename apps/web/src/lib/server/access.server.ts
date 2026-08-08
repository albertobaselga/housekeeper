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

export interface MembershipIdentity {
  /** Identificador estable de Better Auth guardado en app.user_profiles. */
  userId: string;
  name: string;
}

/**
 * Traduce una membresía del hogar a la identidad que hay detrás, para poder
 * reponerle la contraseña. El `user_id` NUNCA viaja al cliente: la pantalla de
 * Ajustes solo maneja identificadores de membresía y esta función hace la
 * traducción en el servidor, dentro de la misma transacción que comprueba que
 * quien pide es `family_admin` del hogar. Devuelve null si no lo es, si la
 * membresía no existe, si ya está revocada o si es la suya propia.
 */
export async function resolveMembershipIdentity(
  user: { id: string },
  householdId: string,
  membershipId: string,
  pool: Pool | null = getDatabasePool()
): Promise<MembershipIdentity | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') return null;
      if (membership.id === membershipId) return null;
      const result = await client.query<{ userId: string; displayName: string | null }>(
        `select m.user_id as "userId", p.display_name as "displayName"
           from app.household_memberships as m
           left join app.user_profiles as p on p.user_id = m.user_id
          where m.household_id = $1 and m.id = $2 and m.revoked_at is null`,
        [householdId, membershipId]
      );
      const row = result.rows[0];
      if (!row) return null;
      return { userId: row.userId, name: row.displayName ?? 'esa persona' } satisfies MembershipIdentity;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('membership identity unavailable', { code: errorCode(cause) });
    }
    return null;
  }
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
