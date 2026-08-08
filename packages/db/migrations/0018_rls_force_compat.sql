BEGIN;

-- Compatibilidad con Postgres gestionado (Supabase): el rol propietario del
-- esquema llega SIN BYPASSRLS. Sobre una tabla con FORCE ROW LEVEL SECURITY ese
-- propietario queda sometido a sus propias políticas, y entonces
-- `SET row_security = off` -- la cláusula que usan las diez funciones
-- SECURITY DEFINER de 0006, 0007, 0009, 0012 y 0015 -- falla ya en el
-- CREATE FUNCTION, no al ejecutarlas.
--
-- Esta migración levanta ÚNICAMENTE el forzado sobre el propietario, y sólo
-- cuando ese propietario no puede puentear RLS. Lo que NO cambia:
--
--   * `ENABLE ROW LEVEL SECURITY` sigue activo en todas las tablas.
--   * `casa_clara_app` y `casa_clara_worker` no son propietarios de ninguna
--     tabla, no tienen BYPASSRLS y no pertenecen al rol propietario, así que
--     siguen sometidos a las mismas políticas por hogar que hoy.
--
-- El bloque «aislamiento estructural» de packages/db/tests/020_rls_matrix.sql
-- convierte esas tres afirmaciones en aserciones que fallan si dejan de ser
-- ciertas, y el resto de la matriz negativa comprueba el efecto observable.
--
-- Condicional e idempotente: en un clúster donde el propietario sí puede
-- puentear RLS (superusuario local, CI) no toca nada y FORCE se conserva.
--
-- El runner (packages/db/scripts/migrate.mjs) ejecuta este mismo fichero antes
-- de cada migración pendiente cuando el rol carece de BYPASSRLS: el forzado se
-- vuelve a aplicar en 0005, 0007, 0008, 0013, 0014, 0015 y 0016, y hay que
-- relajarlo entre una migración y la siguiente para que la instalación desde
-- cero llegue hasta el final.

DO $rls_force_compat$
DECLARE
  owner_can_bypass boolean;
  forced record;
BEGIN
  SELECT rolsuper OR rolbypassrls
    INTO owner_can_bypass
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;

  IF coalesce(owner_can_bypass, false) THEN
    RETURN;
  END IF;

  FOR forced IN
    SELECT relation.oid::regclass AS ident
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname IN ('app', 'app_private')
       AND relation.relkind = 'r'
       AND relation.relforcerowsecurity
       AND pg_catalog.pg_has_role(current_user, relation.relowner, 'USAGE')
     ORDER BY relation.oid
  LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', forced.ident);
  END LOOP;
END
$rls_force_compat$;

COMMIT;
