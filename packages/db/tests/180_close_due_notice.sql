-- El tercer aviso, «el mes está por cerrar» (migración 0034): qué hogares
-- tienen algo por cerrar y a quién se lo decimos.
--
-- Requiere migraciones + fixtures/001_two_households.sql + la siembra
-- COMMITteada de 170_push_subscriptions.sql (que corre antes por orden
-- lexicográfico), y una conexión que pueda SET ROLE casa_clara_app y
-- casa_clara_worker.
--
-- Prefijos de UUID exclusivos de este fichero: fb… (roble y olivo comparten
-- los suyos ya existentes, así que solo hacen falta ids nuevos para lo que
-- este fichero siembra).
--
-- Cada bloque siembra y deshace lo suyo (BEGIN…ROLLBACK): a diferencia de
-- 170, este fichero NO es el último por orden lexicográfico (190 viene
-- detrás), así que no deja nada COMMITteado.
--
-- Truco que sostiene casi todo el fichero sin depender de en qué fecha se
-- ejecute la suite: el acuerdo '12000000…0001' del roble (la primera
-- empleada) solo tiene UNA liquidación en toda la fixture, fechada en marzo
-- de 2025 — un mes que nunca volverá a ser «el mes en curso». Por eso el
-- roble está SIEMPRE «por cerrar» a través de ese acuerdo, sin sembrar nada,
-- salvo que el propio bloque cierre expresamente su liquidación del mes en
-- curso. El olivo, en cambio, no tiene NINGUNA liquidación en la fixture
-- base: está «por cerrar» siempre, y basta una liquidación cerrada del mes en
-- curso para apagarlo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Forma: firmas, GRANTs y el índice único parcial que impide duplicados.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_shape$
DECLARE
  households_signature text;
  targets_signature text;
  worker_households_grants integer;
  worker_targets_grants integer;
  app_households_grants integer;
  app_targets_grants integer;
  index_def text;
BEGIN
  SELECT pg_catalog.pg_get_function_identity_arguments(oid) INTO households_signature
    FROM pg_catalog.pg_proc
   WHERE proname = 'close_due_households' AND pronamespace = 'app_private'::regnamespace;
  IF households_signature <> 'reference date' THEN
    RAISE EXCEPTION 'app_private.close_due_households cambió de firma («%»)', households_signature;
  END IF;

  SELECT pg_catalog.pg_get_function_identity_arguments(oid) INTO targets_signature
    FROM pg_catalog.pg_proc
   WHERE proname = 'push_close_due_targets' AND pronamespace = 'app_private'::regnamespace;
  IF targets_signature <> 'notice_household uuid' THEN
    RAISE EXCEPTION 'app_private.push_close_due_targets cambió de firma («%»): el payload del trabajo solo lleva household_id', targets_signature;
  END IF;

  SELECT count(*)::integer INTO worker_households_grants
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'app_private' AND routine_name = 'close_due_households'
     AND grantee = 'casa_clara_worker' AND privilege_type = 'EXECUTE';
  IF worker_households_grants <> 1 THEN
    RAISE EXCEPTION 'casa_clara_worker no tiene EXECUTE sobre close_due_households (%)', worker_households_grants;
  END IF;

  SELECT count(*)::integer INTO worker_targets_grants
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'app_private' AND routine_name = 'push_close_due_targets'
     AND grantee = 'casa_clara_worker' AND privilege_type = 'EXECUTE';
  IF worker_targets_grants <> 1 THEN
    RAISE EXCEPTION 'casa_clara_worker no tiene EXECUTE sobre push_close_due_targets (%)', worker_targets_grants;
  END IF;

  -- Ni PUBLIC ni casa_clara_app deben poder ejecutar ninguna de las dos: son
  -- funciones definer que devuelven p256dh/auth (la segunda) o deciden quién
  -- cobra un aviso (la primera), y la aplicación no debe alcanzarlas directo.
  SELECT count(*)::integer INTO app_households_grants
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'app_private' AND routine_name = 'close_due_households'
     AND grantee IN ('PUBLIC', 'casa_clara_app') AND privilege_type = 'EXECUTE';
  IF app_households_grants <> 0 THEN
    RAISE EXCEPTION 'close_due_households es alcanzable por % concesiones de más (PUBLIC/casa_clara_app)', app_households_grants;
  END IF;

  SELECT count(*)::integer INTO app_targets_grants
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'app_private' AND routine_name = 'push_close_due_targets'
     AND grantee IN ('PUBLIC', 'casa_clara_app') AND privilege_type = 'EXECUTE';
  IF app_targets_grants <> 0 THEN
    RAISE EXCEPTION 'push_close_due_targets es alcanzable por % concesiones de más (PUBLIC/casa_clara_app)', app_targets_grants;
  END IF;

  SELECT pg_catalog.pg_get_indexdef(indexrelid) INTO index_def
    FROM pg_catalog.pg_index
   WHERE indexrelid = 'app_private.close_due_push_pending_idx'::regclass;
  IF index_def IS NULL OR index_def !~ 'UNIQUE' OR index_def !~ 'household_id' THEN
    RAISE EXCEPTION 'close_due_push_pending_idx no es el índice único parcial esperado («%»)', index_def;
  END IF;
