-- Altas desde la aplicación tras la migración 0030.
--
-- Lo que se juega aquí es quién puede crear a quién, y con qué límites:
--
--   1. Que el alta completa (perfil + membresía + contrato con su versión 1)
--      quepa bajo la RLS del rol de la aplicación, sin `row_security = off` ni
--      el rol propietario de las migraciones. Hasta 0030 no cabía: faltaba la
--      política de INSERT sobre app.user_profiles y el guion externo era la
--      única vía.
--   2. Que ese permiso sea SOLO de quien administra. Una empleada no crea
--      perfiles ni membresías, y no puede darse a sí misma un papel mejor.
--   2 bis. Que quien administra tampoco pueda crear a OTRA administradora desde
--      la aplicación (migración 0038). Es una puerta distinta de la anterior:
--      aquí el permiso existe y lo que se limita es el papel que se concede.
--   3. Que la obligación de cambiar la contraseña provisional no se pueda
--      quitar sola: la enciende quien administra, la apaga la propia persona y
--      nadie más, ni siquiera quien la encendió.
--   4. Que un hogar no toque los perfiles del otro.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- UUIDs con prefijo df* (roble), exclusivos de este fichero. Identidades con
-- prefijo `alta:` para no cruzarse con las fixtures.

-- ─────────────────────────────────────────────────────────────────────────────
-- El alta entera bajo la RLS de quien administra, sin puentear nada.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_alta$
DECLARE
  agreements_before integer;
  agreements integer;
  versions integer;
  pending boolean;
BEGIN
  -- Cuántos contratos vivos hay ANTES, en vez de un número escrito a mano: lo
  -- que se comprueba es que el alta suma uno, no cuánta gente trae la fixture.
  -- El número literal se quedó viejo en cuanto el roble estrenó una segunda
  -- empleada, y la prueba se cayó sin que nada de lo que afirma hubiera dejado
  -- de ser cierto.
  SELECT count(*)::integer INTO agreements_before
    FROM app.employment_agreements
   WHERE household_id = '10000000-0000-4000-8000-000000000001' AND status = 'active';

  INSERT INTO app.user_profiles (user_id, display_name, email, must_change_password)
  VALUES ('alta:roble:segunda', 'Alta Segunda Sintética', 'alta.segunda@casa.local', true);

  INSERT INTO app.household_memberships (id, household_id, user_id, role)
  VALUES (
    'df000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'alta:roble:segunda',
    'employee_live_in'
  );

  -- El contrato de la persona recién dada de alta. El índice único de 0002 es
  -- por PERSONA, no por hogar: que el roble ya tenga un acuerdo activo no
  -- estorba al segundo.
  INSERT INTO app.employment_agreements (
    id, household_id, employee_membership_id, starts_on, created_by_membership_id
  ) VALUES (
    'df100000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'df000000-0000-4000-8000-000000000001',
    '2026-09-01',
    '11000000-0000-4000-8000-000000000001'
  );

  INSERT INTO app.agreement_versions (
    id, household_id, agreement_id, version_number, effective_from,
    monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
    worked_rest_day_credit_minutes, contracted_weekly_minutes, annual_vacation_days,
    reason, created_by_membership_id
  ) VALUES (
    'df200000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'df100000-0000-4000-8000-000000000001',
    1, '2026-09-01', 130000, 0, 0, 1440, 2400, 30,
    'Alta desde la aplicación', '11000000-0000-4000-8000-000000000001'
  );

  SELECT count(*)::integer INTO agreements
    FROM app.employment_agreements
   WHERE household_id = '10000000-0000-4000-8000-000000000001' AND status = 'active';
  IF agreements <> agreements_before + 1 THEN
    RAISE EXCEPTION 'the hire should add exactly one live agreement (% before, % after)',
      agreements_before, agreements;
  END IF;
  IF agreements_before < 1 THEN
    RAISE EXCEPTION 'this assertion is worthless unless the household already held a live agreement';
  END IF;

  SELECT count(*)::integer INTO versions
    FROM app.agreement_versions
   WHERE agreement_id = 'df100000-0000-4000-8000-000000000001';
  IF versions <> 1 THEN
    RAISE EXCEPTION 'the new agreement should hold exactly its first version, saw %', versions;
  END IF;

  SELECT must_change_password INTO pending
    FROM app.user_profiles WHERE user_id = 'alta:roble:segunda';
  IF NOT pending THEN
    RAISE EXCEPTION 'a freshly hired account must carry the provisional-password flag';
  END IF;
