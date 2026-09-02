-- El recibo PDF, registrado y descargable (migración 0035).
--
-- Requiere migraciones + fixtures/001_two_households.sql, y una conexión que
-- pueda SET ROLE casa_clara_app y casa_clara_worker.
--
-- Prefijos de UUID exclusivos de este fichero: fc… . Cada bloque siembra y
-- deshace lo suyo (BEGIN…ROLLBACK); el bloque 4 reutiliza a propósito la
-- liquidación COMMITteada por 170_push_subscriptions.sql (household roble,
-- acuerdo de la segunda empleada, junio de 2026, cerrada) para probar el
-- backfill sin tener que fabricar una liquidación cerrada nueva.
--
-- La liquidación de marzo de 2025 de la fixture base
-- ('12b00000-0000-4000-8000-000000000001', household roble, acuerdo de la
-- PRIMERA empleada, membresía …0003) ya está cerrada de fábrica: sirve de
-- liquidación real para casi todo el fichero sin sembrar nada más.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Forma: RLS, una sola política, GRANTs exactos y la firma de la función.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_shape$
DECLARE
  rls_enabled boolean;
  policies integer;
  app_select integer;
  app_write integer;
  worker_table_grants integer;
  worker_fn_grants integer;
  fn_signature text;
BEGIN
  SELECT relrowsecurity INTO rls_enabled
    FROM pg_catalog.pg_class WHERE oid = 'app.settlement_receipts'::regclass;
  IF NOT coalesce(rls_enabled, false) THEN
    RAISE EXCEPTION 'app.settlement_receipts se quedó sin ENABLE ROW LEVEL SECURITY';
  END IF;

  SELECT count(*)::integer INTO policies
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app' AND tablename = 'settlement_receipts';
  IF policies <> 1 THEN
    RAISE EXCEPTION 'app.settlement_receipts tiene % políticas; se esperaba una sola (lectura, calcada de settlements_read)', policies;
  END IF;

  SELECT count(*)::integer INTO app_select
    FROM information_schema.role_table_grants
   WHERE table_schema = 'app' AND table_name = 'settlement_receipts'
     AND grantee = 'casa_clara_app' AND privilege_type = 'SELECT';
  IF app_select <> 1 THEN
    RAISE EXCEPTION 'casa_clara_app no tiene SELECT sobre app.settlement_receipts';
  END IF;

  SELECT count(*)::integer INTO app_write
    FROM information_schema.role_table_grants
   WHERE table_schema = 'app' AND table_name = 'settlement_receipts'
     AND grantee = 'casa_clara_app' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF app_write <> 0 THEN
    RAISE EXCEPTION 'casa_clara_app tiene % permisos de escritura sobre app.settlement_receipts; la única vía es app_private.record_settlement_receipt', app_write;
  END IF;

  -- El worker tampoco tiene NADA directo sobre la tabla: escribe únicamente a
  -- través de la función definer, igual que con app.push_subscriptions (0032).
  SELECT count(*)::integer INTO worker_table_grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'app' AND table_name = 'settlement_receipts'
     AND grantee = 'casa_clara_worker';
  IF worker_table_grants <> 0 THEN
    RAISE EXCEPTION 'casa_clara_worker tiene % permisos directos sobre app.settlement_receipts', worker_table_grants;
  END IF;

  SELECT pg_catalog.pg_get_function_identity_arguments(oid) INTO fn_signature
    FROM pg_catalog.pg_proc
   WHERE proname = 'record_settlement_receipt' AND pronamespace = 'app_private'::regnamespace;
  IF fn_signature <> 'settlement uuid, target_bucket text, key text, content_sha256 text, size bigint' THEN
    RAISE EXCEPTION 'app_private.record_settlement_receipt cambió de firma («%»)', fn_signature;
  END IF;

  SELECT count(*)::integer INTO worker_fn_grants
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'app_private' AND routine_name = 'record_settlement_receipt'
     AND grantee = 'casa_clara_worker' AND privilege_type = 'EXECUTE';
  IF worker_fn_grants <> 1 THEN
    RAISE EXCEPTION 'casa_clara_worker no tiene EXECUTE sobre record_settlement_receipt (%)', worker_fn_grants;
  END IF;
END
$assert_shape$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Registro feliz + idempotencia: el mismo render dos veces no duplica nada.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

DO $assert_record_and_idempotent$
DECLARE
  first_document uuid;
  second_document uuid;
  receipts integer;
  documents integer;
  objects integer;
  title text;
  visibility text;
  owner uuid;
