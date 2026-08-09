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
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrate.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;

/** Última migración anterior a la que introduce el catálogo de conceptos. */
const STOP_AT = '0020_vacations.sql';

const HOUSEHOLD = '7a000000-0000-4000-8000-000000000001';
const USER = '7a000000-0000-4000-8000-000000000002';
const MEMBERSHIP = '7a000000-0000-4000-8000-000000000003';
const AGREEMENT = '7a000000-0000-4000-8000-000000000004';
const VERSION = '7a000000-0000-4000-8000-000000000005';
const EVENT = '7a000000-0000-4000-8000-000000000006';

describe.runIf(Boolean(adminUrl))('migrar sobre una base con historial', () => {
  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema if exists app_private cascade');
    await client.query('drop table if exists public.schema_migrations');
    await applyMigrations(client, { until: STOP_AT });
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
