import type { PoolClient } from "pg";

import type { UUID } from "@housekeeper/contracts";
import {
  agreementVersionForDate,
  type AgreementVersion,
  type ExtraWorkType,
  type RecurringSupplement,
} from "@housekeeper/domain";

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

/** Tipo del catálogo (0021) junto con la versión que lo congela. */
export interface CataloguedExtraWorkType extends ExtraWorkType {
  agreementId: string;
  agreementVersionId: string;
}

/**
 * Carga un concepto del catálogo bajo RLS. Para la empleada, la política de
 * 0021 solo devuelve los activos y con tarifa de SU acuerdo: un tipo que no le
 * aplica no es «prohibido», es que no existe, y este rechazo dice exactamente
 * eso sin filtrar si el concepto existe para otra persona.
 */
export async function loadExtraWorkType(
  client: PoolClient,
  householdId: UUID,
  typeId: UUID,
): Promise<CataloguedExtraWorkType> {
  const result = await client.query<{
    id: string;
    agreement_id: string;
    agreement_version_id: string;
    code: string;
    name: string;
    unit: ExtraWorkType["unit"];
    rate_cents: string | null;
    reference_minutes: number | null;
    active: boolean;
  }>(
    `select id, agreement_id, agreement_version_id, code, name, unit::text as unit,
            rate_cents::text as rate_cents, reference_minutes, active
       from app.extra_work_types
      where household_id = $1 and id = $2`,
    [householdId, typeId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CommandRejectedError(
      "extra_work_type_not_available",
      "Ese tipo de trabajo extra no existe o no se aplica en este acuerdo",
    );
  }
  return {
    id: row.id,
    agreementId: row.agreement_id,
    agreementVersionId: row.agreement_version_id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    rateCents: row.rate_cents === null ? null : BigInt(row.rate_cents),
    referenceMinutes: row.reference_minutes,
    active: row.active,
  };
}

/** Complementos recurrentes congelados en una versión del acuerdo. */
export async function loadRecurringSupplements(
  client: PoolClient,
  householdId: UUID,
  agreementVersionId: string,
): Promise<RecurringSupplement[]> {
  const result = await client.query<{
    id: string;
    code: string;
    name: string;
    amount_cents: string | null;
    periodicity: "monthly";
    adds_to_pay: boolean;
    starts_on: string | null;
    ends_on: string | null;
    active: boolean;
  }>(
    `select id, code, name, amount_cents::text as amount_cents, periodicity::text as periodicity,
            adds_to_pay, starts_on::text as starts_on, ends_on::text as ends_on, active
       from app.recurring_supplements
      where household_id = $1 and agreement_version_id = $2
      order by sort_order, code`,
    [householdId, agreementVersionId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    amountCents: row.amount_cents === null ? null : BigInt(row.amount_cents),
    periodicity: row.periodicity,
    addsToPay: row.adds_to_pay,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    active: row.active,
  }));
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
