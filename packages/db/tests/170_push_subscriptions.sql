-- Avisos en el móvil: los dispositivos, la ventana de silencio y quién recibe
-- (migración 0032).
--
-- Este fichero existe porque en `docs/notificaciones.md` §4.4 hay una frase
-- escrita para que la lea la empleada —«esto no es una opción que alguien pueda
-- cambiar: la app no sabe hacerlo»— y §6.3 exige que, si se escribe, se pruebe.
-- Mismo trato que se le dio al AC-26. Lo que se pina aquí es exactamente eso:
--
--   1. **Nadie ve el canal de nadie.** Ni quien administra el de la empleada, ni
--      ella el de quien administra. La lista de dispositivos de una persona es
--      un censo de sus aparatos con marcas de cuándo aparecen: en esta casa eso
--      es presencia. Lo impide la RLS, no la interfaz.
--   2. **Nadie puede suscribir por otro.** La política es la misma en lectura y
--      en escritura, así que dar de alta el teléfono de otra persona no es algo
--      que se rechace: es algo que no se puede expresar.
--   3. **La ventana de silencio es del servidor y es universal.** 09:00-21:30 de
--      lunes a sábado, hora de Madrid, para los cinco papeles. Un aviso que cae
--      fuera se aplaza; no hay excepción para nadie, tampoco para quien manda.
--   4. **La empleada no entra JAMÁS en el aviso de la cuenta por pagar.** No es
--      que venga apagado: es que la consulta que resuelve destinatarios no la
--      alcanza. Un aviso repetido recordándole que no le han pagado, sobre algo
--      que no está en su mano, es acoso de bajo nivel.
--   5. **Retirar el acceso apaga los avisos en el acto.** La audiencia se
--      resuelve en el instante del envío contra membresías vivas; no hay ninguna
--      copia de la lista en el payload de ningún trabajo que pueda sobrevivirle.
--   6. **El hecho se reevalúa antes de enviar.** Cobro ya confirmado, cuenta ya
--      pagada, vacaciones en curso: cero destinatarios y el trabajo se completa
--      sin efectos.
--   7. **Sin disparador de auditoría.** `app.audit_events` es append-only,
--      inmutable y no se poda: auditar esta tabla volcaría allí para siempre las
--      claves de cifrado de los teléfonos de la casa.
--
-- Requiere migraciones + fixtures/001_two_households.sql, y una conexión que
-- pueda SET ROLE casa_clara_app y casa_clara_worker.
--
-- Prefijos de UUID exclusivos de este fichero: fa… (roble).
--
-- La siembra de este bloque QUEDA (como en 130 y 160): este es el último fichero
-- por orden lexicográfico y ninguna suite posterior cuenta filas.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra: una cuenta de junio de 2026 cerrada y SIN pagar —el hecho que
-- justifica los dos avisos— y cuatro dispositivos, uno por cada papel que tiene
-- que quedar dentro o fuera de cada audiencia.
--
-- La cuenta es de la SEGUNDA empleada del roble (membresía …0006), y eso es
-- deliberado: la primera tiene vacaciones sembradas por
-- `060_vacations.sql` del 1 al 15 de agosto de 2026, y como el silencio en
-- vacaciones se mide contra el reloj de verdad, usarla ataría el resultado de
-- esta suite al día en que se ejecute. La silenciada la sembramos nosotros en el
-- bloque 5, con fechas relativas a hoy y dentro de una transacción que se
-- deshace.
--
-- Las líneas entran ANTES del cierre porque `settlement_lines_open_only` (0003)
-- solo las admite con la liquidación abierta: es el mismo orden que sigue el
-- comando real.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.settlements (
  id, household_id, agreement_id, employee_membership_id, period_start,
  period_end, due_on, created_by_membership_id
) VALUES (
  'fa100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000006',
  '2026-06-01', '2026-06-30', '2026-07-05', '11000000-0000-4000-8000-000000000001'
);

