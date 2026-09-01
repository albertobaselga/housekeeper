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

  it('la empleada ve su saldo del año de CONTRATO en curso, con lo anulado listado pero sin contar', async () => {
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
           -- Navidad entera: el año de contrato de este acuerdo va del 3 de
           -- febrero al 2 de febrero, así que estos trece días caen dentro y no
           -- se reparten con nadie. Con el año natural se partían en 8 y 5.
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
    // El contrato empezó el 3 de febrero de 2025: en agosto de 2026 se está en
    // su segundo año, y el año se dice con sus fechas.
    expect(vacations!.yearLabel).toBe('Segundo año · 3 feb 2026 – 2 feb 2027');
    // El acuerdo sigue vivo, así que el año va entero: sin prorrateo.
    expect(vacations!.prorated).toBe(false);
    expect(vacations!.entitledDays).toBe(30);
    // 15 de agosto + los 13 de Navidad, que ya no se parten; los 5 anulados, no.
    expect(vacations!.takenDays).toBe(28);
    expect(vacations!.remainingDays).toBe(2);
    expect(vacations!.summaryLabel).toBe('28 de 30 días disfrutados · quedan 2');

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

    // Ella ve los suyos con su mes y su explicación, incluido el que se aplazó
    // desde un mes cerrado. El anulado NO está: ninguna nómina lo llegó a
    // aplicar y ya no hay nada que decidir sobre él, así que deja de ocupar
    // sitio en una pantalla que solo enseña lo que sigue vivo. Su rastro sigue
    // entero en la base: la tabla es append-only y nada se ha borrado.
    // Se comparan ordenados y se busca cada uno por su id: los cuatro se
    // apuntaron en el mismo mes y en la misma sentencia, así que comparten
    // `recorded_at` al microsegundo y entre ellos no hay orden que exigir.
    const suyos = overview!.manualAdjustments;
    expect(suyos.map((row) => row.id).sort()).toEqual([
      'eb100000-0000-4000-8000-000000000001',
      'eb100000-0000-4000-8000-000000000002',
      'eb100000-0000-4000-8000-000000000003'
    ]);
    const porId = (id: string) => suyos.find((row) => row.id.endsWith(id))!;
    expect(porId('001')).toMatchObject({
      periodLabel: 'Agosto 2026',
      transferLabel: 'Se suma a la transferencia',
      voided: false
    });
    expect(porId('002').transferLabel).toBe('Consta, no se transfiere');
    expect(porId('003').deferralNote).toContain('ya estaba cerrada');
    expect(suyos.some((row) => row.voided)).toBe(false);

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
    expect(overview!.vacations).toBeNull();
    expect(overview!.balances).toEqual({ compensation: [], advances: [] });
  });

  it('la empleada ve su horario en lenguaje llano y nadie más lo alcanza', async () => {
    const employee = await loadEmploymentOverview(
      { id: 'fixture:roble:employee' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    const schedule = employee!.terms!.schedule;
    expect(schedule).not.toBeNull();
    expect(schedule!.sentence).toBe(
      'De 8:00 a 16:30, con hora y media de descanso al mediodía. Sábado hasta las 14:30. Domingo libre.'
    );
    expect(schedule!.restDayLabels).toEqual(['Domingo']);
    // Cuadra con los 2400 minutos contratados de esa versión: sin aviso.
    expect(schedule!.mismatchLabel).toBeNull();

    const admin = await loadEmploymentOverview(
      { id: 'fixture:roble:admin' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    expect(admin!.terms!.schedule!.sentence).toBe(schedule!.sentence);

    /*
     * PRUEBA NEGATIVA. La frontera es la de `agreement_versions_read`: quien no
     * administra y no es la interesada no ve el horario. Y no se comprueba
     * mirando la vista —que podría estar null por otra razón— sino contando las
     * filas que Postgres deja salir a cada rol.
     */
    for (const [user, membership] of [
      ['fixture:roble:family', '11000000-0000-4000-8000-000000000002'],
      ['fixture:roble:helper', '11000000-0000-4000-8000-000000000004'],
      ['fixture:roble:viewer', '11000000-0000-4000-8000-000000000005']
    ] as const) {
      const client = await appPool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.user_id', $1, true)`, [user]);
        await client.query('select app.set_household_context($1, $2)', [
          FIXTURE_HOUSEHOLD,
          membership
        ]);
        const schedules = await client.query('select count(*)::int as total from app.agreement_schedules');
        const days = await client.query('select count(*)::int as total from app.agreement_schedule_days');
        expect(schedules.rows[0]!.total, `${user} alcanzó una jornada tipo`).toBe(0);
        expect(days.rows[0]!.total, `${user} alcanzó un día del horario`).toBe(0);
      } finally {
        await client.query('rollback').catch(() => {});
        client.release();
      }
    }

    // Cruce entre hogares: la empleada del olivo tiene SU horario y ni una sola
    // fila del roble, aunque pregunte por el identificador del vecino.
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', 'fixture:olivo:employee', true)`);
      await client.query('select app.set_household_context($1, $2)', [
        '20000000-0000-4000-8000-000000000001',
        '21000000-0000-4000-8000-000000000002'
      ]);
      const own = await client.query('select count(*)::int as total from app.agreement_schedules');
      expect(own.rows[0]!.total).toBe(1);
      const alien = await client.query(
        'select count(*)::int as total from app.agreement_schedules where household_id = $1',
        [FIXTURE_HOUSEHOLD]
      );
      expect(alien.rows[0]!.total).toBe(0);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  });

  it('el horario que no cuadra con la jornada contratada se denuncia en la vista', async () => {
    // El olivo lo tiene así a propósito: de 8:00 a 20:00 con dos horas de
    // descanso y solo el domingo libre son 60 h frente a las 40 contratadas.
    const overview = await loadEmploymentOverview(
      { id: 'fixture:olivo:employee' },
      '20000000-0000-4000-8000-000000000001',
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    const schedule = overview!.terms!.schedule!;
    expect(schedule.matchesContract).toBe(false);
    expect(schedule.mismatchLabel).toBe(
      'El horario suma 60 h a la semana y la jornada contratada dice 40 h: sobran 20 h.'
    );
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
