import type { Pool } from 'pg';

import type { Role } from '@housekeeper/contracts';
import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@housekeeper/server';

import { unreadable } from './data-source.server';
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
 * Vuelve a marcar una contraseña como provisional. Se llama justo después de
 * reponérsela a alguien desde Ajustes: la que entrega la administración es tan
 * de usar y tirar como la del alta, y la persona tiene que cambiarla antes de
 * poder ir a ninguna otra pantalla del hogar.
 *
 * La escritura la ampara `user_profiles_admin_update` (0030) y el disparador
 * `user_profiles_password_flag_guard` exige que encenderla venga de un contexto
 * `family_admin`. Devuelve false si no se pudo, y quien llama lo trata como un
 * aviso, no como un fallo del cambio: la contraseña YA está repuesta cuando
 * esto se ejecuta, y perder la marca no es motivo para decir que no se hizo.
 */
export async function requirePasswordChange(
  user: { id: string },
  householdId: string,
  targetUserId: string,
  pool: Pool | null = getDatabasePool()
): Promise<boolean> {
  if (!pool) return false;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') return false;
      const updated = await client.query(
        `update app.user_profiles set must_change_password = true where user_id = $1`,
        [targetUserId]
      );
      return (updated.rowCount ?? 0) === 1;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('could not flag a provisional password', { code: errorCode(cause) });
    }
    return false;
  }
}

/**
 * Da por cumplida la obligación. Es el ÚNICO sitio del código que apaga la
 * marca, y solo se llama cuando Better Auth ya ha aceptado el cambio de
 * contraseña: la persona la apaga sobre su propia fila
 * (`user_profiles_self_update`), que es lo único que el disparador de 0030
 * permite.
 */
export async function clearPasswordChangeRequirement(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<boolean> {
  if (!pool) return false;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const updated = await client.query(
        `update app.user_profiles
            set must_change_password = false
          where user_id = $1 and must_change_password`,
        [user.id]
      );
      return (updated.rowCount ?? 0) === 1;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('could not clear a provisional password flag', { code: errorCode(cause) });
    }
    return false;
  }
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
    return unreadable(log, 'membership identity', cause);
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
    return unreadable(log, 'access overview', cause);
  }
}
