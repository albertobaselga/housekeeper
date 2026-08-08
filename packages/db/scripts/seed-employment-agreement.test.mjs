// Alta del acuerdo laboral: validación del JSON (sin base) y escritura real
// contra Postgres (solo con TEST_DATABASE_URL).
//
// Todos los datos de estas pruebas son INVENTADOS. El JSON real del hogar vive
// fuera del repositorio y no se copia aquí ni en parte.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrate.mjs';
import {
  normalizeAgreementConfig,
  scheduleToText,
  seedEmploymentAgreement
} from './seed-employment-agreement.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;

const HOUSEHOLD = '78000000-0000-4000-8000-000000000001';
const ADMIN_MEMBERSHIP = '78000000-0000-4000-8000-000000000002';
const EMPLOYEE_MEMBERSHIP = '78000000-0000-4000-8000-000000000003';
const OTHER_HOUSEHOLD = '78000000-0000-4000-8000-000000000004';

/** Fichero de ejemplo, con nombres y cifras inventados. */
function exampleConfig(overrides = {}) {
  return {
    household: { slug: 'casa-ejemplo', displayName: 'Casa Ejemplo' },
    people: [
      { username: 'rosa', name: 'Rosa', email: 'rosa@ejemplo.test', role: 'family_admin' },
      { username: 'nuria', name: 'Nuria', email: 'nuria@ejemplo.test', role: 'family_admin' },
      { username: 'lucia', name: 'Lucía', email: 'lucia@casa.local', role: 'employee_live_in' }
    ],
    agreement: {
      employeeUsername: 'lucia',
      startsOn: '2026-01-07',
      monthlySalaryCents: 123400,
      currencyCode: 'EUR',
      contractedWeeklyMinutes: 2400,
      workedRestDayRateCents: 5000,
      annualVacationDays: 30,
      schedule: {
        from: '08:00',
        to: '19:00',
        longBreakMinutes: 120,
        effectiveHoursPerDay: 8,
        weekly: 'Cinco jornadas de lunes a viernes. Fin de semana libre',
        _nota: 'Una nota interna del fichero que no debe viajar al acuerdo'
      },
      ...overrides
    }
  };
}

describe('condiciones de horario como texto', () => {
  it('redacta los campos sueltos en una frase y descarta las notas internas', () => {
    const text = scheduleToText(exampleConfig().agreement.schedule);
    expect(text).toBe(
      'Presencia de 08:00 a 19:00. Descanso largo de 120 minutos. Jornada efectiva de 8 h al día. ' +
        'Cinco jornadas de lunes a viernes. Fin de semana libre.'
    );
    expect(text).not.toContain('nota interna');
  });

  it('usa tal cual el texto ya escrito y trata el vacío como ausencia', () => {
    expect(scheduleToText('  De 9 a 17, con una hora para comer.  ')).toBe(
      'De 9 a 17, con una hora para comer.'
    );
    expect(scheduleToText('   ')).toBeNull();
    expect(scheduleToText(null)).toBeNull();
  });
});

