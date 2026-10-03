-- Módulo «Cupones» (spec docs/superpowers/specs/2026-10-03-modulo-cupones-design.md
-- §4) desde la base. Lo que aquí se prueba es lo que la interfaz no puede
-- garantizar por sí sola:
--
--   1. Que la cartera es SOLO de la familia (D-audiencia): `family_admin` y
--      `family_member` leen y escriben; la empleada, el apoyo y el acceso
--      puntual ven CERO cupones, CERO usos y CERO objetos de almacenamiento de
--      fotos de cupón, aunque esas fotos las haya subido la familia.
--   2. Que es de TODA la familia (D-reparto): quien no subió la foto la ve en
--      cuanto un cupón la cita, y cualquiera de los dos papeles edita, usa,
--      anula, descarta y recupera los cupones de los demás.
--   3. Que lo único personal es la FIRMA: nadie guarda un cupón, apunta un uso
--      ni lo anula a nombre de otra persona, y la autoría no se reescribe. Y
--      que nadie cuelga de un cupón una foto que no subió (regla de enlace de
--      la spec §7.1, con respaldo en la base).
--   4. Que se registra y no se controla (D-usos): un cupón de un solo uso
--      admite un segundo, y uno descartado y caducado admite otro más.
--   5. Que anular no borra y no tiene vuelta atrás, y que no hay DELETE.
--   6. Que ningún hogar ve ni toca el del al lado, y que una membresía caducada
--      no abre nada.
--
-- Requiere migraciones + fixtures/001_two_households.sql. Todo lo que este
-- fichero escribe va dentro de transacciones que se REVIERTEN: no deja filas,
-- ni siquiera en `audit_events`, que es append-only. UUIDs con prefijo cd*
-- (roble) y ce* (olivo), exclusivos de aquí: cd1/ce1 objetos de
-- almacenamiento, cd2/ce2 cupones, cd3/ce3 usos, cd4/ce4 sondas de CHECK, cd5
-- objetos que no son fotos de cupón (lo que suben la empleada, el apoyo y el
-- acceso puntual) y cd9 membresías propias.
--
-- Una trampa de orden que condiciona varias pruebas: en un INSERT, el
-- disparador BEFORE ROW `coupons_photo_link` corre ANTES que el WITH CHECK de
-- la política y responde el mismo 42501 a quien cita una foto que no subió.
-- Para que un rechazo pruebe la POLÍTICA, quien escribe usa una foto suya (y
-- se exige que el mensaje sea el de la RLS), o la regla de la foto se apaga
-- en una transacción aparte (las altas entre hogares, al final).

-- ─────────────────────────────────────────────────────────────────────────────
-- Forma del esquema: tablas, RLS activada y forzada, privilegios, políticas
-- (las dos mitades), disparadores e índices.
-- ─────────────────────────────────────────────────────────────────────────────
DO $assert_coupons_schema$
DECLARE
  coupon_tables text[] := ARRAY['coupons', 'coupon_uses'];
  probed_table text;
  owner_can_bypass boolean;
  policy_count integer;
  audit_triggers integer;