INSERT INTO app.settlement_lines (
  id, household_id, settlement_id, agreement_id, employee_membership_id,
  line_number, section, kind, occurred_on, concept, amount_cents,
  agreement_version_id
) VALUES (
  'fa110000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000002',
  '11000000-0000-4000-8000-000000000006', 1, 'salary', 'base_salary', '2026-06-01',
  'Fixture base salary junio', 120000, '12100000-0000-4000-8000-000000000003'
);

UPDATE app.settlements
   SET status = 'closed',
       closed_by_membership_id = '11000000-0000-4000-8000-000000000001',
       closed_at = '2026-06-30T18:00:00Z',
       snapshot_hash = repeat('b', 64)
 WHERE id = 'fa100000-0000-4000-8000-000000000001';

INSERT INTO app.push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label) VALUES
  ('fa200000-0000-4000-8000-000000000001', 'fixture:roble:employee2',
   'https://push.ejemplo.test/roble-empleada', 'fixture-p256dh-empleada', 'fixture-auth-1', 'El del bolsillo'),
  ('fa200000-0000-4000-8000-000000000002', 'fixture:roble:admin',
   'https://push.ejemplo.test/roble-admin', 'fixture-p256dh-admin', 'fixture-auth-2', NULL),
  -- Quien es de la familia pero NO administra no paga la cuenta y no recibe el
  -- aviso: la audiencia es `family_admin`, no «la familia».
  ('fa200000-0000-4000-8000-000000000003', 'fixture:roble:family',
   'https://push.ejemplo.test/roble-familia', 'fixture-p256dh-familia', 'fixture-auth-3', NULL),
  -- El otro hogar, con su propia administración: no debe alcanzar nada de aquí.
  ('fa200000-0000-4000-8000-000000000004', 'fixture:olivo:admin',
   'https://push.ejemplo.test/olivo-admin', 'fixture-p256dh-olivo', 'fixture-auth-4', NULL);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Forma: RLS puesta, una sola política, cero auditoría y ni un permiso
--     directo para el emisor.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_shape$
DECLARE
  triggers integer;
  policies integer;
  rls_enabled boolean;
  worker_grants integer;
  signature text;
BEGIN
  SELECT count(*)::integer INTO triggers
    FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'app.push_subscriptions'::regclass
     AND NOT tgisinternal;
  IF triggers <> 0 THEN
    RAISE EXCEPTION 'app.push_subscriptions tiene % disparador(es): auditar esta tabla copiaría las claves de cifrado de los teléfonos a app.audit_events, que es inmutable y no se poda', triggers;
  END IF;

  SELECT relrowsecurity INTO rls_enabled
    FROM pg_catalog.pg_class WHERE oid = 'app.push_subscriptions'::regclass;
  IF NOT coalesce(rls_enabled, false) THEN
    RAISE EXCEPTION 'app.push_subscriptions se quedó sin ENABLE ROW LEVEL SECURITY';
  END IF;

  SELECT count(*)::integer INTO policies
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app' AND tablename = 'push_subscriptions';
  IF policies <> 1 THEN
    RAISE EXCEPTION 'app.push_subscriptions tiene % políticas; se esperaba una sola («solo su dueño», idéntica en lectura y escritura)', policies;
  END IF;

  -- El emisor NO lee esta tabla. Sale por la función definer, que es la única
  -- superficie por la que asoman p256dh y auth y que ya lleva dentro el filtro
  -- de membresía viva, el de audiencia y el de vacaciones.
  SELECT count(*)::integer INTO worker_grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'app' AND table_name = 'push_subscriptions'
     AND grantee = 'casa_clara_worker';
  IF worker_grants <> 0 THEN
    RAISE EXCEPTION 'casa_clara_worker tiene % permisos directos sobre app.push_subscriptions; debe pasar por app_private.push_notice_targets', worker_grants;
  END IF;

  SELECT pg_catalog.pg_get_function_identity_arguments(oid) INTO signature
    FROM pg_catalog.pg_proc
   WHERE proname = 'push_notice_targets' AND pronamespace = 'app_private'::regnamespace;
  IF signature <> 'notice_household uuid, notice_settlement uuid, notice_topic text' THEN
    RAISE EXCEPTION 'app_private.push_notice_targets cambió de firma («%»): el payload del trabajo solo puede llevar identificadores', signature;
  END IF;
