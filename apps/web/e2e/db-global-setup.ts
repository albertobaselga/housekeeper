import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { E2E_APP_LOGIN, E2E_APP_PASSWORD } from '../playwright.db.config';
import { E2E_SEED } from './helpers';

// Siembra de la base de datos para los e2e con Postgres: igual que el
// global-setup de @casa-clara/server (migraciones + fixtures sintéticas) más
// una página de wiki publicada para ejercitar el editor visual, y un login
// sin BYPASSRLS con el que corre el servidor web.

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const SPACE = '33000000-0000-4000-8000-000000000001';
const PAGE = '33100000-0000-4000-8000-000000000001';
const REVISION = '33110000-0000-4000-8000-000000000001';
// Segundo capítulo de la Guía con dos notas: el modo libro necesita un libro
// con páginas, y el avance de acogida necesita algo que quede por leer.
const SPACE_CONVIVENCIA = '33000000-0000-4000-8000-000000000002';
const PAGE_ACOGIDA = '33100000-0000-4000-8000-000000000002';
const PAGE_HORARIOS = '33100000-0000-4000-8000-000000000003';

const WIKI_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id) VALUES
  ('${SPACE_CONVIVENCIA}', '${HOUSEHOLD}', 'convivencia', 'Convivencia', 'Cómo funciona esta casa', 10, '${ADMIN_MEMBERSHIP}'),
  ('${SPACE}', '${HOUSEHOLD}', 'equipamiento', 'Equipamiento', 'Aparatos de la casa', 20, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, parent_page_id, status, current_slug, pinned, position, created_by_membership_id) VALUES
  ('${PAGE_ACOGIDA}', '${HOUSEHOLD}', '${SPACE_CONVIVENCIA}', NULL, 'published', 'principios-de-la-casa', false, 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_HORARIOS}', '${HOUSEHOLD}', '${SPACE_CONVIVENCIA}', NULL, 'published', 'jornada-y-descansos', false, 1, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE}', '${HOUSEHOLD}', '${SPACE}', NULL, 'published', 'lavadora', true, 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${HOUSEHOLD}', '${PAGE_ACOGIDA}', 'principios-de-la-casa'),
  ('${HOUSEHOLD}', '${PAGE_HORARIOS}', 'jornada-y-descansos'),
  ('${HOUSEHOLD}', '${PAGE}', 'lavadora');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id) VALUES
  ('33110000-0000-4000-8000-000000000002', '${HOUSEHOLD}', '${PAGE_ACOGIDA}', 1,
   'Principios de la casa',
   'Cuidado, respeto y comunicación temprana: si algo no está claro, se pregunta antes de actuar.',
   '', ARRAY['manual'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('33110000-0000-4000-8000-000000000003', '${HOUSEHOLD}', '${PAGE_HORARIOS}', 1,
   'Jornada y descansos',
   'La jornada empieza a las ocho. Los descansos son descansos: no se llama ni se escribe.',
   '', ARRAY['manual'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('${REVISION}', '${HOUSEHOLD}', '${PAGE}', 1,
   'Lavadora · programa corto',
   'Usa el programa Mixto 40° para media carga.

El detergente va en el compartimento II.',
   '', ARRAY['colada'], ARRAY['lavadora'], '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '33110000-0000-4000-8000-000000000002' WHERE id = '${PAGE_ACOGIDA}';
UPDATE app.wiki_pages SET current_revision_id = '33110000-0000-4000-8000-000000000003' WHERE id = '${PAGE_HORARIOS}';
UPDATE app.wiki_pages SET current_revision_id = '${REVISION}' WHERE id = '${PAGE}';

COMMIT;
`;

// ─────────────────────────────────────────────────────────────────────────────
// Siembra propia de la batería e2e de familia/empleada (ids aa… de E2E_SEED).
// No toca ninguna entidad de WIKI_SEED ni de las fixtures 1…/2…: alimentos con
// alérgenos revisados y uno sin revisar, comensales con restricción, un grupo
// de menú, dos recetas ligadas a páginas wiki nuevas, rutinas por audiencia y
// hechos laborales pendientes (jornadas extra y un gasto) para que los flujos
// de aceptación/resolución/liquidación partan de un estado conocido. Las
// fechas son relativas a current_date para que el "mes en curso" y "esta
// semana" sean siempre verdad.
// ─────────────────────────────────────────────────────────────────────────────
const E2E_BATTERY_SEED = `
BEGIN;
SET LOCAL row_security = off;

-- Catálogo de alimentos: tres revisados (leche→lácteos, arroz, pollo) y uno sin
-- revisar. El arroz declara además su tamaño de paquete de compra (500 g), que
-- es lo que permite a la lista decir «1 paquete de 500 g» en vez de «0,125 kg».
INSERT INTO app.foods (id, household_id, name, shopping_section, allergens_reviewed, package_size, package_unit, created_by_membership_id) VALUES
  ('${E2E_SEED.foods.leche}', '${HOUSEHOLD}', 'Leche entera E2E', 'lácteos', true, NULL, NULL, '${ADMIN_MEMBERSHIP}'),
  ('${E2E_SEED.foods.arroz}', '${HOUSEHOLD}', 'Arroz redondo E2E', 'despensa', true, 500, 'g', '${ADMIN_MEMBERSHIP}'),
  ('${E2E_SEED.foods.pollo}', '${HOUSEHOLD}', 'Pollo entero E2E', 'carnicería', true, NULL, NULL, '${ADMIN_MEMBERSHIP}'),
  ('${E2E_SEED.foods.sinRevisar}', '${HOUSEHOLD}', 'Pan de espelta E2E', 'panadería', false, NULL, NULL, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.food_allergens (household_id, food_id, allergen_code)
VALUES ('${HOUSEHOLD}', '${E2E_SEED.foods.leche}', 'lacteos');

-- Comensales: Marta sin restricciones y Leo con lácteos en severidad alta.
INSERT INTO app.diners (id, household_id, name, notes) VALUES
  ('${E2E_SEED.diners.marta}', '${HOUSEHOLD}', 'Marta (comensal E2E)', ''),
  ('${E2E_SEED.diners.leo}', '${HOUSEHOLD}', 'Leo (comensal E2E)', 'Revisar etiquetas siempre');

INSERT INTO app.diner_flags (household_id, diner_id, allergen_code, severity, note)
VALUES ('${HOUSEHOLD}', '${E2E_SEED.diners.leo}', 'lacteos', 'high', 'Alergia a la proteína de la leche');

INSERT INTO app.menu_groups (id, household_id, name, position)
VALUES ('${E2E_SEED.menuGroup}', '${HOUSEHOLD}', 'Casa', 10);

INSERT INTO app.menu_group_diners (household_id, group_id, diner_id) VALUES
  ('${HOUSEHOLD}', '${E2E_SEED.menuGroup}', '${E2E_SEED.diners.marta}'),
  ('${HOUSEHOLD}', '${E2E_SEED.menuGroup}', '${E2E_SEED.diners.leo}');

-- Dos recetas como extensión de páginas wiki nuevas en un espacio propio. El
-- apartado nace como RECETARIO (migración 0026): lo mantiene la familia desde el
-- menú y no forma parte del manual de acogida ni del modo libro.
INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, kind, created_by_membership_id)
VALUES ('${E2E_SEED.wikiSpace}', '${HOUSEHOLD}', 'cocina-e2e', 'Cocina E2E', 'Recetario de la batería e2e', 5, 'recipes', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, parent_page_id, status, current_slug, pinned, position, created_by_membership_id) VALUES
  ('${E2E_SEED.recipePages.conLeche}', '${HOUSEHOLD}', '${E2E_SEED.wikiSpace}', NULL, 'published', 'arroz-con-leche-e2e', false, 0, '${ADMIN_MEMBERSHIP}'),
  ('${E2E_SEED.recipePages.sinAlergenos}', '${HOUSEHOLD}', '${E2E_SEED.wikiSpace}', NULL, 'published', 'pollo-asado-e2e', false, 1, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${HOUSEHOLD}', '${E2E_SEED.recipePages.conLeche}', 'arroz-con-leche-e2e'),
  ('${HOUSEHOLD}', '${E2E_SEED.recipePages.sinAlergenos}', 'pollo-asado-e2e');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id) VALUES
  ('aa411000-0000-4000-8000-000000000001', '${HOUSEHOLD}', '${E2E_SEED.recipePages.conLeche}', 1,
   'Arroz con leche (E2E)', 'Cocer el arroz en la leche a fuego suave.', '', ARRAY['postre'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('aa421000-0000-4000-8000-000000000001', '${HOUSEHOLD}', '${E2E_SEED.recipePages.sinAlergenos}', 1,
   'Pollo asado (E2E)', 'Asar el pollo una hora a 190°.', '', ARRAY['comida'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = 'aa411000-0000-4000-8000-000000000001' WHERE id = '${E2E_SEED.recipePages.conLeche}';
UPDATE app.wiki_pages SET current_revision_id = 'aa421000-0000-4000-8000-000000000001' WHERE id = '${E2E_SEED.recipePages.sinAlergenos}';

INSERT INTO app.recipes (household_id, page_id, base_servings, time_minutes) VALUES
  ('${HOUSEHOLD}', '${E2E_SEED.recipePages.conLeche}', 4, 45),
  ('${HOUSEHOLD}', '${E2E_SEED.recipePages.sinAlergenos}', 4, 60);

INSERT INTO app.recipe_ingredients (id, household_id, page_id, food_id, quantity, unit, scaling, position) VALUES
  ('aa412000-0000-4000-8000-000000000001', '${HOUSEHOLD}', '${E2E_SEED.recipePages.conLeche}', '${E2E_SEED.foods.leche}', 1, 'l', 'linear', 0),
  ('aa412000-0000-4000-8000-000000000002', '${HOUSEHOLD}', '${E2E_SEED.recipePages.conLeche}', '${E2E_SEED.foods.arroz}', 0.25, 'kg', 'linear', 1),
  ('aa422000-0000-4000-8000-000000000001', '${HOUSEHOLD}', '${E2E_SEED.recipePages.sinAlergenos}', '${E2E_SEED.foods.pollo}', 1.5, 'kg', 'linear', 0);

-- Rutinas: una de audiencia empleada que vence hoy y una solo de familia.
INSERT INTO app.routines (id, household_id, title, details, audience, next_due_hint, created_by_membership_id,
  pattern, anchor_on, repeat_every) VALUES
  ('${E2E_SEED.routines.employee}', '${HOUSEHOLD}', 'Repaso del filtro del agua (E2E)', 'Aclarar el filtro de la jarra', 'employee', current_date, '${ADMIN_MEMBERSHIP}', 'every_n_days', current_date, 7),
  ('${E2E_SEED.routines.family}', '${HOUSEHOLD}', 'Revisión del botiquín (E2E)', '', 'family', current_date + 1, '${ADMIN_MEMBERSHIP}', 'every_n_days', current_date + 1, 30);

-- Jornadas extra de Ana en el mes en curso: una solicitada (pendiente de
-- aceptación) y un festivo trabajado sin aceptación previa (para resolver).
INSERT INTO app.extra_work_events (
  id, household_id, agreement_id, employee_membership_id, kind, worked_on,
  duration_minutes, note, origin, status, requested_by_membership_id, requested_at,
  performed_by_membership_id, performed_at
) VALUES
  ('${E2E_SEED.extras.requested}', '${HOUSEHOLD}', '${E2E_SEED.agreement}', '${E2E_SEED.memberships.employee}',
   'overtime', date_trunc('month', current_date)::date + 1, 90, 'Plancha del sábado E2E', 'employee_report',
   'requested', '${E2E_SEED.memberships.employee}', now() - interval '2 days', NULL, NULL),
  ('${E2E_SEED.extras.porResolver}', '${HOUSEHOLD}', '${E2E_SEED.agreement}', '${E2E_SEED.memberships.employee}',
   'worked_rest_day', date_trunc('month', current_date)::date, 480, 'Festivo trabajado E2E', 'employee_report',
   'performed_pending_resolution', '${E2E_SEED.memberships.employee}', now() - interval '3 days',
   '${E2E_SEED.memberships.employee}', now() - interval '3 days' + interval '1 hour');

INSERT INTO app.extra_work_transitions (
  id, household_id, extra_work_event_id, sequence_number, from_status, to_status,
  actor_membership_id, occurred_at, reason
) VALUES
  ('aa610000-0000-4000-8000-000000000001', '${HOUSEHOLD}', '${E2E_SEED.extras.requested}', 1, NULL, 'requested',
   '${E2E_SEED.memberships.employee}', now() - interval '2 days', 'Solicitada E2E'),
  ('aa610000-0000-4000-8000-000000000002', '${HOUSEHOLD}', '${E2E_SEED.extras.porResolver}', 1, NULL, 'requested',
   '${E2E_SEED.memberships.employee}', now() - interval '3 days', 'Solicitada E2E'),
  ('aa610000-0000-4000-8000-000000000003', '${HOUSEHOLD}', '${E2E_SEED.extras.porResolver}', 2, 'requested', 'performed_pending_resolution',
   '${E2E_SEED.memberships.employee}', now() - interval '3 days' + interval '1 hour', 'Realizada sin aceptación previa E2E');

-- Contactos reales del hogar: dos destacados (Emergencias + snapshot) y uno
-- solo de directorio. El nombre del pediatra replica la fixture para que la
-- batería offline (emergency-offline.dbe2e) siga afirmando el mismo texto.
INSERT INTO app.contacts (id, household_id, name, role_label, phone, kind, featured, notes, position, created_by_membership_id) VALUES
  ('${E2E_SEED.contacts.pediatra}', '${HOUSEHOLD}', 'Centro Pediátrico Olmo', 'Pediatría', '910 000 111', 'health', true, '', 0, '${ADMIN_MEMBERSHIP}'),
  ('${E2E_SEED.contacts.vecina}', '${HOUSEHOLD}', 'Carmen · 2.º B', 'Vecina de confianza', '600 000 344', 'home', true, 'Tiene llaves de repuesto', 1, '${ADMIN_MEMBERSHIP}'),
  ('${E2E_SEED.contacts.fontanero}', '${HOUSEHOLD}', 'Javier · Fontanería', 'Averías de agua', '600 000 122', 'service', false, '', 2, '${ADMIN_MEMBERSHIP}');

-- Gasto de Ana pendiente de aprobación, dentro del mes en curso.
INSERT INTO app.expenses (
  id, household_id, agreement_id, employee_membership_id, incurred_on,
  description, amount_cents, status, submitted_by_membership_id, submitted_at
) VALUES (
  '${E2E_SEED.expensePending}', '${HOUSEHOLD}', '${E2E_SEED.agreement}', '${E2E_SEED.memberships.employee}',
  date_trunc('month', current_date)::date + 2, 'Farmacia E2E pendiente', 2175, 'pending',
  '${E2E_SEED.memberships.employee}', now() - interval '1 day'
);

COMMIT;
`;

export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env.E2E_DATABASE_URL;
  if (!adminUrl) return;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('drop schema if exists app cascade');
    await admin.query('drop schema if exists app_private cascade');
    await admin.query('drop table if exists public.schema_migrations');

    const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
    const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
    const { applyMigrations } = (await import(migrateHref)) as {
      applyMigrations: (client: pg.Client) => Promise<unknown>;
    };
    await applyMigrations(admin);

    const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
    for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
      await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
    }
    await admin.query(WIKI_SEED);
    await admin.query(E2E_BATTERY_SEED);

    // Login del servidor web: miembro de casa_clara_app, sin BYPASSRLS. Se
    // conserva entre ejecuciones (el servidor anterior puede seguir teniendo
    // conexiones abiertas y `drop role` fallaría).
    await admin.query(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = '${E2E_APP_LOGIN}') then
           create role ${E2E_APP_LOGIN} login password '${E2E_APP_PASSWORD}' nosuperuser nobypassrls in role casa_clara_app;
         else
           alter role ${E2E_APP_LOGIN} with login nosuperuser nobypassrls password '${E2E_APP_PASSWORD}';
           grant casa_clara_app to ${E2E_APP_LOGIN};
         end if;
       end $$;`
    );
  } finally {
    await admin.end();
  }
}
