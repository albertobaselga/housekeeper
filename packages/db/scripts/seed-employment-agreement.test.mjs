// Alta del acuerdo laboral: validación del JSON (sin base) y escritura real
// contra Postgres (solo con TEST_DATABASE_URL).
//
// La batería anterior daba luz verde a un acuerdo MUDO: comprobaba las columnas
// de `app.agreement_versions` y ni miraba `app.extra_work_types`, así que no vio
// que el guion no escribía ni una fila del catálogo de 0021. Aquí el catálogo es
// lo primero que se comprueba, y hay una prueba dedicada a que un JSON sin
// conceptos NO llegue a escribir nada.
//
// Todos los datos de estas pruebas son INVENTADOS. El JSON real del hogar vive
// fuera del repositorio y no se copia aquí ni en parte.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrate.mjs';
import {
  normalizeAgreementConfig,
  relicRates,
  scheduleToText,
  seedEmploymentAgreement
} from './seed-employment-agreement.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;

const HOUSEHOLD = '78000000-0000-4000-8000-000000000001';
const ADMIN_MEMBERSHIP = '78000000-0000-4000-8000-000000000002';
const EMPLOYEE_MEMBERSHIP = '78000000-0000-4000-8000-000000000003';
const OTHER_HOUSEHOLD = '78000000-0000-4000-8000-000000000004';

/**
 * Fichero de ejemplo, con nombres y cifras inventados. Es el caso que pidió el
 * propietario: salario mensual, jornada semanal, 30 días de vacaciones, DOS
 * tipos de jornada extra con tarifa y NINGUNA hora suelta.
 */
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
      annualVacationDays: 30,
      schedule: {
        from: '08:00',
        to: '19:00',
        longBreakMinutes: 120,
        effectiveHoursPerDay: 8,
        weekly: 'Cinco jornadas de lunes a viernes. Fin de semana libre',
        _nota: 'Una nota interna del fichero que no debe viajar al acuerdo'
      },
      extraWorkTypes: [
        {
          code: 'jornada_extra',
          name: 'Jornada extra',
          unit: 'per_shift',
          rateCents: 5000,
          referenceMinutes: 480
        },
        {
          code: 'media_jornada_extra',
          name: 'Media jornada extra',
          unit: 'per_shift',
          rateCents: 2500,
          referenceMinutes: 240
        }
      ],
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

describe('el catálogo de conceptos es obligatorio', () => {
  it('sin `extraWorkTypes` se niega, dice por qué y remite a la pantalla', () => {
    const raw = exampleConfig();
    delete raw.agreement.extraWorkTypes;
    // Que el mensaje explique la consecuencia y no solo la falta: quien lee esto
    // tiene que entender que el destrozo sería irreversible.
    expect(() => normalizeAgreementConfig(raw)).toThrowError(/NO da de alta un acuerdo sin catálogo/);
    expect(() => normalizeAgreementConfig(raw)).toThrowError(/no hay arreglo posible|inmutables/);
    expect(() => normalizeAgreementConfig(raw)).toThrowError(/employment\/acuerdo/);
    // Y que diga cómo decir «aquí no se pacta ningún trabajo extra».
    expect(() => normalizeAgreementConfig(raw)).toThrowError(/"extraWorkTypes": \[\]/);
  });

  it('una lista vacía sí se acepta: es una decisión escrita, no un olvido', () => {
    const config = normalizeAgreementConfig(exampleConfig({ extraWorkTypes: [] }));
    expect(config.version.extraWorkTypes).toEqual([]);
    // Y las columnas reliquia quedan en 0, no heredadas de ningún sitio.
    expect(config.version.overtimeHourlyRateCents).toBe(0);
    expect(config.version.workedRestDayRateCents).toBe(0);
  });

  it('exige de cada concepto lo mismo que 0021, antes de tocar la base', () => {
    const withTypes = (types) => () => normalizeAgreementConfig(exampleConfig({ extraWorkTypes: types }));

    expect(withTypes([{ code: 'Jornada Extra', name: 'X', unit: 'per_shift', rateCents: 1, referenceMinutes: 60 }]))
      .toThrowError(/código en minúsculas/);
    expect(withTypes([{ code: 'jornada_extra', name: 'X', unit: 'por_jornada', rateCents: 1 }]))
      .toThrowError(/unit tiene que ser per_hour, per_shift, fixed_amount/);
    expect(withTypes([{ code: 'jornada_extra', name: 'X', unit: 'per_shift', rateCents: 1 }]))
      .toThrowError(/de cuántos minutos es/);
    expect(withTypes([{ code: 'hora', name: 'X', unit: 'per_hour', rateCents: 1, referenceMinutes: 60 }]))
      .toThrowError(/no lleva duración de referencia/);
    expect(withTypes([{ code: 'jornada_extra', name: 'X', unit: 'per_shift', referenceMinutes: 60 }]))
      .toThrowError(/rateCents falta/);
    expect(
      withTypes([
        { code: 'jornada_extra', name: 'A', unit: 'per_shift', rateCents: 1, referenceMinutes: 60 },
        { code: 'jornada_extra', name: 'B', unit: 'per_shift', rateCents: 2, referenceMinutes: 60 }
      ])
    ).toThrowError(/aparece dos veces/);
  });

  it('un complemento tiene que decir si es dinero para ella o gasto de la casa', () => {
    const withSupplements = (supplements) => () =>
      normalizeAgreementConfig(exampleConfig({ supplements }));

    expect(withSupplements([{ code: 'antiguedad', name: 'Antigüedad', amountCents: 3000 }])).toThrowError(
      /addsToPay falta/
    );
    const config = normalizeAgreementConfig(
      exampleConfig({
        supplements: [
          { code: 'antiguedad', name: 'Antigüedad', amountCents: 3000, addsToPay: true },
          { code: 'seguro_medico', name: 'Seguro médico', amountCents: 4500, addsToPay: false }
        ]
      })
    );
    expect(config.version.supplements.map((row) => [row.code, row.addsToPay])).toEqual([
      ['antiguedad', true],
      ['seguro_medico', false]
    ]);
  });
});

