import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CommandAckV1, CommandEnvelopeV1 } from '@housekeeper/contracts';
import { employmentCommandHandlers, processSyncBatch } from '@housekeeper/server';

import { buildExtraWorkTypeView } from '../src/lib/employment/model';
import {
  createAgreement,
  loadAgreementAdmin,
  stackAgreementVersion
} from '../src/lib/server/agreement-terms.server';
import { loadEmploymentOverview } from '../src/lib/server/employment.server';

/*
 * ALTA DE UN ACUERDO DESDE CERO, y el caso real que viene ahora.
 *
 * El hogar de las fixtures ya trae un acuerdo hecho, así que ninguna batería
 * recorría el camino que de verdad se va a usar contra datos reales: un hogar
 * con personas y SIN acuerdo, y la pantalla `/employment/acuerdo` dándolo de
 * alta con su catálogo. Este fichero lo recorre entero y termina donde importa:
 * la empleada registrando una jornada extra el mismo día.
 *
 * Lo pactado aquí es lo que pidió el propietario:
 *   · salario mensual y jornada semanal;
 *   · 30 días naturales de vacaciones;
 *   · DOS tipos de jornada extra con tarifa —una completa de 480 minutos y una
 *     media de 240—;
 *   · y NINGUNA hora suelta: no se crea ningún concepto `per_hour`, que es toda
 *     la desactivación que hace falta. Una fila que no existe no se puede
 *     enseñar por descuido.
 *
 * La promesa fuerte se comprueba sobre los DATOS QUE VIAJAN AL NAVEGADOR, no
 * sobre lo que se pinta: el expediente que el servidor serializa hacia la página
 * se convierte a JSON y se busca dentro cualquier rastro de tarifa por hora. Un
 * filtro de plantilla no pasaría esta prueba, y ese es el objetivo.
 *
 * Base propia, como las suites de comida y wiki: todas recrean el esquema.
 */
const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_alta_login';
const ALTA_DB = 'housekeeper_alta_it';

const HOUSEHOLD = '7a000000-0000-4000-8000-000000000001';
const ADMIN_MEMBERSHIP = '7a000000-0000-4000-8000-000000000002';
const EMPLOYEE_MEMBERSHIP = '7a000000-0000-4000-8000-000000000003';
/** Apoyo del hogar: existe en la casa y NO puede tener contrato. */
const HELPER_MEMBERSHIP = '7a000000-0000-4000-8000-000000000004';

const ADMIN_USER = { id: 'fixture:alta:admin' };
const EMPLOYEE_USER = { id: 'fixture:alta:employee' };
const HELPER_USER = { id: 'fixture:alta:helper' };
/** `processSyncBatch` pide un principal, no el `{ id }` de los cargadores. */
const EMPLOYEE_PRINCIPAL = { userId: EMPLOYEE_USER.id };

/** El acuerdo empieza y rige desde el mismo día; el trabajo se registra dentro. */
const STARTS_ON = '2029-01-08';
const WORKED_ON = '2029-01-20';
const TODAY = new Date('2029-01-20T09:00:00Z');

/** Un hogar recién dado de alta: personas, sin acuerdo, sin nada más. */
const HOUSEHOLD_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.households (id, slug, display_name)
VALUES ('${HOUSEHOLD}', 'casa-de-la-prueba', 'Casa de la Prueba');

INSERT INTO app.user_profiles (user_id, display_name, email) VALUES
  ('${ADMIN_USER.id}', 'Prueba Administradora', 'admin@ejemplo.test'),
  ('${EMPLOYEE_USER.id}', 'Prueba Empleada', 'empleada@ejemplo.test'),
  ('${HELPER_USER.id}', 'Prueba Apoyo', 'apoyo@ejemplo.test');

INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('${ADMIN_MEMBERSHIP}', '${HOUSEHOLD}', '${ADMIN_USER.id}', 'family_admin'),
  ('${EMPLOYEE_MEMBERSHIP}', '${HOUSEHOLD}', '${EMPLOYEE_USER.id}', 'employee_live_in'),
  ('${HELPER_MEMBERSHIP}', '${HOUSEHOLD}', '${HELPER_USER.id}', 'helper');

COMMIT;
`;

function altaUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${ALTA_DB}`;
  return url.toString();
}