END
$assert_shape$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Cada quien ve su aparato y ninguno más, y nadie suscribe por otro.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_is_blind$
DECLARE
  visible integer;
  touched integer;
BEGIN
  SELECT count(*)::integer INTO visible FROM app.push_subscriptions;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'quien administra ve % dispositivos; debería ver exactamente el suyo. Saber si la empleada tiene los avisos encendidos es un detector de presencia (040-privacidad-reciproca.md:11)', visible;
  END IF;

  SELECT count(*)::integer INTO visible
    FROM app.push_subscriptions WHERE user_id <> 'fixture:roble:admin';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'quien administra alcanza % filas ajenas', visible;
  END IF;

  -- Apagarle los avisos a otra persona no falla: no encuentra nada que apagar.
  UPDATE app.push_subscriptions SET revoked_at = statement_timestamp()
   WHERE user_id = 'fixture:roble:employee2';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'quien administra revocó % dispositivos ajenos', touched;
  END IF;

  DELETE FROM app.push_subscriptions WHERE user_id = 'fixture:roble:employee2';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'quien administra borró % dispositivos ajenos', touched;
  END IF;

  -- Y no puede darle de alta uno: la misma política gobierna el WITH CHECK.
  BEGIN
    INSERT INTO app.push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES ('fixture:roble:employee2', 'https://push.ejemplo.test/impuesto', 'x', 'y');
    RAISE EXCEPTION 'quien administra suscribió el teléfono de otra persona: no existe «activárselo porque es útil para la casa»';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin_is_blind$;

-- La simetría es explícita: ella tampoco ve el canal de quien administra.
SELECT set_config('app.user_id', 'fixture:roble:employee2', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000006'
);

DO $assert_employee_is_blind_too$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible FROM app.push_subscriptions;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'la empleada ve % dispositivos; «nadie ve el de nadie» es la regla, y es más fácil de defender que «nadie ve el de ella»', visible;
  END IF;

  SELECT count(*)::integer INTO visible
    FROM app.push_subscriptions WHERE user_id = 'fixture:roble:admin';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'la empleada alcanza el dispositivo de quien administra';
  END IF;
END
$assert_employee_is_blind_too$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · La ventana de silencio, con reloj de pared y sin excepciones.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

DO $assert_quiet_hours$
DECLARE
  got timestamptz;
BEGIN
  -- Miércoles de madrugada: espera a que abra la ventana.
  got := app.push_run_at('2026-06-10 03:14 Europe/Madrid');
  IF got <> '2026-06-10 09:00 Europe/Madrid'::timestamptz THEN
    RAISE EXCEPTION 'un aviso de madrugada quedó para las % en vez de las 09:00', got;
  END IF;

  -- Dentro de la ventana no se retoca: sale cuando toca.
  got := app.push_run_at('2026-06-10 12:00 Europe/Madrid');
  IF got <> '2026-06-10 12:00 Europe/Madrid'::timestamptz THEN
    RAISE EXCEPTION 'un aviso en plena ventana se movió a %', got;
  END IF;

  -- El borde de cierre entra; un minuto después, no.
  got := app.push_run_at('2026-06-10 21:30 Europe/Madrid');
  IF got <> '2026-06-10 21:30 Europe/Madrid'::timestamptz THEN
    RAISE EXCEPTION 'las 21:30 clavadas se movieron a %', got;
  END IF;

  got := app.push_run_at('2026-06-10 21:31 Europe/Madrid');
  IF got <> '2026-06-11 09:00 Europe/Madrid'::timestamptz THEN
    RAISE EXCEPTION 'un aviso de las 21:31 quedó para % en vez de la mañana siguiente', got;
  END IF;

  -- Sábado por la noche salta el domingo entero: este canal no escribe en
  -- domingo, y no porque el domingo sea el descanso de nadie en concreto —eso
  -- lo diría el manual, que sigue con ese hueco vacío— sino porque es una
  -- propiedad del canal, igual para los cinco papeles.
  got := app.push_run_at('2026-06-13 22:00 Europe/Madrid');
  IF got <> '2026-06-15 09:00 Europe/Madrid'::timestamptz THEN
    RAISE EXCEPTION 'el sábado por la noche saltó a % en vez del lunes a las 09:00', got;
  END IF;

  -- Y el domingo a media mañana, también.
  got := app.push_run_at('2026-06-14 10:00 Europe/Madrid');
  IF got <> '2026-06-15 09:00 Europe/Madrid'::timestamptz THEN
    RAISE EXCEPTION 'un aviso del domingo a las 10:00 salió a %', got;
  END IF;

  -- Invierno: la hora es de pared, no un desplazamiento fijo sobre UTC. Este es
  -- el defecto que tuvo esta casa con `::date::timestamptz` (migración 0027) y
  -- que habría hecho que el primer aviso de su vida sonara a las dos de la
  -- madrugada.
  got := app.push_run_at('2026-01-14 23:00 Europe/Madrid');
  IF got <> '2026-01-15 09:00 Europe/Madrid'::timestamptz THEN
    RAISE EXCEPTION 'en horario de invierno el aplazamiento cayó en % en vez de las 09:00 de Madrid', got;
  END IF;
