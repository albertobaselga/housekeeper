-- Negative RLS matrix across the two fixture households and the runtime roles.
-- Requires migrations plus fixtures/001_two_households.sql already applied, and a
-- connection allowed to SET ROLE casa_clara_app / casa_clara_worker.
--
-- Covers the five brief roles (family_admin, family_member, employee_live_in,
-- helper, viewer) plus the worker contract, over: settlements and agreement
-- versions (member sees the agreement but NOT the versions; helper/viewer see
-- no employment data at all), expenses, draft vs published wiki, menu slots,
-- routines by audience, and zero visibility of the olivo household from a
-- roble context for every role.

-- ─────────────────────────────────────────────────────────────────────────────
-- Aislamiento estructural de los roles de ejecución.
--
-- La migración 0018 levanta FORCE ROW LEVEL SECURITY cuando el propietario del
-- esquema no puede puentear RLS (Supabase). FORCE sólo somete al PROPIETARIO a
-- sus propias políticas, así que quitarlo no debería cambiar nada para
-- casa_clara_app ni casa_clara_worker. Este bloque convierte ese «no debería»
-- en tres condiciones verificables, y falla si alguna deja de cumplirse:
--
--   1. Ninguno de los dos roles es superusuario ni tiene BYPASSRLS.
--   2. Ninguno de los dos posee tablas de app/app_private, ni pertenece
--      (directamente o por transitividad) a ningún rol que las posea. Sin
--      propiedad, FORCE es irrelevante para ellos.
--   3. Todas las tablas de app/app_private siguen con RLS ACTIVADA.
--
-- El resto del fichero comprueba el efecto observable: quién ve qué fila.
-- ─────────────────────────────────────────────────────────────────────────────
DO $assert_runtime_roles_are_subject_to_rls$
DECLARE
  runtime_role text;
  privileged integer;
  owned integer;
  owner_membership integer;
  unprotected integer;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['casa_clara_app', 'casa_clara_worker'] LOOP
    SELECT count(*)::integer INTO privileged
      FROM pg_catalog.pg_roles
     WHERE rolname = runtime_role
       AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication);
    IF privileged <> 0 THEN
      RAISE EXCEPTION '% carries a role attribute that would let it escape RLS', runtime_role;
    END IF;

    SELECT count(*)::integer INTO owned
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname IN ('app', 'app_private')
       AND relation.relkind = 'r'
       AND relation.relowner = runtime_role::regrole;
    IF owned <> 0 THEN
      RAISE EXCEPTION '% owns % tenant tables; FORCE RLS would be its only protection', runtime_role, owned;
    END IF;

    SELECT count(DISTINCT relation.relowner)::integer INTO owner_membership
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname IN ('app', 'app_private')
       AND relation.relkind = 'r'
       AND (pg_catalog.pg_has_role(runtime_role, relation.relowner, 'USAGE')
            OR pg_catalog.pg_has_role(runtime_role, relation.relowner, 'MEMBER'));
    IF owner_membership <> 0 THEN
      RAISE EXCEPTION '% can act as the owner of % tenant table owner role(s)', runtime_role, owner_membership;
    END IF;
  END LOOP;

  SELECT count(*)::integer INTO unprotected
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname IN ('app', 'app_private')
     AND relation.relkind = 'r'
     AND NOT relation.relrowsecurity;
  IF unprotected <> 0 THEN
    RAISE EXCEPTION '% tenant tables have row level security disabled', unprotected;
  END IF;
END
$assert_runtime_roles_are_subject_to_rls$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed (superuser, RLS off): wiki, menu and routines for roble; a parallel set
-- plus one settlement and one expense for olivo so the cross-tenant assertions
-- have real rows to leak. UUID prefixes aa* (roble) / ab* (olivo) are exclusive
-- to this file.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id) VALUES
  ('aa000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'matriz-rls', 'Matriz RLS', 'Espacio sembrado por 020_rls_matrix.sql', 0,
   '11000000-0000-4000-8000-000000000001'),
  ('ab000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'matriz-rls-olivo', 'Matriz RLS Olivo', 'Espacio del segundo hogar', 0,
   '21000000-0000-4000-8000-000000000001');

INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, created_by_membership_id) VALUES
  ('aa100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'aa000000-0000-4000-8000-000000000001', 'published', 'matriz-publicada',
   '11000000-0000-4000-8000-000000000001'),
  ('aa100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'aa000000-0000-4000-8000-000000000001', 'draft', 'matriz-borrador',
   '11000000-0000-4000-8000-000000000001'),
  ('ab100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'ab000000-0000-4000-8000-000000000001', 'published', 'olivo-publicada',
   '21000000-0000-4000-8000-000000000001');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aa100000-0000-4000-8000-000000000001', 'matriz-publicada'),
  ('10000000-0000-4000-8000-000000000001', 'aa100000-0000-4000-8000-000000000002', 'matriz-borrador'),
  ('20000000-0000-4000-8000-000000000001', 'ab100000-0000-4000-8000-000000000001', 'olivo-publicada');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id) VALUES
  ('aa200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'aa100000-0000-4000-8000-000000000001', 1, 'Página publicada de la matriz',
   'Contenido publicado.', '11000000-0000-4000-8000-000000000001'),
  ('aa200000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'aa100000-0000-4000-8000-000000000002', 1, 'Borrador de la matriz',
   'Contenido en borrador.', '11000000-0000-4000-8000-000000000001'),
  ('ab200000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'ab100000-0000-4000-8000-000000000001', 1, 'Página publicada de olivo',
   'Contenido del otro hogar.', '21000000-0000-4000-8000-000000000001');

UPDATE app.wiki_pages SET current_revision_id = 'aa200000-0000-4000-8000-000000000001'
 WHERE id = 'aa100000-0000-4000-8000-000000000001';
UPDATE app.wiki_pages SET current_revision_id = 'aa200000-0000-4000-8000-000000000002'
 WHERE id = 'aa100000-0000-4000-8000-000000000002';
UPDATE app.wiki_pages SET current_revision_id = 'ab200000-0000-4000-8000-000000000001'
 WHERE id = 'ab100000-0000-4000-8000-000000000001';

INSERT INTO app.menu_groups (id, household_id, name, position) VALUES
  ('aa300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Mesa matriz', 0),
  ('ab300000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Mesa olivo', 0);

INSERT INTO app.menu_slots (id, household_id, group_id, on_date, meal, free_text, updated_by_membership_id) VALUES
  ('aa400000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'aa300000-0000-4000-8000-000000000001', '2026-08-10', 'comida', 'Lentejas de la matriz',
   '11000000-0000-4000-8000-000000000001'),
  ('ab400000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'ab300000-0000-4000-8000-000000000001', '2026-08-10', 'cena', 'Sopa del olivo',
   '21000000-0000-4000-8000-000000000001');

-- Las columnas de patrón (0023) van explícitas porque `routines_pattern_shape`
-- no admite una fila con fecha y sin cadencia: `pattern IS NULL` significa «se
-- hace, falta decidir cuándo» y obliga a `next_due_hint IS NULL`. Las heredadas
-- (`frequency`, `interval_count`) YA NO ESTÁN: las retiró la 0033, que renombró
-- además `next_due_on` a `next_due_hint`. Ni una aserción de este fichero
-- cambia por ello, y ése es justo el punto — la audiencia se decide con
-- `audience` y el hogar con `household_id`; la cadencia nunca abrió ni cerró
-- nada, ni cuando había dos vocabularios ni ahora que hay uno.
INSERT INTO app.routines (id, household_id, title, audience, next_due_hint,
  pattern, anchor_on, repeat_every, weekdays, month_day, overdue_policy, created_by_membership_id) VALUES
  ('aa500000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Revisión de seguros (familia)', 'family', '2026-09-01',
   'day_of_month', '2026-09-01', 1, NULL, 1, 'carry',
   '11000000-0000-4000-8000-000000000001'),
  ('aa500000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'Plancha semanal (empleada)', 'employee', '2026-08-17',
   'days_of_week', '2026-08-17', 1, ARRAY[1]::smallint[], NULL, 'skip',
   '11000000-0000-4000-8000-000000000001'),
  ('aa500000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'Riego de plantas (todos)', 'all', '2026-08-08',
   'every_n_days', '2026-08-08', 1, NULL, NULL, 'skip',
   '11000000-0000-4000-8000-000000000001'),
  ('ab500000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Rutina del olivo', 'all', '2026-08-17',
   'days_of_week', '2026-08-17', 1, ARRAY[1]::smallint[], NULL, 'skip',
   '21000000-0000-4000-8000-000000000001');

