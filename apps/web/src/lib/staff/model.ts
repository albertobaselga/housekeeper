import type { Role } from '@housekeeper/contracts';

import { dateLabel, formatCents, weeklyHoursLabel } from '$lib/employment/model';

/**
 * El personal de la casa: quién trabaja hoy aquí y quién trabajó antes, cada
 * cual con sus contratos.
 *
 * No hay tabla de «empleadas» y no la va a haber. El personal son las
 * membresías cuyo papel es de trabajo y su historia son sus acuerdos con sus
 * versiones, que se apilan sin reescribirse desde la migración 0002. Una tabla
 * paralela sería una segunda verdad que mantener sincronizada con la primera.
 *
 * Este módulo es puro: recibe filas y el día, y no toca ni el reloj ni la base
 * de datos. `staff.server.ts` pone las consultas; aquí solo se decide qué
 * significa lo leído.
 */

/** Papeles que cuentan como personal de la casa. */
export const STAFF_ROLES = ['employee_live_in', 'helper'] as const;

export type StaffStatus = 'trabajando' | 'sin_contrato' | 'anterior';

// --- Filas tal y como salen de Postgres -------------------------------------

export interface StaffMemberRow {
  membershipId: string;
  name: string | null;
  role: Role;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Lo decide el reloj de la base, el mismo con el que decide la RLS. */
  accessEnded: boolean;
  mustChangePassword: boolean;
}

export interface StaffAgreementRow {
  id: string;
  employeeMembershipId: string;
  status: 'active' | 'ended';
  startsOn: string;
  endsOn: string | null;
}

export interface StaffVersionRow {
  id: string;
  agreementId: string;
  versionNumber: number;
  effectiveFrom: string;
  monthlySalaryCents: string;
  contractedWeeklyMinutes: number;
  annualVacationDays: number;
  reason: string;
}

// --- Lo que ve la pantalla --------------------------------------------------

export interface StaffVersionView {
  id: string;
  versionNumber: number;
  effectiveFrom: string;
  effectiveFromLabel: string;
  salaryLabel: string;
  weeklyLabel: string;
  annualVacationDays: number;
  reason: string;
  /** vigente hoy / entra en vigor más adelante / histórica. */
  state: 'vigente' | 'futura' | 'historica';
}

export interface StaffAgreementView {
  id: string;
  status: 'active' | 'ended';
  startsOn: string;
  endsOn: string | null;
  /** «Desde el 3 feb 2025» o «Del 3 feb 2025 al 30 jun 2025». */
  periodLabel: string;
  versions: StaffVersionView[];
}

export interface StaffMemberView {
  membershipId: string;
  name: string;
  role: Role;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: StaffStatus;
  /** Sigue con la contraseña provisional que se le entregó en mano. */
  passwordPending: boolean;
  /** El vigente primero; los anteriores debajo, del más reciente al más viejo. */
  agreements: StaffAgreementView[];
}

export interface StaffOverview {
  householdId: string;
  /** Fecha de la base de datos, la misma con la que decide la RLS. */
  today: string;
  /** Quien trabaja hoy en la casa (con contrato, o con acceso y sin contrato). */
  current: StaffMemberView[];
  /** Quien trabajó antes: acceso retirado o caducado. */
  past: StaffMemberView[];
}

/** «Desde el …» mientras siga abierto; «Del … al …» cuando ya terminó. */
function periodLabelFor(startsOn: string, endsOn: string | null): string {
  return endsOn === null
    ? `Desde el ${dateLabel(startsOn)}`
    : `Del ${dateLabel(startsOn)} al ${dateLabel(endsOn)}`;
}

/**
 * Estado de una versión respecto a hoy. Vigente es la de mayor fecha de efecto
 * que no sea posterior a hoy: la misma regla que aplica el motor de cálculo y
 * la que fija `app.agreement_version_in_force`.
 */
function versionState(
  version: StaffVersionRow,
  siblings: StaffVersionRow[],
  today: string
): StaffVersionView['state'] {
  if (version.effectiveFrom > today) return 'futura';
  const laterInForce = siblings.some(
    (candidate) =>
      candidate.effectiveFrom <= today && candidate.effectiveFrom > version.effectiveFrom
  );
  return laterInForce ? 'historica' : 'vigente';
}

/**
 * Reparte versiones en acuerdos y acuerdos en personas, y decide el estado de
 * cada quien:
 *
 *   · `anterior`     — el acceso está retirado o caducado. Trabajó aquí.
 *   · `trabajando`   — acceso vivo y un acuerdo activo.
 *   · `sin_contrato` — acceso vivo y ningún acuerdo activo. Es un estado real,
 *                      no un error: alguien puede tener acceso mientras se
 *                      pactan sus condiciones, y la pantalla lo dice tal cual
 *                      en vez de fingir un contrato que no existe.
 */
export function buildStaffOverview(
  householdId: string,
  today: string,
  members: StaffMemberRow[],
  agreements: StaffAgreementRow[],
  versions: StaffVersionRow[]
): StaffOverview {
  const versionsByAgreement = new Map<string, StaffVersionRow[]>();
  for (const version of versions) {
    const list = versionsByAgreement.get(version.agreementId) ?? [];
    list.push(version);
    versionsByAgreement.set(version.agreementId, list);
  }

  const agreementsByMembership = new Map<string, StaffAgreementView[]>();
  for (const agreement of agreements) {
    const siblings = versionsByAgreement.get(agreement.id) ?? [];
    const view: StaffAgreementView = {
      id: agreement.id,
      status: agreement.status,
      startsOn: agreement.startsOn,
      endsOn: agreement.endsOn,
      periodLabel: periodLabelFor(agreement.startsOn, agreement.endsOn),
      versions: siblings
        .map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          effectiveFrom: version.effectiveFrom,
          effectiveFromLabel: dateLabel(version.effectiveFrom),
          salaryLabel: formatCents(version.monthlySalaryCents),
          weeklyLabel: weeklyHoursLabel(version.contractedWeeklyMinutes),
          annualVacationDays: version.annualVacationDays,
          reason: version.reason,
          state: versionState(version, siblings, today)
        }))
        // La más reciente arriba: es la que se consulta.
        .sort((left, right) => right.versionNumber - left.versionNumber)
    };
    const list = agreementsByMembership.get(agreement.employeeMembershipId) ?? [];
    list.push(view);
    agreementsByMembership.set(agreement.employeeMembershipId, list);
  }

  const current: StaffMemberView[] = [];
  const past: StaffMemberView[] = [];
  for (const member of members) {
    const own = agreementsByMembership.get(member.membershipId) ?? [];
    const status: StaffStatus = member.accessEnded
      ? 'anterior'
      : own.some((agreement) => agreement.status === 'active')
        ? 'trabajando'
        : 'sin_contrato';
    const view: StaffMemberView = {
      membershipId: member.membershipId,
      name: member.name ?? 'Perfil sin nombre',
      role: member.role,
      startsAt: member.startsAt,
      expiresAt: member.expiresAt,
      revokedAt: member.revokedAt,
      status,
      // Quien ya no entra no tiene contraseña pendiente de la que avisar.
      passwordPending: member.mustChangePassword && !member.accessEnded,
      agreements: own
    };
    (status === 'anterior' ? past : current).push(view);
  }
  return { householdId, today, current, past };
}