END
$assert_quiet_hours$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Quién recibe cada aviso, resuelto en el instante del envío.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_worker;

DO $assert_audiences$
DECLARE
  targets integer;
  who text;
BEGIN
  -- El recibo es de quien lo cobra.
  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.receipt_ready');
  IF targets <> 1 THEN
    RAISE EXCEPTION 'el aviso del recibo alcanza % dispositivos; debería alcanzar solo el de la empleada del contrato', targets;
  END IF;

  SELECT endpoint INTO who
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.receipt_ready');
  IF who <> 'https://push.ejemplo.test/roble-empleada' THEN
    RAISE EXCEPTION 'el aviso del recibo iba a %', who;
  END IF;

  -- La cuenta por pagar es de quien puede pagarla: `family_admin` y nadie más.
  -- Ni la empleada (no está en su mano), ni quien es familia sin administrar,
  -- ni el otro hogar.
  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.due');
  IF targets <> 1 THEN
    RAISE EXCEPTION 'el aviso de la cuenta por pagar alcanza % dispositivos; debería alcanzar solo el de quien administra', targets;
  END IF;

  SELECT endpoint INTO who
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.due');
  IF who <> 'https://push.ejemplo.test/roble-admin' THEN
    RAISE EXCEPTION 'el aviso de la cuenta por pagar iba a %: la empleada no entra en esta consulta por construcción', who;
  END IF;

  -- Un hogar que no es el de la liquidación no alcanza nada.
  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '20000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.due');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'el otro hogar alcanzó % destinatarios de una liquidación ajena', targets;
  END IF;

  -- El catálogo de avisos es cerrado: inventarse uno no cuela silenciosamente.
  BEGIN
    PERFORM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'routine.due');
    RAISE EXCEPTION 'un aviso fuera del catálogo («routine.due», recordatorio de tarea hacia quien trabaja) resolvió destinatarios';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$assert_audiences$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · Lo que apaga un aviso: retirar el acceso, estar de vacaciones, confirmar
--     el cobro o pagar la cuenta. Los cuatro se comprueban sobre el MISMO hecho
--     del bloque anterior, que acaba de demostrarse vivo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

-- (a) Se le retira el acceso a quien administra.
UPDATE app.household_memberships
   SET revoked_at = statement_timestamp()
 WHERE id = '11000000-0000-4000-8000-000000000001';

-- (b) La empleada tiene vacaciones apuntadas que cubren hoy.
INSERT INTO app.vacation_periods (
  id, household_id, agreement_id, employee_membership_id, starts_on, ends_on,
  recorded_by_membership_id
) VALUES (
  'fa300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000006',
  (now() AT TIME ZONE 'Europe/Madrid')::date - 1,
  (now() AT TIME ZONE 'Europe/Madrid')::date + 1,
  '11000000-0000-4000-8000-000000000002'
);

SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_worker;

DO $assert_silence$
DECLARE
  targets integer;