END
$assert_shape$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · close_due_households: el olivo (un solo acuerdo) enciende y apaga limpio.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_olivo_toggles$
DECLARE
  due boolean;
  reference date := (now() AT TIME ZONE 'Europe/Madrid')::date;
  month_start date := date_trunc('month', reference)::date;
  month_end date := (date_trunc('month', reference) + interval '1 month' - interval '1 day')::date;
BEGIN
  -- Sin ninguna liquidación en toda la fixture, el olivo está «por cerrar»
  -- siempre.
  SELECT true INTO due
    FROM app_private.close_due_households(reference)
   WHERE close_due_households = '20000000-0000-4000-8000-000000000001';
  IF NOT coalesce(due, false) THEN
    RAISE EXCEPTION 'el olivo no aparece como «por cerrar» sin ninguna liquidación cerrada';
  END IF;

  INSERT INTO app.settlements (
    id, household_id, agreement_id, employee_membership_id, period_start, period_end,
    due_on, status, created_by_membership_id, closed_by_membership_id, closed_at, snapshot_hash
  ) VALUES (
    'fb100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002',
    month_start, month_end, month_end, 'closed',
    '21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
    statement_timestamp(), repeat('d', 64)
  );

  SELECT true INTO due
    FROM app_private.close_due_households(reference)
   WHERE close_due_households = '20000000-0000-4000-8000-000000000001';
  IF coalesce(due, false) THEN
    RAISE EXCEPTION 'el olivo sigue «por cerrar» con su único acuerdo ya liquidado y cerrado este mes';
  END IF;
END
$assert_olivo_toggles$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · close_due_households: el roble (dos acuerdos) exige cerrar los DOS.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_roble_needs_both$
DECLARE
  due boolean;
  reference date := (now() AT TIME ZONE 'Europe/Madrid')::date;
  month_start date := date_trunc('month', reference)::date;
  month_end date := (date_trunc('month', reference) + interval '1 month' - interval '1 day')::date;
BEGIN
  -- Se cierra SOLO el acuerdo de la segunda empleada; el de la primera sigue
  -- sin liquidación de este mes (la única suya en la fixture es de 2025-03).
  INSERT INTO app.settlements (
    id, household_id, agreement_id, employee_membership_id, period_start, period_end,
    due_on, status, created_by_membership_id, closed_by_membership_id, closed_at, snapshot_hash
  ) VALUES (
    'fb200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000006',
    month_start, month_end, month_end, 'closed',
    '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
    statement_timestamp(), repeat('e', 64)
  );

  SELECT true INTO due
    FROM app_private.close_due_households(reference)
   WHERE close_due_households = '10000000-0000-4000-8000-000000000001';
  IF NOT coalesce(due, false) THEN
    RAISE EXCEPTION 'el roble dejó de estar «por cerrar» con UN solo acuerdo liquidado: el de la primera empleada sigue sin cerrar';
  END IF;

  -- Ahora se cierra también el de la primera empleada: los DOS acuerdos
  -- activos tienen ya su liquidación cerrada de este mes.
  INSERT INTO app.settlements (
    id, household_id, agreement_id, employee_membership_id, period_start, period_end,
    due_on, status, created_by_membership_id, closed_by_membership_id, closed_at, snapshot_hash
  ) VALUES (
    'fb200000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
    month_start, month_end, month_end, 'closed',
    '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
    statement_timestamp(), repeat('f', 64)
  );

  SELECT true INTO due
    FROM app_private.close_due_households(reference)
   WHERE close_due_households = '10000000-0000-4000-8000-000000000001';
  IF coalesce(due, false) THEN
    RAISE EXCEPTION 'el roble sigue «por cerrar» con sus DOS acuerdos ya liquidados y cerrados este mes';
  END IF;
END
$assert_roble_needs_both$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · push_close_due_targets: solo family_admin, nadie más.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

-- La siembra COMMITteada de 170_push_subscriptions.sql ya deja un dispositivo
-- vivo del mismo admin (fa200000-…002, endpoint …/roble-admin): se revoca
-- aquí, DENTRO de esta transacción (el ROLLBACK de más abajo lo repone), para
-- que «un admin, un dispositivo» compruebe la audiencia (family_admin, nadie
-- más) sin que un segundo dispositivo legítimo del mismo admin —perfectamente
-- normal: teléfono y tableta— quede contado dos veces.
UPDATE app.push_subscriptions SET revoked_at = statement_timestamp()
 WHERE id = 'fa200000-0000-4000-8000-000000000002';