BEGIN
  SELECT rolsuper OR rolbypassrls INTO owner_can_bypass
    FROM pg_catalog.pg_roles WHERE rolname = current_user;

  FOREACH probed_table IN ARRAY coupon_tables LOOP
    IF to_regclass('app.' || probed_table) IS NULL THEN
      RAISE EXCEPTION 'falta la tabla app.%', probed_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = to_regclass('app.' || probed_table)
         AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'app.% no tiene ENABLE ROW LEVEL SECURITY', probed_table;
    END IF;
    -- FORCE como en 010: puesto donde el propietario puede puentear RLS
    -- (local, CI) y levantado por la 0018 donde no (Supabase, la sonda). Que
    -- la 0039 lo ponga de verdad lo comprueba su propio bloque $check$.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = to_regclass('app.' || probed_table)
         AND relation.relforcerowsecurity = coalesce(owner_can_bypass, false)
    ) THEN
      RAISE EXCEPTION 'app.% no tiene el FORCE ROW LEVEL SECURITY esperado (el propietario puentea: %)',
        probed_table, coalesce(owner_can_bypass, false);
    END IF;

    IF NOT has_table_privilege('casa_clara_app', 'app.' || probed_table, 'SELECT')
       OR NOT has_table_privilege('casa_clara_app', 'app.' || probed_table, 'INSERT')
       OR NOT has_table_privilege('casa_clara_app', 'app.' || probed_table, 'UPDATE') THEN
      RAISE EXCEPTION 'casa_clara_app necesita SELECT, INSERT y UPDATE sobre app.%', probed_table;
    END IF;
    -- Sin DELETE: un cupón se descarta y un uso se anula.
    IF has_table_privilege('casa_clara_app', 'app.' || probed_table, 'DELETE')
       OR has_table_privilege('casa_clara_app', 'app.' || probed_table, 'TRUNCATE') THEN
      RAISE EXCEPTION 'casa_clara_app puede borrar en app.%', probed_table;
    END IF;
    -- El emisor de trabajos no tiene nada que hacer aquí: no hay avisos push.
    IF has_table_privilege('casa_clara_worker', 'app.' || probed_table, 'SELECT')
       OR has_table_privilege('casa_clara_worker', 'app.' || probed_table, 'INSERT')
       OR has_table_privilege('casa_clara_worker', 'app.' || probed_table, 'UPDATE')
       OR has_table_privilege('casa_clara_worker', 'app.' || probed_table, 'DELETE') THEN
      RAISE EXCEPTION 'casa_clara_worker tiene privilegios sobre app.%', probed_table;
    END IF;

    -- Ninguna política que cubra DELETE: ni `FOR DELETE` ni `FOR ALL`. Así, si
    -- un día alguien concede DELETE por despiste, la RLS sigue sin dejar borrar.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'app' AND tablename = probed_table AND cmd IN ('DELETE', 'ALL')
    ) THEN
      RAISE EXCEPTION 'app.% tiene una política que cubre DELETE', probed_table;
    END IF;

    -- Las DOS mitades de cada política llevan el hogar del contexto y el papel
    -- de familia. `qual` es NULL en la de INSERT y `with_check` en la de
    -- SELECT: por eso cada lado se mira solo cuando existe.
    SELECT count(*)::integer INTO policy_count
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = probed_table
       AND permissive = 'PERMISSIVE'
       AND (qual IS NULL OR (qual LIKE '%tenant_context_matches(household_id)%'
                             AND qual LIKE '%family_role()%'))
       AND (with_check IS NULL OR (with_check LIKE '%tenant_context_matches(household_id)%'
                                   AND with_check LIKE '%family_role()%'));
    IF policy_count <> 3
       OR (SELECT count(*) FROM pg_catalog.pg_policies
            WHERE schemaname = 'app' AND tablename = probed_table) <> 3 THEN
      RAISE EXCEPTION 'app.% necesita exactamente tres políticas (leer, crear, cambiar) cerradas a la familia del hogar; cumplen %',
        probed_table, policy_count;
    END IF;
  END LOOP;

  -- Las firmas, en el WITH CHECK de cada escritura.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupons'
       AND policyname = 'coupons_family_insert' AND cmd = 'INSERT'
       AND with_check LIKE '%created_by_membership_id = %current_membership_id()%'
       AND with_check LIKE '%discarded_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'coupons_family_insert no exige que el cupón lo guarde quien escribe y nazca en la cartera';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupons'
       AND policyname = 'coupons_family_read' AND cmd = 'SELECT'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupons'
       AND policyname = 'coupons_family_update' AND cmd = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'faltan coupons_family_read o coupons_family_update';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupon_uses'
       AND policyname = 'coupon_uses_family_insert' AND cmd = 'INSERT'
       AND with_check LIKE '%used_by_membership_id = %current_membership_id()%'
       AND with_check LIKE '%app.coupons%'
  ) THEN
    RAISE EXCEPTION 'coupon_uses_family_insert no firma el uso o no hereda la visibilidad del cupón';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupon_uses'
       AND policyname = 'coupon_uses_family_read' AND cmd = 'SELECT'
       AND qual LIKE '%app.coupons%'
  ) THEN
    RAISE EXCEPTION 'coupon_uses_family_read no hereda la visibilidad del cupón';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupon_uses'
       AND policyname = 'coupon_uses_family_void' AND cmd = 'UPDATE'
       AND qual LIKE '%voided_at IS NULL%'
       AND with_check LIKE '%voided_at IS NOT NULL%'
       AND with_check LIKE '%voided_by_membership_id = %current_membership_id()%'
  ) THEN
    RAISE EXCEPTION 'coupon_uses_family_void no se limita a anular usos vivos a nombre de quien anula';
  END IF;

  -- La foto: permisiva NUEVA sobre storage_objects, acotada al hogar y al
  -- cupón que la cita (su EXISTS pasa por la RLS de coupons).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'storage_objects'
       AND policyname = 'storage_objects_read_coupon_photo'
       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'
       AND roles = ARRAY['casa_clara_app']::name[]
       AND qual LIKE '%tenant_context_matches(household_id)%'
       AND qual LIKE '%app.coupons%'
       AND qual LIKE '%photo_storage_object_id = storage_objects.id%'
  ) THEN
    RAISE EXCEPTION 'falta la política storage_objects_read_coupon_photo o no está acotada al cupón';
  END IF;
  -- Y la de siempre no se ha tocado para hacerle sitio.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'storage_objects'
       AND policyname = 'storage_objects_read' AND qual LIKE '%coupon%'
  ) THEN
    RAISE EXCEPTION 'storage_objects_read no debía cambiar';
  END IF;

  SELECT count(*)::integer INTO audit_triggers
    FROM pg_catalog.pg_trigger
   WHERE tgrelid IN (to_regclass('app.coupons'), to_regclass('app.coupon_uses'))
     AND tgname IN ('coupons_audit', 'coupon_uses_audit')
     AND tgfoid = to_regprocedure('app_private.write_audit_event()');
  IF audit_triggers <> 2 THEN
    RAISE EXCEPTION 'se esperaban 2 disparadores de auditoría de cupones, hay %', audit_triggers;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.coupons') AND tgname = 'coupons_touch_updated_at'
       AND tgfoid = to_regprocedure('app_private.touch_updated_at()')
  ) THEN
    RAISE EXCEPTION 'coupons no mantiene updated_at';
  END IF;
  -- Los cerrojos de la fila vigilan UPDATE (bit 16 de tgtype).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.coupons') AND tgname = 'coupons_keep_identity'
       AND (tgtype & 16) <> 0
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.coupon_uses') AND tgname = 'coupon_uses_keep_record'
       AND (tgtype & 16) <> 0
  ) THEN
    RAISE EXCEPTION 'faltan los cerrojos de identidad de coupons o de registro de coupon_uses';
  END IF;
  -- La regla de enlace de la foto, en INSERT (bit 4) y en UPDATE (bit 16).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.coupons') AND tgname = 'coupons_photo_link'
       AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0
  ) THEN
    RAISE EXCEPTION 'falta el respaldo en base de la regla de enlace de la foto (BEFORE INSERT OR UPDATE)';
  END IF;
  -- D-usos: NINGÚN disparador propio de INSERT en coupon_uses (bit 4). Lo
  -- único que corre al apuntar un uso es la auditoría, después.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.coupon_uses')
       AND NOT tgisinternal
       AND (tgtype & 4) <> 0
       AND tgname <> 'coupon_uses_audit'
  ) THEN
    RAISE EXCEPTION 'coupon_uses tiene un disparador de INSERT: los usos se registran, no se controlan (D-usos)';
  END IF;

  IF to_regclass('app.coupon_uses_live_idx') IS NULL
     OR to_regclass('app.coupons_household_idx') IS NULL THEN
    RAISE EXCEPTION 'faltan coupon_uses_live_idx o coupons_household_idx';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index
     WHERE indexrelid = to_regclass('app.coupon_uses_live_idx') AND indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'coupon_uses_live_idx tiene que ser parcial (solo usos vivos)';
  END IF;
  -- La política de la foto se suma con OR a TODA lectura de storage_objects
  -- de la aplicación y busca el cupón por (hogar, foto): sin este índice, cada
  -- lectura de un justificante recorrería los cupones del hogar.
  IF to_regclass('app.coupons_photo_idx') IS NULL
     OR pg_get_indexdef(to_regclass('app.coupons_photo_idx'))
        NOT LIKE '%ON app.coupons USING btree (household_id, photo_storage_object_id)' THEN
    RAISE EXCEPTION 'falta coupons_photo_idx sobre (household_id, photo_storage_object_id), entero';
  END IF;

  -- Los nombres de quien guardó y de quien usó, para toda la familia: una
  -- SECURITY DEFINER en plpgsql (el validador no planifica su cuerpo al
  -- crearla, así que no choca con el FORCE; lección de la 0032), con la RLS
  -- apagada DENTRO y la puerta del papel puesta por ella misma. Solo la
  -- aplicación la ejecuta: ni PUBLIC ni el emisor de trabajos.
  IF to_regprocedure('app.coupon_people()') IS NULL THEN
    RAISE EXCEPTION 'falta app.coupon_people(): la familia no administradora no vería quién usó un cupón';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS fn
      JOIN pg_catalog.pg_language AS lang ON lang.oid = fn.prolang
     WHERE fn.oid = to_regprocedure('app.coupon_people()')
       AND fn.prosecdef
       AND lang.lanname = 'plpgsql'
       AND 'row_security=off' = ANY (fn.proconfig)
       AND EXISTS (SELECT 1 FROM unnest(fn.proconfig) AS setting WHERE setting LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'app.coupon_people() tiene que ser plpgsql, SECURITY DEFINER, con search_path fijo y row_security=off';
  END IF;
  IF has_function_privilege('public', 'app.coupon_people()', 'EXECUTE')
     OR has_function_privilege('casa_clara_worker', 'app.coupon_people()', 'EXECUTE')
     OR NOT has_function_privilege('casa_clara_app', 'app.coupon_people()', 'EXECUTE') THEN
    RAISE EXCEPTION 'app.coupon_people() la tiene que ejecutar casa_clara_app y nadie más';
  END IF;
END
$assert_coupons_schema$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CHECKs y cerrojos de la fila, como propietario (sin RLS de por medio, para
-- que lo que salte sea la restricción y no una política). Todo se revierte.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
) VALUES (
  'cd400000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fixture-attachments', 'fixture/casa-roble/cupones/sonda-check.jpg', 'image/jpeg', 2048,
  repeat('d', 64), '11000000-0000-4000-8000-000000000001'
), (
  'ce400000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  'fixture-attachments', 'fixture/casa-olivo/cupones/sonda-check.jpg', 'image/jpeg', 2048,
  repeat('f', 64), '21000000-0000-4000-8000-000000000001'
);
INSERT INTO app.coupons (
  household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id,
  discarded_at, discarded_by_membership_id
) VALUES (
  '10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000002',
  'Comercio de la sonda', 'Oferta de la sonda', 'cd400000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001', NULL, NULL
), (
  '10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000005',
  'Comercio descartado', 'Oferta descartada', 'cd400000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  '2026-09-15T12:00:00Z', '11000000-0000-4000-8000-000000000002'
);
INSERT INTO app.coupon_uses (
  household_id, id, coupon_id, used_on, used_by_membership_id, voided_at, voided_by_membership_id
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000003',
   'cd400000-0000-4000-8000-000000000002', '2026-09-20',
   '11000000-0000-4000-8000-000000000002', NULL, NULL),
  ('10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000004',
   'cd400000-0000-4000-8000-000000000002', '2026-09-21',
   '11000000-0000-4000-8000-000000000002', '2026-09-21T12:00:00Z',
   '11000000-0000-4000-8000-000000000002');

DO $assert_coupon_checks$
DECLARE
  bad record;
  good record;