/** Lo que la pantalla de alta envía tras rellenar el formulario del caso real. */
function realCaseInput() {
  return {
    employeeMembershipId: EMPLOYEE_MEMBERSHIP,
    startsOn: STARTS_ON,
    terms: {
      effectiveFrom: STARTS_ON,
      monthlySalaryCents: '150000',
      contractedWeeklyMinutes: 2400,
      annualVacationDays: 30,
      reason: 'Alta inicial del acuerdo',
      extraWorkTypes: [
        {
          code: 'jornada_extra',
          name: 'Jornada extra',
          unit: 'per_shift' as const,
          rateCents: '5000',
          referenceMinutes: 480,
          active: true
        },
        {
          code: 'media_jornada_extra',
          name: 'Media jornada extra',
          unit: 'per_shift' as const,
          rateCents: '2500',
          referenceMinutes: 240,
          active: true
        }
      ],
      supplements: [
        {
          code: 'antiguedad',
          name: 'Complemento de antigüedad',
          amountCents: '3000',
          periodicity: 'monthly' as const,
          addsToPay: true,
          startsOn: null,
          endsOn: null,
          active: true
        }
      ]
    }
  };
}

describe.runIf(Boolean(adminUrl))('alta del acuerdo desde cero, con su catálogo', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let agreementId: string;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${ALTA_DB} with (force)`);
      await cluster.query(`create database ${ALTA_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: altaUrlFor(adminUrl as string) });
    await admin.connect();
    try {
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      // Las fixtures NO se cargan a propósito: el asunto de esta batería es un
      // hogar que todavía no tiene acuerdo, y las fixtures traen uno hecho.
      await admin.query(HOUSEHOLD_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: altaUrlFor(adminUrl as string), max: 2 });
    const url = new URL(altaUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it('la pantalla ofrece a la empleada sin acuerdo, y antes del alta no hay nada que enseñarle', async () => {
    const overview = await loadAgreementAdmin(ADMIN_USER, HOUSEHOLD, appPool, TODAY);
    expect(overview).not.toBeNull();
    expect(overview!.agreements).toEqual([]);
    // Acaba de llegar: nunca tuvo contrato en esta casa. La distinción es de la
    // portada, que ofrece «pactar su contrato» diciendo cuál de las dos
    // historias es —volver a la casa no es lo mismo que llegar por primera vez—.
    expect(overview!.candidates).toEqual([
      {
        membershipId: EMPLOYEE_MEMBERSHIP,
        name: 'Prueba Empleada',
        previousEndedOn: null,
        returning: false
      }
    ]);

    const mine = await loadEmploymentOverview(EMPLOYEE_USER, HOUSEHOLD, appPool, TODAY);
    expect(mine?.hasEmploymentData ?? false).toBe(false);
  });

  it('el alta escribe acuerdo, versión Y catálogo en una sola transacción', async () => {
    const result = await createAgreement(ADMIN_USER, HOUSEHOLD, realCaseInput() as never, appPool);
    expect(result).toMatchObject({ ok: true });
    agreementId = (result as { agreementId: string }).agreementId;

    const written = await adminPool.query<{
      version_number: number;
      annual_vacation_days: number;
      monthly_salary_cents: string;
      overtime_hourly_rate_cents: string;
      worked_rest_day_rate_cents: string;
      worked_rest_day_credit_minutes: number;
    }>(
      `select version_number, annual_vacation_days,
              monthly_salary_cents::text as monthly_salary_cents,
              overtime_hourly_rate_cents::text as overtime_hourly_rate_cents,
              worked_rest_day_rate_cents::text as worked_rest_day_rate_cents,
              worked_rest_day_credit_minutes
         from app.agreement_versions where agreement_id = $1`,
      [agreementId]
    );
    expect(written.rows).toEqual([
      {
        version_number: 1,
        annual_vacation_days: 30,
        monthly_salary_cents: '150000',
        // La reliquia de 0002 queda en cero porque no hay concepto por horas:
        // no queda escrita NINGUNA tarifa horaria en toda la base.
        overtime_hourly_rate_cents: '0',
        worked_rest_day_rate_cents: '5000',
        worked_rest_day_credit_minutes: 480
      }
    ]);

    const catalogue = await adminPool.query<{ code: string; unit: string; rate_cents: string }>(
      `select code, unit::text as unit, rate_cents::text as rate_cents
         from app.extra_work_types where agreement_id = $1 order by sort_order`,
      [agreementId]
    );
    expect(catalogue.rows).toEqual([
      { code: 'jornada_extra', unit: 'per_shift', rate_cents: '5000' },
      { code: 'media_jornada_extra', unit: 'per_shift', rate_cents: '2500' }
    ]);

    // El complemento pactado como dinero para ella se guarda como tal.
    const supplements = await adminPool.query<{ code: string; adds_to_pay: boolean }>(
      `select code, adds_to_pay from app.recurring_supplements where agreement_id = $1`,
      [agreementId]
    );
    expect(supplements.rows).toEqual([{ code: 'antiguedad', adds_to_pay: true }]);
  });

  it('el apoyo del hogar no puede acabar con contrato, aunque le cuelen su identificador', async () => {
    /*
     * El identificador de la persona viaja en un campo OCULTO del formulario, y
     * la pantalla sólo lo desaconseja con prosa: los dos botones de la etapa 2
     * eran igual de pulsables con cualquier papel. Demostrado en revisión: un
     * alta con `role=helper` y «Dar de alta con su contrato» creaba el acuerdo y
     * la línea en la lista de personas empleadas, que es exactamente lo que el
     * diseño prohíbe («no genera contrato ni línea en esta lista»).
     *
     * La reja está en el servidor, no en la plantilla.
     */
    const result = await createAgreement(
      ADMIN_USER,
      HOUSEHOLD,
      { ...realCaseInput(), employeeMembershipId: HELPER_MEMBERSHIP } as never,
      appPool
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Sólo una empleada interna tiene contrato');

    // Y no ha escrito NADA: ni acuerdo, ni versión, ni catálogo.
    const escrito = await adminPool.query(
      `select 1 from app.employment_agreements where employee_membership_id = $1`,
      [HELPER_MEMBERSHIP]
    );
    expect(escrito.rows).toEqual([]);
  });

  it('una membresía que no existe en el hogar tampoco estrena contrato', async () => {
    const result = await createAgreement(
      ADMIN_USER,
      HOUSEHOLD,
      {
        ...realCaseInput(),
        employeeMembershipId: '7a000000-0000-4000-8000-0000000000ff'
      } as never,
      appPool
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no está dada de alta en este hogar');
  });

  it('la empleada puede registrar una jornada extra el mismo día del alta', async () => {
    const overview = await loadEmploymentOverview(EMPLOYEE_USER, HOUSEHOLD, appPool, TODAY);
    expect(overview).not.toBeNull();
    expect(overview!.hasEmploymentData).toBe(true);

    // El desplegable de la tarjeta de trabajo extra sale de aquí. Si estuviera
    // vacío, la pantalla diría «Sin trabajo extra disponible».
    expect(overview!.registrableTypes.map((type) => [type.code, type.rateLabel])).toEqual([
      ['jornada_extra', '50,00 € por jornada'],
      ['media_jornada_extra', '25,00 € por jornada']
    ]);

    const jornada = overview!.registrableTypes[0]!;
    const envelope: CommandEnvelopeV1 = {
      apiVersion: 1,
      operationId: '7a000000-0000-4000-8000-0000000000aa',
      householdId: HOUSEHOLD,
      schemaVersion: 1,
      aggregateType: 'extra_work',
      aggregateId: null,
      baseRevision: null,
      occurredAt: '2029-01-20T09:00:00.000Z',
      payload: {
        action: 'register',
        agreementId,
        extraWorkTypeId: jornada.id,
        kind: 'worked_rest_day',
        workedOn: WORKED_ON,
        durationMinutes: 480,
        note: 'Domingo trabajado'
      }
    } as CommandEnvelopeV1;

    const batch = await processSyncBatch(appPool, EMPLOYEE_PRINCIPAL, [envelope], employmentCommandHandlers);
    const ack = batch.acknowledgements[0] as CommandAckV1;
    expect(ack).toMatchObject({ status: 'accepted' });

    const stored = await adminPool.query<{ kind: string; extra_work_type_id: string; status: string }>(
      'select kind, extra_work_type_id, status from app.extra_work_events where id = $1',
      [ack.resourceId]
    );
    expect(stored.rows[0]).toEqual({
      kind: 'worked_rest_day',
      extra_work_type_id: jornada.id,
      status: 'requested'
    });
  });

  it('no ve NINGUNA tarifa por hora, ni en sus condiciones ni en el JSON de la página', async () => {
    const overview = await loadEmploymentOverview(EMPLOYEE_USER, HOUSEHOLD, appPool, TODAY);
    const terms = overview!.terms!;
    expect(terms.salaryLabel).toBe('1.500,00 €');
    expect(terms.weeklyHoursLabel).toBe('40 h a la semana');
    expect(terms.vacationDaysLabel).toBe('30 días naturales al año');
    expect(terms.extraWorkTypes.map((type) => type.rateLabel)).toEqual([
      '50,00 € por jornada',
      '25,00 € por jornada'
    ]);
    expect(terms.paidSupplements.map((row) => row.amountLabel)).toEqual(['30,00 € al mes']);

    /*
     * LA ASERCIÓN DEL ENCARGO. Esto es literalmente lo que SvelteKit serializa
     * dentro de la página: si una tarifa por hora sobreviviera en cualquier
     * rincón del expediente —una unidad, una etiqueta «€/h», una columna
     * reliquia—, aparecería aquí aunque ninguna plantilla la pintara.
     */
    const payload = JSON.stringify(overview);
    expect(payload).not.toContain('per_hour');
    expect(payload).not.toContain('€/h');
    expect(payload).not.toContain('por hora');
    expect(payload).not.toContain('Hora extraordinaria');
    expect(payload).not.toContain('overtimeHourlyRate');
  });

  it('y esas cuatro negaciones no son vacías: un concepto por horas sí las produce', () => {
    /*
     * Control negativo. Una prueba que solo dice «esto no aparece» pasa igual de
     * bien cuando la cadena buscada no podría aparecer nunca. Aquí se comprueba
     * que las palabras que la prueba anterior persigue son exactamente las que
     * el modelo genera para un concepto por horas.
     */
    const view = buildExtraWorkTypeView({
      id: '7a000000-0000-4000-8000-0000000000bb',
      agreementVersionId: '7a000000-0000-4000-8000-0000000000cc',
      code: 'hora_extra',
      name: 'Hora extraordinaria',
      unit: 'per_hour',
      rateCents: '1400',
      referenceMinutes: null,
      active: true
    });
    const serialized = JSON.stringify(view);
    expect(serialized).toContain('per_hour');
    expect(serialized).toContain('€/h');
    expect(serialized).toContain('por hora');
    expect(serialized).toContain('Hora extraordinaria');
  });

  it('y la RLS, no la plantilla, es la que se lo impide: por identificador tampoco', async () => {
    // El concepto por horas no existe en este acuerdo, así que la prueba fuerte
    // es la contraria: quien administra ve el catálogo entero y en él no hay
    // ninguna fila `per_hour`, luego no hay nada que la RLS pueda dejar escapar.
    const admin = await loadAgreementAdmin(ADMIN_USER, HOUSEHOLD, appPool, TODAY);
    const version = admin!.agreements[0]!.versions[0]!;
    expect(version.extraWorkTypes.map((type) => type.unit)).toEqual(['per_shift', 'per_shift']);

    // Y desde la conexión de la empleada, preguntando por la tabla a pelo.
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [EMPLOYEE_USER.id]);
      await client.query('select app.set_household_context($1, $2)', [HOUSEHOLD, EMPLOYEE_MEMBERSHIP]);
      const rows = await client.query<{ unit: string }>(
        'select unit::text as unit from app.extra_work_types'
      );
      expect(rows.rows.map((row) => row.unit)).toEqual(['per_shift', 'per_shift']);
      const relic = await client.query<{ n: number }>(
        `select count(*)::int as n from app.agreement_versions
          where overtime_hourly_rate_cents <> 0`
      );
      expect(relic.rows[0]!.n).toBe(0);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  });

  it('apilar una versión CONSERVA las claves de `terms` que no escribe', async () => {
    /*
     * `terms` es un jsonb compartido: hoy sólo lleva la política de caducidad,
     * pero vacaciones tiene tarea abierta y va a meter más. Un escritor que
     * REEMPLACE el objeto entero borra en silencio lo que puso otro, y la fila
     * es inmutable: lo borrado no se recupera, sólo se tapa apilando otra
     * versión. La regla es conservar lo que no se escribe.
     *
     * Se siembra una versión con una clave ajena —por SQL directo, porque el
     * disparador de 0002 prohíbe todo UPDATE— y se apila encima con el camino
     * de verdad.
     */
    await adminPool.query(
      `insert into app.agreement_versions
         (household_id, agreement_id, version_number, effective_from, monthly_salary_cents,
          overtime_hourly_rate_cents, worked_rest_day_rate_cents, contracted_weekly_minutes,
          annual_vacation_days, reason, created_by_membership_id, terms)
       values ($1, $2, 2, date '2029-02-01', 150000, 0, 5000, 2400, 30,
               'Siembra de una clave ajena', $3,
               '{"vacationCarryoverExpiry":{"mode":"never"},"vacacionesDeOtraTarea":{"x":1}}'::jsonb)`,
      [HOUSEHOLD, agreementId, ADMIN_MEMBERSHIP]
    );

    const stacked = await stackAgreementVersion(
      ADMIN_USER,
      HOUSEHOLD,
      agreementId,
      {
        ...realCaseInput().terms,
        effectiveFrom: '2029-03-01',
        reason: 'Cambia sólo la caducidad',
        vacationCarryoverExpiry: { mode: 'months', months: 12 }
      } as never,
      appPool
    );
    expect(stacked).toMatchObject({ ok: true });

    const written = await adminPool.query<{ terms: Record<string, unknown> }>(
      `select terms from app.agreement_versions
        where agreement_id = $1 and version_number = 3`,
      [agreementId]
    );
    // Lo que esta pantalla escribe, actualizado…
    expect(written.rows[0]!.terms.vacationCarryoverExpiry).toEqual({ mode: 'months', months: 12 });
    // …y lo que no escribe, intacto.
    expect(written.rows[0]!.terms.vacacionesDeOtraTarea).toEqual({ x: 1 });
  });
});
