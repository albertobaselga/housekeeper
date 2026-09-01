import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withAuthorizedTransaction } from '@housekeeper/server';

import {
  loadFoodCatalog,
  loadMenuWeek,
  loadRecipe,
  loadRoutines,
  loadShoppingList
} from '../src/lib/server/food.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_food_login';
// Base de datos propia (como wiki y auth): las otras suites recrean el esquema
// entero en paralelo y ninguna puede compartir instancia.
const FOOD_DB = 'housekeeper_food_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';

const FOOD_LECHE = '41000000-0000-4000-8000-000000000001';
const FOOD_NATA = '41000000-0000-4000-8000-000000000002';
const FOOD_ARROZ = '41000000-0000-4000-8000-000000000003';
const FOOD_ACEITE = '41000000-0000-4000-8000-000000000004';
const DINER_LEO = '42000000-0000-4000-8000-000000000001';
const DINER_MARTA = '42000000-0000-4000-8000-000000000002';
const GROUP_FAMILIA = '43000000-0000-4000-8000-000000000001';
const SPACE = '44000000-0000-4000-8000-000000000001';
const PAGE_CREMA = '45000000-0000-4000-8000-000000000001';
const PAGE_ARROZ = '45000000-0000-4000-8000-000000000002';
const REV_CREMA = '46000000-0000-4000-8000-000000000001';
const REV_ARROZ = '46000000-0000-4000-8000-000000000002';
const SLOT_COMIDA = '47000000-0000-4000-8000-000000000001';
const SLOT_CENA = '47000000-0000-4000-8000-000000000002';
const ROUTINE_PLANTAS = '48000000-0000-4000-8000-000000000001';
const ROUTINE_MENU = '48000000-0000-4000-8000-000000000002';

const WEEK = '2026-08-03';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };

function foodUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${FOOD_DB}`;
  return url.toString();
}

const FOOD_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.foods (id, household_id, name, shopping_section, allergens_reviewed, created_by_membership_id) VALUES
  ('${FOOD_LECHE}', '${FIXTURE_HOUSEHOLD}', 'Leche entera', 'frescos', true, '${ADMIN_MEMBERSHIP}'),
  ('${FOOD_NATA}', '${FIXTURE_HOUSEHOLD}', 'Nata para cocinar', 'frescos', false, '${ADMIN_MEMBERSHIP}'),
  ('${FOOD_ARROZ}', '${FIXTURE_HOUSEHOLD}', 'Arroz redondo', 'despensa', true, '${ADMIN_MEMBERSHIP}'),
  ('${FOOD_ACEITE}', '${FIXTURE_HOUSEHOLD}', 'Aceite de oliva', 'despensa', true, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.food_allergens (household_id, food_id, allergen_code) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${FOOD_LECHE}', 'lacteos'),
  ('${FIXTURE_HOUSEHOLD}', '${FOOD_NATA}', 'lacteos');

INSERT INTO app.diners (id, household_id, name, notes) VALUES
  ('${DINER_LEO}', '${FIXTURE_HOUSEHOLD}', 'Leo', 'Triturar cuando toque'),
  ('${DINER_MARTA}', '${FIXTURE_HOUSEHOLD}', 'Marta', '');

INSERT INTO app.diner_flags (household_id, diner_id, allergen_code, severity, note) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${DINER_LEO}', 'lacteos', 'high', 'Sin lácteos, revisar etiquetas');

INSERT INTO app.menu_groups (id, household_id, name, position) VALUES
  ('${GROUP_FAMILIA}', '${FIXTURE_HOUSEHOLD}', 'Familia', 0);

INSERT INTO app.menu_group_diners (household_id, group_id, diner_id) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${GROUP_FAMILIA}', '${DINER_LEO}'),
  ('${FIXTURE_HOUSEHOLD}', '${GROUP_FAMILIA}', '${DINER_MARTA}');

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id)
VALUES ('${SPACE}', '${FIXTURE_HOUSEHOLD}', 'recetas', 'Recetas', 'Recetario de la casa', 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, position, created_by_membership_id) VALUES
  ('${PAGE_CREMA}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', 'published', 'crema-de-calabaza', 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_ARROZ}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', 'published', 'arroz-con-leche', 1, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_CREMA}', 'crema-de-calabaza'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_ARROZ}', 'arroz-con-leche');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id) VALUES
  ('${REV_CREMA}', '${FIXTURE_HOUSEHOLD}', '${PAGE_CREMA}', 1, 'Crema de calabaza',
   'Rehogar y triturar.', '', ARRAY['receta'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('${REV_ARROZ}', '${FIXTURE_HOUSEHOLD}', '${PAGE_ARROZ}', 1, 'Arroz con leche',
   'Cocer a fuego lento.', '', ARRAY['receta'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '${REV_CREMA}' WHERE id = '${PAGE_CREMA}';
UPDATE app.wiki_pages SET current_revision_id = '${REV_ARROZ}' WHERE id = '${PAGE_ARROZ}';

INSERT INTO app.recipes (household_id, page_id, base_servings, time_minutes) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_CREMA}', 4, 35),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_ARROZ}', 2, 60);

INSERT INTO app.recipe_ingredients (household_id, page_id, food_id, quantity, unit, scaling, position) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_CREMA}', '${FOOD_LECHE}', 0.50, 'l', 'linear', 0),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_CREMA}', '${FOOD_NATA}', 0.20, 'l', 'linear', 1),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_CREMA}', '${FOOD_ACEITE}', 0.10, 'l', 'fixed', 2),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_ARROZ}', '${FOOD_LECHE}', 1.00, 'l', 'linear', 0),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_ARROZ}', '${FOOD_ARROZ}', 0.30, 'kg', 'linear', 1);

INSERT INTO app.menu_slots (id, household_id, group_id, on_date, meal, recipe_page_id, notes, updated_by_membership_id) VALUES
  ('${SLOT_COMIDA}', '${FIXTURE_HOUSEHOLD}', '${GROUP_FAMILIA}', '${WEEK}', 'comida', '${PAGE_CREMA}', 'Triturar una ración para Leo', '${ADMIN_MEMBERSHIP}'),
  ('${SLOT_CENA}', '${FIXTURE_HOUSEHOLD}', '${GROUP_FAMILIA}', '${WEEK}', 'cena', '${PAGE_ARROZ}', '', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.shopping_items (household_id, custom_name, section, week_starts_on, created_by_membership_id)
VALUES ('${FIXTURE_HOUSEHOLD}', 'Papel de cocina', 'hogar', '${WEEK}', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.routines (id, household_id, title, details, audience, next_due_hint, created_by_membership_id,
  pattern, anchor_on, repeat_every) VALUES
  ('${ROUTINE_PLANTAS}', '${FIXTURE_HOUSEHOLD}', 'Regar plantas', '', 'all', '2026-08-10', '${ADMIN_MEMBERSHIP}', 'every_n_days', '2026-08-10', 7),
  ('${ROUTINE_MENU}', '${FIXTURE_HOUSEHOLD}', 'Planificar el menú', '', 'family', '2026-08-09', '${ADMIN_MEMBERSHIP}', 'every_n_days', '2026-08-09', 7);

INSERT INTO app.routine_completions (household_id, routine_id, due_on, completed_by_membership_id)
VALUES ('${FIXTURE_HOUSEHOLD}', '${ROUTINE_PLANTAS}', '2026-08-10', '${ADMIN_MEMBERSHIP}');

COMMIT;
`;