BEGIN
  -- Lo que los CHECK rechazan. Una fila por caso, todas con el mismo id: como
  -- cada intento falla, ninguna llega a ocupar la clave.
  FOR bad IN
    SELECT * FROM (VALUES
      ('comercio vacío',            '',                'Oferta',          NULL::text,       NULL::integer, NULL::text),
      ('comercio solo de espacios', '   ',             'Oferta',          NULL,             NULL,          NULL),
      ('comercio de 121',           repeat('m', 121),  'Oferta',          NULL,             NULL,          NULL),
      ('oferta vacía',              'Comercio',        ' ',               NULL,             NULL,          NULL),
      ('oferta de 201',             'Comercio',        repeat('o', 201),  NULL,             NULL,          NULL),
      ('código vacío',              'Comercio',        'Oferta',          '',               NULL,          NULL),
      ('código de espacios',        'Comercio',        'Oferta',          '   ',            NULL,          NULL),
      ('código de 121',             'Comercio',        'Oferta',          repeat('c', 121), NULL,          NULL),
      ('notas de 1001',             'Comercio',        'Oferta',          NULL,             NULL,          repeat('n', 1001)),
      ('max_uses 0',                'Comercio',        'Oferta',          NULL,             0,             NULL),
      ('max_uses negativo',         'Comercio',        'Oferta',          NULL,             -1,            NULL),
      ('max_uses 1000',             'Comercio',        'Oferta',          NULL,             1000,          NULL)
    ) AS cases(label, merchant, offer, code, max_uses, notes)
  LOOP
    BEGIN
      INSERT INTO app.coupons (
        household_id, id, merchant, offer, code, max_uses, notes,
        photo_storage_object_id, created_by_membership_id
      ) VALUES (
        '10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000010',
        bad.merchant, bad.offer, bad.code, bad.max_uses, bad.notes,
        'cd400000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
      );
      RAISE EXCEPTION 'el CHECK no rechazó: %', bad.label;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;

  -- Las fechas, en el rango del contrato (2000–2999): una fila escrita a mano
  -- fuera de él tumbaría la cartera entera al leerla, porque el dominio no
  -- entiende esos años (revisión de integración de la fase 2, m-5).
  FOR bad IN
    SELECT * FROM (VALUES
      ('caducidad de 1999', DATE '1999-12-31'),
      ('caducidad de 3000', DATE '3000-01-01'),
      ('caducidad del año 26', DATE '0026-10-09')
    ) AS cases(label, expires_on)
  LOOP
    BEGIN
      INSERT INTO app.coupons (
        household_id, id, merchant, offer, expires_on,
        photo_storage_object_id, created_by_membership_id
      ) VALUES (
        '10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000010',
        'Comercio', 'Oferta', bad.expires_on,
        'cd400000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
      );
      RAISE EXCEPTION 'el CHECK no rechazó: %', bad.label;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;
  FOR bad IN
    SELECT * FROM (VALUES
      ('uso de 1999', DATE '1999-12-31'),
      ('uso de 3000', DATE '3000-01-01')
    ) AS cases(label, used_on)
  LOOP
    BEGIN
      INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
      VALUES ('10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000020',
              'cd400000-0000-4000-8000-000000000002', bad.used_on,
              '11000000-0000-4000-8000-000000000001');
      RAISE EXCEPTION 'el CHECK no rechazó: %', bad.label;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;
  -- Los bordes sí entran.
  INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id) VALUES
    ('10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000021',
     'cd400000-0000-4000-8000-000000000002', '2000-01-01', '11000000-0000-4000-8000-000000000001'),
    ('10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000022',
     'cd400000-0000-4000-8000-000000000002', '2999-12-31', '11000000-0000-4000-8000-000000000001');
  INSERT INTO app.coupons (
    household_id, id, merchant, offer, expires_on, photo_storage_object_id, created_by_membership_id
  ) VALUES
    ('10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000014',
     'Comercio', 'Oferta', '2000-01-01', 'cd400000-0000-4000-8000-000000000001',
     '11000000-0000-4000-8000-000000000001'),
    ('10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000015',
     'Comercio', 'Oferta', '2999-12-31', 'cd400000-0000-4000-8000-000000000001',
     '11000000-0000-4000-8000-000000000001');

  -- Y lo que admiten, justo en el borde. Sin esto, un CHECK que cerrara de más
  -- (max_uses BETWEEN 2 AND 998, un código obligatorio) pasaría por bueno.
  FOR good IN
    SELECT * FROM (VALUES
      ('cd400000-0000-4000-8000-000000000011'::uuid, repeat('m', 120), repeat('o', 200),
       repeat('c', 120), 1, repeat('n', 1000)),
      ('cd400000-0000-4000-8000-000000000012'::uuid, 'Comercio', 'Oferta', 'X', 999, NULL::text),
      ('cd400000-0000-4000-8000-000000000013'::uuid, 'Comercio', 'Oferta', NULL::text, NULL::integer, NULL)
    ) AS cases(id, merchant, offer, code, max_uses, notes)
  LOOP
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, code, max_uses, notes,
      photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', good.id,
      good.merchant, good.offer, good.code, good.max_uses, good.notes,
      'cd400000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
    );
  END LOOP;

  -- La FK compuesta (hogar, objeto): un cupón del roble no puede citar un
  -- objeto del olivo. Se prueba aquí, como propietario y sin contexto, porque
  -- desde la aplicación la regla de enlace de la foto lo rechaza antes.
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000010',
      'Comercio', 'Oferta', 'ce400000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'un cupón del roble citó un objeto del olivo';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  -- Sin foto no hay cupón: es lo primero que se hace al guardarlo.
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'cd400000-0000-4000-8000-000000000010',
      'Comercio', 'Oferta', NULL, '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'se guardó un cupón sin foto';
  EXCEPTION WHEN not_null_violation THEN
    NULL;
  END;

  -- Descartar: fecha y autor van juntos o no van.
  BEGIN
    UPDATE app.coupons SET discarded_at = statement_timestamp()
     WHERE id = 'cd400000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'se aceptó un descarte sin autor';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupons SET discarded_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE id = 'cd400000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'se aceptó un autor de descarte sin descarte';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Anular: igual.
  BEGIN
    UPDATE app.coupon_uses SET voided_at = statement_timestamp()
     WHERE id = 'cd400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'se aceptó una anulación sin autor';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupon_uses SET voided_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE id = 'cd400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'se aceptó un autor de anulación sin anulación';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Los cerrojos de la fila alcanzan también al propietario: no son RLS.
  BEGIN
    UPDATE app.coupon_uses SET voided_at = NULL, voided_by_membership_id = NULL
     WHERE id = 'cd400000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'un uso anulado se desanuló';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupon_uses
       SET voided_at = statement_timestamp(),
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
           used_on = '2026-09-01'
     WHERE id = 'cd400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'anular un uso reescribió su fecha';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupons SET created_by_membership_id = '11000000-0000-4000-8000-000000000002'
     WHERE id = 'cd400000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'un cupón cambió de autoría';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  -- Ni su identificador ni su fecha de alta. El cupón del cambio de id no
  -- tiene usos: así no hay FK de por medio y lo único que puede pararlo es
  -- el cerrojo.
  BEGIN
    UPDATE app.coupons SET id = 'cd400000-0000-4000-8000-000000000007'
     WHERE id = 'cd400000-0000-4000-8000-000000000013';
    RAISE EXCEPTION 'un cupón cambió de identificador';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupons SET created_at = '2020-01-01T00:00:00Z'
     WHERE id = 'cd400000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'un cupón cambió su fecha de alta';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  -- Un uso VIVO tampoco se muda: ni a otro cupón del hogar (la FK lo
  -- admitiría), ni de identificador, ni de cuándo llegó a la base. Vivo,
  -- porque uno anulado ya lo para la primera regla del cerrojo.
  BEGIN
    UPDATE app.coupon_uses SET coupon_id = 'cd400000-0000-4000-8000-000000000005'
     WHERE id = 'cd400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'un uso se mudó de cupón';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupon_uses SET id = 'cd400000-0000-4000-8000-000000000006'
     WHERE id = 'cd400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'un uso cambió de identificador';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupon_uses SET recorded_at = '2020-01-01T00:00:00Z'
     WHERE id = 'cd400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'un uso cambió el momento en que se apuntó';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  -- Un descarte vigente no se vuelve a firmar ni a fechar, tampoco sin
  -- contexto: como un uso anulado, para cambiarlo se recupera y se descarta.
  BEGIN
    UPDATE app.coupons SET discarded_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE id = 'cd400000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'un descarte cambió de firma';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupons SET discarded_at = '2026-09-16T12:00:00Z'
     WHERE id = 'cd400000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'un descarte cambió de fecha';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  -- Recuperarlo, en cambio, sí: el descarte deja de estar.
  UPDATE app.coupons SET discarded_at = NULL, discarded_by_membership_id = NULL
   WHERE id = 'cd400000-0000-4000-8000-000000000005';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el propietario no pudo recuperar un cupón descartado';
  END IF;
END
$assert_coupon_checks$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La matriz por papel. Una sola transacción que se revierte al final: siembra
-- como propietario, control positivo, y después cada identidad por turno.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

-- Fotos. cd1…01, 02 y 06 las citan cupones; cd1…03 NO la cita nadie (es el
-- control de que la política nueva no abre cualquier objeto de la
-- administración); cd1…04, 05 y 0a están libres para lo que la familia guarda
-- más abajo. cd1…07 (un PDF), cd1…08 (una imagen borrada) y cd5…01 (una foto
-- que subió la EMPLEADA, p. ej. el tique de un gasto) son lo que la regla de
-- enlace no deja citar. cd5…02 a 05 son imágenes vivas que subieron la
-- empleada, la segunda empleada, el apoyo y el acceso puntual: con ellas la
-- regla de la foto deja pasar su alta, y quien la tiene que parar es la RLS.
INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256,
  created_by_membership_id, deleted_at
) VALUES
  ('cd100000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/justificante.pdf', 'application/pdf', 4096,
   repeat('7', 64), '11000000-0000-4000-8000-000000000001', NULL),
  ('cd100000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/borrada.jpg', 'image/jpeg', 4096,
   repeat('8', 64), '11000000-0000-4000-8000-000000000001', statement_timestamp()),
  ('cd100000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/otra-foto-familia.jpg', 'image/jpeg', 4096,
   repeat('a', 64), '11000000-0000-4000-8000-000000000002', NULL),
  ('cd500000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/tique-empleada.jpg', 'image/jpeg', 4096,
   repeat('9', 64), '11000000-0000-4000-8000-000000000003', NULL),
  ('cd500000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/foto-empleada.jpg', 'image/jpeg', 4096,
   repeat('b', 64), '11000000-0000-4000-8000-000000000003', NULL),
  ('cd500000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/foto-empleada2.png', 'image/png', 4096,
   repeat('c', 64), '11000000-0000-4000-8000-000000000006', NULL),
  ('cd500000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/foto-apoyo.webp', 'image/webp', 4096,
   repeat('0', 64), '11000000-0000-4000-8000-000000000004', NULL),
  ('cd500000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/foto-visor.jpg', 'image/jpeg', 4096,
   repeat('ab', 32), '11000000-0000-4000-8000-000000000005', NULL);

INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
) VALUES
  ('cd100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/fruta.jpg', 'image/jpeg', 4096,
   repeat('1', 64), '11000000-0000-4000-8000-000000000001'),
  ('cd100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/drogueria.png', 'image/png', 4096,
   repeat('2', 64), '11000000-0000-4000-8000-000000000002'),
  ('cd100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/no-es-cupon.jpg', 'image/jpeg', 4096,
   repeat('3', 64), '11000000-0000-4000-8000-000000000001'),
  ('cd100000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/libre-familia.webp', 'image/webp', 4096,
   repeat('4', 64), '11000000-0000-4000-8000-000000000002'),
  ('cd100000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/libre-admin.jpg', 'image/jpeg', 4096,
   repeat('5', 64), '11000000-0000-4000-8000-000000000001'),
  ('cd100000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/panaderia.jpg', 'image/jpeg', 4096,
   repeat('6', 64), '11000000-0000-4000-8000-000000000001'),
  ('ce100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-olivo/cupones/mercado.jpg', 'image/jpeg', 4096,
   repeat('e', 64), '21000000-0000-4000-8000-000000000001');

-- Tres cupones del roble: uno de un solo uso que guardó la administración,
-- uno sin límite que guardó la familia y uno caducado y descartado. Fechas de
-- creación antiguas a propósito, para poder ver que editar mueve updated_at.
INSERT INTO app.coupons (
  household_id, id, merchant, offer, code, expires_on, max_uses, notes,
  photo_storage_object_id, created_by_membership_id, created_at, updated_at,
  discarded_at, discarded_by_membership_id
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000001',
   'Súper Sintético', '10 % en fruta', 'FRUTA10', '2026-10-10', 1, NULL,
   'cd100000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
   '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', NULL, NULL),
  ('10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000002',
   'Droguería Ficticia', '2x1 en detergente', NULL, NULL, NULL, 'Solo los martes',
   'cd100000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002',
   '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', NULL, NULL),
  ('10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000003',
   'Panadería Inventada', 'Café gratis con la barra', 'CAFE', '2026-09-01', 5, NULL,
   'cd100000-0000-4000-8000-000000000006', '11000000-0000-4000-8000-000000000001',
   '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
   '2020-02-01T00:00:00Z', '11000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001',
   'Mercado del Olivo', '5 € de descuento', 'OLIVO5', NULL, 1, NULL,
   'ce100000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
   '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', NULL, NULL);

INSERT INTO app.coupon_uses (
  household_id, id, coupon_id, used_on, used_by_membership_id, voided_at, voided_by_membership_id
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000001',
   'cd200000-0000-4000-8000-000000000002', '2026-09-10',
   '11000000-0000-4000-8000-000000000002', NULL, NULL),
  ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000002',
   'cd200000-0000-4000-8000-000000000002', '2026-09-12',
   '11000000-0000-4000-8000-000000000001', '2026-09-12T12:00:00Z',
   '11000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000003',
   'cd200000-0000-4000-8000-000000000003', '2026-08-30',
   '11000000-0000-4000-8000-000000000001', NULL, NULL),
  ('20000000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000001',
   'ce200000-0000-4000-8000-000000000001', '2026-09-11',
   '21000000-0000-4000-8000-000000000001', NULL, NULL);

-- Una persona de la familia con la membresía ya caducada.
INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('fixture:roble:cupones-caducada', 'Fixture Familia Caducada Roble');
INSERT INTO app.household_memberships (id, household_id, user_id, role, starts_at, expires_at) VALUES
  ('cd900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'fixture:roble:cupones-caducada', 'family_member',
   statement_timestamp() - interval '2 days', statement_timestamp() - interval '1 day');

-- Lo que la familia del roble TIENE que ver, contado como propietario antes de
-- bajar de rol (patrón de 030): así la aserción positiva es una igualdad
-- exacta y se ajusta sola si mañana una fixture siembra cupones.
SELECT set_config('casaclara.cupones_roble',
  (SELECT count(*)::text FROM app.coupons
    WHERE household_id = '10000000-0000-4000-8000-000000000001'), true);
SELECT set_config('casaclara.usos_roble',
  (SELECT count(*)::text FROM app.coupon_uses
    WHERE household_id = '10000000-0000-4000-8000-000000000001'), true);
SELECT set_config('casaclara.fotos_roble',
  (SELECT count(DISTINCT photo_storage_object_id)::text FROM app.coupons
    WHERE household_id = '10000000-0000-4000-8000-000000000001'), true);

-- Control positivo: los dos hogares tienen cupones, usos y fotos. Sin esto,
-- «el olivo ve cero del roble» sería cierto también con el roble vacío.
DO $assert_hogares_tienen_cupones$
BEGIN
  IF current_setting('casaclara.cupones_roble')::integer < 3
     OR current_setting('casaclara.usos_roble')::integer < 3
     OR current_setting('casaclara.fotos_roble')::integer < 3 THEN
    RAISE EXCEPTION 'la siembra dejó el roble sin cupones, usos o fotos: la matriz no probaría nada';
  END IF;
  IF (SELECT count(*) FROM app.coupons WHERE household_id = '20000000-0000-4000-8000-000000000001') = 0
     OR (SELECT count(*) FROM app.coupon_uses WHERE household_id = '20000000-0000-4000-8000-000000000001') = 0 THEN
    RAISE EXCEPTION 'la siembra dejó el olivo sin cupones o usos';
  END IF;
END
$assert_hogares_tienen_cupones$;

SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;

-- Sin contexto de hogar no se ve nada, aunque haya identidad.
SELECT set_config('app.user_id', 'fixture:roble:family', true);
DO $assert_sin_contexto$
BEGIN
  IF (SELECT count(*) FROM app.coupons) <> 0
     OR (SELECT count(*) FROM app.coupon_uses) <> 0
     OR (SELECT count(*) FROM app.storage_objects WHERE id::text LIKE 'cd1%') <> 0 THEN
    RAISE EXCEPTION 'sin contexto de hogar se ven cupones, usos o fotos';
  END IF;
  IF (SELECT count(*) FROM app.coupon_people()) <> 0 THEN
    RAISE EXCEPTION 'sin contexto de hogar app.coupon_people() devuelve nombres';
  END IF;
END
$assert_sin_contexto$;

