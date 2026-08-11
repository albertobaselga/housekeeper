// Migrar sobre una base CON HISTORIAL, no sobre una vacía.
//
// Por qué existe: 0021 pasaba en verde en todas las suites y reventaba al
// llegar a una base con datos («cannot ALTER TABLE ... because it has pending
// trigger events»), porque un UPDATE deja pendientes las comprobaciones
// diferidas y el ALTER TABLE siguiente ya no puede correr. Con las tablas
// vacías el UPDATE no toca nada y el fallo no aparece.
//
// La prueba deja la base en el punto anterior a la migración, siembra el
// mínimo historial que esa migración tiene que tocar, y sigue migrando hasta
// la cabeza. Sirve para cualquier migración futura del mismo tipo: basta con
// mover `STOP_AT` y sembrar lo que corresponda.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, migrationsDir } from './migrate.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;

/** Última migración anterior a la que introduce el catálogo de conceptos. */
const STOP_AT = '0020_vacations.sql';
/** Última migración anterior a la que estrena la recurrencia de rutinas. */
const STOP_AT_BEFORE_RECURRENCE = '0022_manual_adjustments.sql';

const HOUSEHOLD = '7a000000-0000-4000-8000-000000000001';
const USER = '7a000000-0000-4000-8000-000000000002';
const MEMBERSHIP = '7a000000-0000-4000-8000-000000000003';
const AGREEMENT = '7a000000-0000-4000-8000-000000000004';
const VERSION = '7a000000-0000-4000-8000-000000000005';
const EVENT = '7a000000-0000-4000-8000-000000000006';

/** Deja la base vacía y aplica migraciones hasta `until`, ambas inclusive. */
async function rewindTo(client, until) {
  await client.query('drop schema if exists app cascade');
  await client.query('drop schema if exists app_private cascade');
  await client.query('drop table if exists public.schema_migrations');
  await applyMigrations(client, { until });
}