describe('las condiciones de 0002 ya no se pactan a mano', () => {
  it('rechaza las claves que el catálogo sustituyó, diciendo adónde se fueron', () => {
    expect(() => normalizeAgreementConfig(exampleConfig({ overtimeHourlyRateCents: 1000 }))).toThrowError(
      /overtimeHourlyRateCents ya no se pacta aquí[\s\S]*per_hour/
    );
    expect(() => normalizeAgreementConfig(exampleConfig({ workedRestDayRateCents: 5000 }))).toThrowError(
      /workedRestDayRateCents ya no se pacta aquí/
    );
    expect(() => normalizeAgreementConfig(exampleConfig({ allowsHourlyOvertime: false }))).toThrowError(
      /el permiso real es el campo `active`/
    );
  });

  it('deriva las columnas reliquia del catálogo, igual que la pantalla', () => {
    // Sin ningún concepto por horas la tarifa horaria es 0: no hay ninguna
    // cifra por hora escrita en ninguna parte de la base.
    expect(relicRates([])).toEqual({
      overtimeHourlyRateCents: 0,
      workedRestDayRateCents: 0,
      workedRestDayCreditMinutes: 1440
    });
    const config = normalizeAgreementConfig(exampleConfig());
    expect(config.version.overtimeHourlyRateCents).toBe(0);
    // La primera jornada activa manda: 50 € y 480 minutos de crédito.
    expect(config.version.workedRestDayRateCents).toBe(5000);
    expect(config.version.workedRestDayCreditMinutes).toBe(480);

    // Un concepto desactivado no presta su tarifa a la columna reliquia.
    const desactivado = normalizeAgreementConfig(
      exampleConfig({
        extraWorkTypes: [
          { code: 'hora_extra', name: 'Hora', unit: 'per_hour', rateCents: 1400, active: false },
          { code: 'jornada_extra', name: 'Jornada', unit: 'per_shift', rateCents: 5000, referenceMinutes: 480 }
        ]
      })
    );
    expect(desactivado.version.overtimeHourlyRateCents).toBe(0);
  });
});