BEGIN
  -- La llamada de verdad, con el rol que la hace en producción: prueba que el
  -- GRANT de la migración 0035 basta de punta a punta, no solo que existe
  -- (eso ya lo comprueba la sección 1).
  SET ROLE casa_clara_worker;

  SELECT app_private.record_settlement_receipt(
    '12b00000-0000-4000-8000-000000000001', 'fixture-documents',
    'fixture/casa-roble/receipt-2025-03.pdf', repeat('1', 64), 12345
  ) INTO first_document;

  SELECT app_private.record_settlement_receipt(
    '12b00000-0000-4000-8000-000000000001', 'fixture-documents',
    'fixture/casa-roble/receipt-2025-03.pdf', repeat('1', 64), 12345
  ) INTO second_document;

  -- `casa_clara_worker` no tiene NADA de lectura directa sobre estas tres
  -- tablas (por diseño, ver sección 1): las comprobaciones de abajo tienen que
  -- volver al rol de esta sesión, o chocarían con "permission denied" antes de
  -- llegar a ningún IF.
  RESET ROLE;

  IF first_document IS NULL OR second_document IS NULL OR first_document <> second_document THEN
    RAISE EXCEPTION 'dos registros del mismo recibo devolvieron documentos distintos (% / %)', first_document, second_document;
  END IF;

  SELECT count(*)::integer INTO receipts
    FROM app.settlement_receipts
   WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF receipts <> 1 THEN
    RAISE EXCEPTION 're-registrar el mismo recibo dejó % filas en settlement_receipts; el PDF es determinista, debería ser una sola', receipts;
  END IF;

  SELECT count(*)::integer INTO documents
    FROM app.documents WHERE id = first_document;
  IF documents <> 1 THEN
    RAISE EXCEPTION 'el documento del recibo no existe (o se duplicó): %', documents;
  END IF;

  SELECT count(*)::integer INTO objects
    FROM app.storage_objects
   WHERE bucket = 'fixture-documents' AND object_key = 'fixture/casa-roble/receipt-2025-03.pdf';
  IF objects <> 1 THEN
    RAISE EXCEPTION 're-registrar el mismo recibo dejó % objetos de almacenamiento con la misma clave', objects;
  END IF;

  SELECT document.title, document.visibility::text, document.owner_membership_id
    INTO title, visibility, owner
    FROM app.documents AS document WHERE document.id = first_document;
  IF title <> 'Recibo 2025-03' THEN
    RAISE EXCEPTION 'el título del recibo es «%», se esperaba «Recibo 2025-03»', title;
  END IF;
  IF visibility <> 'employment' THEN
    RAISE EXCEPTION 'la visibilidad del recibo es «%», se esperaba employment', visibility;
  END IF;
  IF owner <> '11000000-0000-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'el dueño del recibo es %, se esperaba la empleada del contrato (…0003)', owner;
  END IF;
END
$assert_record_and_idempotent$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Rechaza una liquidación que no existe o que no está cerrada.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

-- `status` no se lista: su DEFAULT ('open', migración 0003) es exactamente lo
-- que esta sección necesita — una liquidación todavía ABIERTA.
INSERT INTO app.settlements (
  id, household_id, agreement_id, employee_membership_id, period_start, period_end,
  due_on, created_by_membership_id
) VALUES (
  'fc100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
  '2099-01-01', '2099-01-31', '2099-01-31', '11000000-0000-4000-8000-000000000001'
);

SET LOCAL ROLE casa_clara_worker;

DO $assert_rejects_bad_settlement$
BEGIN
  BEGIN
    PERFORM app_private.record_settlement_receipt(
      'fc100000-0000-4000-8000-000000000001', 'fixture-documents', 'fixture/casa-roble/no-deberia.pdf',
      repeat('3', 64), 1
    );
    RAISE EXCEPTION 'registró el recibo de una liquidación todavía ABIERTA';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    PERFORM app_private.record_settlement_receipt(
      'fc900000-0000-4000-8000-000000000009', 'fixture-documents', 'fixture/casa-roble/no-existe.pdf',
      repeat('4', 64), 1
    );
    RAISE EXCEPTION 'registró el recibo de una liquidación que no existe';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$assert_rejects_bad_settlement$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Backfill: la clave determinista ya existía en storage_objects (subida
--     por una versión anterior a este frente) y se reutiliza en vez de chocar
--     con su UNIQUE (bucket, object_key). Ver docs/runbooks/planificador-cola.md.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
) VALUES (
  'fc200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fixture-documents', 'fixture/casa-roble/receipt-backfill.pdf', 'application/pdf', 999,
  repeat('5', 64), '11000000-0000-4000-8000-000000000001'
);

DO $assert_backfill_reuses_object$
DECLARE
  document_id uuid;
  objects_with_key integer;
  reused_object uuid;