-- ── Administración del roble: lee todo lo del roble y nada del olivo ─────────
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_lee$
BEGIN
  -- La fuga entre hogares va PRIMERO (lección de 030): si fuera después de los
  -- conteos exactos, una fila del olivo colada la cazaría el conteo con el
  -- mensaje equivocado y esta aserción no se ejecutaría nunca.
  IF (SELECT count(*) FROM app.coupons WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.coupon_uses WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.storage_objects WHERE id = 'ce100000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'fuga entre hogares: la administración del roble ve cupones, usos o fotos del olivo';
  END IF;
  IF (SELECT count(*) FROM app.coupons) <> current_setting('casaclara.cupones_roble')::integer THEN
    RAISE EXCEPTION 'la administración ve % cupones, se esperaban %',
      (SELECT count(*) FROM app.coupons), current_setting('casaclara.cupones_roble');
  END IF;
  IF (SELECT count(*) FROM app.coupon_uses) <> current_setting('casaclara.usos_roble')::integer THEN
    RAISE EXCEPTION 'la administración ve % usos, se esperaban %',
      (SELECT count(*) FROM app.coupon_uses), current_setting('casaclara.usos_roble');
  END IF;
  IF (SELECT count(*) FROM app.storage_objects AS photo
       WHERE EXISTS (SELECT 1 FROM app.coupons AS coupon
                      WHERE coupon.photo_storage_object_id = photo.id))
     <> current_setting('casaclara.fotos_roble')::integer THEN
    RAISE EXCEPTION 'la administración no ve todas las fotos de los cupones del roble';
  END IF;
END
$assert_admin_lee$;

-- ── Familia no administradora: lo mismo, y la foto que NO subió ─────────────
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_familia_lee$
BEGIN
  IF (SELECT count(*) FROM app.coupons WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.coupon_uses WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.storage_objects WHERE id = 'ce100000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'fuga entre hogares: la familia del roble ve cupones, usos o fotos del olivo';
  END IF;
  IF (SELECT count(*) FROM app.coupons) <> current_setting('casaclara.cupones_roble')::integer
     OR (SELECT count(*) FROM app.coupon_uses) <> current_setting('casaclara.usos_roble')::integer THEN
    RAISE EXCEPTION 'la familia ve % cupones y % usos, se esperaban % y %',
      (SELECT count(*) FROM app.coupons), (SELECT count(*) FROM app.coupon_uses),
      current_setting('casaclara.cupones_roble'), current_setting('casaclara.usos_roble');
  END IF;

  -- El caso que justifica la política nueva: la foto de «Súper Sintético» la
  -- subió la administración, y `storage_objects_read` (0005) solo se la
  -- enseñaría a quien la subió o a family_admin. La ve porque un cupón la cita.
  IF (SELECT count(*) FROM app.storage_objects
       WHERE id IN ('cd100000-0000-4000-8000-000000000001',
                    'cd100000-0000-4000-8000-000000000006')) <> 2 THEN
    RAISE EXCEPTION 'la familia no ve la foto de un cupón que subió otra persona';
  END IF;
  IF (SELECT count(*) FROM app.storage_objects AS photo
       WHERE EXISTS (SELECT 1 FROM app.coupons AS coupon
                      WHERE coupon.photo_storage_object_id = photo.id))
     <> current_setting('casaclara.fotos_roble')::integer THEN
    RAISE EXCEPTION 'la familia no ve todas las fotos de los cupones del roble';
  END IF;
  -- Y nada más: los objetos de la administración que ningún cupón cita siguen
  -- fuera, igual que el que tiene libre para su próximo cupón.
  IF (SELECT count(*) FROM app.storage_objects
       WHERE id IN ('cd100000-0000-4000-8000-000000000003',
                    'cd100000-0000-4000-8000-000000000005',
                    'cd100000-0000-4000-8000-000000000007',
                    'cd100000-0000-4000-8000-000000000008')) <> 0 THEN
    RAISE EXCEPTION 'la política de la foto abre objetos que ningún cupón cita';
  END IF;

  -- Quién guardó y quién usó, CON NOMBRE, también para la familia que no
  -- administra (revisión de la fase 2, I-1). La premisa primero: la RLS de
  -- `user_profiles` (0005) no le enseña el perfil de la administración, así
  -- que sin la función la ficha diría «Alguien de la familia».
  IF (SELECT count(*) FROM app.user_profiles WHERE user_id = 'fixture:roble:admin') <> 0 THEN
    RAISE EXCEPTION 'la familia ya lee el perfil de la administración: revisa si app.coupon_people() sigue haciendo falta';
  END IF;
  -- Y la función devuelve EXACTAMENTE a quien firmó un alta o un uso vivo del
  -- hogar: ni la empleada (subió fotos, pero no guardó ningún cupón), ni el
  -- apoyo, ni la membresía caducada, ni nadie del olivo.
  IF (SELECT string_agg(person.membership_id::text || '=' || person.display_name, ','
                        ORDER BY person.membership_id)
        FROM app.coupon_people() AS person)
     IS DISTINCT FROM '11000000-0000-4000-8000-000000000001=Fixture Admin Roble,'
                      '11000000-0000-4000-8000-000000000002=Fixture Familiar Roble' THEN
    RAISE EXCEPTION 'app.coupon_people() no devuelve a la familia los nombres de quien guardó y usó: %',
      (SELECT string_agg(person.membership_id::text || '=' || person.display_name, ','
                         ORDER BY person.membership_id)
         FROM app.coupon_people() AS person);
  END IF;
END
$assert_familia_lee$;

-- ── Administración del olivo: lo suyo, nada del roble ───────────────────────
SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

DO $assert_olivo$
DECLARE
  touched integer;
BEGIN
  IF (SELECT count(*) FROM app.coupons WHERE household_id = '10000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.coupon_uses WHERE household_id = '10000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.storage_objects WHERE id::text LIKE 'cd1%') <> 0 THEN
    RAISE EXCEPTION 'fuga entre hogares: el olivo ve cupones, usos o fotos del roble';
  END IF;
  IF (SELECT count(*) FROM app.coupons) <> 1
     OR (SELECT count(*) FROM app.coupon_uses) <> 1
     OR (SELECT count(*) FROM app.storage_objects WHERE id = 'ce100000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'el olivo no ve su propio cupón, su uso o su foto';
  END IF;
  -- Los nombres, solo los de su casa.
  IF (SELECT string_agg(person.membership_id::text || '=' || person.display_name, ','
                        ORDER BY person.membership_id)
        FROM app.coupon_people() AS person)
     IS DISTINCT FROM '21000000-0000-4000-8000-000000000001=Fixture Admin Olivo' THEN
    RAISE EXCEPTION 'fuga entre hogares: app.coupon_people() da al olivo nombres que no son de su casa';
  END IF;

  -- Escribir en el roble desde el olivo: ni el cupón ni el uso. El alta del
  -- cupón la para aquí la regla de la foto (el olivo no ve ningún objeto del
  -- roble) antes de que hable la política; que la POLÍTICA sola también la
  -- pare se prueba al final, con la regla apagada.
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000010',
      'Intruso', 'Oferta intrusa', 'cd100000-0000-4000-8000-000000000005',
      '21000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'el olivo guardó un cupón en el roble';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000010',
            'cd200000-0000-4000-8000-000000000001', '2026-09-20',
            '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'el olivo apuntó un uso en un cupón del roble';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  -- Ni colgarlo de su propio hogar con el cupón del vecino: el EXISTS del
  -- WITH CHECK no encuentra un cupón (olivo, id del roble).
  BEGIN
    INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
    VALUES ('20000000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000011',
            'cd200000-0000-4000-8000-000000000001', '2026-09-20',
            '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'el olivo apuntó en su hogar un uso del cupón del roble';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  -- Y lo del roble no se toca: la RLS no deja ver la fila y el UPDATE no
  -- encuentra nada que cambiar.
  UPDATE app.coupons SET notes = 'Tocado desde el olivo'
   WHERE id = 'cd200000-0000-4000-8000-000000000001';
  IF FOUND THEN
    RAISE EXCEPTION 'el olivo editó un cupón del roble';
  END IF;

  -- Y SIN WHERE, que es el caso que de verdad importa: el WHERE de arriba lee
  -- una columna y le suma la política de SELECT, que ya filtra el hogar; una
  -- sentencia que no lee ninguna solo pasa por la de UPDATE. Alcanza lo suyo
  -- —su cupón y su uso vivo, el control de que la sentencia escribe— y CERO
  -- filas del roble.
  BEGIN
    UPDATE app.coupons SET notes = 'Tocado desde el olivo, sin WHERE';
    GET DIAGNOSTICS touched = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'un UPDATE sin WHERE desde el olivo llegó a cupones del roble: %', SQLERRM;
  END;
  IF touched < 1 THEN
    RAISE EXCEPTION 'el olivo no pudo editar ni su propio cupón: el cero del roble no probaría nada';
  ELSIF touched > 1 THEN
    RAISE EXCEPTION 'un UPDATE sin WHERE desde el olivo cambió % cupones del roble', touched - 1;
  END IF;
  BEGIN
    UPDATE app.coupon_uses
       SET voided_at = statement_timestamp(),
           voided_by_membership_id = '21000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS touched = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN
    RAISE EXCEPTION 'un UPDATE sin WHERE desde el olivo llegó a usos del roble: %', SQLERRM;
  END;
  IF touched < 1 THEN
    RAISE EXCEPTION 'el olivo no pudo anular ni su propio uso: el cero del roble no probaría nada';
  ELSIF touched > 1 THEN
    RAISE EXCEPTION 'un UPDATE sin WHERE desde el olivo anuló % usos del roble', touched - 1;
  END IF;
END
$assert_olivo$;

-- ── Membresía caducada: no abre contexto y, sin él, cero ────────────────────
SELECT set_config('app.user_id', 'fixture:roble:cupones-caducada', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);

DO $assert_caducada$
BEGIN
  BEGIN
    PERFORM app.set_household_context(
      '10000000-0000-4000-8000-000000000001',
      'cd900000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'una membresía de familia caducada abrió el contexto del hogar';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF (SELECT count(*) FROM app.coupons) <> 0
     OR (SELECT count(*) FROM app.coupon_uses) <> 0
     OR (SELECT count(*) FROM app.storage_objects WHERE id::text LIKE 'cd1%') <> 0 THEN
    RAISE EXCEPTION 'una membresía caducada ve cupones, usos o fotos';
  END IF;
  IF (SELECT count(*) FROM app.coupon_people()) <> 0 THEN
    RAISE EXCEPTION 'una membresía caducada recibe nombres de app.coupon_people()';
  END IF;
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000090',
      'Caducada', 'Oferta caducada', 'cd100000-0000-4000-8000-000000000004',
      'cd900000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'una membresía caducada guardó un cupón';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_caducada$;

-- ── Administración del roble: escribe, y firma a su nombre ───────────────────
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_escribe$
DECLARE
  touched integer;
  voided app.coupon_uses%ROWTYPE;
  bad record;
BEGIN
  -- Guardar, a su nombre.
  INSERT INTO app.coupons (
    household_id, id, merchant, offer, code, expires_on, max_uses,
    photo_storage_object_id, created_by_membership_id
  ) VALUES (
    '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000010',
    'Frutería Sintética', '3 € menos en 20 €', 'FRUTA3', '2026-12-31', 3,
    'cd100000-0000-4000-8000-000000000005', '11000000-0000-4000-8000-000000000001'
  );
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la administración no pudo guardar un cupón';
  END IF;

  -- El patrón del comando (spec §7.1): reintentar con el mismo id no duplica ni
  -- falla, aunque cambie el resto de la fila.
  INSERT INTO app.coupons (
    household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
  ) VALUES (
    '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000010',
    'Reintento', 'Reintento', 'cd100000-0000-4000-8000-000000000005',
    '11000000-0000-4000-8000-000000000001'
  ) ON CONFLICT (household_id, id) DO NOTHING;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 OR (SELECT merchant FROM app.coupons
                       WHERE id = 'cd200000-0000-4000-8000-000000000010') <> 'Frutería Sintética' THEN
    RAISE EXCEPTION 'reintentar el alta de un cupón no fue idempotente';
  END IF;

  -- Guardarlo a nombre de otra persona, no. La foto es suya, así que la regla
  -- de enlace la deja pasar y quien dice que no es la firma de la política.
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000020',
      'Suplantado', 'Oferta suplantada', 'cd100000-0000-4000-8000-000000000005',
      '11000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'un cupón quedó guardado a nombre de quien no lo guardó';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'el alta a nombre ajeno no la paró la RLS sino: %', SQLERRM;
    END IF;
  END;

  -- Ni en el hogar de al lado. Como en el olivo, aquí la para antes la regla
  -- de la foto; la política sola se prueba al final.
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '20000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000021',
      'Intruso', 'Oferta intrusa', 'ce100000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'el roble guardó un cupón en el olivo';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- La regla de enlace de la foto (spec §7.1), con respaldo en la base: solo
  -- una imagen VIVA que haya subido QUIEN la enlaza. La administración ve todos
  -- los objetos del hogar (`storage_objects_read`), y justo por eso no puede
  -- colgar de un cupón —y abrírselo así a toda la familia— lo que subió otra
  -- persona. Tampoco la foto del hogar de al lado (además, la FK compuesta no
  -- la encontraría; eso se prueba como propietario, más arriba).
  FOR bad IN
    SELECT * FROM (VALUES
      ('cd100000-0000-4000-8000-000000000004'::uuid, 'una foto que subió la familia'),
      ('cd500000-0000-4000-8000-000000000001'::uuid, 'el tique que subió la empleada'),
      ('cd100000-0000-4000-8000-000000000007'::uuid, 'un PDF'),
      ('cd100000-0000-4000-8000-000000000008'::uuid, 'una imagen borrada'),
      ('ce100000-0000-4000-8000-000000000001'::uuid, 'la foto de un cupón del olivo')
    ) AS cases(photo, label)
  LOOP
    BEGIN
      INSERT INTO app.coupons (
        household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
      ) VALUES (
        '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000022',
        'Con foto ajena', 'Oferta', bad.photo, '11000000-0000-4000-8000-000000000001'
      );
      RAISE EXCEPTION 'un cupón citó %', bad.label;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END LOOP;
  -- Y cambiar la foto de un cupón ya guardado pasa por la misma regla.
  BEGIN
    UPDATE app.coupons SET photo_storage_object_id = 'cd500000-0000-4000-8000-000000000001'
     WHERE id = 'cd200000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'la administración cambió la foto de un cupón por el tique de la empleada';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- D-usos: se registra, no se controla. «Súper Sintético» es de UN solo uso
  -- y admite un segundo; «Panadería Inventada» está caducada y descartada y
  -- admite otro más.
  INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id) VALUES
    ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000010',
     'cd200000-0000-4000-8000-000000000001', '2026-09-20', '11000000-0000-4000-8000-000000000001'),
    ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000011',
     'cd200000-0000-4000-8000-000000000001', '2026-09-21', '11000000-0000-4000-8000-000000000001'),
    ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000012',
     'cd200000-0000-4000-8000-000000000003', '2026-09-22', '11000000-0000-4000-8000-000000000001');
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 3 THEN
    RAISE EXCEPTION 'la base rechazó usos de un cupón agotado o descartado (% de 3)', touched;
  END IF;

  -- Reintentar un uso con el mismo id tampoco lo duplica.
  INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000010',
          'cd200000-0000-4000-8000-000000000001', '2026-09-20', '11000000-0000-4000-8000-000000000001')
  ON CONFLICT (household_id, id) DO NOTHING;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'reintentar un uso lo duplicó';
  END IF;

  -- Apuntar un uso a nombre de otra persona, no.
  BEGIN
    INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000020',
            'cd200000-0000-4000-8000-000000000001', '2026-09-20',
            '11000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'un uso quedó apuntado a nombre de quien no lo usó';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Ni que nazca ya anulado y firmado por otra persona: un uso nace vivo.
  BEGIN
    INSERT INTO app.coupon_uses (
      household_id, id, coupon_id, used_on, used_by_membership_id, voided_at, voided_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000021',
      'cd200000-0000-4000-8000-000000000001', '2026-09-20',
      '11000000-0000-4000-8000-000000000001', statement_timestamp(),
      '11000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'un uso nació anulado';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Ni colgado de un cupón del olivo.
  BEGIN
    INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000022',
            'ce200000-0000-4000-8000-000000000001', '2026-09-20',
            '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'el roble apuntó un uso de un cupón del olivo';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Anular un uso que apuntó OTRA persona de la familia: sí (D-reparto), y a
  -- nombre de quien anula.
  UPDATE app.coupon_uses
     SET voided_at = statement_timestamp(),
         voided_by_membership_id = '11000000-0000-4000-8000-000000000001'
   WHERE id = 'cd300000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la administración no pudo anular un uso de la familia';
  END IF;
  SELECT * INTO voided FROM app.coupon_uses WHERE id = 'cd300000-0000-4000-8000-000000000001';
  IF voided.voided_at IS NULL
     OR voided.voided_by_membership_id <> '11000000-0000-4000-8000-000000000001'
     OR voided.used_by_membership_id <> '11000000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'la anulación perdió su autoría o la de quien usó el cupón';
  END IF;

  -- Anular firmando como otra persona, no.
  BEGIN
    UPDATE app.coupon_uses
       SET voided_at = statement_timestamp(),
           voided_by_membership_id = '11000000-0000-4000-8000-000000000002'
     WHERE id = 'cd300000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'una anulación quedó firmada por quien no la hizo';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Un uso anulado no se desanula: la RLS no deja ni verla como candidata.
  UPDATE app.coupon_uses SET voided_at = NULL, voided_by_membership_id = NULL
   WHERE id = 'cd300000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0
     OR (SELECT voided_at FROM app.coupon_uses WHERE id = 'cd300000-0000-4000-8000-000000000002') IS NULL THEN
    RAISE EXCEPTION 'un uso anulado se desanuló';
  END IF;
  -- Ni se vuelve a firmar.
  UPDATE app.coupon_uses
     SET voided_at = statement_timestamp(),
         voided_by_membership_id = '11000000-0000-4000-8000-000000000001'
   WHERE id = 'cd300000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'un uso anulado se volvió a anular';
  END IF;

  -- Anular no reescribe lo apuntado: ni la fecha, ni quién lo usó.
  BEGIN
    UPDATE app.coupon_uses
       SET voided_at = statement_timestamp(),
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
           used_on = '2026-01-01'
     WHERE id = 'cd300000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'anular un uso cambió su fecha';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupon_uses
       SET used_by_membership_id = '11000000-0000-4000-8000-000000000002'
     WHERE id = 'cd300000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'un uso cambió de autoría';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  -- Ni lo muda a otro cupón del hogar en la misma sentencia: la fila nueva
  -- está anulada, firmada por quien anula y colgada de un cupón visible, así
  -- que el WITH CHECK la daría por buena. Solo el cerrojo ve la vieja.
  BEGIN
    UPDATE app.coupon_uses
       SET voided_at = statement_timestamp(),
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
           coupon_id = 'cd200000-0000-4000-8000-000000000001'
     WHERE id = 'cd300000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'anular un uso lo mudó de cupón';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  -- Editar un cupón que guardó OTRA persona: sí (D-reparto), y updated_at se mueve.
  UPDATE app.coupons SET notes = 'Solo los martes y los jueves'
   WHERE id = 'cd200000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1
     OR (SELECT updated_at FROM app.coupons WHERE id = 'cd200000-0000-4000-8000-000000000002')
        <= '2020-01-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'la administración no pudo editar un cupón de la familia, o updated_at no se movió';
  END IF;
  -- Y uno que DESCARTÓ otra persona, también: la firma del descarte no cierra
  -- el cupón a los demás, solo dice quién lo descartó.
  UPDATE app.coupons SET notes = 'Ya no la hacen'
   WHERE id = 'cd200000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1
     OR (SELECT discarded_by_membership_id FROM app.coupons
          WHERE id = 'cd200000-0000-4000-8000-000000000003') <> '11000000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'la administración no pudo editar un cupón que descartó la familia, o el descarte cambió de firma';
  END IF;

  -- Descartar y recuperar.
  UPDATE app.coupons
     SET discarded_at = statement_timestamp(),
         discarded_by_membership_id = '11000000-0000-4000-8000-000000000001'
   WHERE id = 'cd200000-0000-4000-8000-000000000002' AND discarded_at IS NULL;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la administración no pudo descartar un cupón';
  END IF;
  UPDATE app.coupons SET discarded_at = NULL, discarded_by_membership_id = NULL
   WHERE id = 'cd200000-0000-4000-8000-000000000002' AND discarded_at IS NOT NULL;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la administración no pudo recuperar un cupón';
  END IF;

  -- La autoría y el hogar de un cupón no se reescriben al editarlo.
  BEGIN
    UPDATE app.coupons SET created_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE id = 'cd200000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'editar un cupón cambió quién lo guardó';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    UPDATE app.coupons SET household_id = '20000000-0000-4000-8000-000000000001'
     WHERE id = 'cd200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'un cupón se mudó de hogar';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  -- Sin DELETE: permiso denegado antes de llegar a la RLS.
  BEGIN
    DELETE FROM app.coupons WHERE id = 'cd200000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'la administración borró un cupón';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    DELETE FROM app.coupon_uses WHERE id = 'cd300000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'la administración borró un uso';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin_escribe$;

-- ── Familia no administradora: escribe igual que la administración ──────────
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_familia_escribe$
DECLARE
  touched integer;
BEGIN
  -- La foto libre de la administración era invisible para la familia; ahora
  -- que la cita el cupón que la administración acaba de guardar, se ve.
  IF (SELECT count(*) FROM app.storage_objects
       WHERE id = 'cd100000-0000-4000-8000-000000000005') <> 1 THEN
    RAISE EXCEPTION 'la familia no ve la foto del cupón recién guardado por la administración';
  END IF;

  INSERT INTO app.coupons (
    household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
  ) VALUES (
    '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000011',
    'Zapatería Imaginaria', 'Segunda unidad a mitad de precio',
    'cd100000-0000-4000-8000-000000000004', '11000000-0000-4000-8000-000000000002'
  );
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la familia no pudo guardar un cupón';
  END IF;

  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000023',
      'Suplantado', 'Oferta suplantada', 'cd100000-0000-4000-8000-000000000004',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'la familia guardó un cupón a nombre de la administración';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'el alta a nombre de la administración no la paró la RLS sino: %', SQLERRM;
    END IF;
  END;

  -- Un cupón nace EN LA CARTERA: si pudiera nacer descartado, el alta serviría
  -- para firmar un descarte a nombre de otra persona. Firmado a su nombre y
  -- con su foto, para que lo único que falle sea eso.
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id,
      discarded_at, discarded_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000024',
      'Nacido descartado', 'Oferta', 'cd100000-0000-4000-8000-00000000000a',
      '11000000-0000-4000-8000-000000000002',
      statement_timestamp(), '11000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'un cupón nació descartado';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'el alta de un cupón descartado no la paró la RLS sino: %', SQLERRM;
    END IF;
  END;

  -- Usar un cupón que guardó la administración.
  INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000013',
          'cd200000-0000-4000-8000-000000000010', '2026-09-23',
          '11000000-0000-4000-8000-000000000002');
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la familia no pudo usar un cupón de la administración';
  END IF;

  -- Anular un uso que apuntó la administración, a su nombre…
  UPDATE app.coupon_uses
     SET voided_at = statement_timestamp(),
         voided_by_membership_id = '11000000-0000-4000-8000-000000000002'
   WHERE id = 'cd300000-0000-4000-8000-000000000010';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la familia no pudo anular un uso de la administración';
  END IF;
  -- …pero no a nombre de la administración.
  BEGIN
    UPDATE app.coupon_uses
       SET voided_at = statement_timestamp(),
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE id = 'cd300000-0000-4000-8000-000000000011';
    RAISE EXCEPTION 'la familia firmó una anulación a nombre de la administración';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Editar, descartar y recuperar un cupón de la administración. Editar sin
  -- cambiar la foto no pasa por la regla de enlace: la foto la subió otra
  -- persona y el cupón sigue siendo de todos.
  UPDATE app.coupons SET offer = '10 % en fruta y verdura'
   WHERE id = 'cd200000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la familia no pudo editar un cupón de la administración';
  END IF;
  -- Tampoco una reescritura completa que repite la misma foto, que es como
  -- puede llegar el comando `update` (sustitución de todos los campos).
  UPDATE app.coupons
     SET merchant = merchant, offer = offer, code = code, expires_on = expires_on,
         max_uses = max_uses, notes = notes,
         photo_storage_object_id = photo_storage_object_id
   WHERE id = 'cd200000-0000-4000-8000-000000000010';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'reescribir un cupón ajeno con su misma foto no pasó';
  END IF;
  -- Cambiarle la foto por una SUYA, sí; por una de la administración, no.
  UPDATE app.coupons SET photo_storage_object_id = 'cd100000-0000-4000-8000-00000000000a'
   WHERE id = 'cd200000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la familia no pudo cambiar la foto de un cupón por una suya';
  END IF;
  BEGIN
    UPDATE app.coupons SET photo_storage_object_id = 'cd100000-0000-4000-8000-000000000003'
     WHERE id = 'cd200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'la familia colgó de un cupón un objeto de la administración';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  -- Descartar firmando como la administración, no: el descarte, como la
  -- anulación de un uso, va a nombre de quien lo hace.
  BEGIN
    UPDATE app.coupons
       SET discarded_at = statement_timestamp(),
           discarded_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE id = 'cd200000-0000-4000-8000-000000000001' AND discarded_at IS NULL;
    RAISE EXCEPTION 'la familia descartó un cupón a nombre de la administración';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  -- Ni volver a firmar un descarte que ya está («Panadería Inventada» la
  -- descartó ella misma): se recupera y se descarta otra vez.
  BEGIN
    UPDATE app.coupons SET discarded_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE id = 'cd200000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'la familia pasó a la administración la firma de un descarte';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  UPDATE app.coupons
     SET discarded_at = statement_timestamp(),
         discarded_by_membership_id = '11000000-0000-4000-8000-000000000002'
   WHERE id = 'cd200000-0000-4000-8000-000000000001' AND discarded_at IS NULL;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la familia no pudo descartar un cupón de la administración';
  END IF;
  UPDATE app.coupons SET discarded_at = NULL, discarded_by_membership_id = NULL
   WHERE id = 'cd200000-0000-4000-8000-000000000001' AND discarded_at IS NOT NULL;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la familia no pudo recuperar un cupón de la administración';
  END IF;

  BEGIN
    DELETE FROM app.coupons WHERE id = 'cd200000-0000-4000-8000-000000000011';
    RAISE EXCEPTION 'la familia borró un cupón';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    DELETE FROM app.coupon_uses WHERE id = 'cd300000-0000-4000-8000-000000000013';
    RAISE EXCEPTION 'la familia borró un uso';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_familia_escribe$;

