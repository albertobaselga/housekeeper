import type { Pool } from 'pg';

import type { Role } from '@housekeeper/contracts';
import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@housekeeper/server';

import {
  buildStaffOverview,
  STAFF_ROLES,
  type StaffAgreementRow,
  type StaffOverview,
  type StaffVersionRow
} from '$lib/staff/model';
import { getDatabasePool } from './db.server';

const log = createLogger('web:staff');

/** Fila cruda de membresía: pg entrega los timestamptz como Date. */
interface MembershipRow {
  membershipId: string;
  name: string | null;
  role: Role;
  startsAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  accessEnded: boolean;
  mustChangePassword: boolean;
  today: string;
}

/**
 * Personal del hogar leído bajo RLS. El gate de `family_admin` es
 * deliberadamente redundante con las políticas: para cualquier otro papel
 * `memberships_admin_read` ya devolvería como mucho su propia fila, y esta
 * vista o es completa o no es. Media lista de personal es peor que ninguna.
 *
 * Devuelve null sin pool (demo sin DATABASE_URL), sin membresía autorizada o
 * sin ser quien administra. La pantalla dice esa verdad sin distinguir los
 * casos y sin caer a ninguna fixture: una lista de personal inventada en una
 * pantalla que habla de contratos sería peor que una pantalla vacía.
 */
export async function loadStaffOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<StaffOverview | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') return null;

      // El reloj y el calendario son los de la base: los mismos con los que la
      // RLS decide si una membresía sigue viva. Comparar aquí con el reloj del
      // proceso podría enseñar como activa a quien la base ya deja fuera.
      const members = await client.query<MembershipRow>(
        `select m.id as "membershipId",
                p.display_name as "name",
                m.role::text as "role",
                m.starts_at as "startsAt",
                m.expires_at as "expiresAt",
                m.revoked_at as "revokedAt",
                (m.revoked_at is not null
                 or (m.expires_at is not null and m.expires_at <= statement_timestamp())) as "accessEnded",
                coalesce(p.must_change_password, false) as "mustChangePassword",
                (statement_timestamp() at time zone 'Europe/Madrid')::date::text as "today"
           from app.household_memberships as m
           left join app.user_profiles as p on p.user_id = m.user_id
          where m.household_id = $1
            and m.role = any($2::app.household_role[])
          order by m.created_at, m.id`,
        [householdId, [...STAFF_ROLES]]
      );

      const today =
        members.rows[0]?.today ??
        (
          await client.query<{ today: string }>(
            `select (statement_timestamp() at time zone 'Europe/Madrid')::date::text as "today"`
          )
        ).rows[0]!.today;

      const membershipIds = members.rows.map((row) => row.membershipId);
      const noRows = { rows: [] as never[] };
      const agreements =
        membershipIds.length > 0
          ? await client.query<StaffAgreementRow>(
              `select id,
                      employee_membership_id as "employeeMembershipId",
                      status::text as "status",
                      starts_on::text as "startsOn",
                      ends_on::text as "endsOn"
                 from app.employment_agreements
                where household_id = $1 and employee_membership_id = any($2::uuid[])
                order by (status = 'active') desc, starts_on desc`,
              [householdId, membershipIds]
            )
          : noRows;

      const agreementIds = agreements.rows.map((row) => row.id);
      const versions =
        agreementIds.length > 0
          ? await client.query<StaffVersionRow>(
              `select id,
                      agreement_id as "agreementId",
                      version_number as "versionNumber",
                      effective_from::text as "effectiveFrom",
                      monthly_salary_cents as "monthlySalaryCents",
                      contracted_weekly_minutes as "contractedWeeklyMinutes",
                      annual_vacation_days as "annualVacationDays",
                      reason
                 from app.agreement_versions
                where household_id = $1 and agreement_id = any($2::uuid[])
                order by version_number`,
              [householdId, agreementIds]
            )
          : noRows;

      return buildStaffOverview(
        householdId,
        today,
        members.rows.map((row) => ({
          membershipId: row.membershipId,
          name: row.name,
          role: row.role,
          startsAt: row.startsAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          accessEnded: row.accessEnded,
          mustChangePassword: row.mustChangePassword
        })),
        agreements.rows,
        versions.rows
      );
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('staff overview unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}