BEGIN
  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.due');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'a quien se le retiró el acceso le siguen llegando avisos (% destinatarios). La revocación tiene que ser instantánea y no puede perderse: por eso la audiencia no viaja nunca en el payload del trabajo', targets;
  END IF;

  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.receipt_ready');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'sonó un aviso en vacaciones (% destinatarios). El hecho sigue en pantalla, que es donde se atiende', targets;
  END IF;
END
$assert_silence$;

ROLLBACK;

-- (c) Ella ya confirmó el cobro y la cuenta se pagó entera: los dos avisos se
--     quedan sin nada que decir. Es la reevaluación del hecho justo antes de
--     enviar, que es lo que evita el aviso aplazado que llega cuando ya no toca.
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.settlement_receipt_confirmations (
  id, household_id, settlement_id, employee_membership_id, confirmed_at
) VALUES (
  'fa500000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000006',
  '2026-07-03T09:00:00Z'
);

INSERT INTO app.payments (
  id, household_id, settlement_id, employee_membership_id, amount_cents,
  method, value_on, recorded_by_membership_id
) VALUES (
  'fa400000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000006',
  120000, 'bank_transfer', '2026-07-02', '11000000-0000-4000-8000-000000000001'
);

SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_worker;

DO $assert_settled_is_quiet$
DECLARE
  targets integer;
BEGIN
  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.receipt_ready');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'se avisaría de un recibo cuyo cobro ya está confirmado (% destinatarios)', targets;
  END IF;

  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.due');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'se seguiría reavisando de una cuenta ya pagada (% destinatarios)', targets;
  END IF;
END
$assert_settled_is_quiet$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · El resultado de la entrega, y el endpoint muerto que deja de intentarse.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_worker;

DO $assert_delivery$
DECLARE
  failures integer;
  successes timestamptz;
  targets integer;
BEGIN
  PERFORM app_private.push_delivery_recorded(
    'fa200000-0000-4000-8000-000000000001', false, false);
  PERFORM app_private.push_delivery_recorded(
    'fa200000-0000-4000-8000-000000000001', false, false);

  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.receipt_ready');
  IF targets <> 1 THEN
    RAISE EXCEPTION 'dos fallos sueltos (un 500, un timeout) dieron por muerto un dispositivo vivo';
  END IF;

  -- 404/410: ese endpoint no volverá a existir. Se marca y deja de intentarse,
  -- pero la fila se conserva: la fecha es lo único que permite explicar el
  -- silencio en «Tu cuenta», que es el riesgo de mantenimiento número uno.
  PERFORM app_private.push_delivery_recorded(
    'fa200000-0000-4000-8000-000000000001', false, true);

  SELECT count(*)::integer INTO targets
    FROM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.receipt_ready');
  IF targets <> 0 THEN
    RAISE EXCEPTION 'se sigue escribiendo a un endpoint que devolvió 410 Gone';
  END IF;
END
$assert_delivery$;

ROLLBACK;

-- Y el emisor escribe el resultado sin tener UPDATE sobre la tabla: la única
-- vía es la función definer.
BEGIN;
SET LOCAL ROLE casa_clara_worker;

DO $assert_worker_cannot_touch_the_table$
BEGIN
  BEGIN
    PERFORM 1 FROM app.push_subscriptions LIMIT 1;
    RAISE EXCEPTION 'el emisor puede leer app.push_subscriptions directamente';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_worker_cannot_touch_the_table$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7 · La aplicación no puede resolver destinatarios ni escribir entregas: no
--     tiene ni USAGE sobre `app_private`. Encolar sí; enviar, no.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_app_cannot_send$
BEGIN
  BEGIN
    PERFORM app_private.push_notice_targets(
      '10000000-0000-4000-8000-000000000001',
      'fa100000-0000-4000-8000-000000000001',
      'settlement.due');
    RAISE EXCEPTION 'la aplicación resolvió destinatarios de push: p256dh y auth saldrían por el mismo rol que sirve las páginas';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- La ventana de silencio sí la necesita: es quien encola al cerrar el mes.
  PERFORM app.push_run_at(statement_timestamp());
END
$assert_app_cannot_send$;

ROLLBACK;