describe('validación del JSON del acuerdo', () => {
  it('EXIGE la tarifa de hora extraordinaria y no la inventa', () => {
    expect(() => normalizeAgreementConfig(exampleConfig())).toThrowError(
      /tarifa de hora extraordinaria[\s\S]*NO la inventa/
    );
    // El mensaje tiene que decir CÓMO arreglarlo, no solo que falta.
    expect(() => normalizeAgreementConfig(exampleConfig())).toThrowError(
      /overtimeHourlyRateCents|--overtime-hourly-rate-cents/
    );
  });

  it('la acepta del JSON o del argumento, y el argumento manda', () => {
    const fromJson = normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 900 }));
    expect(fromJson.version.overtimeHourlyRateCents).toBe(900);

    const fromFlag = normalizeAgreementConfig(exampleConfig(), { overtimeHourlyRateCents: 1000 });
    expect(fromFlag.version.overtimeHourlyRateCents).toBe(1000);

    const both = normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 900 }), {
      overtimeHourlyRateCents: 1000
    });
    expect(both.version.overtimeHourlyRateCents).toBe(1000);
  });

  it('deja lo pactado tal y como va a escribirse', () => {
    const config = normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 1000 }));
    expect(config.householdSlug).toBe('casa-ejemplo');
    expect(config.employeeUsername).toBe('lucia');
    expect(config.startsOn).toBe('2026-01-07');
    expect(config.version).toMatchObject({
      // La versión 1 entra en vigor el día en que empieza el acuerdo.
      effectiveFrom: '2026-01-07',
      monthlySalaryCents: 123400,
      workedRestDayRateCents: 5000,
      workedRestDayCreditMinutes: 1440,
      contractedWeeklyMinutes: 2400,
      annualVacationDays: 30,
      currencyCode: 'EUR',
      reason: 'Alta inicial del acuerdo'
    });
    expect(config.version.terms.schedule).toContain('Presencia de 08:00 a 19:00.');
  });

  it('firma por la casa la primera family_admin, o la que diga el JSON', () => {
    const byDefault = normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 1000 }));
    expect(byDefault.creatorUsername).toBe('rosa');

    const declared = normalizeAgreementConfig(
      exampleConfig({ overtimeHourlyRateCents: 1000, createdByUsername: 'nuria' })
    );
    expect(declared.creatorUsername).toBe('nuria');

    expect(() =>
      normalizeAgreementConfig(
        exampleConfig({ overtimeHourlyRateCents: 1000, createdByUsername: 'lucia' })
      )
    ).toThrowError(/no es family_admin/);
  });

  it('rechaza lo que no puede ser un acuerdo', () => {
    expect(() =>
      normalizeAgreementConfig({ household: { slug: 'casa-ejemplo' }, people: [] })
    ).toThrowError(/bloque `agreement`/);

    expect(() =>
      normalizeAgreementConfig(
        exampleConfig({ overtimeHourlyRateCents: 1000, employeeUsername: 'rosa' })
      )
    ).toThrowError(/solo puede firmarse con employee_live_in o helper/);

    expect(() =>
      normalizeAgreementConfig(
        exampleConfig({ overtimeHourlyRateCents: 1000, employeeUsername: 'nadie' })
      )
    ).toThrowError(/no está en la lista people/);

    expect(() =>
      normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 1000, startsOn: '7/1/2026' }))
    ).toThrowError(/AAAA-MM-DD/);

    expect(() =>
      normalizeAgreementConfig(
        exampleConfig({ overtimeHourlyRateCents: 1000, monthlySalaryCents: 1234.5 })
      )
    ).toThrowError(/monthlySalaryCents/);

    expect(() =>
      normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 1000, schedule: null }))
    ).toThrowError(/condiciones de horario/);

    expect(() =>
      normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 1000, currencyCode: 'USD' }))
    ).toThrowError(/Solo se admite EUR/);
  });
});