INSERT INTO app.push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES
  ('fb300000-0000-4000-8000-000000000001', 'fixture:roble:admin',
   'https://push.ejemplo.test/cierre-roble-admin', 'fixture-p256dh-cierre-1', 'fixture-auth-cierre-1'),
  ('fb300000-0000-4000-8000-000000000002', 'fixture:roble:family',
   'https://push.ejemplo.test/cierre-roble-familia', 'fixture-p256dh-cierre-2', 'fixture-auth-cierre-2'),
  ('fb300000-0000-4000-8000-000000000003', 'fixture:roble:employee',
   'https://push.ejemplo.test/cierre-roble-empleada', 'fixture-p256dh-cierre-3', 'fixture-auth-cierre-3'),
  ('fb300000-0000-4000-8000-000000000004', 'fixture:roble:helper',
   'https://push.ejemplo.test/cierre-roble-apoyo', 'fixture-p256dh-cierre-4', 'fixture-auth-cierre-4'),
  ('fb300000-0000-4000-8000-000000000005', 'fixture:roble:viewer',
   'https://push.ejemplo.test/cierre-roble-visor', 'fixture-p256dh-cierre-5', 'fixture-auth-cierre-5');

SET LOCAL ROLE casa_clara_worker;

DO $assert_only_admin$
DECLARE
  targets integer;
  who text;
BEGIN
  SELECT count(*)::integer INTO targets
    FROM app_private.push_close_due_targets('10000000-0000-4000-8000-000000000001');
  IF targets <> 1 THEN
    RAISE EXCEPTION 'el aviso de cierre de mes alcanza % dispositivos; debería alcanzar solo el de quien administra', targets;
  END IF;

  SELECT endpoint INTO who
    FROM app_private.push_close_due_targets('10000000-0000-4000-8000-000000000001');
  IF who <> 'https://push.ejemplo.test/cierre-roble-admin' THEN
    RAISE EXCEPTION 'el aviso de cierre de mes iba a %: family_member, empleada, apoyo y visor no entran en esta consulta por construcción', who;
  END IF;
END
$assert_only_admin$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · push_close_due_targets: se apaga en el acto si ya no queda nada por
--     cerrar (reevaluación del hecho en el instante del envío).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

-- Mismo choque que en la sección 4: 170_push_subscriptions.sql ya deja vivo
-- un dispositivo COMMITteado del admin del olivo (fa200000-…004). Se revoca
-- dentro de esta transacción para que «un admin, un dispositivo» siga siendo
-- comprobable aquí.
UPDATE app.push_subscriptions SET revoked_at = statement_timestamp()
 WHERE id = 'fa200000-0000-4000-8000-000000000004';

INSERT INTO app.push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES
  ('fb400000-0000-4000-8000-000000000001', 'fixture:olivo:admin',
   'https://push.ejemplo.test/cierre-olivo-admin', 'fixture-p256dh-cierre-6', 'fixture-auth-cierre-6');

SET LOCAL ROLE casa_clara_worker;

DO $assert_reevaluates$
DECLARE
  targets integer;
BEGIN
  SELECT count(*)::integer INTO targets
    FROM app_private.push_close_due_targets('20000000-0000-4000-8000-000000000001');
  IF targets <> 1 THEN
    RAISE EXCEPTION 'el aviso de cierre no alcanza a quien administra el olivo (% destinatarios) antes de cerrar nada', targets;
  END IF;
END
$assert_reevaluates$;

RESET ROLE;
SET LOCAL row_security = off;

INSERT INTO app.settlements (
  id, household_id, agreement_id, employee_membership_id, period_start, period_end,
  due_on, status, created_by_membership_id, closed_by_membership_id, closed_at, snapshot_hash
) VALUES (
  'fb400000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002',
  date_trunc('month', now() AT TIME ZONE 'Europe/Madrid')::date,
  (date_trunc('month', now() AT TIME ZONE 'Europe/Madrid') + interval '1 month' - interval '1 day')::date,
  (date_trunc('month', now() AT TIME ZONE 'Europe/Madrid') + interval '1 month' - interval '1 day')::date,
  'closed', '21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
  statement_timestamp(), repeat('a', 64)
);

SET LOCAL ROLE casa_clara_worker;

DO $assert_silence_after_closing$
DECLARE
  targets integer;
