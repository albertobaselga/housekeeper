import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extraWorkCommandHandler, processSyncBatch } from '@housekeeper/server';

import { registerExtra } from '../src/lib/employment/commands';
import {
  loadEmploymentOverview,
  loadEmploymentPortada
} from '../src/lib/server/employment.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_multiemp_login';
// Base de datos propia (patrón de contactos y comida): estas suites recrean el
// esquema entero y ninguna puede compartir instancia con otra.
const MULTIEMP_DB = 'housekeeper_multiemp_it';

const AGREEMENT_ONE = '12000000-0000-4000-8000-000000000001';
const AGREEMENT_TWO = '12000000-0000-4000-8000-000000000002';
const EMPLOYEE_ONE = '11000000-0000-4000-8000-000000000003';
const EMPLOYEE_TWO = '11000000-0000-4000-8000-000000000006';
const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
// Conceptos: «Jornada extra» es del acuerdo de la primera; «Jornada completa»,
// del de la segunda. Cada uno trae su tarifa y sus minutos de referencia.
const TYPE_JORNADA_EXTRA = '13000000-0000-4000-8000-000000000005';
const TYPE_JORNADA_COMPLETA = '13000000-0000-4000-8000-000000000008';
// «Hora extraordinaria» del acuerdo de la primera: desactivada en la versión
// vigente y, por tanto, invisible para ella. Es el canario de que ninguna
// tarifa horaria viaja al navegador.
const TYPE_HORA_EXTRAORDINARIA = '13000000-0000-4000-8000-000000000003';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_ONE_USER = { id: 'fixture:roble:employee' };
const EMPLOYEE_TWO_USER = { id: 'fixture:roble:employee2' };
const FAMILY_USER = { id: 'fixture:roble:family' };

// Agosto de 2026: las jornadas de la fixture son todas de marzo de 2025, así
// que el devengo del mes en curso empieza vacío y lo que aparezca en él es
// exactamente lo que apunte esta suite.
const NOW = new Date('2026-08-10T09:00:00Z');

function multiempUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${MULTIEMP_DB}`;
  return url.toString();
}

let operationCounter = 0;
function nextOperation(): { operationId: string; occurredAt: string } {
  operationCounter += 1;
  return {
    operationId: `99999999-0000-4000-8000-${String(operationCounter).padStart(12, '0')}`,
    occurredAt: '2026-08-10T09:00:00.000Z'
  };
}

describe.runIf(Boolean(adminUrl))('un hogar con dos personas empleadas, bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${MULTIEMP_DB} with (force)`);
      await cluster.query(`create database ${MULTIEMP_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: multiempUrlFor(adminUrl as string) });
    await admin.connect();
    try {
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

    // Todo lo que sigue va por este pool: sin BYPASSRLS, es decir, viendo
    // exactamente lo que Postgres deja salir hacia cada navegador.
    const url = new URL(multiempUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('quien administra ve a las dos y elige de quién es el expediente', async () => {
    const byDefault = await loadEmploymentOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(byDefault).not.toBeNull();
    // Las dos, con su nombre y su periodo. El orden es el de Postgres: activo
    // primero y, a igualdad, el acuerdo más reciente.
    expect(byDefault!.agreements).toEqual([
      {
        id: AGREEMENT_ONE,
        employeeMembershipId: EMPLOYEE_ONE,
        employeeLabel: 'Fixture Empleada Roble',
        status: 'active',
        active: true,
        startsOn: '2025-02-03',
        endsOn: null,
        periodLabel: 'Desde el 3 feb 2025'
      },
      {
        id: AGREEMENT_TWO,
        employeeMembershipId: EMPLOYEE_TWO,
        employeeLabel: 'Fixture Segunda Empleada Roble',
        status: 'active',
        active: true,
        startsOn: '2025-01-07',
        endsOn: null,
        periodLabel: 'Desde el 7 ene 2025'
      }
    ]);
    // Sin elegir se mira el primero, que es lo que hacía la página cuando solo
    // sabía leer uno: nadie pierde su vista de siempre.
    expect(byDefault!.agreement?.id).toBe(AGREEMENT_ONE);

    const second = await loadEmploymentOverview(
      ADMIN_USER,
      FIXTURE_HOUSEHOLD,
      appPool,
      NOW,
      AGREEMENT_TWO
    );
    expect(second!.agreement?.id).toBe(AGREEMENT_TWO);
    expect(second!.agreement?.employeeMembershipId).toBe(EMPLOYEE_TWO);
    // Y con él cambia TODO el expediente, no solo la cabecera: sus versiones y
    // su catálogo, que son los conceptos con los que se le puede apuntar algo.
    expect(second!.versions.map((version) => version.versionNumber)).toEqual([1]);
    expect(second!.registrableTypes.map((type) => type.name)).toEqual([
      'Jornada completa',
      'Media jornada'
    ]);
    // Ni un concepto de su compañera se cuela en la lista de la otra.
    expect(second!.registrableTypes.map((type) => type.id)).not.toContain(TYPE_JORNADA_EXTRA);
  });

  it('la empleada solo alcanza su expediente, y eso lo decide Postgres', async () => {
    // Pide el acuerdo de su compañera a propósito: la elección no es una reja,
    // la reja es la RLS. La lista que le llega tiene un elemento —el suyo— y
    // pedir otro la deja donde estaba.
    const overview = await loadEmploymentOverview(
      EMPLOYEE_ONE_USER,
      FIXTURE_HOUSEHOLD,
      appPool,
      NOW,
      AGREEMENT_TWO
    );
    expect(overview!.agreements.map((option) => option.id)).toEqual([AGREEMENT_ONE]);
    expect(overview!.agreement?.id).toBe(AGREEMENT_ONE);
    expect(overview!.agreement?.employeeMembershipId).toBe(EMPLOYEE_ONE);

    // No es que la lista venga recortada aquí: es que la tabla no le devuelve
    // la fila. Se comprueba contra Postgres, con su propio contexto.
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [EMPLOYEE_ONE_USER.id]);
      await client.query('select app.set_household_context($1, $2)', [
        FIXTURE_HOUSEHOLD,
        EMPLOYEE_ONE
      ]);
      const agreements = await client.query('select id from app.employment_agreements');
      expect(agreements.rows.map((row) => row.id)).toEqual([AGREEMENT_ONE]);
      const foreignTypes = await client.query(
        'select id from app.extra_work_types where agreement_id = $1',
        [AGREEMENT_TWO]
      );
      expect(foreignTypes.rows).toEqual([]);
      await client.query('rollback');
    } finally {
      client.release();
    }

    // Su acuerdo no le permite ninguna hora: el único concepto por hora está
    // desactivado y la RLS no se lo devuelve. Ni el JSON que viajaría a su
    // navegador contiene una tarifa horaria.
    expect(overview!.registrableTypes.some((type) => type.unit === 'per_hour')).toBe(false);
    expect(overview!.terms?.extraWorkTypes.some((type) => type.unit === 'per_hour')).toBe(false);
    const serialized = JSON.stringify(overview);
    // Ni la unidad, ni el concepto por hora, ni una sola etiqueta «…€/h» en
    // todo lo que se serializaría hacia su navegador.
    expect(serialized).not.toContain('per_hour');
    expect(serialized).not.toContain(TYPE_HORA_EXTRAORDINARIA);
    expect(serialized).not.toContain('€/h');
  });

  it('la jornada que le apunta la familia consta en su expediente con su origen', async () => {
    const registered = await processSyncBatch(
      appPool,
      { userId: ADMIN_USER.id },
      [
        registerExtra(
          {
            householdId: FIXTURE_HOUSEHOLD,
            agreementId: AGREEMENT_ONE,
            extraWorkTypeId: TYPE_JORNADA_EXTRA,
            // El cliente manda `kind` pero el concepto manda más: `per_shift`
            // convierte esto en `worked_rest_day` en el servidor.
            kind: 'overtime',
            workedOn: '2026-08-04',
            durationMinutes: 600,
            note: 'Cubrió el puente con los niños'
          },
          nextOperation()
        )
      ],
      { extra_work: extraWorkCommandHandler }
    );
    expect(registered.acknowledgements[0]).toMatchObject({ status: 'accepted' });

    const hers = await loadEmploymentOverview(EMPLOYEE_ONE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    const apuntada = hers!.pendingExtras.find((extra) => extra.workedOn === '2026-08-04');
    expect(apuntada).toBeDefined();
    expect(apuntada).toMatchObject({
      // El nombre del catálogo, no la clasificación gruesa.
      kindLabel: 'Jornada extra',
      durationLabel: '10 h',
      note: 'Cubrió el puente con los niños',
      origin: 'family_request',
      originLabel: 'La apuntó la familia',
      status: 'requested',
      employeeMembershipId: EMPLOYEE_ONE
    });
    // La suya de siempre sigue diciendo que la apuntó ella: el origen no es un
    // adorno de las nuevas, va con cada hecho.
    const suya = hers!.pendingExtras.find((extra) => extra.workedOn === '2025-03-27');
    expect(suya?.originLabel).toBe('La apuntó la empleada');
  });

  it('apuntada y cerrada en el acto, entra en su cuenta del mes valorada por el concepto', async () => {
    const resolved = await processSyncBatch(
      appPool,
      { userId: ADMIN_USER.id },
      [
        registerExtra(
          {
            householdId: FIXTURE_HOUSEHOLD,
            agreementId: AGREEMENT_ONE,
            extraWorkTypeId: TYPE_JORNADA_EXTRA,
            kind: 'worked_rest_day',
            workedOn: '2026-08-05',
            durationMinutes: 600,
            note: 'Se quedó el sábado',
            resolveNow: { resolution: 'money', reason: 'Se le paga con agosto' }
          },
          nextOperation()
        )
      ],
      { extra_work: extraWorkCommandHandler }
    );
    expect(resolved.acknowledgements[0]).toMatchObject({ status: 'accepted' });

    const hers = await loadEmploymentOverview(EMPLOYEE_ONE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    const line = hers!.accrual?.lines.find((candidate) => candidate.concept.includes('Jornada extra'));
    expect(line).toBeDefined();
    // 50,00 € es la tarifa de «Jornada extra» en la versión vigente en agosto
    // de 2026. Nadie la tecleó: el payload no lleva importes.
    expect(line).toMatchObject({
      kind: 'extra_work',
      amountCents: '5000',
      amountLabel: '+50,00 €',
      originLabel: 'La apuntó la familia'
    });
    expect(line!.concept).toBe('Jornada extra · Se quedó el sábado');

    // Y no se le cuela en el expediente de su compañera.
    const others = await loadEmploymentOverview(
      EMPLOYEE_TWO_USER,
      FIXTURE_HOUSEHOLD,
      appPool,
      NOW
    );
    expect(others!.agreement?.id).toBe(AGREEMENT_TWO);
    expect(others!.accrual?.lines.filter((candidate) => candidate.kind === 'extra_work')).toEqual(
      []
    );
    expect(others!.pendingExtras).toEqual([]);
  });

  it('quien no administra ve a las dos personas pero ni un importe de ninguna', async () => {
    // `agreements_read` incluye a family_member: la relación laboral existe y
    // no es secreta. Los importes sí lo son, y esos viven en las versiones.
    const overview = await loadEmploymentOverview(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(overview!.agreements.map((option) => option.id)).toEqual([
      AGREEMENT_ONE,
      AGREEMENT_TWO
    ]);
    // Sin poder leer el perfil de nadie, la etiqueta es neutra en vez de un
    // identificador crudo o un hueco.
    expect(overview!.agreements.map((option) => option.employeeLabel)).toEqual([
      'Empleada del hogar',
      'Empleada del hogar'
    ]);
    expect(overview!.versions).toEqual([]);
    expect(overview!.registrableTypes).toEqual([]);
    expect(overview!.accrual).toBeNull();
    expect(JSON.stringify(overview)).not.toContain(TYPE_JORNADA_COMPLETA);
  });

  /*
   * LA PORTADA DEL HOGAR. Hasta aquí `loadEmploymentPortada` no tenía ni una
   * prueba: se referenciaba desde su definición y desde el `load` de la ruta, y
   * nada más. Todo el SQL de la deuda entraría sin red.
   */
  describe('la portada del hogar', () => {
    // Agosto cerrada y sin pagar para la primera empleada, con vencimiento ya
    // pasado a día de NOW. Es la deuda que la portada tiene que contestar.
    const NOMINA_VENCIDA = 'ac000000-0000-4000-8000-00000000000a';
    // Y una cuenta ABIERTA, que no es deuda: es previsión de un mes que aún no
    // ha terminado, y sumarla haría que la cuenta mintiera.
    const NOMINA_ABIERTA = 'ac000000-0000-4000-8000-00000000000b';

    beforeAll(async () => {
      const admin = new pg.Client({ connectionString: multiempUrlFor(adminUrl as string) });
      await admin.connect();
      try {
        await admin.query('begin');
        await admin.query('set local row_security = off');
        await admin.query(
          `insert into app.settlements
             (id, household_id, agreement_id, employee_membership_id, period_start, period_end,
              due_on, created_by_membership_id)
           values ($1, $2, $3, $4, date '2026-06-01', date '2026-06-30', date '2026-06-30', $6),
                  ($5, $2, $3, $4, date '2026-08-01', date '2026-08-31', date '2026-08-31', $6)`,
          [
            NOMINA_VENCIDA,
            FIXTURE_HOUSEHOLD,
            AGREEMENT_ONE,
            EMPLOYEE_ONE,
            NOMINA_ABIERTA,
            ADMIN_MEMBERSHIP
          ]
        );
        // Los totales NO se teclean: el disparador de cierre los calcula desde
        // las líneas. Escribirlos a mano en el insert produce un cero silencioso.
        await admin.query(
          `insert into app.settlement_lines
             (household_id, settlement_id, agreement_id, employee_membership_id, line_number,
              section, kind, occurred_on, concept, amount_cents, agreement_version_id)
           values ($1, $2, $3, $4, 1, 'salary', 'base_salary', date '2026-06-30',
                   'Salario de junio', 120000,
                   (select id from app.agreement_versions
                     where household_id = $1 and agreement_id = $3
                     order by version_number limit 1))`,
          [FIXTURE_HOUSEHOLD, NOMINA_VENCIDA, AGREEMENT_ONE, EMPLOYEE_ONE]
        );
        await admin.query(
          `update app.settlements
              set status = 'closed', closed_by_membership_id = $1,
                  closed_at = '2026-06-30T18:00:00Z', snapshot_hash = repeat('a', 64)
            where id = $2`,
          [ADMIN_MEMBERSHIP, NOMINA_VENCIDA]
        );
        await admin.query('commit');
      } finally {
        await admin.end();
      }
    }, 60_000);

    it('«pendiente» son las cuentas cerradas sin pagar, y nada más', async () => {
      const portada = await loadEmploymentPortada(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
      expect(portada).not.toBeNull();
      expect(portada!.seesAmounts).toBe(true);

      // La cerrada cuenta; la abierta del mes en curso NO, aunque sea la más
      // reciente: es previsión, no deuda.
      expect(portada!.owedTotalLabel).toBe('1.200,00 €');

      const primera = portada!.employees.find((row) => row.agreementId === AGREEMENT_ONE)!;
      expect(primera.owedLabel).toBe('1.200,00 €');
      expect(primera.owedDueLabel).toBe('Venció el 30 jun 2026');
      // Vencía el 30 de junio y NOW es el 10 de agosto.
      expect(primera.overdue).toBe(true);

      // La segunda no debe nada: null y no «0,00 €», que se leería como cifra.
      const segunda = portada!.employees.find((row) => row.agreementId === AGREEMENT_TWO)!;
      expect(segunda.owedLabel).toBeNull();
      expect(segunda.owedDueLabel).toBeNull();
      expect(segunda.overdue).toBe(false);
    });

    it('la empleada solo ve la suya, y eso lo decide Postgres', async () => {
      const portada = await loadEmploymentPortada(
        EMPLOYEE_ONE_USER,
        FIXTURE_HOUSEHOLD,
        appPool,
        NOW
      );
      expect(portada!.employees.map((row) => row.agreementId)).toEqual([AGREEMENT_ONE]);
      expect(portada!.seesAmounts).toBe(true);
      expect(portada!.owedTotalLabel).toBe('1.200,00 €');
    });

    it('la familia no administradora ve a las personas y ni una cifra', async () => {
      const portada = await loadEmploymentPortada(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
      // Ve a las dos: la relación laboral existe y no es secreta.
      expect(portada!.employees.map((row) => row.agreementId)).toEqual([
        AGREEMENT_ONE,
        AGREEMENT_TWO
      ]);
      // Y ni un importe. `seesAmounts` sale del PAPEL, no de que ninguna cifra
      // haya llegado: es la diferencia entre «no puedes verlo» y «su contrato no
      // está en vigor este mes».
      expect(portada!.seesAmounts).toBe(false);
      expect(portada!.owedTotalLabel).toBeNull();
      expect(portada!.employees.every((row) => row.monthTotalLabel === null)).toBe(true);
      // Y sin el alta: las personas sin contrato solo se las ofrece a quien
      // puede hacer algo con ellas.
      expect(portada!.candidates).toEqual([]);
      // Ni la etiqueta del importe en todo lo que se serializaría hacia su
      // navegador. (Los céntimos crudos no valen como canario: «120000» es
      // también el principio de los identificadores de acuerdo de la fixture.)
      expect(JSON.stringify(portada)).not.toContain('1.200,00');
    });

    it('la que vuelve a la casa se distingue de la que acaba de llegar', async () => {
      // Se termina el contrato de la segunda: su membresía sigue viva, así que
      // vuelve a la lista como candidata a un contrato nuevo. Va la última de la
      // suite porque cambia el estado del hogar.
      const admin = new pg.Client({ connectionString: multiempUrlFor(adminUrl as string) });
      await admin.connect();
      try {
        await admin.query('set row_security = off');
        await admin.query(
          `update app.employment_agreements
              set status = 'ended', ends_on = date '2026-07-31',
                  ended_at = '2026-07-31T18:00:00Z'
            where id = $1`,
          [AGREEMENT_TWO]
        );
      } finally {
        await admin.end();
      }

      const portada = await loadEmploymentPortada(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
      const candidata = portada!.candidates.find((row) => row.name.includes('Segunda'));
      expect(candidata).toBeDefined();
      expect(candidata!.returning).toBe(true);
      expect(candidata!.previousEndedOn).toBe('2026-07-31');
      expect(candidata!.detailLabel).toBe(
        'Volvió a la casa · su contrato anterior terminó el 31 jul 2026'
      );
      // Su acuerdo terminado sigue en la lista de expedientes, marcado como tal:
      // el historial no se borra por terminar.
      const suya = portada!.employees.find((row) => row.agreementId === AGREEMENT_TWO)!;
      expect(suya.active).toBe(false);
    });
  });
});