describe('validación del JSON del acuerdo', () => {
  it('deja lo pactado tal y como va a escribirse', () => {
    const config = normalizeAgreementConfig(exampleConfig());
    expect(config.householdSlug).toBe('casa-ejemplo');
    expect(config.employeeUsername).toBe('lucia');
    expect(config.startsOn).toBe('2026-01-07');
    expect(config.version).toMatchObject({
      // La versión 1 entra en vigor el día en que empieza el acuerdo.
      effectiveFrom: '2026-01-07',
      monthlySalaryCents: 123400,
      contractedWeeklyMinutes: 2400,
      annualVacationDays: 30,
      currencyCode: 'EUR',
      reason: 'Alta inicial del acuerdo'
    });
    expect(config.version.terms.schedule).toContain('Presencia de 08:00 a 19:00.');
    expect(config.version.extraWorkTypes).toEqual([
      {
        code: 'jornada_extra',
        name: 'Jornada extra',
        unit: 'per_shift',
        rateCents: 5000,
        referenceMinutes: 480,
        active: true
      },
      {
        code: 'media_jornada_extra',
        name: 'Media jornada extra',
        unit: 'per_shift',
        rateCents: 2500,
        referenceMinutes: 240,
        active: true
      }
    ]);
  });

  it('firma por la casa la primera family_admin, o la que diga el JSON', () => {
    expect(normalizeAgreementConfig(exampleConfig()).creatorUsername).toBe('rosa');
    expect(normalizeAgreementConfig(exampleConfig({ createdByUsername: 'nuria' })).creatorUsername).toBe(
      'nuria'
    );
    expect(() => normalizeAgreementConfig(exampleConfig({ createdByUsername: 'lucia' }))).toThrowError(
      /no es family_admin/
    );
  });

  it('rechaza lo que no puede ser un acuerdo', () => {
    expect(() =>
      normalizeAgreementConfig({ household: { slug: 'casa-ejemplo' }, people: [] })
    ).toThrowError(/bloque `agreement`/);

    expect(() => normalizeAgreementConfig(exampleConfig({ employeeUsername: 'rosa' }))).toThrowError(
      /solo puede firmarse con employee_live_in o helper/
    );

    expect(() => normalizeAgreementConfig(exampleConfig({ employeeUsername: 'nadie' }))).toThrowError(
      /no está en la lista people/
    );

    expect(() => normalizeAgreementConfig(exampleConfig({ startsOn: '7/1/2026' }))).toThrowError(
      /AAAA-MM-DD/
    );

    expect(() => normalizeAgreementConfig(exampleConfig({ monthlySalaryCents: 1234.5 }))).toThrowError(
      /monthlySalaryCents/
    );

    expect(() => normalizeAgreementConfig(exampleConfig({ schedule: null }))).toThrowError(
      /condiciones de horario/
    );

    expect(() => normalizeAgreementConfig(exampleConfig({ currencyCode: 'USD' }))).toThrowError(
      /Solo se admite EUR/
    );
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
    // TRUNCATE y no DELETE: las versiones del acuerdo y su catálogo son
    // append-only y sus disparadores rechazan cualquier borrado fila a fila
    // (0002_employment.sql, 0021_agreement_terms_catalogue.sql).
    await client.query(
      `truncate app.extra_work_types, app.recurring_supplements, app.agreement_versions,
                app.employment_agreements, app.household_memberships, app.user_profiles,
                app.households cascade`
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
    const config = normalizeAgreementConfig(raw);
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

  it('crea el acuerdo, su versión 1 y EL CATÁLOGO de esa versión', async () => {
    const report = await seed(exampleConfig());
    expect(report).toMatchObject({
      agreementCreated: true,
      versionCreated: true,
      employeeMembershipId: EMPLOYEE_MEMBERSHIP,
      extraWorkTypes: 2,
      registrableTypes: 2,
      supplements: 0
    });

    const { rows } = await client.query(
      `select agreement.starts_on::text as starts_on,
              agreement.status::text as status,
              agreement.created_by_membership_id,
              version.version_number, version.effective_from::text as effective_from,
              version.monthly_salary_cents::text as monthly_salary_cents,
              version.overtime_hourly_rate_cents::text as overtime_hourly_rate_cents,
              version.worked_rest_day_rate_cents::text as worked_rest_day_rate_cents,
              version.worked_rest_day_credit_minutes,
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
      // Derivadas del catálogo: ninguna hora suelta pactada → 0.
      overtime_hourly_rate_cents: '0',
      worked_rest_day_rate_cents: '5000',
      worked_rest_day_credit_minutes: 480,
      contracted_weekly_minutes: 2400,
      annual_vacation_days: 30,
      currency_code: 'EUR',
      reason: 'Alta inicial del acuerdo'
    });
    expect(rows[0].terms.schedule).toContain('Presencia de 08:00 a 19:00.');

    // LO QUE LA BATERÍA ANTERIOR NO MIRABA.
    const catalogue = await client.query(
      `select code, name, unit::text as unit, rate_cents::text as rate_cents,
              reference_minutes, active, sort_order
         from app.extra_work_types where household_id = $1 order by sort_order`,
      [HOUSEHOLD]
    );
    expect(catalogue.rows).toEqual([
      {
        code: 'jornada_extra',
        name: 'Jornada extra',
        unit: 'per_shift',
        rate_cents: '5000',
        reference_minutes: 480,
        active: true,
        sort_order: 10
      },
      {
        code: 'media_jornada_extra',
        name: 'Media jornada extra',
        unit: 'per_shift',
        rate_cents: '2500',
        reference_minutes: 240,
        active: true,
        sort_order: 20
      }
    ]);
    // Y ninguna fila por horas: no hay tarifa horaria que se le pueda enseñar.
    expect(catalogue.rows.some((row) => row.unit === 'per_hour')).toBe(false);
  });

  it('escribe los complementos con su `adds_to_pay` tal cual se pactó', async () => {
    await seed(
      exampleConfig({
        supplements: [
          { code: 'antiguedad', name: 'Antigüedad', amountCents: 3000, addsToPay: true },
          {
            code: 'seguro_medico',
            name: 'Seguro médico',
            amountCents: 4500,
            addsToPay: false,
            startsOn: '2026-02-01'
          }
        ]
      })
    );
    const { rows } = await client.query(
      `select code, amount_cents::text as amount_cents, adds_to_pay,
              starts_on::text as starts_on, active, sort_order
         from app.recurring_supplements where household_id = $1 order by sort_order`,
      [HOUSEHOLD]
    );
    expect(rows).toEqual([
      {
        code: 'antiguedad',
        amount_cents: '3000',
        adds_to_pay: true,
        starts_on: null,
        active: true,
        sort_order: 10
      },
      {
        code: 'seguro_medico',
        amount_cents: '4500',
        adds_to_pay: false,
        starts_on: '2026-02-01',
        active: true,
        sort_order: 20
      }
    ]);
  });

  it('repetirlo no escribe nada', async () => {
    const first = await seed(exampleConfig());
    const second = await seed(exampleConfig());
    expect(second.agreementCreated).toBe(false);
    expect(second.versionCreated).toBe(false);
    expect(second.agreementId).toBe(first.agreementId);

    const counts = await client.query(
      `select (select count(*) from app.employment_agreements)::int as agreements,
              (select count(*) from app.agreement_versions)::int as versions,
              (select count(*) from app.extra_work_types)::int as types`
    );
    expect(counts.rows[0]).toEqual({ agreements: 1, versions: 1, types: 2 });
  });

  it('con --dry-run no deja rastro, ni del acuerdo ni del catálogo', async () => {
    const report = await seed(exampleConfig(), { dryRun: true });
    expect(report.agreementCreated).toBe(true);
    expect(report.extraWorkTypes).toBe(2);
    const { rows } = await client.query(
      `select (select count(*) from app.employment_agreements)::int as agreements,
              (select count(*) from app.extra_work_types)::int as types`
    );
    expect(rows[0]).toEqual({ agreements: 0, types: 0 });
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

  it('si cambió una TARIFA del catálogo también aborta, en vez de decir que todo está igual', async () => {
    await seed(exampleConfig());
    // La media jornada no presta su tarifa a ninguna columna reliquia, así que
    // solo la comparación del catálogo puede ver este cambio.
    const subida = exampleConfig();
    subida.agreement.extraWorkTypes[1].rateCents = 2600;
    await expect(seed(subida)).rejects.toThrowError(/catálogo de conceptos no es el del JSON/);

    const conUnoMas = exampleConfig();
    conUnoMas.agreement.extraWorkTypes.push({
      code: 'noche_de_guardia',
      name: 'Noche de guardia',
      unit: 'fixed_amount',
      rateCents: 5000
    });
    await expect(seed(conUnoMas)).rejects.toThrowError(/catálogo de conceptos no es el del JSON/);
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
