import { describe, expect, it } from 'vitest';

import {
  buildStaffOverview,
  type StaffAgreementRow,
  type StaffMemberRow,
  type StaffVersionRow
} from '../src/lib/staff/model';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const TODAY = '2026-08-11';

function member(overrides: Partial<StaffMemberRow> & { membershipId: string }): StaffMemberRow {
  return {
    name: 'Sin nombre',
    role: 'employee_live_in',
    startsAt: '2025-02-03T08:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    accessEnded: false,
    mustChangePassword: false,
    ...overrides
  };
}

function version(overrides: Partial<StaffVersionRow> & { id: string; agreementId: string }): StaffVersionRow {
  return {
    versionNumber: 1,
    effectiveFrom: '2025-02-03',
    monthlySalaryCents: '140000',
    contractedWeeklyMinutes: 2400,
    annualVacationDays: 30,
    reason: 'Condiciones iniciales',
    ...overrides
  };
}

describe('el personal de la casa, tal y como se lee', () => {
  it('separa a quien trabaja hoy de quien trabajó antes', () => {
    const members: StaffMemberRow[] = [
      member({ membershipId: 'm-ana', name: 'Ana' }),
      member({ membershipId: 'm-lucia', name: 'Lucía', role: 'helper' }),
      member({
        membershipId: 'm-rosa',
        name: 'Rosa',
        accessEnded: true,
        revokedAt: '2025-12-31T10:00:00.000Z'
      })
    ];
    const agreements: StaffAgreementRow[] = [
      { id: 'a-ana', employeeMembershipId: 'm-ana', status: 'active', startsOn: '2025-02-03', endsOn: null },
      { id: 'a-rosa', employeeMembershipId: 'm-rosa', status: 'ended', startsOn: '2024-01-01', endsOn: '2025-12-31' }
    ];

    const overview = buildStaffOverview(HOUSEHOLD, TODAY, members, agreements, [
      version({ id: 'v-ana', agreementId: 'a-ana' }),
      version({ id: 'v-rosa', agreementId: 'a-rosa', effectiveFrom: '2024-01-01' })
    ]);

    expect(overview.current.map((person) => person.name)).toEqual(['Ana', 'Lucía']);
    expect(overview.past.map((person) => person.name)).toEqual(['Rosa']);
    expect(overview.current[0]!.status).toBe('trabajando');
    // Apoyo con acceso vivo y sin contrato: es un estado real, no un error.
    expect(overview.current[1]!.status).toBe('sin_contrato');
    expect(overview.past[0]!.status).toBe('anterior');
    // Y quien se fue conserva su contrato en el historial, con su periodo.
    expect(overview.past[0]!.agreements[0]!.periodLabel).toBe('Del 1 ene 2024 al 31 dic 2025');
    expect(overview.current[0]!.agreements[0]!.periodLabel).toBe('Desde el 3 feb 2025');
  });

  it('un acceso caducado cuenta como anterior aunque no esté revocado', () => {
    // `accessEnded` lo decide la base con su propio reloj; el modelo no vuelve
    // a mirar la hora, precisamente para no discrepar de la RLS.
    const overview = buildStaffOverview(
      HOUSEHOLD,
      TODAY,
      [member({ membershipId: 'm-eva', name: 'Eva', expiresAt: '2026-01-01T00:00:00.000Z', accessEnded: true })],
      [],
      []
    );
    expect(overview.past.map((person) => person.name)).toEqual(['Eva']);
    expect(overview.current).toEqual([]);
  });

  it('ordena las versiones de la más reciente a la más antigua y marca cuál rige', () => {
    const overview = buildStaffOverview(
      HOUSEHOLD,
      TODAY,
      [member({ membershipId: 'm-ana', name: 'Ana' })],
      [{ id: 'a-ana', employeeMembershipId: 'm-ana', status: 'active', startsOn: '2025-02-03', endsOn: null }],
      [
        version({ id: 'v1', agreementId: 'a-ana', versionNumber: 1, effectiveFrom: '2025-02-03' }),
        version({ id: 'v2', agreementId: 'a-ana', versionNumber: 2, effectiveFrom: '2026-01-01' }),
        version({ id: 'v3', agreementId: 'a-ana', versionNumber: 3, effectiveFrom: '2026-12-01' })
      ]
    );

    const versions = overview.current[0]!.agreements[0]!.versions;
    expect(versions.map((entry) => entry.versionNumber)).toEqual([3, 2, 1]);
    expect(versions.map((entry) => entry.state)).toEqual(['futura', 'vigente', 'historica']);
  });

  it('traduce el dinero y la jornada sin que la pantalla tenga que saber de céntimos', () => {
    const overview = buildStaffOverview(
      HOUSEHOLD,
      TODAY,
      [member({ membershipId: 'm-ana', name: 'Ana' })],
      [{ id: 'a-ana', employeeMembershipId: 'm-ana', status: 'active', startsOn: '2025-02-03', endsOn: null }],
      [version({ id: 'v1', agreementId: 'a-ana', monthlySalaryCents: '152175', contractedWeeklyMinutes: 2430 })]
    );
    const shown = overview.current[0]!.agreements[0]!.versions[0]!;
    expect(shown.salaryLabel).toContain('1.521,75');
    expect(shown.weeklyLabel).toBe('40 h 30 min a la semana');
  });

  it('no avisa de contraseña provisional a quien ya no entra', () => {
    const overview = buildStaffOverview(
      HOUSEHOLD,
      TODAY,
      [
        member({ membershipId: 'm-nueva', name: 'Nueva', mustChangePassword: true }),
        member({ membershipId: 'm-ida', name: 'Ida', mustChangePassword: true, accessEnded: true })
      ],
      [],
      []
    );
    expect(overview.current[0]!.passwordPending).toBe(true);
    expect(overview.past[0]!.passwordPending).toBe(false);
  });

  it('una persona sin nombre de perfil no aparece en blanco', () => {
    const overview = buildStaffOverview(
      HOUSEHOLD,
      TODAY,
      [member({ membershipId: 'm-x', name: null })],
      [],
      []
    );
    expect(overview.current[0]!.name).toBe('Perfil sin nombre');
  });
});