-- ── Empleada, segunda empleada, apoyo y acceso puntual: CERO en todo ─────────
-- Va DESPUÉS de las escrituras de la familia a propósito: así el cero se mide
-- con más cupones, más usos y más fotos citadas, incluidas las de esta misma
-- transacción.
DO $assert_resto_no_ve_nada$
DECLARE
  role_pair record;
  touched integer;
BEGIN
  FOR role_pair IN
    SELECT * FROM (VALUES
      ('fixture:roble:employee',  '11000000-0000-4000-8000-000000000003'::uuid,
       'cd500000-0000-4000-8000-000000000002'::uuid),
      ('fixture:roble:employee2', '11000000-0000-4000-8000-000000000006'::uuid,
       'cd500000-0000-4000-8000-000000000003'::uuid),
      ('fixture:roble:helper',    '11000000-0000-4000-8000-000000000004'::uuid,
       'cd500000-0000-4000-8000-000000000004'::uuid),
      ('fixture:roble:viewer',    '11000000-0000-4000-8000-000000000005'::uuid,
       'cd500000-0000-4000-8000-000000000005'::uuid)
    ) AS pairs(user_id, membership_id, own_photo_id)
  LOOP
    PERFORM set_config('app.user_id', role_pair.user_id, true);
    PERFORM set_config('app.household_id', '', true);
    PERFORM set_config('app.membership_id', '', true);
    PERFORM set_config('app.role', '', true);
    PERFORM app.set_household_context(
      '10000000-0000-4000-8000-000000000001', role_pair.membership_id);

    IF (SELECT count(*) FROM app.coupons) <> 0 THEN
      RAISE EXCEPTION '% ve % cupones', role_pair.user_id, (SELECT count(*) FROM app.coupons);
    END IF;
    IF (SELECT count(*) FROM app.coupon_uses) <> 0 THEN
      RAISE EXCEPTION '% ve % usos', role_pair.user_id, (SELECT count(*) FROM app.coupon_uses);
    END IF;
    -- Ni los nombres de quien guardó o usó: la función se cierra sola a quien
    -- no es de la familia, aunque la llame directamente.
    IF (SELECT count(*) FROM app.coupon_people()) <> 0 THEN
      RAISE EXCEPTION '% recibe % nombres de app.coupon_people()', role_pair.user_id,
        (SELECT count(*) FROM app.coupon_people());
    END IF;
    -- Las fotos las subió la familia y ahora las citan cupones: aun así, cero.
    -- Ni los metadatos (comercio en la clave, tamaño, huella) deben llegar.
    IF (SELECT count(*) FROM app.storage_objects WHERE id::text LIKE 'cd1%') <> 0 THEN
      RAISE EXCEPTION '% ve % objetos de fotos de cupón', role_pair.user_id,
        (SELECT count(*) FROM app.storage_objects WHERE id::text LIKE 'cd1%');
    END IF;

    -- El alta, con una foto SUYA, viva y de imagen, firmada a su nombre: la
    -- regla de enlace la deja pasar, y lo único que la puede parar es que la
    -- política no es de su papel. Con una foto ajena el 42501 sería del
    -- disparador y la prueba seguiría verde con la política abierta a la
    -- empleada (revisión de la ronda 1). Primero, que de verdad ve su foto:
    -- si no la viera, volvería a ser el disparador quien dice que no.
    IF NOT EXISTS (SELECT 1 FROM app.storage_objects WHERE id = role_pair.own_photo_id) THEN
      RAISE EXCEPTION '% no ve la foto que subió: su alta no llegaría a la RLS', role_pair.user_id;
    END IF;
    BEGIN
      INSERT INTO app.coupons (
        household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
      ) VALUES (
        '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000030',
        'Fuera de la familia', 'Oferta', role_pair.own_photo_id,
        role_pair.membership_id
      );
      RAISE EXCEPTION '% guardó un cupón', role_pair.user_id;
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION 'el alta de % no la paró la RLS sino: %', role_pair.user_id, SQLERRM;
      END IF;
    END;
    BEGIN
      INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id)
      VALUES ('10000000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000030',
              'cd200000-0000-4000-8000-000000000002', '2026-09-24', role_pair.membership_id);
      RAISE EXCEPTION '% apuntó un uso', role_pair.user_id;
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION 'el uso de % no lo paró la RLS sino: %', role_pair.user_id, SQLERRM;
      END IF;
    END;

    UPDATE app.coupons SET notes = 'Tocado fuera de la familia';
    GET DIAGNOSTICS touched = ROW_COUNT;
    IF touched <> 0 THEN
      RAISE EXCEPTION '% editó % cupones', role_pair.user_id, touched;
    END IF;
    UPDATE app.coupon_uses
       SET voided_at = statement_timestamp(), voided_by_membership_id = role_pair.membership_id;
    GET DIAGNOSTICS touched = ROW_COUNT;
    IF touched <> 0 THEN
      RAISE EXCEPTION '% anuló % usos', role_pair.user_id, touched;
    END IF;

    BEGIN
      DELETE FROM app.coupons;
      RAISE EXCEPTION '% borró cupones', role_pair.user_id;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END LOOP;
