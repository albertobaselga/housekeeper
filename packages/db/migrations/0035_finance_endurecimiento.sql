BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Endurecimiento del módulo «Finanzas»: los dos agujeros que la revisión de la
-- 0034 encontró en la base. La 0034 no se edita —ya está aplicada y sellada por
-- SHA-256, y el runner aborta si su hash cambia—, así que las correcciones
-- entran aquí.
--
--   1. El rastro de auditoría dejaba leer las finanzas a un administrador SIN
--      concesión, por fuera de las políticas finance_*.
--   2. La reja del árbol de categorías solo miraba hacia arriba, así que por
--      UPDATE se colaban un tercer nivel y un ciclo de longitud 1.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. El rastro financiero se escribe siempre; leerlo exige el cerrojo ──────
--
-- `app_private.write_audit_event()` vuelca la fila entera en `after_data`, y
-- `audit_events_read` (0005) deja leer esa tabla a CUALQUIER family_admin del
-- hogar sin pasar por `finance_enabled()`. Resultado: un administrador al que
-- nadie ha concedido Finanzas veía cero movimientos por la vía normal y, acto
-- seguido, leía concepto, proveedor, importe y saldo de cada uno en la
-- auditoría. No era escalada de privilegio —ese mismo administrador puede
-- concederse el módulo—, pero sí pérdida del rastro: concederse deja una fila
-- visible y auditada, y leer por aquí no dejaba nada.
--
-- Lo que NO se hace, a propósito: recortar lo que el trigger registra. La
-- auditoría sigue guardando la fila íntegra; lo único que se controla es quién
-- puede leerla. Tampoco se toca `0005_rls.sql` ni la política `audit_events_read`.
--
-- RESTRICTIVA y no permisiva porque las permisivas de una misma orden se
-- combinan con OR —solo podrían ampliar el acceso, nunca recortarlo— mientras
-- que las restrictivas se combinan con AND sobre el conjunto permisivo. Es la
-- primera política restrictiva del expediente.
--
-- Acotada `TO casa_clara_app` por una razón medida, no por descuido:
-- `app.finance_enabled()` es SECURITY INVOKER y su cuerpo lee
-- `app.finance_module_grants`, tabla sobre la que `casa_clara_worker` no tiene
-- —ni debe tener— privilegio alguno. Sin la cláusula TO, toda lectura del
-- worker sobre `audit_events` moría con «permission denied for function
-- finance_enabled» (comprobado), y abrirle la tabla de concesiones para evitarlo
-- habría sido peor que el problema. El worker no pierde nada: su permisiva ya lo
-- deja a cero, porque `audit_events_read` exige contexto de hogar y el worker no
-- lo establece. La cláusula alcanza por pertenencia al rol de login real
-- (`casa_clara_app_login`), que es con el que se conecta la web.
--
-- Efecto aceptado conscientemente: a un administrador que escribió movimientos y
-- a quien luego se le revoque la concesión deja de vérsele su propio rastro
-- financiero. Es la política deseada. El prefijo `finance\_%` usa la barra
-- invertida como escape por defecto de LIKE, así que casa el prefijo literal
-- `finance_` y no alcanza al dominio laboral (`compensation_*`, `settlements`…).
CREATE POLICY audit_events_finance_lock ON app.audit_events
  AS RESTRICTIVE
  FOR SELECT
  TO casa_clara_app
  USING (entity_table NOT LIKE 'finance\_%' OR app.finance_enabled());

-- ── 2. La reja del árbol mira también hacia abajo y hacia sí misma ───────────
--
-- La versión de la 0034 comprobaba el padre del padre que se asigna a la fila,
-- pero nunca si la fila que se mueve YA TIENE hijas, ni que no se apuntara a sí
-- misma. Por UPDATE se colaban dos cosas:
--
--   (a) colgar bajo otra raíz una categoría con hijas, que las dejaba en un
--       tercer nivel —la invariante de dos niveles que las fases 3 (ETL) y 5
--       (Ajustes) dan por hecha—;
--   (b) `parent_id = id`: en un BEFORE UPDATE la tabla todavía contiene la fila
--       vieja, así que la reja leía el abuelo anterior (NULL) y aprobaba. Queda
--       un ciclo de longitud 1 que no termina en una consulta recursiva y, peor,
--       saca a la raíz de transferencia del índice parcial
--       `... WHERE kind = 'transferencia' AND parent_id IS NULL`, dejando sitio
--       a una segunda; el pipeline post-import de la fase 2 depende de que sea
--       única.
--
-- Un ciclo de dos (A → B → A) ya quedaba bloqueado por la comprobación del
-- abuelo. El trigger no se recrea: sigue siendo el mismo
-- `finance_categories_depth_guard` de la 0034, con el cuerpo reemplazado.
CREATE OR REPLACE FUNCTION app.enforce_finance_category_depth()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  grandparent_id uuid;
  parent_exists boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'una categoría no puede ser su propia madre'
      USING ERRCODE = '23514';
  END IF;
  -- Solo en UPDATE: una fila recién insertada no puede tener descendencia
  -- todavía, porque nadie ha podido apuntar a un id que aún no existía.
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM app.finance_categories AS child
     WHERE child.household_id = NEW.household_id AND child.parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'no se puede colgar % de otra categoría: ya tiene subcategorías', NEW.name
      USING ERRCODE = '23514';
  END IF;
  SELECT true, parent.parent_id INTO parent_exists, grandparent_id
    FROM app.finance_categories AS parent
   WHERE parent.household_id = NEW.household_id AND parent.id = NEW.parent_id;
  IF NOT coalesce(parent_exists, false) THEN
    RAISE EXCEPTION 'finance category parent % does not exist in this household', NEW.parent_id
      USING ERRCODE = '23514';
  END IF;
  IF grandparent_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance categories are a two-level tree: % cannot hang from a subcategory', NEW.name
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

COMMIT;