-- Employment rows for olivo so the cross-tenant checks have something to leak.
INSERT INTO app.settlements (id, household_id, agreement_id, employee_membership_id,
  period_start, period_end, due_on, created_by_membership_id) VALUES
  ('ab600000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002',
   '2025-04-01', '2025-04-30', '2025-04-30', '21000000-0000-4000-8000-000000000001');

INSERT INTO app.expenses (id, household_id, agreement_id, employee_membership_id,
  incurred_on, description, amount_cents, status, submitted_by_membership_id, submitted_at) VALUES
  ('ab700000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002',
   '2025-04-10', 'Gasto sembrado del olivo', 999, 'pending',
   '21000000-0000-4000-8000-000000000002', '2025-04-10T10:00:00Z');

-- Expired membership (F4-03 in the matrix): a roble viewer whose expires_at is
-- already in the past. No role may select this context.
INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('fixture:roble:expired', 'Fixture Caducada Roble');
INSERT INTO app.household_memberships (id, household_id, user_id, role, starts_at, expires_at) VALUES
  ('aa900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'fixture:roble:expired', 'viewer',
   statement_timestamp() - interval '2 days', statement_timestamp() - interval '1 day');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Application role: the five household roles, one after another, all under a
-- roble context. Every block also asserts zero rows from the olivo household.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);

DO $assert_membership_discovery$
DECLARE
  visible_memberships integer;
BEGIN
  SELECT count(*)::integer INTO visible_memberships FROM app.household_memberships;
  IF visible_memberships <> 1 THEN
    RAISE EXCEPTION 'user-id-only membership discovery expected 1 row, got %', visible_memberships;
  END IF;
END
$assert_membership_discovery$;

SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_rls$
DECLARE
  visible_households integer;
  visible_settlements integer;
  leaked_settlements integer;
  visible_total bigint;