END
$assert_resto_no_ve_nada$;

-- ── El emisor de trabajos no tiene GRANT: permiso denegado, no cero filas ────
RESET ROLE;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SET LOCAL ROLE casa_clara_worker;

DO $assert_worker_sin_cupones$
BEGIN
  BEGIN
    PERFORM 1 FROM app.coupons;
    RAISE EXCEPTION 'el worker leyó cupones';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM 1 FROM app.coupon_uses;
    RAISE EXCEPTION 'el worker leyó usos de cupones';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM 1 FROM app.coupon_people();
    RAISE EXCEPTION 'el worker leyó los nombres de la cartera';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_worker_sin_cupones$;

-- ── El rastro: cada escritura de la matriz quedó auditada con su autoría ─────
RESET ROLE;
SET LOCAL row_security = off;

DO $assert_auditoria$
BEGIN
  IF (SELECT count(*) FROM app.audit_events
       WHERE entity_table = 'coupons' AND action = 'INSERT'
         AND entity_id = 'cd200000-0000-4000-8000-000000000010'
         AND actor_membership_id = '11000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'el alta del cupón de la administración no quedó auditada a su nombre';
  END IF;
  IF (SELECT count(*) FROM app.audit_events
       WHERE entity_table = 'coupon_uses' AND action = 'UPDATE'
         AND entity_id = 'cd300000-0000-4000-8000-000000000010'
         AND actor_membership_id = '11000000-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'la anulación de la familia no quedó auditada a su nombre';
  END IF;
END
$assert_auditoria$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La política de alta, SOLA. Entre hogares, la regla de la foto rechaza
-- SIEMPRE antes que la política: quien escribe no ve ningún objeto del hogar
-- de al lado, y el disparador BEFORE ROW corre antes que el WITH CHECK. Así,
-- arriba, una política que hubiera perdido `tenant_context_matches` seguiría
-- en verde. Aquí se apaga `coupons_photo_link` —DISABLE TRIGGER es del
-- propietario y se revierte con la transacción— y se exige que quien rechace
-- sea la RLS. Cada alta va firmada a nombre de quien escribe, para que lo
-- único que falle sea el hogar; y cada hogar guarda antes uno propio, para
-- saber que con la regla apagada el alta sí llega.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
ALTER TABLE app.coupons DISABLE TRIGGER coupons_photo_link;
SET LOCAL row_security = off;

INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
) VALUES
  ('cd100000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-roble/cupones/sin-regla.jpg', 'image/jpeg', 4096,
   repeat('b', 64), '11000000-0000-4000-8000-000000000001'),
  ('ce100000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-000000000001',
   'fixture-attachments', 'fixture/casa-olivo/cupones/sin-regla.jpg', 'image/jpeg', 4096,
   repeat('b', 64), '21000000-0000-4000-8000-000000000001');

SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_politica_sola_roble$
DECLARE
  touched integer;
BEGIN
  INSERT INTO app.coupons (
    household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
  ) VALUES (
    '10000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000040',
    'Control del roble', 'Oferta', 'cd100000-0000-4000-8000-00000000000b',
    '11000000-0000-4000-8000-000000000001'
  );
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'con la regla de la foto apagada, el roble no pudo guardar su propio cupón';
  END IF;

  -- En el olivo, a su nombre y con una foto del olivo. Si la política no
  -- mirase el hogar, la fila pasaría la RLS y la pararía después la FK de la
  -- autoría: se dice así, para que nadie lo lea como un rechazo correcto.
  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '20000000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000041',
      'Intruso', 'Oferta intrusa', 'ce100000-0000-4000-8000-00000000000b',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'la política dejó al roble guardar un cupón en el olivo';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION 'el alta del roble en el olivo no la paró la RLS sino: %', SQLERRM;
      END IF;
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'la política no mira el hogar: el alta del roble en el olivo llegó hasta la FK (%)', SQLERRM;
  END;
END
$assert_politica_sola_roble$;

SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

DO $assert_politica_sola_olivo$
DECLARE
  touched integer;
BEGIN
  INSERT INTO app.coupons (
    household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
  ) VALUES (
    '20000000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000040',
    'Control del olivo', 'Oferta', 'ce100000-0000-4000-8000-00000000000b',
    '21000000-0000-4000-8000-000000000001'
  );
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'con la regla de la foto apagada, el olivo no pudo guardar su propio cupón';
  END IF;

  BEGIN
    INSERT INTO app.coupons (
      household_id, id, merchant, offer, photo_storage_object_id, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000041',
      'Intruso', 'Oferta intrusa', 'cd100000-0000-4000-8000-00000000000b',
      '21000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'la política dejó al olivo guardar un cupón en el roble';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION 'el alta del olivo en el roble no la paró la RLS sino: %', SQLERRM;
      END IF;
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'la política no mira el hogar: el alta del olivo en el roble llegó hasta la FK (%)', SQLERRM;
  END;
END
$assert_politica_sola_olivo$;

ROLLBACK;