BEGIN
  -- La liquidación de junio de 2026 de 170_push_subscriptions.sql: ya cerrada,
  -- de un household/acuerdo distinto al de los bloques anteriores.
  SET ROLE casa_clara_worker;

  SELECT app_private.record_settlement_receipt(
    'fa100000-0000-4000-8000-000000000001', 'fixture-documents',
    'fixture/casa-roble/receipt-backfill.pdf', repeat('5', 64), 999
  ) INTO document_id;

  -- `casa_clara_worker` no lee `app.storage_objects` directamente (sección 1):
  -- de vuelta al rol de esta sesión para las comprobaciones de abajo.
  RESET ROLE;

  IF document_id IS NULL THEN
    RAISE EXCEPTION 'el backfill no devolvió documento';
  END IF;

  SELECT count(*)::integer INTO objects_with_key
    FROM app.storage_objects
   WHERE bucket = 'fixture-documents' AND object_key = 'fixture/casa-roble/receipt-backfill.pdf';
  IF objects_with_key <> 1 THEN
    RAISE EXCEPTION 'el backfill duplicó el objeto de almacenamiento (% filas) en vez de reutilizar el que ya existía', objects_with_key;
  END IF;

  SELECT id INTO reused_object
    FROM app.storage_objects
   WHERE bucket = 'fixture-documents' AND object_key = 'fixture/casa-roble/receipt-backfill.pdf';
  IF reused_object <> 'fc200000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'el backfill creó un objeto nuevo (%) en vez de reutilizar el original', reused_object;
  END IF;
END
$assert_backfill_reuses_object$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · Matriz de visibilidad: admin sí, la empleada del contrato sí, otra
--     empleada no, family_member/helper/viewer no, el otro hogar no.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
) VALUES (
  'fc300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fixture-documents', 'fixture/casa-roble/receipt-matrix.pdf', 'application/pdf', 42,
  repeat('6', 64), '11000000-0000-4000-8000-000000000001'
);
INSERT INTO app.documents (
  id, household_id, storage_object_id, owner_membership_id, visibility, document_type, title,
  created_by_membership_id
) VALUES (
  'fc300000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  'fc300000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 'employment',
  'settlement_receipt', 'Recibo 2025-03 (matriz)', '11000000-0000-4000-8000-000000000001'
);
INSERT INTO app.settlement_receipts (
  settlement_id, household_id, document_id, bucket, object_key, sha256, byte_size
) VALUES (
  '12b00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fc300000-0000-4000-8000-000000000002', 'fixture-documents', 'fixture/casa-roble/receipt-matrix.pdf',
  repeat('6', 64), 42
);

-- `row_security = off` seguiría activo para el resto de la transacción si no
-- se repone aquí: `casa_clara_app` no puede saltarse RLS (no es su dueña ni
-- superusuaria), y la combinación «off» + rol sin permiso para saltársela es
-- justo la que Postgres rechaza con «query would be affected by row-level
-- security policy» en vez de aplicar la política en silencio. Esta sección
-- existe precisamente para EJERCER esa política, así que tiene que quedar
-- puesta.
RESET row_security;
SET LOCAL ROLE casa_clara_app;

-- Quien administra.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_sees_it$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.settlement_receipts WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF visible <> 1 THEN
    RAISE EXCEPTION 'quien administra no ve el recibo de su propio hogar (% filas)', visible;
  END IF;
END
$assert_admin_sees_it$;

-- La empleada DEL contrato.
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003'
);

DO $assert_own_employee_sees_it$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.settlement_receipts WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF visible <> 1 THEN
    RAISE EXCEPTION 'la empleada del contrato no ve el recibo de su propia liquidación (% filas)', visible;
  END IF;
END
$assert_own_employee_sees_it$;

-- Cada rol que NO debe ver el recibo: otra empleada, family_member, helper,
-- viewer y el hogar ajeno.
SELECT set_config('app.user_id', 'fixture:roble:employee2', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000006'
);

DO $assert_other_employee_denied$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.settlement_receipts WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'la segunda empleada alcanza el recibo de una liquidación que no es la suya (% filas)', visible;
  END IF;
END
$assert_other_employee_denied$;

SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002'
);

DO $assert_family_member_denied$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.settlement_receipts WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'family_member alcanza el recibo (% filas): settlements_read tampoco lo incluye', visible;
  END IF;
END
$assert_family_member_denied$;

SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_denied$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.settlement_receipts WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'helper alcanza el recibo (% filas)', visible;
  END IF;
END
$assert_helper_denied$;

SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer_denied$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.settlement_receipts WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'viewer alcanza el recibo (% filas)', visible;
  END IF;
END
$assert_viewer_denied$;

SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001'
);

DO $assert_other_household_denied$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.settlement_receipts WHERE settlement_id = '12b00000-0000-4000-8000-000000000001';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'la administración del olivo alcanza un recibo del roble (% filas)', visible;
  END IF;
END
$assert_other_household_denied$;

ROLLBACK;