describe.runIf(Boolean(adminUrl))('alta del acuerdo contra Postgres', () => {
  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema if exists app_private cascade');
    await client.query('drop table if exists public.schema_migrations');
    await applyMigrations(client);
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query('begin');
    await client.query('set local row_security = off');
    // TRUNCATE y no DELETE: las versiones del acuerdo son append-only y su
    // disparador rechaza cualquier borrado fila a fila (0002_employment.sql).
    await client.query(
      `truncate app.agreement_versions, app.employment_agreements,
                app.household_memberships, app.user_profiles, app.households cascade`
    );
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'casa-ejemplo', 'Casa Ejemplo'), ($2, 'otra-casa', 'Otra Casa')`,
      [HOUSEHOLD, OTHER_HOUSEHOLD]
    );
    await client.query(
      `insert into app.user_profiles (user_id, display_name, email) values
         ('fixture:rosa', 'Rosa', 'rosa@ejemplo.test'),
         ('fixture:nuria', 'Nuria', 'nuria@ejemplo.test'),
         ('fixture:lucia', 'Lucía', 'lucia@casa.local')`
    );
    await client.query(
      `insert into app.household_memberships (id, household_id, user_id, role) values
         ($1, $3, 'fixture:rosa', 'family_admin'),
         ($2, $3, 'fixture:lucia', 'employee_live_in')`,
      [ADMIN_MEMBERSHIP, EMPLOYEE_MEMBERSHIP, HOUSEHOLD]
    );
    await client.query('commit');
  });

  /** Ejecuta el alta en su propia transacción, como hace el guion. */
  async function seed(raw, options = {}) {
    const config = normalizeAgreementConfig(raw, { overtimeHourlyRateCents: 1000 });
    await client.query('begin');
    await client.query('set local row_security = off');
    try {
      const report = await seedEmploymentAgreement(client, config, options);
      await client.query(options.dryRun ? 'rollback' : 'commit');
      return report;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  it('crea el acuerdo y su versión 1 con lo pactado', async () => {
    const report = await seed(exampleConfig());
    expect(report.agreementCreated).toBe(true);
    expect(report.versionCreated).toBe(true);
    expect(report.employeeMembershipId).toBe(EMPLOYEE_MEMBERSHIP);

    const { rows } = await client.query(
      `select agreement.starts_on::text as starts_on,
              agreement.status::text as status,
              agreement.created_by_membership_id,
              version.version_number, version.effective_from::text as effective_from,
              version.monthly_salary_cents::text as monthly_salary_cents,
              version.overtime_hourly_rate_cents::text as overtime_hourly_rate_cents,
              version.worked_rest_day_rate_cents::text as worked_rest_day_rate_cents,
              version.contracted_weekly_minutes, version.annual_vacation_days,
              version.currency_code, version.terms, version.reason
         from app.employment_agreements as agreement
         join app.agreement_versions as version
           on version.agreement_id = agreement.id
        where agreement.household_id = $1`,
      [HOUSEHOLD]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      starts_on: '2026-01-07',
      status: 'active',
      created_by_membership_id: ADMIN_MEMBERSHIP,
      version_number: 1,
      effective_from: '2026-01-07',
      monthly_salary_cents: '123400',
      overtime_hourly_rate_cents: '1000',
      worked_rest_day_rate_cents: '5000',
      contracted_weekly_minutes: 2400,
      annual_vacation_days: 30,
      currency_code: 'EUR',
      reason: 'Alta inicial del acuerdo'
    });
    expect(rows[0].terms.schedule).toContain('Presencia de 08:00 a 19:00.');
  });

  it('repetirlo no escribe nada', async () => {
    const first = await seed(exampleConfig());
    const second = await seed(exampleConfig());
    expect(second.agreementCreated).toBe(false);
    expect(second.versionCreated).toBe(false);
    expect(second.agreementId).toBe(first.agreementId);

    const counts = await client.query(
      `select (select count(*) from app.employment_agreements)::int as agreements,
              (select count(*) from app.agreement_versions)::int as versions`
    );
    expect(counts.rows[0]).toEqual({ agreements: 1, versions: 1 });
  });

  it('con --dry-run no deja rastro', async () => {
    const report = await seed(exampleConfig(), { dryRun: true });
    expect(report.agreementCreated).toBe(true);
    const { rows } = await client.query('select count(*)::int as total from app.employment_agreements');
    expect(rows[0].total).toBe(0);
  });

  it('si lo pactado cambió, manda añadir una versión desde la aplicación', async () => {
    await seed(exampleConfig());
    await expect(seed(exampleConfig({ monthlySalaryCents: 130000 }))).rejects.toThrowError(
      /versiones son inmutables[\s\S]*versión nueva desde la aplicación/
    );
    await expect(seed(exampleConfig({ startsOn: '2026-02-02' }))).rejects.toThrowError(
      /ya tiene un acuerdo activo que empezó el 2026-01-07/
    );
  });

  it('sin cuentas dadas de alta lo dice y manda ejecutar el otro guion', async () => {
    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query('delete from app.household_memberships where id = $1', [EMPLOYEE_MEMBERSHIP]);
    await client.query('commit');
    await expect(seed(exampleConfig())).rejects.toThrowError(/seed:accounts/);
  });

  it('sin hogar dado de alta no inventa uno', async () => {
    const config = exampleConfig();
    config.household.slug = 'casa-que-no-existe';
    await expect(seed(config)).rejects.toThrowError(/No existe ningún hogar con slug/);
  });
});
