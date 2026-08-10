BEGIN;

/*
 * Personal y altas desde la aplicación (docs/personal-y-contratos.md).
 *
 * El modelo de datos ya admitía varias empleadas: `employment_agreements` tiene
 * un único acuerdo activo POR PERSONA, no por hogar, desde 0002. Lo que no
 * existía era la forma de dar de alta a una desde dentro de la aplicación, y el
 * hueco no estaba en el dominio sino en la identidad: `app.user_profiles` solo
 * tenía `user_profiles_self_insert`, así que quien administra la casa no podía
 * escribir el perfil de la persona que va a entrar. Se creaban desde un guion
 * externo con el rol propietario de las migraciones, saltándose la RLS.
 *
 * Esta migración añade lo justo para cerrarlo:
 *
 *   1. La marca de contraseña provisional pendiente de cambiar.
 *   2. Las dos políticas que le faltaban a `user_profiles` para el alta.
 *   3. El disparador que impide que la obligación de cambiarla se quite sola.
 *
 * No crea ninguna tabla. El personal de la casa son las membresías cuyo papel
 * es `employee_live_in` o `helper`, y su historia son sus acuerdos con sus
 * versiones: una tabla paralela de «empleadas» sería una segunda verdad que
 * mantener sincronizada con la primera.
 */

-- ── 1. Contraseña provisional ───────────────────────────────────────────────
/*
 * La contraseña inicial la teclea quien da el alta y se entrega en persona (no
 * hay correo en este producto, y es una decisión: docs/despliegue/
 * opciones-de-acceso.md). Mientras esta marca esté encendida, la aplicación
 * lleva a esa persona a «Tu acceso» y no la deja ir a ninguna otra parte del
 * hogar.
 *
 * Vive en el esquema `app` y no en el de identidad por dos razones: es una
 * regla de la casa, no de Better Auth, y así viaja en la MISMA consulta que
 * `resolveAppUser` ya hace sobre el perfil, sin una petición más por visita.
 */
ALTER TABLE app.user_profiles
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.user_profiles.must_change_password IS
  'Contraseña provisional entregada en persona: la aplicación obliga a cambiarla antes de dejar entrar a ninguna otra pantalla.';

-- ── 2. La administración puede crear y corregir perfiles de su hogar ────────
/*
 * `user_profiles_admin_insert` no puede exigir en su WITH CHECK que la persona
 * tenga ya una membresía en el hogar: en el alta el perfil se escribe ANTES que
 * la membresía, porque la membresía lo referencia. La condición es, por tanto,
 * la más fuerte posible sin caer en esa circularidad: contexto completo y papel
 * `family_admin`.
 *
 * Una fila de perfil suelta es inerte. No abre ninguna puerta: quien decide qué
 * se ve es la membresía, y `memberships_admin_insert` sigue exigiendo
 * `tenant_context_matches(household_id)`. Lo peor que puede hacer una
 * administradora con esta política es ocupar identificadores de perfil dentro
 * de su propia sesión autorizada, cosa que ya podía hacer creando membresías.
 */
CREATE POLICY user_profiles_admin_insert ON app.user_profiles
  FOR INSERT WITH CHECK (
    app.context_is_complete()
    AND app.current_household_role() = 'family_admin'
  );

/*
 * La corrección sí puede exigirlo, y lo exige: mismo predicado que
 * `user_profiles_admin_read` (0005). Sirve para renombrar a alguien de la casa
 * y para volver a encender la marca de contraseña provisional cuando se le
 * repone desde Ajustes.
 */
CREATE POLICY user_profiles_admin_update ON app.user_profiles
  FOR UPDATE USING (
    app.current_household_role() = 'family_admin'
    AND EXISTS (
      SELECT 1 FROM app.household_memberships AS membership
       WHERE membership.household_id = app.current_household_id()
         AND membership.user_id = user_profiles.user_id
    )
  ) WITH CHECK (
    app.current_household_role() = 'family_admin'
    AND EXISTS (
      SELECT 1 FROM app.household_memberships AS membership
       WHERE membership.household_id = app.current_household_id()
         AND membership.user_id = user_profiles.user_id
    )
  );

-- ── 3. La obligación no se quita sola ───────────────────────────────────────
/*
 * `user_profiles_self_update` existe desde 0005 y da permiso sobre la fila
 * ENTERA de una misma. Sin este disparador, quien tiene que cambiar la
 * contraseña podría apagar la marca sin cambiarla —y quien quisiera fastidiar a
 * otra persona podría encendérsela— si algún día apareciera un formulario de
 * perfil. Hoy el único código que la apaga es el que acaba de cambiar la
 * contraseña de verdad; esto es la reja para mañana.
 *
 *   · encenderla  → solo bajo contexto de `family_admin` (alta y reposición).
 *   · apagarla    → solo la propia persona.
 *
 * El disparador NO estorba al guion de alta ni a las migraciones: quien escribe
 * con `row_security = off` y sin contexto de hogar tampoco toca la columna, y
 * sin transición de valor no hay nada que comprobar.
 */
CREATE FUNCTION app.enforce_password_flag_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.must_change_password IS NOT DISTINCT FROM OLD.must_change_password THEN
    RETURN NEW;
  END IF;
  IF NEW.must_change_password THEN
    IF app.current_household_role() IS DISTINCT FROM 'family_admin' THEN
      RAISE EXCEPTION 'only a family_admin may require a password change'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'only the person themselves may clear their password change requirement'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER user_profiles_password_flag_guard
BEFORE UPDATE ON app.user_profiles
FOR EACH ROW EXECUTE FUNCTION app.enforce_password_flag_transition();

-- ── 4. Buscar al personal de un hogar ───────────────────────────────────────
/*
 * La pantalla de Personal recorre las membresías de trabajo del hogar, vivas y
 * pasadas. Sin este índice es un recorrido secuencial de la tabla entera; con
 * dos hogares no se nota, pero el índice cuesta nada y la consulta es la que
 * más veces va a hacer la administración.
 */
CREATE INDEX household_memberships_household_role_idx
  ON app.household_memberships (household_id, role, created_at);

COMMIT;