END
$assert_alta$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ni siquiera quien administra crea otra administradora DESDE LA APLICACIÓN
-- (migración 0038). Hasta entonces `memberships_admin_insert` sólo miraba quién
-- escribía, nunca el papel que se concedía, y la promesa «esta puerta no crea
-- administradoras» vivía entera en una comparación de cadenas de TypeScript
-- (`HIREABLE_ROLES`). Se comprobó contra el banco real que por el rol
-- `casa_clara_app` se podía insertar una membresía `family_admin`.
--
-- Administrar se sigue concediendo con guion, que corre con el rol PROPIETARIO
-- de las migraciones y por tanto no está sometido a estas políticas.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_cannot_crown$
BEGIN
  INSERT INTO app.user_profiles (user_id, display_name)
  VALUES ('alta:roble:corona', 'Alta Corona Sintética');

  BEGIN
    INSERT INTO app.household_memberships (id, household_id, user_id, role)
    VALUES (
      'df000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      'alta:roble:corona',
      'family_admin'
    );
    RAISE EXCEPTION 'the application unexpectedly created a family_admin membership';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Y los papeles que el alta SÍ concede siguen entrando: la política
  -- restrictiva no puede haber cerrado la puerta entera.
  INSERT INTO app.household_memberships (id, household_id, user_id, role)
  VALUES (
    'df000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'alta:roble:corona',
    'helper'
  );
END
$assert_admin_cannot_crown$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Quien no administra no da de alta a nadie. Ni perfil, ni membresía, ni un
-- papel mejor para sí misma.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_cannot_hire$
DECLARE
  changed integer;
BEGIN
  BEGIN
    INSERT INTO app.user_profiles (user_id, display_name)
    VALUES ('alta:colada', 'Colada Sintética');
    RAISE EXCEPTION 'an employee unexpectedly created another person''s profile';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.household_memberships (id, household_id, user_id, role)
    VALUES (
      'df000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      'fixture:roble:viewer',
      'family_admin'
    );
    RAISE EXCEPTION 'an employee unexpectedly created a membership';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Su propia membresía tampoco: `memberships_admin_update` es de family_admin,
  -- así que la USING no la alcanza y el UPDATE no toca ninguna fila.
  UPDATE app.household_memberships
     SET role = 'family_admin'
   WHERE id = '11000000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN
    RAISE EXCEPTION 'an employee unexpectedly promoted herself (% rows)', changed;
  END IF;
END
$assert_employee_cannot_hire$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La obligación de cambiar la contraseña provisional: la enciende quien
-- administra, la apaga solo la propia persona.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_flag_admin$
DECLARE
  changed integer;
  pending boolean;
BEGIN
  -- Reponer una contraseña la vuelve a marcar como provisional.
  UPDATE app.user_profiles
     SET must_change_password = true
   WHERE user_id = 'fixture:roble:employee';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'family_admin should be able to flag a household profile (% rows)', changed;
  END IF;

  SELECT must_change_password INTO pending
    FROM app.user_profiles WHERE user_id = 'fixture:roble:employee';
  IF NOT pending THEN
    RAISE EXCEPTION 'the flag did not stick';
  END IF;

  -- Pero apagarla es de la persona, no de quien la encendió: quien administra
  -- no puede dar por cambiada una contraseña que no ha cambiado.
  BEGIN
    UPDATE app.user_profiles
       SET must_change_password = false
     WHERE user_id = 'fixture:roble:employee';
    RAISE EXCEPTION 'family_admin unexpectedly cleared someone else''s obligation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_flag_admin$;

-- La misma transacción, ahora con la identidad de la empleada.
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_flag_self$
DECLARE
  changed integer;
BEGIN
  UPDATE app.user_profiles
     SET must_change_password = false
   WHERE user_id = 'fixture:roble:employee';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'a person must be able to clear her own obligation (% rows)', changed;
  END IF;

  -- Y no puede encendérsela ella misma ni a nadie: encenderla es un acto de
  -- administración (alta o reposición), y esta es la reja que lo dice.
  BEGIN
    UPDATE app.user_profiles
       SET must_change_password = true
     WHERE user_id = 'fixture:roble:employee';
    RAISE EXCEPTION 'a non-admin unexpectedly required a password change';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_flag_self$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cada hogar, lo suyo: quien administra el roble no ve ni corrige los perfiles
-- del olivo. La USING de `user_profiles_admin_update` exige membresía en el
-- hogar EN CONTEXTO, así que no hay error, hay cero filas: la fila no existe
-- para quien mira.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_tenant_isolation$
DECLARE
  visible integer;
  changed integer;
BEGIN
  SELECT count(*)::integer INTO visible
    FROM app.user_profiles WHERE user_id = 'fixture:olivo:employee';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'the roble admin can read an olivo profile (% rows)', visible;
  END IF;

  UPDATE app.user_profiles
     SET display_name = 'Renombrada Desde El Roble'
   WHERE user_id = 'fixture:olivo:employee';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN
    RAISE EXCEPTION 'the roble admin renamed an olivo profile (% rows)', changed;
  END IF;

  -- Y el personal que la pantalla enseña es el de su hogar y solo el de su
  -- hogar: ninguna membresía ajena asoma en la lista, ni siquiera revocada.
  SELECT count(*)::integer INTO visible
    FROM app.household_memberships
   WHERE household_id <> '10000000-0000-4000-8000-000000000001';
  IF visible <> 0 THEN
    RAISE EXCEPTION 'the roble admin can see % membership(s) from another household', visible;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.household_memberships
     WHERE id = '11000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'the roble admin cannot see her own household staff';
  END IF;
END
$assert_tenant_isolation$;

ROLLBACK;