describe.runIf(Boolean(adminUrl))('migrar sobre una base con historial', () => {
  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await rewindTo(client, STOP_AT);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  it('completa las migraciones restantes con una jornada extra ya resuelta', async () => {
    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'hogar-historial', 'Hogar con historial')`,
      [HOUSEHOLD]
    );
    await client.query(
      `insert into app.user_profiles (user_id, display_name, email)
       values ($1, 'Empleada del historial', 'empleada.historial@casa.demo')`,
      [USER]
    );
    await client.query(
      `insert into app.household_memberships (id, household_id, user_id, role, starts_at)
       values ($1, $2, $3, 'employee_live_in', now())`,
      [MEMBERSHIP, HOUSEHOLD, USER]
    );
    await client.query(
      `insert into app.employment_agreements (id, household_id, employee_membership_id, status, starts_on, created_by_membership_id)
       values ($1, $2, $3, 'active', date '2026-01-01', $3)`,
      [AGREEMENT, HOUSEHOLD, MEMBERSHIP]
    );
    await client.query(
      `insert into app.agreement_versions (
         id, household_id, agreement_id, version_number, effective_from,
         monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
         contracted_weekly_minutes, reason, created_by_membership_id
       )
       values ($1, $2, $3, 1, date '2026-01-01', 150000, 1000, 4500, 2400, 'Alta', $4)`,
      [VERSION, HOUSEHOLD, AGREEMENT, MEMBERSHIP]
    );
    // Un hecho YA RESUELTO: es el que la migración tiene que enlazar con su
    // concepto, y el que provoca las comprobaciones diferidas pendientes.
    // Se fabrica sin pasar por la máquina de estados (exigiría la cadena entera
    // de transiciones): aquí interesa el dato en reposo, no cómo llegó a serlo.
    await client.query("set local session_replication_role = 'replica'");
    await client.query(
      `insert into app.extra_work_events (
         id, household_id, agreement_id, employee_membership_id, kind, worked_on,
         duration_minutes, origin, status, resolution, resolved_agreement_version_id,
         frozen_unit_rate_cents, frozen_amount_cents, balance_minutes,
         requested_by_membership_id,
         approved_by_membership_id, approved_at,
         performed_by_membership_id, performed_at,
         resolved_by_membership_id, resolved_at, resolution_reason
       )
       values ($1, $2, $3, $4, 'overtime', date '2026-02-10', 120,
               'employee_report', 'resolved', 'money', $5, 1000, 2000, 0,
               $4, $4, now(), $4, now(), $4, now(), 'Pagada con la nómina de febrero')`,
      [EVENT, HOUSEHOLD, AGREEMENT, MEMBERSHIP, VERSION]
    );
    // La cadena de transiciones que respalda el estado: sin ella, la
    // comprobación diferida rechaza el hecho en cuanto algo la fuerza. La
    // primera siempre es `requested` sin origen; el resto encadena.
    for (const [sequence, from, to] of [
      [1, null, 'requested'],
      [2, 'requested', 'accepted'],
      [3, 'accepted', 'performed'],
      [4, 'performed', 'resolved']
    ]) {
      await client.query(
        `insert into app.extra_work_transitions (
           household_id, extra_work_event_id, sequence_number, from_status, to_status,
           actor_membership_id, reason
         )
         values ($1, $2, $3, $4, $5, $6, 'Historial fabricado para la prueba')`,
        [HOUSEHOLD, EVENT, sequence, from, to, MEMBERSHIP]
      );
    }
    await client.query('commit');

    // Aquí es donde saltaba el fallo real.
    await expect(applyMigrations(client)).resolves.toBeGreaterThan(0);

    const { rows } = await client.query(
      `select t.code, t.unit, e.extra_work_type_id is not null as enlazado
         from app.extra_work_events as e
         join app.extra_work_types as t
           on t.household_id = e.household_id and t.id = e.extra_work_type_id
        where e.id = $1`,
      [EVENT]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('overtime');
    expect(rows[0].enlazado).toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 0023: la recurrencia de rutinas, sobre rutinas y finalizaciones ya escritas.
//
// La promesa que hay que comprobar no es «la migración corre»: es que NINGUNA
// rutina cambia de próxima fecha por migrar. El relleno pone
// `anchor_on = next_due_on` justamente para eso, y aquí se verifica fila a
// fila en vez de creerse el comentario.
//
// La siembra es la del §3.6 de docs/rutinas-y-calendario.md: una rutina por
// frecuencia, la `quarterly` con el intervalo máximo (que es la que obliga a
// que la CHECK admita 36 meses y no 24), una mensual ya recortada a 28 —el
// límite irrecuperable, que se comprueba que quede documentado y no
// enmascarado— y una semanal con finalización previa.
// ─────────────────────────────────────────────────────────────────────────────
const RECURRENCE_HOUSEHOLD = '7b000000-0000-4000-8000-000000000001';
const RECURRENCE_ADMIN = '7b000000-0000-4000-8000-000000000002';
const RECURRENCE_EMPLOYEE = '7b000000-0000-4000-8000-000000000003';

/**
 * Las cinco heredadas y lo que el §3.2 dice que tienen que ser después.
 * `nextDueOn` se repite a propósito en `anchorOn`: es la promesa del encargo.
 */
const SEEDED_ROUTINES = [
  {
    id: '7b100000-0000-4000-8000-000000000001',
    title: 'Ventilación de la mañana',
    audience: 'employee',
    frequency: 'daily',
    intervalCount: 1,
    nextDueOn: '2026-08-10',
    expected: {
      pattern: 'every_n_days',
      repeat_every: 1,
      weekdays: null,
      month_day: null,
      // Sub-semanal: la ocurrencia caduca al acabar su día. Es el cambio de
      // semántica que la ola busca, no un efecto colateral.
      overdue_policy: 'skip'
    }
  },
  {
    id: '7b100000-0000-4000-8000-000000000002',
    title: 'Riego del jardín cada siete días',
    audience: 'all',
    frequency: 'daily',
    intervalCount: 7,
    nextDueOn: '2026-08-12',
    // El borde exacto de la derivación: 6 días es sub-semanal, 7 ya no.
    expected: {
      pattern: 'every_n_days',
      repeat_every: 7,
      weekdays: null,
      month_day: null,
      overdue_policy: 'carry'
    }
  },
  {
    id: '7b100000-0000-4000-8000-000000000003',
    title: 'Cambio de sábanas',
    audience: 'employee',
    frequency: 'weekly',
    intervalCount: 2,
    // Jueves: el día de la semana sale de la fecha, no se inventa.
    nextDueOn: '2026-08-13',
    completedDueOn: '2026-07-30',
    expected: {
      pattern: 'days_of_week',
      repeat_every: 2,
      weekdays: [4],
      month_day: null,
      overdue_policy: 'skip'
    }
  },
  {
    id: '7b100000-0000-4000-8000-000000000004',
    title: 'Revisión de la caldera',
    audience: 'family',
    frequency: 'monthly',
    intervalCount: 1,
    // Ya recortada por el avance viejo: venía del 31 y nadie puede saberlo.
    nextDueOn: '2026-02-28',
    expected: {
      pattern: 'day_of_month',
      repeat_every: 1,
      weekdays: null,
      month_day: 28,
      overdue_policy: 'carry'
    }
  },
  {
    id: '7b100000-0000-4000-8000-000000000005',
    title: 'Limpieza a fondo trienal',
    audience: 'all',
    frequency: 'quarterly',
    intervalCount: 12,
    nextDueOn: '2026-09-01',
    // 3 × 12 = 36 meses. Una CHECK de 24 habría hecho fallar la migración.
    expected: {
      pattern: 'day_of_month',
      repeat_every: 36,
      weekdays: null,
      month_day: 1,
      overdue_policy: 'carry'
    }
  }
];

describe.runIf(Boolean(adminUrl))('migrar la recurrencia de rutinas con historial', () => {
  /** @type {pg.Client} */
  let client;
  /** @type {string} */
  let migrationSql;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    migrationSql = await readFile(
      path.join(migrationsDir, '0023_routine_recurrence.sql'),
      'utf8'
    );
    await rewindTo(client, STOP_AT_BEFORE_RECURRENCE);

    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'hogar-recurrencia', 'Hogar con rutinas heredadas')`,
      [RECURRENCE_HOUSEHOLD]
    );
    await client.query(
      `insert into app.user_profiles (user_id, display_name, email) values
         ('recurrencia:admin', 'Admin del historial', 'admin.recurrencia@casa.demo'),
         ('recurrencia:empleada', 'Empleada del historial', 'empleada.recurrencia@casa.demo')`
    );
    await client.query(
      `insert into app.household_memberships (id, household_id, user_id, role, starts_at) values
         ($1, $3, 'recurrencia:admin', 'family_admin', now()),
         ($2, $3, 'recurrencia:empleada', 'employee_live_in', now())`,
      [RECURRENCE_ADMIN, RECURRENCE_EMPLOYEE, RECURRENCE_HOUSEHOLD]
    );
    for (const routine of SEEDED_ROUTINES) {
      await client.query(
        `insert into app.routines
           (id, household_id, title, audience, frequency, interval_count, next_due_on,
            created_by_membership_id)
         values ($1, $2, $3, $4::app.routine_audience, $5::app.routine_frequency, $6, $7, $8)`,
        [
          routine.id,
          RECURRENCE_HOUSEHOLD,
          routine.title,
          routine.audience,
          routine.frequency,
          routine.intervalCount,
          routine.nextDueOn,
          RECURRENCE_ADMIN
        ]
      );
      if (routine.completedDueOn) {
        await client.query(
          `insert into app.routine_completions
             (household_id, routine_id, due_on, completed_by_membership_id)
           values ($1, $2, $3, $4)`,
          [RECURRENCE_HOUSEHOLD, routine.id, routine.completedDueOn, RECURRENCE_EMPLOYEE]
        );
      }
    }
    await client.query('commit');
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  it('rellena las cinco rutinas sin moverles la próxima fecha', async () => {
    // Se para EN la 0023 a propósito: lo que este bloque promete es lo de
    // expandir, y una de sus aserciones es que lo heredado sigue intacto. La
    // contracción llega más abajo, sobre estas mismas filas.
    await expect(
      applyMigrations(client, { until: '0023_routine_recurrence.sql' })
    ).resolves.toBeGreaterThan(0);

    const { rows } = await client.query(
      `select id, next_due_on::text as next_due_on, pattern::text as pattern,
              anchor_on::text as anchor_on, repeat_every, weekdays, month_day,
              overdue_policy::text as overdue_policy, months, ends_on,
              frequency::text as frequency, interval_count
         from app.routines where household_id = $1 order by id`,
      [RECURRENCE_HOUSEHOLD]
    );
    expect(rows).toHaveLength(SEEDED_ROUTINES.length);

    for (const seeded of SEEDED_ROUTINES) {
      const row = rows.find((candidate) => candidate.id === seeded.id);
      // La promesa del encargo, dicha sin rodeos: la fecha que estaba pendiente
      // sigue pendiente, y el ancla es esa misma fecha.
      expect(row.next_due_on, seeded.title).toBe(seeded.nextDueOn);
      expect(row.anchor_on, seeded.title).toBe(seeded.nextDueOn);
      expect(row.pattern, seeded.title).toBe(seeded.expected.pattern);
      expect(row.repeat_every, seeded.title).toBe(seeded.expected.repeat_every);
      expect(row.weekdays, seeded.title).toEqual(seeded.expected.weekdays);
      expect(row.month_day, seeded.title).toBe(seeded.expected.month_day);
      expect(row.overdue_policy, seeded.title).toBe(seeded.expected.overdue_policy);
      expect(row.months, seeded.title).toBeNull();
      expect(row.ends_on, seeded.title).toBeNull();
      // Expandir, no contraer: lo heredado sigue intacto hasta la 0024.
      expect(row.frequency, seeded.title).toBe(seeded.frequency);
      expect(row.interval_count, seeded.title).toBe(seeded.intervalCount);
    }
  }, 180_000);

  it('no toca las finalizaciones ya registradas', async () => {
    const { rows } = await client.query(
      `select routine_id, due_on::text as due_on, completed_by_membership_id
         from app.routine_completions where household_id = $1`,
      [RECURRENCE_HOUSEHOLD]
    );
    expect(rows).toEqual([
      {
        routine_id: '7b100000-0000-4000-8000-000000000003',
        due_on: '2026-07-30',
        completed_by_membership_id: RECURRENCE_EMPLOYEE
      }
    ]);
  });

  it('estrena el estado «se hace, falta decidir cuándo» y cierra el imposible', async () => {
    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.routines
         (id, household_id, title, audience, frequency, interval_count, next_due_on,
          pattern, created_by_membership_id)
       values ('7b100000-0000-4000-8000-000000000009', $1, 'Garaje a fondo', 'employee',
               'monthly', 1, null, null, $2)`,
      [RECURRENCE_HOUSEHOLD, RECURRENCE_ADMIN]
    );
    // Y el estado que haría aparecer en Hoy una tarea que nadie ha decidido
    // cuándo se hace queda cerrado con llave.
    await expect(
      client.query(
        `update app.routines set next_due_on = '2026-08-10'
          where id = '7b100000-0000-4000-8000-000000000009'`
      )
    ).rejects.toThrow(/routines_pattern_shape/);
    await client.query('rollback');
  });

  it('deja la línea SET CONSTRAINTS entre el UPDATE y los ALTER', () => {
    // No se puede provocar el fallo de la 0021 sobre `app.routines` (no tiene
    // ninguna comprobación diferida propia), así que lo que se protege es la
    // regla de orden que lo evita: si alguien reordena el fichero o borra la
    // línea en un refactor, esto se pone rojo antes que producción.
    const addColumns = migrationSql.indexOf('ADD COLUMN pattern');
    const dropNotNull = migrationSql.indexOf('ALTER COLUMN next_due_on DROP NOT NULL');
    const fill = migrationSql.indexOf('UPDATE app.routines\n   SET pattern');
    const immediate = migrationSql.indexOf('SET CONSTRAINTS ALL IMMEDIATE;');
    const constraint = migrationSql.indexOf('ADD CONSTRAINT routines_pattern_shape');
    for (const step of [addColumns, dropNotNull, fill, immediate, constraint]) {
      expect(step).toBeGreaterThan(-1);
    }
    expect(fill).toBeGreaterThan(addColumns);
    expect(fill).toBeGreaterThan(dropNotNull);
    expect(immediate).toBeGreaterThan(fill);
    expect(constraint).toBeGreaterThan(immediate);
  });

  it('la aserción del relleno falla de verdad si el relleno se corrompe', async () => {
    // La aserción se extrae del FICHERO de la migración, no se copia aquí: una
    // aserción que solo se prueba contra una copia no prueba nada.
    const assertion = migrationSql.match(/DO \$check\$[\s\S]*?\$check\$;/)?.[0];
    expect(assertion).toBeTruthy();

    for (const [label, corruption, expected] of [
      [
        'una rutina sin patrón',
        `update app.routines
            set pattern = null, anchor_on = null, repeat_every = null, weekdays = null,
                month_day = null, months = null, next_due_on = null, ends_on = null
          where id = '7b100000-0000-4000-8000-000000000001'`,
        /quedan rutinas sin patrón/
      ],
      [
        'un ancla que ya no reproduce la próxima fecha',
        `update app.routines set anchor_on = anchor_on - 1
          where id = '7b100000-0000-4000-8000-000000000002'`,
        /la regla derivada no reproduce next_due_on/
      ],
      [
        'un día del mes que no es el de la próxima fecha',
        `update app.routines set month_day = 15
          where id = '7b100000-0000-4000-8000-000000000004'`,
        /la regla derivada no reproduce next_due_on/
      ],
      [
        'un día de la semana que no es el de la próxima fecha',
        `update app.routines set weekdays = array[2]::smallint[]
          where id = '7b100000-0000-4000-8000-000000000003'`,
        /la regla derivada no reproduce next_due_on/
      ]
    ]) {
      await client.query('begin');
      await client.query('set local row_security = off');
      await client.query(corruption);
      await expect(client.query(assertion), label).rejects.toThrow(expected);
      await client.query('rollback');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 0033: CONTRAER, sobre las mismas cinco rutinas y su finalización.
  //
  // Aquí no se siembra nada nuevo a propósito. Son las filas que nacieron con
  // el vocabulario viejo, pasaron por la 0023 y llegan ahora a la contracción:
  // el recorrido completo que hará una fila real de producción. Y la
  // comparación no es contra el estado intermedio sino contra lo SEMBRADO, que
  // es la única forma de demostrar que la fecha que la casa tenía apuntada
  // hace dos migraciones sigue siendo la misma.
  //
  // Lo que más se vigila no es el DROP —eso es catálogo— sino el RENAME:
  // `next_due_on` pasa a `next_due_hint` y los cuerpos de las funciones que la
  // citan se guardan como TEXTO, así que PostgreSQL no los toca ni avisa. Una
  // contracción que olvidara recrearlas dejaría la base impecable y el feed
  // ICS reventando en la primera petición.
  // ───────────────────────────────────────────────────────────────────────────
  it('la 0033 contrae sin mover ni una fecha ni una cadencia', async () => {
    await expect(applyMigrations(client)).resolves.toBeGreaterThan(0);

    const { rows } = await client.query(
      `select id, next_due_hint::text as next_due_hint, pattern::text as pattern,
              anchor_on::text as anchor_on, repeat_every, weekdays, month_day,
              overdue_policy::text as overdue_policy, months, ends_on
         from app.routines where household_id = $1 order by id`,
      [RECURRENCE_HOUSEHOLD]
    );
    expect(rows).toHaveLength(SEEDED_ROUTINES.length);

    for (const seeded of SEEDED_ROUTINES) {
      const row = rows.find((candidate) => candidate.id === seeded.id);
      // La promesa del encargo, fila a fila y contra el valor SEMBRADO: la
      // fecha que estaba pendiente antes de la 0023 sigue pendiente después de
      // la 0033, solo que la columna ya no finge ser un estado.
      expect(row.next_due_hint, seeded.title).toBe(seeded.nextDueOn);
      expect(row.anchor_on, seeded.title).toBe(seeded.nextDueOn);
      // Y la cadencia entera, que es la otra mitad de la promesa: contraer no
      // puede degradar «cada 36 meses» ni perder los días de la semana.
      expect(row.pattern, seeded.title).toBe(seeded.expected.pattern);
      expect(row.repeat_every, seeded.title).toBe(seeded.expected.repeat_every);
      expect(row.weekdays, seeded.title).toEqual(seeded.expected.weekdays);
      expect(row.month_day, seeded.title).toBe(seeded.expected.month_day);
      expect(row.overdue_policy, seeded.title).toBe(seeded.expected.overdue_policy);
      expect(row.months, seeded.title).toBeNull();
      expect(row.ends_on, seeded.title).toBeNull();
    }
  }, 180_000);

  it('la finalización que ya existía sigue exactamente donde estaba', async () => {
    // Se repite tras la contracción y no solo tras la 0023: `routine_completions`
    // es el activo que hace viable todo el modelo (una fila por ocurrencia), y
    // una contracción que la tocara sería irreparable.
    const { rows } = await client.query(
      `select routine_id, due_on::text as due_on, completed_by_membership_id
         from app.routine_completions where household_id = $1`,
      [RECURRENCE_HOUSEHOLD]
    );
    expect(rows).toEqual([
      {
        routine_id: '7b100000-0000-4000-8000-000000000003',
        due_on: '2026-07-30',
        completed_by_membership_id: RECURRENCE_EMPLOYEE
      }
    ]);
  });

  it('lo retirado está retirado: columnas, ENUM y la definer que avanzaba', async () => {
    const columns = await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'app' and table_name = 'routines'
          and column_name in ('frequency', 'interval_count', 'next_due_on')`
    );
    expect(columns.rows).toEqual([]);

    const enumType = await client.query(
      `select 1 from pg_catalog.pg_type where typname = 'routine_frequency'`
    );
    expect(enumType.rows).toEqual([]);

    const definer = await client.query(
      `select 1 from pg_catalog.pg_proc as p
         join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'advance_routine_after_completion'`
    );
    expect(definer.rows).toEqual([]);

    // Las restricciones que colgaban de las columnas se van con ellas, sin
    // haberlas nombrado en la migración.
    const constraints = await client.query(
      `select conname from pg_catalog.pg_constraint
        where conrelid = 'app.routines'::regclass
          and conname in ('routines_frequency_not_null', 'routines_interval_count_not_null',
                          'routines_interval_count_check')`
    );
    expect(constraints.rows).toEqual([]);
  });

  it('el renombrado arrastra índice y CHECK, y NO deja funciones rotas', async () => {
    // Índice y restricción son dependencias registradas: PostgreSQL reescribe
    // su definición al renombrar. Se comprueba en vez de darlo por hecho,
    // porque de ello depende que el prefiltro de «lo que toca hoy» siga
    // existiendo.
    const index = await client.query(
      `select indexdef from pg_catalog.pg_indexes
        where schemaname = 'app' and tablename = 'routines'
          and indexname = 'routines_due_hint_idx'`
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toContain('next_due_hint');

    const check = await client.query(
      `select pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint
        where conrelid = 'app.routines'::regclass and conname = 'routines_pattern_shape'`
    );
    expect(check.rows[0].def).toContain('next_due_hint');
    expect(check.rows[0].def).not.toContain('next_due_on');

    // Y los cuerpos de función, que es lo que el RENAME no alcanza.
    const orphans = await client.query(
      `select n.nspname || '.' || p.proname as fn
         from pg_catalog.pg_proc as p
         join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
        where n.nspname in ('app', 'app_private')
          and (p.prosrc like '%next_due_on%' or p.prosrc like '%interval_count%')`
    );
    expect(orphans.rows).toEqual([]);
  });

  it('el feed ICS se puede LLAMAR tras el renombrado, y conserva su GRANT', async () => {
    // La prueba que de verdad importa: que la función exista no basta, porque
    // su cuerpo es texto y el fallo aparece al ejecutarla. Un token que no
    // existe devuelve cero filas —y no un error de columna—, que es justo lo
    // que distingue «recreada» de «rota».
    await expect(
      client.query(`select * from app_private.ics_feed_events($1)`, ['no-existe-este-token'])
    ).resolves.toMatchObject({ rows: [] });

    // El tipo de retorno publica el nombre nuevo y ninguno de los viejos.
    const result = await client.query(
      `select pg_catalog.pg_get_function_result(
                'app_private.ics_feed_events(text)'::regprocedure) as firma`
    );
    expect(result.rows[0].firma).toContain('next_due_hint');
    expect(result.rows[0].firma).not.toContain('next_due_on');
    expect(result.rows[0].firma).not.toContain('frequency');

    // Y el GRANT reemitido, que es la lección de la 0011: al recrear una
    // función se pierde su ACL y vuelve el EXECUTE para PUBLIC.
    const acl = await client.query(
      `select coalesce(array_to_string(p.proacl, ' '), '') as acl
         from pg_catalog.pg_proc as p
         join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'app_private' and p.proname = 'ics_feed_events'`
    );
    expect(acl.rows[0].acl).toContain('casa_clara_app=X');
    expect(acl.rows[0].acl).not.toMatch(/(^|\s)=X/);

    // La otra recreada, con el mismo criterio.
    const hintAcl = await client.query(
      `select coalesce(array_to_string(p.proacl, ' '), '') as acl
         from pg_catalog.pg_proc as p
         join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'set_routine_due_hint'`
    );
    expect(hintAcl.rows[0].acl).toContain('casa_clara_app=X');
    expect(hintAcl.rows[0].acl).not.toMatch(/(^|\s)=X/);
  });

  it('la aserción de la 0033 falla de verdad si la cadencia se mueve', async () => {
    // El mismo criterio que la de la 0023: una aserción que solo se prueba
    // contra una copia no prueba nada, así que se extrae del FICHERO. Se
    // reconstruye la foto que la migración se toma de sí misma, se corrompe una
    // fila, y se comprueba que la aserción lo ve.
    const contractSql = await readFile(
      path.join(migrationsDir, '0033_routine_recurrence_contract.sql'),
      'utf8'
    );
    const assertion = contractSql.match(/DO \$check\$[\s\S]*?\$check\$;/)?.[0];
    expect(assertion).toBeTruthy();

    for (const [label, corruption] of [
      [
        'una próxima fecha movida un día',
        `update app.routines set next_due_hint = next_due_hint + 1
          where id = '7b100000-0000-4000-8000-000000000004'`
      ],
      [
        'una cadencia degradada',
        `update app.routines set repeat_every = 1
          where id = '7b100000-0000-4000-8000-000000000005'`
      ],
      [
        'una rutina que desaparece',
        `delete from app.routines where id = '7b100000-0000-4000-8000-000000000001'`
      ]
    ]) {
      await client.query('begin');
      await client.query('set local row_security = off');
      // La foto, tal y como la toma el paso 1 de la migración pero con los
      // nombres ya contraídos: es el estado BUENO contra el que comparar.
      await client.query(
        `create temp table routine_cadence_before on commit drop as
         select id, next_due_hint as next_due_on, pattern, anchor_on, repeat_every,
                weekdays, month_day, months, ends_on, overdue_policy
           from app.routines`
      );
      await client.query(corruption);
      await expect(client.query(assertion), label).rejects.toThrow(
        /la contracción movió la cadencia/
      );
      await client.query('rollback');
    }
  });

  it('reejecutar el runner sobre una base ya migrada no cambia nada', async () => {
    await expect(applyMigrations(client)).resolves.toBe(0);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 0025 y 0026, sobre una casa que ya tenía contrato y guía escritos.
//
// Las dos llegaron por ramas distintas y ninguna había visto a la otra, así que
// lo que se comprueba aquí es lo único que no se puede comprobar por separado:
// que APLICADAS EN ORDEN, y encima de datos, no se estorban ni inventan nada.
//
// Lo delicado de cada una sobre una base con historial:
//
//   · 0025 solo AÑADE tablas. La promesa es negativa y por eso hay que
//     escribirla: un contrato que ya existía NO estrena horario por migrar. El
//     horario es una condición pactada; deducirlo de la frase de terms sería
//     inventárselo.
//   · 0026 sí toca lo escrito, y de las tres maneras que suelen doler:
//     clasifica los apartados que ya existen (kind), añade a
//     app.wiki_revisions una columna GENERADA Y ALMACENADA —que reescribe la
//     tabla fila a fila— y le pone una CHECK a app.wiki_page_slugs, que está
//     llena. Con las tablas vacías las tres pasan solas.
// ─────────────────────────────────────────────────────────────────────────────
/** Última migración anterior a la que estrena el horario del contrato. */
const STOP_AT_BEFORE_SCHEDULE = '0023_routine_recurrence.sql';

const LEGACY_HOUSEHOLD = '7c000000-0000-4000-8000-000000000001';
const LEGACY_ADMIN = '7c000000-0000-4000-8000-000000000002';
const LEGACY_EMPLOYEE = '7c000000-0000-4000-8000-000000000003';
const LEGACY_AGREEMENT = '7c000000-0000-4000-8000-000000000004';
const LEGACY_VERSION = '7c000000-0000-4000-8000-000000000005';
const LEGACY_GUIDE_SPACE = '7c100000-0000-4000-8000-000000000001';
const LEGACY_RECIPE_SPACE = '7c100000-0000-4000-8000-000000000002';
const LEGACY_GUIDE_PAGE = '7c200000-0000-4000-8000-000000000001';
const LEGACY_RECIPE_PAGE = '7c200000-0000-4000-8000-000000000002';
const LEGACY_GUIDE_REVISION = '7c300000-0000-4000-8000-000000000001';
const LEGACY_RECIPE_REVISION = '7c300000-0000-4000-8000-000000000002';

describe.runIf(Boolean(adminUrl))('0025 y 0026 sobre una casa ya escrita', () => {
  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await rewindTo(client, STOP_AT_BEFORE_SCHEDULE);

    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'hogar-anterior', 'Hogar anterior al horario')`,
      [LEGACY_HOUSEHOLD]
    );
    await client.query(
      `insert into app.user_profiles (user_id, display_name, email) values
         ('anterior:admin', 'Admin anterior', 'admin.anterior@casa.demo'),
         ('anterior:empleada', 'Empleada anterior', 'empleada.anterior@casa.demo')`
    );
    await client.query(
      `insert into app.household_memberships (id, household_id, user_id, role, starts_at) values
         ($1, $3, 'anterior:admin', 'family_admin', now()),
         ($2, $3, 'anterior:empleada', 'employee_live_in', now())`,
      [LEGACY_ADMIN, LEGACY_EMPLOYEE, LEGACY_HOUSEHOLD]
    );
    await client.query(
      `insert into app.employment_agreements
         (id, household_id, employee_membership_id, status, starts_on, created_by_membership_id)
       values ($1, $2, $3, 'active', date '2026-01-01', $4)`,
      [LEGACY_AGREEMENT, LEGACY_HOUSEHOLD, LEGACY_EMPLOYEE, LEGACY_ADMIN]
    );
    // El horario, como se pactaba antes de 0025: una frase dentro de terms.
    await client.query(
      `insert into app.agreement_versions (
         id, household_id, agreement_id, version_number, effective_from,
         monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
         contracted_weekly_minutes, annual_vacation_days,
         terms, reason, created_by_membership_id
       )
       values ($1, $2, $3, 1, date '2026-01-01', 150000, 1000, 4500, 2400, 30,
               $4::jsonb, 'Alta anterior al horario', $5)`,
      [
        LEGACY_VERSION,
        LEGACY_HOUSEHOLD,
        LEGACY_AGREEMENT,
        JSON.stringify({ schedule: 'Presencia de 08:00 a 19:00. Fin de semana libre.' }),
        LEGACY_ADMIN
      ]
    );

    // Una guía y un recetario, ya escritos, con el slug 'recetas' que es por lo
    // que 0026 reconoce el segundo.
    await client.query(
      `insert into app.wiki_spaces (id, household_id, slug, name, position, created_by_membership_id) values
         ($1, $3, 'acogida-anterior', 'Acogida', 0, $4),
         ($2, $3, 'recetas', 'Recetas', 1, $4)`,
      [LEGACY_GUIDE_SPACE, LEGACY_RECIPE_SPACE, LEGACY_HOUSEHOLD, LEGACY_ADMIN]
    );
    await client.query(
      `insert into app.wiki_pages
         (id, household_id, space_id, status, current_slug, position, created_by_membership_id) values
         ($1, $3, $5, 'published', 'la-cocina-anterior', 0, $4),
         ($2, $3, $6, 'published', 'lentejas-anteriores', 0, $4)`,
      [
        LEGACY_GUIDE_PAGE,
        LEGACY_RECIPE_PAGE,
        LEGACY_HOUSEHOLD,
        LEGACY_ADMIN,
        LEGACY_GUIDE_SPACE,
        LEGACY_RECIPE_SPACE
      ]
    );
    await client.query(
      `insert into app.wiki_page_slugs (household_id, page_id, slug) values
         ($1, $2, 'la-cocina-anterior'),
         ($1, $3, 'lentejas-anteriores')`,
      [LEGACY_HOUSEHOLD, LEGACY_GUIDE_PAGE, LEGACY_RECIPE_PAGE]
    );
    await client.query(
      `insert into app.wiki_revisions
         (id, household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id) values
         ($1, $3, $5, 1, 'La cocina', 'La placa es de **inducción**.', $4),
         ($2, $3, $6, 1, 'Lentejas', 'Una hora a fuego lento.', $4)`,
      [
        LEGACY_GUIDE_REVISION,
        LEGACY_RECIPE_REVISION,
        LEGACY_HOUSEHOLD,
        LEGACY_ADMIN,
        LEGACY_GUIDE_PAGE,
        LEGACY_RECIPE_PAGE
      ]
    );
    await client.query('commit');
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  it('aplica las dos en orden sobre datos y deja la base en la cabeza', async () => {
    await expect(applyMigrations(client)).resolves.toBeGreaterThan(0);

    const { rows } = await client.query(
      `select filename from public.schema_migrations order by filename`
    );
    const applied = rows.map((row) => row.filename);
    expect(applied).toContain('0025_agreement_schedule.sql');
    expect(applied).toContain('0026_guide_authorship_and_reading.sql');
    // El orden es el que dice el nombre, y 0026 va detrás de 0025.
    expect(applied.indexOf('0026_guide_authorship_and_reading.sql')).toBeGreaterThan(
      applied.indexOf('0025_agreement_schedule.sql')
    );
    // Y las tablas nuevas existen de verdad, no solo en el registro.
    const tables = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'app'
          and table_name in ('agreement_schedules', 'agreement_schedule_days', 'wiki_reading_progress')
        order by table_name`
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'agreement_schedule_days',
      'agreement_schedules',
      'wiki_reading_progress'
    ]);
  }, 180_000);

  it('un contrato anterior no estrena horario por migrar, y su frase sigue ahí', async () => {
    const schedules = await client.query(
      `select count(*)::int as total from app.agreement_schedules where household_id = $1`,
      [LEGACY_HOUSEHOLD]
    );
    expect(schedules.rows[0].total).toBe(0);

    const version = await client.query(
      `select terms->>'schedule' as schedule, contracted_weekly_minutes
         from app.agreement_versions where id = $1`,
      [LEGACY_VERSION]
    );
    expect(version.rows[0].schedule).toBe('Presencia de 08:00 a 19:00. Fin de semana libre.');
    expect(version.rows[0].contracted_weekly_minutes).toBe(2400);
  });

  it('los apartados que ya existían quedan clasificados, no reescritos', async () => {
    const { rows } = await client.query(
      `select slug, kind::text as kind, name from app.wiki_spaces
        where household_id = $1 order by position`,
      [LEGACY_HOUSEHOLD]
    );
    expect(rows).toEqual([
      { slug: 'acogida-anterior', kind: 'guide', name: 'Acogida' },
      { slug: 'recetas', kind: 'recipes', name: 'Recetas' }
    ]);
  });

  it('la huella de lectura se calcula para lo ya escrito, y solo mira las palabras', async () => {
    const { rows } = await client.query(
      `select id, reading_fingerprint from app.wiki_revisions
        where household_id = $1 order by id`,
      [LEGACY_HOUSEHOLD]
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.reading_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0].reading_fingerprint).not.toBe(rows[1].reading_fingerprint);

    // El mismo texto sin el marcado da la MISMA huella: reimportar el manual con
    // otro formato no devuelve a pendientes una nota ya leída.
    const same = await client.query(
      `select md5(app.reading_normalized($1) || ' | ' || app.reading_normalized($2)) as huella`,
      ['La cocina', 'La placa es de inducción.']
    );
    expect(same.rows[0].huella).toBe(
      rows.find((row) => row.id === LEGACY_GUIDE_REVISION).reading_fingerprint
    );
  });

  it('nadie estrena progreso de lectura por migrar', async () => {
    const { rows } = await client.query(
      `select count(*)::int as total from app.wiki_reading_progress`
    );
    expect(rows[0].total).toBe(0);
  });

  it('los slugs reservados quedan cerrados sin tocar los que ya existían', async () => {
    const existing = await client.query(
      `select slug from app.wiki_page_slugs where household_id = $1 order by slug`,
      [LEGACY_HOUSEHOLD]
    );
    expect(existing.rows.map((row) => row.slug)).toEqual([
      'la-cocina-anterior',
      'lentejas-anteriores'
    ]);

    await client.query('begin');
    await client.query('set local row_security = off');
    await expect(
      client.query(
        `insert into app.wiki_page_slugs (household_id, page_id, slug) values ($1, $2, 'libro')`,
        [LEGACY_HOUSEHOLD, LEGACY_GUIDE_PAGE]
      )
    ).rejects.toThrow(/wiki_page_slugs_reserved_slug/);
    await client.query('rollback');
  });

  it('reejecutar el runner sobre la base ya migrada no cambia nada', async () => {
    await expect(applyMigrations(client)).resolves.toBe(0);
  }, 120_000);
});