BEGIN
  SELECT count(*)::integer INTO visible_households FROM app.households;
  SELECT count(*)::integer, max(transfer_total_cents)
    INTO visible_settlements, visible_total FROM app.settlements;
  SELECT count(*)::integer INTO leaked_settlements
    FROM app.settlements
   WHERE household_id = '20000000-0000-4000-8000-000000000001';
  IF visible_households <> 1 OR visible_settlements <> 1
     OR visible_total <> 145330 OR leaked_settlements <> 0 THEN
    RAISE EXCEPTION 'admin tenant isolation failed';
  END IF;

  -- Full read surface of the administrator over roble.
  -- Dos acuerdos activos y sus tres versiones: el hogar puede emplear a más de
  -- una persona y quien administra las ve a todas.
  IF (SELECT count(*) FROM app.settlement_lines) <> 8
     OR (SELECT count(*) FROM app.payments) <> 2
     OR (SELECT count(*) FROM app.employment_agreements) <> 2
     OR (SELECT count(*) FROM app.agreement_versions) <> 3
     OR (SELECT count(*) FROM app.expenses) <> 2
     OR (SELECT count(*) FROM app.wiki_pages) <> 2
     OR (SELECT count(*) FROM app.wiki_revisions) <> 2
     OR (SELECT count(*) FROM app.menu_slots) <> 1
     OR (SELECT count(*) FROM app.routines) <> 3 THEN
    RAISE EXCEPTION 'family_admin read matrix failed';
  END IF;

  BEGIN
    INSERT INTO app.command_receipts (
      household_id, operation_id, command_type, payload_hash, result, actor_membership_id
    ) VALUES (
      '20000000-0000-4000-8000-000000000001', gen_random_uuid(),
      'fixture.cross_tenant', repeat('e', 64), '{}'::jsonb,
      '21000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-tenant RLS insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin_rls$;

DO $assert_admin_no_olivo$
BEGIN
  IF (SELECT count(*) FROM app.settlements    WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.expenses    WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.wiki_pages  WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.wiki_revisions WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.menu_slots  WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.routines    WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.households  WHERE id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_admin leaked rows from the olivo household';
  END IF;
END
$assert_admin_no_olivo$;

-- family_member: sees the agreement relationship, the PUBLISHED guide (drafts
-- belong to whoever administers it since migration 0026), menu and every
-- routine audience, but NO salary-bearing rows (agreement versions,
-- settlements, lines, payments) and NO expenses (migration 0038: an expense
-- carries an amount, and amounts do not reach the non-administering family).
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_family_member_rls$
BEGIN
  IF (SELECT count(*) FROM app.households) <> 1
     OR (SELECT count(*) FROM app.employment_agreements) <> 2
     OR (SELECT count(*) FROM app.wiki_pages) <> 1
     OR (SELECT count(*) FROM app.wiki_pages WHERE status = 'draft') <> 0
     OR (SELECT count(*) FROM app.wiki_revisions) <> 1
     OR (SELECT count(*) FROM app.menu_slots) <> 1
     OR (SELECT count(*) FROM app.routines) <> 3 THEN
    RAISE EXCEPTION 'family_member positive read matrix failed';
  END IF;
  -- The financial core stays invisible: the member sees the relationship but
  -- never the money (AC-12 / control 1 of the baseline).
  --
  -- `expenses` belongs in this list since migration 0038 and not in the one
  -- above. It used to be the single exception in the whole schema —
  -- `expenses_read` passed `include_family_member => true`— and it leaked the
  -- description, the date and the AMOUNT of what the employee had advanced out
  -- of her own pocket, plus the link to the receipt. There is no reading of the
  -- product rule that makes an expense less about money than a settlement line.
  IF (SELECT count(*) FROM app.agreement_versions) <> 0
     OR (SELECT count(*) FROM app.expenses) <> 0
     OR (SELECT count(*) FROM app.settlements) <> 0
     OR (SELECT count(*) FROM app.settlement_lines) <> 0
     OR (SELECT count(*) FROM app.payments) <> 0 THEN
    RAISE EXCEPTION 'family_member unexpectedly read salary-bearing rows';
  END IF;
  IF (SELECT count(*) FROM app.settlements WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.expenses WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.wiki_pages WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.routines WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.menu_slots WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_member leaked rows from the olivo household';
  END IF;
END
$assert_family_member_rls$;

-- employee_live_in: full view of her own employment record (settlement, lines,
-- payments, agreement versions, expenses), the PUBLISHED guide only (she reads
-- it, she no longer writes it: migración 0026), menu, and routines with
-- audience employee/all — never the family-only ones.
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_rls$
DECLARE
  own_total bigint;
BEGIN
  SELECT max(transfer_total_cents) INTO own_total FROM app.settlements;
  IF (SELECT count(*) FROM app.settlements) <> 1
     OR own_total <> 145330
     OR (SELECT count(*) FROM app.settlement_lines) <> 8
     OR (SELECT count(*) FROM app.payments) <> 2
     OR (SELECT count(*) FROM app.employment_agreements) <> 1
     OR (SELECT count(*) FROM app.agreement_versions) <> 2
     OR (SELECT count(*) FROM app.expenses) <> 2
     OR (SELECT count(*) FROM app.wiki_pages) <> 1
     OR (SELECT count(*) FROM app.wiki_pages WHERE status = 'draft') <> 0
     OR (SELECT count(*) FROM app.wiki_revisions) <> 1
     OR (SELECT count(*) FROM app.menu_slots) <> 1 THEN
    RAISE EXCEPTION 'employee_live_in positive read matrix failed';
  END IF;
  IF (SELECT count(*) FROM app.routines) <> 2
     OR (SELECT count(*) FROM app.routines WHERE audience = 'family') <> 0 THEN
    RAISE EXCEPTION 'employee_live_in must not see family-audience routines';
  END IF;
  -- Con DOS empleadas en el hogar, «ve su expediente» significa «ve el suyo y
  -- nada del de su compañera»: ni el acuerdo, ni sus versiones, ni el catálogo
  -- de conceptos con el que se le pagan las jornadas.
  IF (SELECT count(*) FROM app.employment_agreements
       WHERE employee_membership_id <> '11000000-0000-4000-8000-000000000003') <> 0
     OR (SELECT count(*) FROM app.agreement_versions
          WHERE agreement_id = '12000000-0000-4000-8000-000000000002') <> 0
     OR (SELECT count(*) FROM app.extra_work_types
          WHERE agreement_id = '12000000-0000-4000-8000-000000000002') <> 0 THEN
    RAISE EXCEPTION 'employee_live_in leaked the other employee record';
  END IF;
  IF (SELECT count(*) FROM app.settlements WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.expenses WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.wiki_pages WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.routines WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.menu_slots WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'employee_live_in leaked rows from the olivo household';
  END IF;
END
$assert_employee_rls$;

-- helper: nothing employment-related at all; wiki only when published; menu
-- yes; routines only audience 'all'; aggregated search gaps are family-only.
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_rls$
BEGIN
  IF (SELECT count(*) FROM app.employment_agreements) <> 0
     OR (SELECT count(*) FROM app.agreement_versions) <> 0
     OR (SELECT count(*) FROM app.settlements) <> 0
     OR (SELECT count(*) FROM app.settlement_lines) <> 0
     OR (SELECT count(*) FROM app.payments) <> 0
     OR (SELECT count(*) FROM app.expenses) <> 0
     OR (SELECT count(*) FROM app.compensation_ledger_entries) <> 0 THEN
    RAISE EXCEPTION 'helper unexpectedly read employment data';
  END IF;
  IF (SELECT count(*) FROM app.wiki_pages) <> 1
     OR (SELECT count(*) FROM app.wiki_pages WHERE status = 'draft') <> 0
     OR (SELECT count(*) FROM app.wiki_revisions) <> 1 THEN
    RAISE EXCEPTION 'helper must see published wiki content only';
  END IF;
  IF (SELECT count(*) FROM app.menu_slots) <> 1 THEN
    RAISE EXCEPTION 'helper should read the menu';
  END IF;
  IF (SELECT count(*) FROM app.routines) <> 1
     OR (SELECT count(*) FROM app.routines WHERE audience <> 'all') <> 0 THEN
    RAISE EXCEPTION 'helper must see audience-all routines only';
  END IF;
  IF (SELECT count(*) FROM app.search_gap_events) <> 0 THEN
    RAISE EXCEPTION 'helper unexpectedly read aggregated search gaps';
  END IF;
  IF (SELECT count(*) FROM app.settlements WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.expenses WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.wiki_pages WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.routines WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.menu_slots WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'helper leaked rows from the olivo household';
  END IF;
END
$assert_helper_rls$;

-- viewer: only the household row itself; no employment, wiki, menu or routine
-- rows whatsoever.
SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer_rls$
BEGIN
  IF (SELECT count(*) FROM app.households) <> 1
     OR (SELECT count(*) FROM app.employment_agreements) <> 0
     OR (SELECT count(*) FROM app.agreement_versions) <> 0
     OR (SELECT count(*) FROM app.settlements) <> 0
     OR (SELECT count(*) FROM app.settlement_lines) <> 0
     OR (SELECT count(*) FROM app.payments) <> 0
     OR (SELECT count(*) FROM app.expenses) <> 0 THEN
    RAISE EXCEPTION 'viewer access matrix failed';
  END IF;
  IF (SELECT count(*) FROM app.wiki_spaces) <> 0
     OR (SELECT count(*) FROM app.wiki_pages) <> 0
     OR (SELECT count(*) FROM app.wiki_revisions) <> 0
     OR (SELECT count(*) FROM app.menu_slots) <> 0
     OR (SELECT count(*) FROM app.routines) <> 0
     OR (SELECT count(*) FROM app.search_gap_events) <> 0 THEN
    RAISE EXCEPTION 'viewer must not read wiki, menu, routines or search gaps';
  END IF;
  IF (SELECT count(*) FROM app.settlements WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.wiki_pages WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.routines WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'viewer leaked rows from the olivo household';
  END IF;
END
$assert_viewer_rls$;

-- Context spoofing: an authenticated roble identity cannot select an olivo
-- membership, and an expired membership is dead for context selection too.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);

DO $assert_context_spoofing$
BEGIN
  BEGIN
    PERFORM app.set_household_context(
      '20000000-0000-4000-8000-000000000001',
      '21000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-user context selection unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_context_spoofing$;

SELECT set_config('app.user_id', 'fixture:roble:expired', true);

DO $assert_expired_membership$
BEGIN
  -- Discovery already filters expirations: the expired viewer sees no
  -- membership of her own.
  IF (SELECT count(*) FROM app.household_memberships) <> 0 THEN
    RAISE EXCEPTION 'expired membership unexpectedly discoverable';
  END IF;
  BEGIN
    PERFORM app.set_household_context(
      '10000000-0000-4000-8000-000000000001',
      'aa900000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'expired membership context selection unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_expired_membership$;

COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_worker;
DO $assert_worker_contract$
DECLARE
  jobs integer;
BEGIN
  SELECT count(*)::integer INTO jobs FROM app_private.job_queue;
  IF jobs <> 1 THEN
    RAISE EXCEPTION 'worker expected one fixture job, got %', jobs;
  END IF;
  BEGIN
    PERFORM 1 FROM app.settlements;
    RAISE EXCEPTION 'worker unexpectedly read settlement data directly';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM 1 FROM app.wiki_revisions;
    RAISE EXCEPTION 'worker unexpectedly read wiki content directly';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_worker_contract$;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Lo que la migración 0018 concede al propietario del esquema y NO concede a
-- los roles de ejecución. Con FORCE levantado, el propietario puede leer con
-- `row_security = off`; casa_clara_app y casa_clara_worker no pueden, ni pueden
-- recuperar esa latitud tocando las tablas. Los tres intentos son fallos
-- esperados con SQLSTATE 42501: si alguno dejara de fallar, la matriz se pone
-- roja aunque todos los recuentos de filas de arriba sigan cuadrando.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
DO $assert_app_cannot_bypass_rls$
BEGIN
  BEGIN
    SET LOCAL row_security = off;
    PERFORM 1 FROM app.settlements;
    RAISE EXCEPTION 'casa_clara_app read app.settlements with row_security = off';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    EXECUTE 'ALTER TABLE app.settlements NO FORCE ROW LEVEL SECURITY';
    RAISE EXCEPTION 'casa_clara_app was able to relax FORCE RLS on app.settlements';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    EXECUTE 'ALTER TABLE app.settlements DISABLE ROW LEVEL SECURITY';
    RAISE EXCEPTION 'casa_clara_app was able to disable RLS on app.settlements';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_app_cannot_bypass_rls$;
COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_worker;
DO $assert_worker_cannot_bypass_rls$
BEGIN
  BEGIN
    SET LOCAL row_security = off;
    PERFORM 1 FROM app_private.job_queue;
    RAISE EXCEPTION 'casa_clara_worker read app_private.job_queue with row_security = off';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    EXECUTE 'ALTER TABLE app_private.job_queue NO FORCE ROW LEVEL SECURITY';
    RAISE EXCEPTION 'casa_clara_worker was able to relax FORCE RLS on app_private.job_queue';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_worker_cannot_bypass_rls$;
COMMIT;
