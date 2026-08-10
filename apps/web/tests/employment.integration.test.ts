import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEmploymentOverview } from '../src/lib/server/employment.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_web_login';
const MARCH_SETTLEMENT = '12b00000-0000-4000-8000-000000000001';

describe.runIf(Boolean(adminUrl))('expediente laboral desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    // Igual que packages/server/test-support/global-setup.mjs, pero local a esta
    // suite: esquema limpio, migraciones, fixtures y un login sin BYPASSRLS.
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('drop schema if exists app cascade');
      await admin.query('drop schema if exists app_private cascade');
      await admin.query('drop table if exists public.schema_migrations');
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la empleada ve liquidación de marzo pagada y confirmada, crédito permanente y anticipo pendiente', async () => {
    const overview = await loadEmploymentOverview(
      { id: 'fixture:roble:employee' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );

    expect(overview).not.toBeNull();
    expect(overview!.hasEmploymentData).toBe(true);
    expect(overview!.agreement?.status).toBe('active');
    expect(overview!.agreement?.employeeMembershipId).toBe('11000000-0000-4000-8000-000000000003');

    // Trabajo pendiente de acción: la jornada realizada sin aceptación previa
    // espera resolución del administrador; no hay gastos pendientes en fixtures.
    expect(overview!.pendingExtras.map((extra) => extra.id)).toEqual([
      '12400000-0000-4000-8000-000000000005'
    ]);
    expect(overview!.pendingExtras[0]).toMatchObject({
      status: 'performed_pending_resolution',
      durationMinutes: 45,
      acceptable: false,
      performable: false,
      resolvable: true,
      employeeMembershipId: '11000000-0000-4000-8000-000000000003'
    });
    expect(overview!.pendingExpenses).toEqual([]);

    // Liquidación cerrada de marzo: transfer 145330, 8 líneas trazables,
    // pagada al completo (vista settlement_payment_totals) y cobro confirmado.
    const march = overview!.settlements.find((settlement) => settlement.id === MARCH_SETTLEMENT);
    expect(march).toBeDefined();
    expect(march!.status).toBe('closed');
    expect(march!.transferTotalCents).toBe('145330');
    expect(march!.transferTotalLabel).toBe('1.453,30 €');
    expect(march!.paidCents).toBe('145330');
    expect(march!.pendingCents).toBe('0');
    expect(march!.fullyPaid).toBe(true);
    expect(march!.receiptConfirmed).toBe(true);
    expect(march!.paymentStateLabel).toBe('Pagada y cobro confirmado');
    expect(march!.lines).toHaveLength(8);
    expect(march!.payments.map((payment) => payment.amountCents)).toEqual(['80000', '65330']);
    const baseLine = march!.lines.find((line) => line.kind === 'base_salary');
    expect(baseLine?.href).toBe('#version-12100000-0000-4000-8000-000000000001');
    const advanceLine = march!.lines.find((line) => line.kind === 'advance_deduction');
    expect(advanceLine?.amountCents).toBe('-10000');
    expect(advanceLine?.href).toBe('#anticipo-12800000-0000-4000-8000-000000000001');

    // Partes semanales recientes: el fixture trae la semana confirmada de marzo
    // (confirmación manual, no auto-confirmada).
    expect(overview!.recentReports).toHaveLength(1);
    expect(overview!.recentReports[0]).toMatchObject({
      weekStartsOn: '2025-03-10',
      weekEndsOn: '2025-03-16',
      status: 'confirmed',
      autoConfirmed: false,
      statusLabel: 'Confirmado'
    });

    // Saldos: crédito permanente de 1440 min (sin caducidad) y 200,00 € de anticipo.
    const credit = overview!.balances.compensation.find(
      (balance) => balance.balanceType === 'worked_rest_day'
    );
    expect(credit?.balanceMinutes).toBe('1440');
    expect(credit?.minutesLabel).toBe('1 día');
    expect(credit?.permanent).toBe(true);
    const advance = overview!.balances.advances[0];
    expect(advance?.outstandingCents).toBe('20000');

    // Versiones con diff de salario: v2 vigente en 2026-08, +100,00 €.
    expect(overview!.versions.map((version) => version.state)).toEqual(['historica', 'vigente']);
    expect(overview!.versions[1]!.salaryDiffCents).toBe('10000');

    // Devengo proyectado del periodo en curso: salario vigente 1.500,00 € menos
    // la cuota del anticipo aún vivo, más el complemento de antigüedad (30,00 €),
    // que sí es dinero para ella. El seguro médico que paga la casa NO entra en
    // la transferencia por muy vigente que esté, y el plus retirado tampoco.
    // Los gastos de marzo ya liquidados no se vuelven a reembolsar.
    expect(overview!.accrual).not.toBeNull();
    expect(overview!.accrual!.period).toBe('2026-08');
    expect(overview!.accrual!.agreementVersionId).toBe('12100000-0000-4000-8000-000000000002');
    expect(overview!.accrual!.salaryCents).toBe('143000');
    expect(overview!.accrual!.reimbursementCents).toBe('0');
    expect(overview!.accrual!.transferTotalCents).toBe('143000');
    const kinds = overview!.accrual!.lines.map((line) => line.kind);
    expect(kinds).toEqual(['base_salary', 'supplement', 'advance_deduction']);
  });

  it('la empleada ve su saldo de vacaciones del año en curso, con lo anulado listado pero sin contar', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('set row_security = off');
      await admin.query(
        `insert into app.vacation_periods
           (id, household_id, agreement_id, employee_membership_id, starts_on, ends_on, note,
            recorded_by_membership_id)
         values
           ('ea100000-0000-4000-8000-000000000001', $1, $2, $3, '2026-08-01', '2026-08-15',
            'Quincena de agosto', $4),
           ('ea100000-0000-4000-8000-000000000002', $1, $2, $3, '2026-04-06', '2026-04-10',
            'Apuntado por error', $4),
           -- A caballo del fin de año: solo sus ocho días de 2026 cuentan aquí.
           ('ea100000-0000-4000-8000-000000000003', $1, $2, $3, '2026-12-24', '2027-01-05',
            'Navidad', $4)`,
        [
          FIXTURE_HOUSEHOLD,
          '12000000-0000-4000-8000-000000000001',
          '11000000-0000-4000-8000-000000000003',
          '11000000-0000-4000-8000-000000000001'
        ]
      );
      await admin.query(
        `update app.vacation_periods
            set status = 'voided', voided_by_membership_id = $1,
                voided_at = now(), void_reason = 'Las fechas eran otras'
          where id = 'ea100000-0000-4000-8000-000000000002'`,
        ['11000000-0000-4000-8000-000000000001']
      );
    } finally {
      await admin.end();
    }

    const overview = await loadEmploymentOverview(
      { id: 'fixture:roble:employee' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );

    const vacations = overview!.vacations;
    expect(vacations).not.toBeNull();
    expect(vacations!.year).toBe(2026);
    // El acuerdo empezó en 2025, así que 2026 va entero: sin prorrateo.
    expect(vacations!.prorated).toBe(false);
    expect(vacations!.entitledDays).toBe(30);
    // 15 de agosto + 8 de la Navidad que caen en 2026; los 5 anulados, no.
    expect(vacations!.takenDays).toBe(23);
    expect(vacations!.remainingDays).toBe(7);
    expect(vacations!.summaryLabel).toBe('23 de 30 días disfrutados · quedan 7');

    // Los tres periodos se listan, el anulado con su motivo, del más reciente
    // al más antiguo.
    expect(vacations!.periods.map((period) => period.id)).toEqual([
      'ea100000-0000-4000-8000-000000000003',
      'ea100000-0000-4000-8000-000000000001',
      'ea100000-0000-4000-8000-000000000002'
    ]);
    expect(vacations!.periods[2]).toMatchObject({
      voided: true,
      voidReason: 'Las fechas eran otras'
    });

    // El derecho vive en la versión del acuerdo y se enseña en su historial.
    expect(overview!.versions.map((version) => version.annualVacationDays)).toEqual([30, 30]);
    expect(overview!.versions[0]!.vacationDaysLabel).toBe('30 días naturales al año');
  });

  it('la empleada ve los conceptos apuntados a mano: en su cuenta del mes y en su lista', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('set row_security = off');
      await admin.query(
        `insert into app.manual_adjustments
           (id, household_id, agreement_id, employee_membership_id, period_month,
            requested_period_month, label, reason, amount_cents, adds_to_pay,
            deferral_note, recorded_by_membership_id)
         values
           ('eb100000-0000-4000-8000-000000000001', $1, $2, $3, '2026-08-01', '2026-08-01',
            'Gratificación de verano', 'Acordada el 2 de agosto', 15000, true, '', $4),
           -- Consta y no se transfiere: ya se lo pagaron en mano.
           ('eb100000-0000-4000-8000-000000000002', $1, $2, $3, '2026-08-01', '2026-08-01',
            'Anticipo devuelto en mano', 'Devolvió 200 € en efectivo el 12 de agosto',
            -20000, false, '', $4),
           -- Aplazado desde un mes que ya estaba cerrado: la fila lo cuenta.
           ('eb100000-0000-4000-8000-000000000003', $1, $2, $3, '2026-08-01', '2026-07-01',
            'Descuento acordado', 'Rotura de la vitrocerámica, a medias', -5000, true,
            'Se pidió para julio de 2026, pero esa cuenta ya estaba cerrada: se imputa a agosto de 2026.',
            $4),
           ('eb100000-0000-4000-8000-000000000004', $1, $2, $3, '2026-08-01', '2026-08-01',
            'Apuntado por error', 'El importe era otro', 9000, true, '', $4)`,
        [
          FIXTURE_HOUSEHOLD,
          '12000000-0000-4000-8000-000000000001',
          '11000000-0000-4000-8000-000000000003',
          '11000000-0000-4000-8000-000000000001'
        ]
      );
      await admin.query(
        `update app.manual_adjustments
            set status = 'voided', voided_by_membership_id = $1,
                voided_at = now(), void_reason = 'Se apuntó dos veces'
          where id = 'eb100000-0000-4000-8000-000000000004'`,
        ['11000000-0000-4000-8000-000000000001']
      );
    } finally {
      await admin.end();
    }

    const overview = await loadEmploymentOverview(
      { id: 'fixture:roble:employee' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );

    const accrual = overview!.accrual;
    const adjustmentLines = accrual!.lines.filter((line) => line.kind === 'adjustment');
    // Los dos que mueven la transferencia; el anulado no, y el que solo consta
    // tampoco es línea de nada.
    expect(adjustmentLines.map((line) => [line.concept, line.detail, line.amountLabel])).toEqual([
      ['Gratificación de verano', 'Acordada el 2 de agosto', '+150,00 €'],
      ['Descuento acordado', 'Rotura de la vitrocerámica, a medias', '−50,00 €']
    ]);
    expect(accrual!.notedAdjustments).toEqual([
      {
        id: 'eb100000-0000-4000-8000-000000000002',
        label: 'Anticipo devuelto en mano',
        reason: 'Devolvió 200 € en efectivo el 12 de agosto',
        amountLabel: '−200,00 €'
      }
    ]);

    // La lista los trae todos, anulado incluido, con su mes y su explicación.
    expect(overview!.manualAdjustments.map((row) => row.id)).toEqual([
      'eb100000-0000-4000-8000-000000000001',
      'eb100000-0000-4000-8000-000000000002',
      'eb100000-0000-4000-8000-000000000003',
      'eb100000-0000-4000-8000-000000000004'
    ]);
    expect(overview!.manualAdjustments[0]).toMatchObject({
      periodLabel: 'Agosto 2026',
      transferLabel: 'Se suma a la transferencia',
      voided: false
    });
    expect(overview!.manualAdjustments[1]!.transferLabel).toBe('Consta, no se transfiere');
    expect(overview!.manualAdjustments[2]!.deferralNote).toContain('ya estaba cerrada');
    expect(overview!.manualAdjustments[3]).toMatchObject({
      voided: true,
      voidReason: 'Se apuntó dos veces'
    });

    // Y a quien no le corresponde verlos, RLS no le devuelve ninguno.
    const member = await loadEmploymentOverview(
      { id: 'fixture:roble:family' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    expect(member!.manualAdjustments).toEqual([]);
  });

  it('la familia no administradora ve las vacaciones; el apoyo, ni el saldo', async () => {
    // Los días son organización de la casa, no importes: por eso family_member
    // los lee (política `vacation_periods_read` con include_family_member).
    const member = await loadEmploymentOverview(
      { id: 'fixture:roble:family' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    // …pero NO ve las versiones del acuerdo (ahí van los importes), así que sin
    // derecho conocido no se le pinta un saldo inventado.
    expect(member!.versions).toEqual([]);
    expect(member!.vacations).toBeNull();

    const helper = await loadEmploymentOverview(
      { id: 'fixture:roble:helper' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    expect(helper!.vacations).toBeNull();
  });

  it('el rol helper no ve datos laborales y el modelo degrada limpiamente', async () => {
    const overview = await loadEmploymentOverview(
      { id: 'fixture:roble:helper' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    expect(overview).not.toBeNull();
    expect(overview!.hasEmploymentData).toBe(false);
    expect(overview!.agreement).toBeNull();
    expect(overview!.versions).toEqual([]);
    expect(overview!.accrual).toBeNull();
    expect(overview!.settlements).toEqual([]);
    expect(overview!.pendingExtras).toEqual([]);
    expect(overview!.pendingExpenses).toEqual([]);
    expect(overview!.recentReports).toEqual([]);
    expect(overview!.vacations).toBeNull();
    expect(overview!.balances).toEqual({ compensation: [], advances: [] });
  });

  it('un usuario sin membresía en el hogar recibe null y la página cae a la fixture', async () => {
    const overview = await loadEmploymentOverview(
      { id: 'fixture:olivo:employee' },
      FIXTURE_HOUSEHOLD,
      appPool
    );
    expect(overview).toBeNull();
  });
});
