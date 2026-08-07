import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { agreementVersionForDate, type AgreementVersion } from "@casa-clara/domain";

import { CommandRejectedError } from "../sync.js";

/** Suma días a una fecha ISO `YYYY-MM-DD` sin depender de la zona local. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface AgreementFacts {
  employeeMembershipId: UUID;
  status: string;
}

/**
 * Carga el acuerdo bajo RLS: para la empleada solo su propio acuerdo es visible,
 * de modo que "no visible" y "no existe" colapsan en el mismo rechazo.
 */
export async function requireAgreement(
  client: PoolClient,
  householdId: UUID,
  agreementId: UUID,
): Promise<AgreementFacts> {
  const result = await client.query<{ employee_membership_id: string; status: string }>(
    `select employee_membership_id, status
       from app.employment_agreements
      where household_id = $1 and id = $2`,
    [householdId, agreementId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CommandRejectedError("agreement_not_found", "El acuerdo no existe o no es visible");
  }
  return { employeeMembershipId: row.employee_membership_id, status: row.status };
}

/** Versión de acuerdo con las tarifas necesarias para congelar jornadas extra. */
export interface AgreementVersionFacts extends AgreementVersion {
  overtimeHourlyRateCents: bigint;
  workedRestDayRateCents: bigint;
  workedRestDayCreditMinutes: number;
}

/**
 * Lee el historial append-only de versiones y deriva las ventanas de vigencia:
 * cada versión rige desde su `effective_from` hasta el día anterior a la
 * siguiente. El motor puro (`agreementVersionForDate`) decide cuál aplica.
 */
export async function loadAgreementVersions(
  client: PoolClient,
  householdId: UUID,
  agreementId: UUID,
): Promise<AgreementVersionFacts[]> {
  const result = await client.query<{
    id: string;
    effective_from: string;
    monthly_salary_cents: string;
    overtime_hourly_rate_cents: string;
    worked_rest_day_rate_cents: string;
    worked_rest_day_credit_minutes: number;
  }>(
    `select id, effective_from::text as effective_from,
            monthly_salary_cents::text as monthly_salary_cents,
            overtime_hourly_rate_cents::text as overtime_hourly_rate_cents,
            worked_rest_day_rate_cents::text as worked_rest_day_rate_cents,
            worked_rest_day_credit_minutes
       from app.agreement_versions
      where household_id = $1 and agreement_id = $2
      order by version_number`,
    [householdId, agreementId],
  );
  return result.rows.map((row, index) => {
    const next = result.rows[index + 1];
    return {
      id: row.id,
      validFrom: row.effective_from,
      validTo: next ? addDays(next.effective_from, -1) : null,
      monthlySalaryCents: BigInt(row.monthly_salary_cents),
      overtimeHourlyRateCents: BigInt(row.overtime_hourly_rate_cents),
      workedRestDayRateCents: BigInt(row.worked_rest_day_rate_cents),
      workedRestDayCreditMinutes: row.worked_rest_day_credit_minutes,
    };
  });
}

export function versionInForceOn(
  versions: readonly AgreementVersionFacts[],
  onDate: string,
): AgreementVersionFacts {
  try {
    return agreementVersionForDate(versions, onDate) as AgreementVersionFacts;
  } catch {
    throw new CommandRejectedError(
      "no_agreement_version",
      `No hay una versión de acuerdo vigente el ${onDate}`,
    );
  }
}
