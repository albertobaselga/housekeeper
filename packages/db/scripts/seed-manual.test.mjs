// Integración de la siembra estructurada del manual (rutinas, contacto 112 y
// plantilla de menú) contra Postgres real. Solo con TEST_DATABASE_URL.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrate.mjs';
import { deterministicUuid, seedManual } from './seed-manual.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;

const HOUSEHOLD = '79000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '79000000-0000-4000-8000-000000000002';
const GROUP = '79000000-0000-4000-8000-000000000003';

describe('uuid determinista de la siembra', () => {
  it('es estable por (hogar, clave) y distinto entre claves y hogares', () => {
    const a = deterministicUuid(HOUSEHOLD, 'routine:plan-semanal');
    expect(a).toBe(deterministicUuid(HOUSEHOLD, 'routine:plan-semanal'));
    expect(a).not.toBe(deterministicUuid(HOUSEHOLD, 'routine:plan-periodico'));
    expect(a).not.toBe(deterministicUuid(MEMBERSHIP, 'routine:plan-semanal'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe.runIf(Boolean(adminUrl))('siembra estructurada del manual', () => {
  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema if exists app_private cascade');
    await client.query('drop table if exists public.schema_migrations');
    await applyMigrations(client);
    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'hogar-siembra', 'Hogar de la siembra')`,
      [HOUSEHOLD]
    );
    await client.query(
      `insert into app.user_profiles (user_id, display_name)
       values ('fixture:siembra', 'Admin de la siembra')`
    );
    await client.query(
      `insert into app.household_memberships (id, household_id, user_id, role)
       values ($1, $2, 'fixture:siembra', 'family_admin')`,
      [MEMBERSHIP, HOUSEHOLD]
    );
    await client.query(
      `insert into app.menu_groups (id, household_id, name, position)
       values ($1, $2, 'Casa', 0)`,
      [GROUP, HOUSEHOLD]
    );
    await client.query('commit');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('el dry-run no persiste nada', async () => {
    const report = await seedManual(client, { householdId: HOUSEHOLD, dryRun: true });
    expect(report.routines.created).toHaveLength(5);
    const routines = await client.query('select count(*)::int as n from app.routines');
    expect(routines.rows[0].n).toBe(0);
  });

  it('siembra rutinas, contacto 112 destacado y plantilla aplicable', async () => {
    const report = await seedManual(client, { householdId: HOUSEHOLD });
    expect(report.routines.created).toHaveLength(5);
    expect(report.contacts.created).toEqual(['Emergencias Comunidad de Madrid']);
    expect(report.template).toMatchObject({ created: true, slots: 14, group: 'Casa' });
    expect(report.recipes).toBe(0);

    const routines = await client.query(
      `select title, audience::text as audience, frequency::text as frequency,
              interval_count, details
         from app.routines where household_id = $1 order by title`,
      [HOUSEHOLD]
    );
    expect(routines.rows).toHaveLength(5);
    const quincenal = routines.rows.find((row) =>
      row.title.startsWith('Confirmar la compra personal')
    );
    // Plan quincenal del manual → semanal con «cada 2» (el modelo lo soporta).
    expect(quincenal).toMatchObject({ frequency: 'weekly', interval_count: 2, audience: 'all' });
    expect(routines.rows.every((row) => row.details.includes('Ver ficha:'))).toBe(true);
    const daily = routines.rows.filter((row) => row.frequency === 'daily');
    expect(daily).toHaveLength(2);
    expect(daily.every((row) => row.audience === 'employee')).toBe(true);

    const contact = await client.query(
      `select name, phone, kind, featured from app.contacts where household_id = $1`,
      [HOUSEHOLD]
    );
    expect(contact.rows).toEqual([
      {
        name: 'Emergencias Comunidad de Madrid',
        phone: '112',
        kind: 'emergency',
        featured: true,
      },
    ]);

    const slots = await client.query(
      `select count(*)::int as n
         from app.menu_week_template_slots slot
         join app.menu_week_templates template
           on template.household_id = slot.household_id and template.id = slot.template_id
        where slot.household_id = $1 and template.name like 'Semana tipo%'`,
      [HOUSEHOLD]
    );
    expect(slots.rows[0].n).toBe(14);
  });

  it('repetir la siembra actualiza en el sitio sin duplicar ni reiniciar recurrencias', async () => {
    // Simula recurrencia avanzada: la siguiente pasada no debe pisarla.
    const routineId = deterministicUuid(HOUSEHOLD, 'routine:rutina-diaria-de-referencia');
    await client.query(
      `update app.routines set next_due_on = current_date + 9 where id = $1`,
      [routineId]
    );

    const report = await seedManual(client, { householdId: HOUSEHOLD });
    expect(report.routines.created).toEqual([]);
    expect(report.routines.updated).toHaveLength(5);
    expect(report.contacts.updated).toEqual(['Emergencias Comunidad de Madrid']);
    expect(report.template).toMatchObject({ created: false, slots: 14 });

    const counts = await client.query(
      `select (select count(*) from app.routines where household_id = $1)::int as routines,
              (select count(*) from app.contacts where household_id = $1)::int as contacts,
              (select count(*) from app.menu_week_templates where household_id = $1)::int as templates`,
      [HOUSEHOLD]
    );
    expect(counts.rows[0]).toEqual({ routines: 5, contacts: 1, templates: 1 });

    const untouched = await client.query(
      `select (next_due_on = current_date + 9) as kept from app.routines where id = $1`,
      [routineId]
    );
    expect(untouched.rows[0].kept).toBe(true);
  });
});