BEGIN
  SELECT count(*)::integer INTO targets
    FROM app_private.push_close_due_targets('20000000-0000-4000-8000-000000000001');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'a quien administra el olivo le sigue llegando el aviso (% destinatarios) con su único acuerdo ya cerrado este mes: la reevaluación en el envío es justo lo que debe apagarlo', targets;
  END IF;
END
$assert_silence_after_closing$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · Vacaciones apuntadas: silencio, misma regla que push_notice_targets.
--
--     Escenario sintético: la fixture no da vacaciones a quien administra —el
--     beneficio es de quien trabaja—, pero la consulta no distingue de quién
--     es la membresía, solo si tiene un periodo `recorded` que cubra hoy. Se
--     apunta uno sobre la propia membresía admin para ejercitar el filtro
--     exactamente como lo aplica la función, sin depender de qué rol lo tenga.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES
  ('fb500000-0000-4000-8000-000000000001', 'fixture:roble:admin',
   'https://push.ejemplo.test/cierre-roble-vacaciones', 'fixture-p256dh-cierre-7', 'fixture-auth-cierre-7');

INSERT INTO app.vacation_periods (
  id, household_id, agreement_id, employee_membership_id, starts_on, ends_on,
  recorded_by_membership_id
) VALUES (
  'fb500000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
  (now() AT TIME ZONE 'Europe/Madrid')::date - 1,
  (now() AT TIME ZONE 'Europe/Madrid')::date + 1,
  '11000000-0000-4000-8000-000000000001'
);

SET LOCAL ROLE casa_clara_worker;

DO $assert_vacation_silences$
DECLARE
  targets integer;
BEGIN
  SELECT count(*)::integer INTO targets
    FROM app_private.push_close_due_targets('10000000-0000-4000-8000-000000000001');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'con vacaciones apuntadas cubriendo hoy, el aviso de cierre igualmente alcanza % dispositivos', targets;
  END IF;
END
$assert_vacation_silences$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7 · La aplicación no puede resolver ni hogares ni destinatarios.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_app_cannot_resolve$
BEGIN
  BEGIN
    PERFORM 1 FROM app_private.close_due_households(current_date);
    RAISE EXCEPTION 'la aplicación pudo listar hogares por cerrar directamente';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM app_private.push_close_due_targets('10000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'la aplicación resolvió destinatarios del aviso de cierre: p256dh y auth saldrían por el mismo rol que sirve las páginas';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_app_cannot_resolve$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8 · Como mucho un aviso de cierre pendiente por hogar (índice único parcial).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_worker;

DO $assert_no_duplicate_pending$
BEGIN
  INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001', 'notification.push',
    '{"topic": "settlement.close_due"}'::jsonb, now()
  );

  -- Un segundo intento de avisar al MISMO hogar mientras el primero sigue
  -- `queued` choca con el índice único parcial: es el mecanismo de
  -- idempotencia funcionando, no un fallo del trabajo (ver close-due.ts).
  BEGIN
    INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
    VALUES (
      '10000000-0000-4000-8000-000000000001', 'notification.push',
      '{"topic": "settlement.close_due"}'::jsonb, now()
    );
    RAISE EXCEPTION 'se pudo encolar un segundo aviso de cierre pendiente para el mismo hogar';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- Un hogar DISTINTO no choca con nada: el índice es por hogar.
  INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
  VALUES (
    '20000000-0000-4000-8000-000000000001', 'notification.push',
    '{"topic": "settlement.close_due"}'::jsonb, now()
  );
END
$assert_no_duplicate_pending$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9 · El predicado sobrevive a campos extra en el payload (no es igualdad
--     exacta de jsonb, es `payload->>'topic'`).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_worker;

DO $assert_predicate_survives_extra_fields$
BEGIN
  INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001', 'notification.push',
    '{"topic": "settlement.close_due"}'::jsonb, now()
  );

  -- Un payload con un campo de más (mismo tópico) sigue chocando: un predicado
  -- de igualdad jsonb exacta lo dejaría pasar, porque el jsonb entero ya no
  -- coincide byte a byte. `payload->>'topic'` no le importa.
  BEGIN
    INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
    VALUES (
      '10000000-0000-4000-8000-000000000001', 'notification.push',
      '{"topic": "settlement.close_due", "extra": true}'::jsonb, now()
    );
    RAISE EXCEPTION 'un payload con un campo de más se coló como si fuera un aviso distinto';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- Y `settlement.due` (dos campos, sin `topic` de cierre) no choca con nada:
  -- el predicado sigue distinguiendo tópicos, solo dejó de exigir igualdad
  -- exacta del jsonb entero.
  INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001', 'notification.push',
    jsonb_build_object('topic', 'settlement.due', 'settlementId', '12b00000-0000-4000-8000-000000000001'), now()
  );
END
$assert_predicate_survives_extra_fields$;

ROLLBACK;
