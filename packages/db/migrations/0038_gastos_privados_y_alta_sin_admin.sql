BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Dos agujeros de autorización que se tapan donde manda esta casa: en la base.
--
-- ── 1. UN GASTO LLEVA IMPORTE, Y LOS IMPORTES NO SON DE LA FAMILIA ──────────
--
-- La regla del producto es una sola frase y estaba escrita en todas partes
-- menos aquí: quien tiene el papel `family_member` ve la RELACIÓN laboral, pero
-- no ve el dinero. Se cumple tabla por tabla —`agreement_versions`,
-- `settlements`, `settlement_lines`, `payments`, `advances`,
-- `compensation_accounts`, `manual_adjustments` (0022) y los arrastres de
-- vacaciones (0037) usan todos `include_family_member => false`—. Los gastos
-- eran LA excepción: `expenses_read` (0005) pasaba `true`, y con ella la
-- familia no administradora leía la descripción, la fecha y el IMPORTE de lo
-- que la empleada se había adelantado de su bolsillo, más el enlace al
-- justificante cuando lo había.
--
-- Se llegaba en dos clics: desde el expediente de la persona, la pestaña
-- Conceptos —cuya llave `settlement.read` esa familia sí tiene— lo enseñaba;
-- y la portada Hoy lo repetía con la cifra formateada.
--
-- No es una excepción defendible. Un gasto es una cantidad de dinero que la
-- casa le debe a alguien; que además esté pendiente de aprobar no lo convierte
-- en otra cosa. Aquí `expenses_read` pasa a `false` y queda como sus vecinas.
--
-- NO se toca `vacation_periods_read` (0020), que sí pasa `true`: son días y
-- fechas, no dinero, y esa decisión está declarada y es deliberada.
--
-- ── 2. EL ALTA NO PUEDE CREAR A QUIEN ADMINISTRA, Y AHORA TAMPOCO LA BASE ───
--
-- `HIREABLE_ROLES` (apps/web/src/lib/server/staff-hire.server.ts) sólo deja dar
-- de alta `employee_live_in` y `helper`, y lo comprueba en el servidor por los
-- dos caminos, así que manipular el campo oculto del formulario no lleva a
-- ninguna parte. Pero `memberships_admin_insert` (0005) sólo exige que QUIEN
-- ESCRIBE sea `family_admin`; no mira NUNCA el papel que se concede. Es decir:
-- la promesa «esta puerta no crea administradoras» estaba sostenida por una
-- comparación de cadenas en TypeScript, en una casa cuyo argumento entero es
-- que la autoridad vive en Postgres. Comprobado contra el banco real: por el
-- rol `casa_clara_app` se podía insertar una membresía `family_admin`.
--
-- La política es RESTRICTIVA a propósito: no concede nada, se suma con AND a
-- todo lo que ya hay, y por eso no se puede sortear escribiendo mañana una
-- política permisiva nueva sobre la misma tabla. Enumera los cuatro papeles
-- que la aplicación sí puede conceder; añadir un papel al enum sin pasar por
-- aquí lo deja fuera, que es el sentido correcto de fallar.
--
-- POR QUÉ ESTO NO ROMPE EL ALTA DE ADMINISTRADORAS. Administrar se sigue
-- concediendo con guion, deliberadamente (`staff-hire.server.ts`), y ese guion
-- —`packages/db/scripts/seed-employment-agreement.mjs`— se conecta con
-- `DATABASE_URL`, que su propia cabecera documenta como «rol propietario de las
-- migraciones del esquema app». Un propietario no está sometido a RLS salvo con
-- FORCE, y sobre estas tablas FORCE no le alcanza por ninguno de los dos
-- caminos posibles: donde el propietario es superusuario (local, CI) puentea
-- RLS por atributo de rol, y donde no lo es (Supabase, y el banco `sb_owner`
-- con el que se ensaya) la 0018 le levanta el forzado a él y sólo a él. Las
-- políticas —ésta incluida— siguen gobernando `casa_clara_app` y
-- `casa_clara_worker`, que no son propietarios de nada. O sea: la puerta de la
-- aplicación queda cerrada y el guion sigue abriendo la suya.
--
-- POR QUÉ NO HAY NINGÚN `FORCE ROW LEVEL SECURITY` EN ESTE FICHERO. No se crea
-- ninguna tabla ni ninguna función `SECURITY DEFINER`: las dos tablas que se
-- tocan ya venían forzadas de la 0005, y volver a forzarlas aquí obligaría a la
-- 0018 a relajarlo otra vez sin ganar nada. La regla de la casa —FORCE al final
-- del fichero, después de cualquier función que nombre la tabla— se cumple por
-- vacío.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Los gastos dejan de llegar a la familia no administradora ────────────
DROP POLICY expenses_read ON app.expenses;
CREATE POLICY expenses_read ON app.expenses
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, false));

-- ── 2. Desde la aplicación no nace ninguna administradora ───────────────────
CREATE POLICY memberships_no_admin_from_app ON app.household_memberships
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (role IN ('employee_live_in', 'helper', 'family_member', 'viewer'));

-- ── Aserción: lo que esta migración promete, comprobado sobre el catálogo ────
DO $check$
DECLARE
  regla text;
BEGIN
  SELECT qual INTO regla
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app' AND tablename = 'expenses' AND policyname = 'expenses_read';
  IF regla IS NULL OR regla LIKE '%, true)%' THEN
    RAISE EXCEPTION 'expenses_read sigue enseñando los gastos a la familia no administradora: %', regla;
  END IF;

  -- Que exista no basta: una política PERMISIVA con este mismo texto no
  -- restringiría nada, sólo añadiría otra vía de entrada.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'household_memberships'
       AND policyname = 'memberships_no_admin_from_app'
       AND permissive = 'RESTRICTIVE' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'la puerta del alta no tiene su política restrictiva de INSERT';
  END IF;

  SELECT with_check INTO regla
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app' AND tablename = 'household_memberships'
     AND policyname = 'memberships_no_admin_from_app';
  IF regla IS NULL OR regla LIKE '%family_admin%' THEN
    RAISE EXCEPTION 'la política restrictiva del alta admite family_admin: %', regla;
  END IF;
END
$check$;

COMMIT;