describe.runIf(Boolean(adminUrl))('comida y rutinas desde Postgres bajo RLS', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    // Igual que la suite de wiki (migraciones + fixtures + login sin
    // BYPASSRLS), pero sobre una base propia y con la siembra de comida encima.
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${FOOD_DB} with (force)`);
      await cluster.query(`create database ${FOOD_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: foodUrlFor(adminUrl as string) });
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
      await admin.query(FOOD_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: foodUrlFor(adminUrl as string), max: 2 });
    const url = new URL(foodUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it('loadMenuWeek trae grupos con flags, el hueco con receta y el choque de alérgenos', async () => {
    const week = await loadMenuWeek(ADMIN_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    expect(week).not.toBeNull();
    expect(week!.canWrite).toBe(true);
    expect(week!.days).toHaveLength(7);
    expect(week!.days[0]).toBe(WEEK);

    const group = week!.groups.find((candidate) => candidate.id === GROUP_FAMILIA)!;
    expect(group.diners.map((diner) => diner.name).sort()).toEqual(['Leo', 'Marta']);
    const leo = group.diners.find((diner) => diner.id === DINER_LEO)!;
    expect(leo.flags).toEqual([
      {
        allergenCode: 'lacteos',
        allergenName: 'Leche y derivados (lactosa)',
        severity: 'high',
        note: 'Sin lácteos, revisar etiquetas'
      }
    ]);

    const comida = week!.slots.find((slot) => slot.id === SLOT_COMIDA)!;
    expect(comida.recipe).not.toBeNull();
    expect(comida.recipe!.title).toBe('Crema de calabaza');
    expect(comida.recipe!.baseServings).toBe(4);
    expect(comida.recipe!.ingredients.map((ingredient) => ingredient.name)).toEqual([
      'Leche entera',
      'Nata para cocinar',
      'Aceite de oliva'
    ]);
    expect(comida.recipe!.ingredients[1]!.reviewed).toBe(false);
    expect(comida.recipe!.allergens).toEqual([{ code: 'lacteos', name: 'Leche y derivados (lactosa)' }]);

    // AC-21: el choque receta ↔ flags del grupo viene resuelto del load.
    expect(comida.conflicts).toEqual([
      {
        dinerId: DINER_LEO,
        dinerName: 'Leo',
        allergenCode: 'lacteos',
        allergenName: 'Leche y derivados (lactosa)',
        severity: 'high'
      }
    ]);

    // El selector de recetas del hogar marca el alimento sin revisar.
    const option = week!.recipeOptions.find((candidate) => candidate.pageId === PAGE_CREMA)!;
    expect(option.hasUnreviewedFood).toBe(true);
    expect(week!.recipeOptions.find((candidate) => candidate.pageId === PAGE_ARROZ)!.hasUnreviewedFood).toBe(false);
  });

  it('el contentHash es estable entre cargas y cambia si cambia una restricción', async () => {
    const first = await loadMenuWeek(ADMIN_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    const second = await loadMenuWeek(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    const slotFirst = first!.slots.find((slot) => slot.id === SLOT_COMIDA)!;
    const slotSecond = second!.slots.find((slot) => slot.id === SLOT_COMIDA)!;
    expect(slotFirst.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // La web delega en computeMenuSlotHash de @housekeeper/server (la misma
    // función contra la que compara el comando confirm): mismo hash para
    // cualquier lector del mismo contenido.
    expect(slotFirst.contentHash).toBe(slotSecond.contentHash);
    // El hueco sin confirmar no arrastra confirmación.
    expect(slotFirst.confirmation).toBeNull();

    // Cambiar un DietaryFlag del grupo invalida el hash (y con él cualquier
    // confirmación previa).
    await adminPool.query(
      `insert into app.diner_flags (household_id, diner_id, allergen_code, severity)
       values ($1, $2, 'huevos', 'medium')`,
      [FIXTURE_HOUSEHOLD, DINER_MARTA]
    );
    try {
      const third = await loadMenuWeek(ADMIN_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
      const slotThird = third!.slots.find((slot) => slot.id === SLOT_COMIDA)!;
      expect(slotThird.contentHash).not.toBe(slotFirst.contentHash);
    } finally {
      await adminPool.query(
        `delete from app.diner_flags
          where household_id = $1 and diner_id = $2 and allergen_code = 'huevos'`,
        [FIXTURE_HOUSEHOLD, DINER_MARTA]
      );
    }
  });

  it('loadShoppingList agrega la leche de dos recetas y respeta la cantidad fija', async () => {
    const list = await loadShoppingList(ADMIN_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    expect(list).not.toBeNull();
    expect(list!.canWrite).toBe(true);
    // La administración familiar sí dispone de la sección «Personal».
    expect(list!.canUsePersonal).toBe(true);

    const frescos = list!.sections.find((section) => section.section === 'frescos')!;
    // Leche: 0.50 × 2/4 (crema, 2 comensales) + 1.00 × 2/2 (arroz) = 1.25 l.
    const leche = frescos.lines.find((line) => line.foodId === FOOD_LECHE)!;
    expect(leche.parts).toEqual([
      expect.objectContaining({ unit: 'l', quantity: '1.25', fromMenu: '1.25', fromManual: null })
    ]);
    expect(leche.origin).toBe('menu');
    // Nata: 0.20 × 2/4 = 0.1 l.
    expect(frescos.lines.find((line) => line.foodId === FOOD_NATA)!.parts[0]!.quantity).toBe('0.1');

    const despensa = list!.sections.find((section) => section.section === 'despensa')!;
    // 'fixed' entra intacto, sin escalar por comensales.
    const aceite = despensa.lines.find((line) => line.foodId === FOOD_ACEITE)!;
    expect(aceite.parts[0]!.quantity).toBe('0.1');
    expect(aceite.parts[0]!.includesFixed).toBe(true);
    expect(despensa.lines.find((line) => line.foodId === FOOD_ARROZ)!.parts[0]!.quantity).toBe('0.3');

    // El añadido a mano conserva su línea marcable en su sección.
    const hogar = list!.sections.find((section) => section.section === 'hogar')!;
    const manual = hogar.lines.find((line) => line.name === 'Papel de cocina')!;
    expect(manual.origin).toBe('manual');
    expect(manual.itemIds).toHaveLength(1);
    expect(manual.checked).toBe(false);
  });

  it('loadShoppingList: el apoyo no recibe la sección personal ni se le ofrece', async () => {
    const helper = await loadShoppingList(HELPER_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    expect(helper).not.toBeNull();
    expect(helper!.canUsePersonal).toBe(false);
    expect(helper!.personal).toEqual([]);
  });

  it('loadRecipe trae la ficha con alérgenos y estado de revisión', async () => {
    const recipe = await loadRecipe(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, PAGE_CREMA, appPool);
    expect(recipe).not.toBeNull();
    expect(recipe!.title).toBe('Crema de calabaza');
    expect(recipe!.slug).toBe('crema-de-calabaza');
    expect(recipe!.baseServings).toBe(4);
    expect(recipe!.canWrite).toBe(false);
    const nata = recipe!.ingredients.find((ingredient) => ingredient.foodId === FOOD_NATA)!;
    expect(nata.reviewed).toBe(false);
    expect(nata.allergenNames).toEqual(['Leche y derivados (lactosa)']);
  });

  it('el helper lee el menú pero el catálogo es de solo lectura: RLS rechaza su escritura', async () => {
    const week = await loadMenuWeek(HELPER_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    expect(week).not.toBeNull();
    expect(week!.canWrite).toBe(false);
    expect(week!.slots).toHaveLength(2);

    const catalog = await loadFoodCatalog(HELPER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(catalog).not.toBeNull();
    expect(catalog!.canWrite).toBe(false);
    expect(catalog!.foods.map((food) => food.name)).toContain('Leche entera');

    // La misma conexión RLS que le deja leer le impide escribir en app.foods.
    await expect(
      withAuthorizedTransaction(appPool, { userId: HELPER_USER.id }, FIXTURE_HOUSEHOLD, async (client, membership) => {
        await client.query(
          `insert into app.foods (household_id, name, shopping_section, created_by_membership_id)
           values ($1, 'Colado por el helper', 'despensa', $2)`,
          [FIXTURE_HOUSEHOLD, membership.id]
        );
      })
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('el viewer no ve nada: RLS devuelve cero filas en todos los loads', async () => {
    const week = await loadMenuWeek(VIEWER_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    expect(week).not.toBeNull();
    expect(week!.groups).toEqual([]);
    expect(week!.slots).toEqual([]);
    expect(week!.recipeOptions).toEqual([]);

    const catalog = await loadFoodCatalog(VIEWER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(catalog!.foods).toEqual([]);
    expect(catalog!.diners).toEqual([]);

    const list = await loadShoppingList(VIEWER_USER, FIXTURE_HOUSEHOLD, WEEK, appPool);
    expect(list!.sections).toEqual([]);

    const routines = await loadRoutines(VIEWER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(routines!.routines).toEqual([]);
  });

  it('loadRoutines: cadencia y próxima ocurrencia, sin porcentajes ni histórico (AC-26)', async () => {
    // «Hoy» se inyecta para que la prueba no dependa del día en que se ejecuta.
    const admin = await loadRoutines(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, '2026-08-10');
    expect(admin).not.toBeNull();
    expect(admin!.canWrite).toBe(true);
    expect(admin!.todayISO).toBe('2026-08-10');

    // Ancla hoy, cada 7 días, y la ocurrencia de hoy ya marcada: no queda nada
    // que hacer y la próxima es la de la semana que viene.
    const plantas = admin!.routines.find((routine) => routine.id === ROUTINE_PLANTAS)!;
    expect(plantas.schedule).toEqual({
      pattern: 'every_n_days',
      anchorOn: '2026-08-10',
      repeatEvery: 7,
      endsOn: null
    });
    expect(plantas.completedToday).toBe(true);
    expect(plantas.actionableDueOn).toBeNull();
    expect(plantas.nextOccurrenceOn).toBe('2026-08-17');

    // Ancla ayer y sin marcar: con `carry` se arrastra UNA sola vencida, la más
    // antigua, y es la que ofrece «Marcar hecha».
    const planMenu = admin!.routines.find((routine) => routine.id === ROUTINE_MENU)!;
    expect(planMenu.completedToday).toBe(false);
    expect(planMenu.actionableDueOn).toBe('2026-08-09');
    expect(planMenu.nextOccurrenceOn).toBe('2026-08-09');
    expect(planMenu.nextAfterActionOn).toBe('2026-08-16');

    // AC-26 revisado: hechos con su fecha, nunca un agregado que puntúe a
    // nadie. La vista no expone porcentajes, rachas, medias ni comparativas.
    expect(Object.keys(plantas).sort()).toEqual([
      'actionableDueOn',
      'audience',
      'completedToday',
      'details',
      'id',
      'nextAfterActionOn',
      'nextOccurrenceOn',
      'schedule',
      'title'
    ]);

    // La audiencia filtra por RLS: la empleada no ve la rutina de familia y
    // el helper solo ve las de toda la casa.
    const employee = await loadRoutines(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(employee!.routines.map((routine) => routine.id)).toEqual([ROUTINE_PLANTAS]);
    const helper = await loadRoutines(HELPER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(helper!.routines.map((routine) => routine.id)).toEqual([ROUTINE_PLANTAS]);
  });

  it('una finalización huérfana no pinta «Hecha»: la regla ya no la reconoce', async () => {
    // §9, caso 15: al cambiar la regla, las finalizaciones registradas ni
    // reviven ni se borran; las que dejaron de ser ocurrencia dejan de
    // pintarse. Aquí la rutina pasa a ser «los lunes» y queda una finalización
    // de un día que ya no toca.
    const routineId = '48000000-0000-4000-8000-000000000004';
    await withAuthorizedTransaction(appPool, { userId: ADMIN_USER.id }, FIXTURE_HOUSEHOLD, async (client, membership) => {
      await client.query(
        // `overdue_policy = 'skip'` es lo que DERIVA el comando para un ritmo
        // sub-semanal (§2.5): una rutina de días fijos no acumula pendientes.
        `insert into app.routines (id, household_id, title, details, audience, next_due_hint, created_by_membership_id,
                                   pattern, anchor_on, repeat_every, weekdays, overdue_policy)
         values ($1, $2, 'Cocina a fondo', '', 'all', '2026-08-10', $3,
                 'days_of_week', '2026-08-10', 1, ARRAY[1]::smallint[], 'skip')`,
        [routineId, FIXTURE_HOUSEHOLD, membership.id]
      );
      // 2026-08-11 es martes: con `weekdays = [1]` ya no es ocurrencia.
      await client.query(
        `insert into app.routine_completions (household_id, routine_id, due_on, completed_by_membership_id)
         values ($1, $2, '2026-08-11', $3)`,
        [FIXTURE_HOUSEHOLD, routineId, membership.id]
      );
    });

    const admin = await loadRoutines(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, '2026-08-11');
    const cocina = admin!.routines.find((routine) => routine.id === routineId)!;
    expect(cocina.completedToday).toBe(false);
    expect(cocina.actionableDueOn).toBeNull();
    expect(cocina.nextOccurrenceOn).toBe('2026-08-17');
  });

  it('una rutina sin cadencia se ve aquí, sin fecha y sin nada que marcar', async () => {
    // §2.3: `pattern IS NULL` es «se hace, falta decidir cuándo». Es el estado
    // de una veintena de tareas del manual, y esta página es el ÚNICO sitio
    // donde se ven: nunca Hoy, ni el calendario, ni el ICS, ni los avisos.
    const routineId = '48000000-0000-4000-8000-000000000003';
    await withAuthorizedTransaction(appPool, { userId: ADMIN_USER.id }, FIXTURE_HOUSEHOLD, async (client, membership) => {
      await client.query(
        `insert into app.routines (id, household_id, title, details, audience, next_due_hint, created_by_membership_id, pattern)
         values ($1, $2, 'Limpieza a fondo del salón', '', 'employee', null, $3, null)`,
        [routineId, FIXTURE_HOUSEHOLD, membership.id]
      );
    });

    const admin = await loadRoutines(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, '2026-08-10');
    const salon = admin!.routines.find((routine) => routine.id === routineId)!;
    expect(salon.schedule).toBeNull();
    expect(salon.nextOccurrenceOn).toBeNull();
    expect(salon.actionableDueOn).toBeNull();
    expect(salon.completedToday).toBe(false);
  });

  it('un usuario sin membresía en el hogar recibe null y la página cae a la fixture', async () => {
    expect(await loadMenuWeek({ id: 'fixture:olivo:employee' }, FIXTURE_HOUSEHOLD, WEEK, appPool)).toBeNull();
    expect(await loadFoodCatalog({ id: 'fixture:olivo:employee' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
    expect(await loadRoutines({ id: 'fixture:olivo:employee' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });
});
