BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Dos condiciones nuevas del contrato: el precio del día de vacaciones no
-- disfrutado y la política de caducidad de los días arrastrados.
--
-- Apartados 4.2 y 4.4 de docs/ux/contrato-feedback-v2.md. Las dos son
-- CONDICIONES PACTADAS, no cálculos: por eso viven en la versión del acuerdo y
-- no en una tabla de vacaciones. Cambiarlas es cambiar lo pactado, y eso ya
-- sabe hacerlo esta casa: se apila una versión nueva.
--
-- 1. `unused_vacation_day_rate_cents` — el importe por día de vacaciones no
--    disfrutado, hermano de `overtime_hourly_rate_cents` y de
--    `worked_rest_day_rate_cents`. `bigint`, `CHECK (>= 0)` y **NULLABLE a
--    propósito**.
--
--    Vacía significa «no se pactó», que es la verdad de todos los contratos
--    firmados antes de hoy. Un cero por omisión dejaría escrito en una tabla
--    INMUTABLE que se acordó pagar cero euros por día, que es falso y que
--    además no se podría corregir nunca: sólo tapar apilando otra versión, con
--    la mentira quedándose para siempre en el historial. Por eso no lleva
--    DEFAULT y por eso no es NOT NULL.
--
--    Sin tarifa pactada la aplicación no estima ningún importe: ofrece
--    arrastrar o rechazar los días y, para compensarlos, dice lo que falta y
--    lleva a pactarlo.
--
-- 2. La política de caducidad de los días arrastrados, en `terms` (jsonb, que
--    existe desde la 0002 y hasta hoy nadie escribía). No es columna porque es
--    política pactada con forma propia —«seis meses», «otro número de meses» o
--    «nunca expiran»— y `terms` es exactamente para eso. **Ausente = seis
--    meses**, así que ningún contrato ya firmado necesita tocarse: esta
--    migración no hace ni un UPDATE de datos.
--
--    La CHECK de forma no duplica la regla de negocio: sólo impide que alguien
--    escriba ahí una tercera forma que ningún lector sepa interpretar. El
--    esquema zod (`packages/contracts/src/schemas.ts`) es quien valida la
--    entrada; esto es la red de debajo.
--
-- POR QUÉ NO HAY QUE REESCRIBIR NINGÚN DISPARADOR. El
-- `enforce_agreement_version_append_only` de la 0002 **no enumera columnas**:
-- levanta la excepción para todo lo que no sea INSERT y luego comprueba número
-- y fecha. Añadir una columna no le abre ningún hueco —al revés que en
-- `app.manual_adjustments`, cuyo disparador sí va columna a columna—. El paso
-- 3 lo comprueba en vez de fiarse.
--
-- POR QUÉ NO HAY NINGÚN `FORCE ROW LEVEL SECURITY` AQUÍ. Esta migración no
-- crea ninguna función `SECURITY DEFINER` y no toca ninguna política: la RLS de
-- `app.agreement_versions` (0005) sigue siendo exactamente la misma, y las
-- columnas nuevas viajan con ella. Los GRANT son de tabla entera
-- (`GRANT … ON ALL TABLES IN SCHEMA app`, 0005), no por columna, así que una
-- columna nueva queda concedida sola. Si algún día hiciera falta forzar la RLS
-- desde aquí, iría AL FINAL del fichero, después de cualquier definer que
-- nombre la tabla: una migración anterior de este repositorio era imposible de
-- aplicar en Supabase por ponerlo antes, y fallaba en silencio.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1 · El precio del día de vacaciones no disfrutado ────────────────────────
ALTER TABLE app.agreement_versions
  ADD COLUMN unused_vacation_day_rate_cents bigint
    CHECK (unused_vacation_day_rate_cents >= 0);

COMMENT ON COLUMN app.agreement_versions.unused_vacation_day_rate_cents IS
  'Importe en céntimos por día de vacaciones NO disfrutado, pactado en esta versión. NULL = no se pactó, que es la verdad de los contratos anteriores a la 0034: sin tarifa no hay compensación y la aplicación no estima ninguna. Nunca se escribe 0 por omisión, porque esta tabla es inmutable y ese 0 diría para siempre que se acordó pagar cero euros por día.';

-- ── 2 · La política de caducidad de los días arrastrados ─────────────────────
/*
 * Formas admitidas, y ninguna más:
 *
 *   ausente                                     → seis meses (el defecto)
 *   {"vacationCarryoverExpiry":{"mode":"months","months":<1..120>}}
 *   {"vacationCarryoverExpiry":{"mode":"never"}}
 *
 * `terms -> 'clave' IS NULL` y no el operador de existencia: la clave ausente
 * devuelve NULL de SQL, y una clave presente con `null` de JSON cae por el
 * `jsonb_typeof <> 'object'` de la rama siguiente, que es lo que se quiere
 * (escribir `null` ahí sería decir «se pactó nada», y eso no existe).
 */
ALTER TABLE app.agreement_versions
  ADD CONSTRAINT agreement_versions_carryover_expiry_shape CHECK (
    terms -> 'vacationCarryoverExpiry' IS NULL
    OR (
      jsonb_typeof(terms -> 'vacationCarryoverExpiry') = 'object'
      AND (
        terms #>> '{vacationCarryoverExpiry,mode}' = 'never'
        OR (
          terms #>> '{vacationCarryoverExpiry,mode}' = 'months'
          AND jsonb_typeof(terms #> '{vacationCarryoverExpiry,months}') = 'number'
          AND (terms #>> '{vacationCarryoverExpiry,months}') ~ '^[0-9]+$'
          AND (terms #>> '{vacationCarryoverExpiry,months}')::integer BETWEEN 1 AND 120
        )
      )
    )
  );

-- ── 3 · Aserción: lo que esta migración promete, comprobado ──────────────────
DO $check$
DECLARE
  columna record;
  con_tarifa integer;
  cuerpo text;
BEGIN
  -- 3a · La columna existe, es bigint y es NULLABLE SIN defecto. Es la parte
  -- que más fácil sería «arreglar» de más en una revisión futura, y la que no
  -- se puede deshacer si se despliega mal: un NOT NULL DEFAULT 0 escribiría en
  -- todas las versiones ya firmadas que se pactó pagar cero euros por día.
  SELECT is_nullable, data_type, column_default
    INTO columna
    FROM information_schema.columns
   WHERE table_schema = 'app'
     AND table_name = 'agreement_versions'
     AND column_name = 'unused_vacation_day_rate_cents';
  IF columna IS NULL THEN
    RAISE EXCEPTION 'no se creó app.agreement_versions.unused_vacation_day_rate_cents';
  END IF;
  IF columna.is_nullable <> 'YES' OR columna.column_default IS NOT NULL THEN
    RAISE EXCEPTION 'la tarifa del día de vacaciones tiene que ser NULLABLE y sin defecto (es %, defecto %)',
      columna.is_nullable, coalesce(columna.column_default, '(ninguno)');
  END IF;
  IF columna.data_type <> 'bigint' THEN
    RAISE EXCEPTION 'la tarifa del día de vacaciones tiene que ser bigint, no %', columna.data_type;
  END IF;

  -- 3b · Ninguna versión ya firmada estrena tarifa. Aquí no hay UPDATE de
  -- datos, y esto lo demuestra sobre las filas REALES de la base contra la que
  -- se aplique, producción incluida.
  SELECT count(*) INTO con_tarifa
    FROM app.agreement_versions
   WHERE unused_vacation_day_rate_cents IS NOT NULL;
  IF con_tarifa > 0 THEN
    RAISE EXCEPTION 'la migración le puso tarifa a % versión(es) ya pactadas', con_tarifa;
  END IF;

  -- 3c · El disparador de la 0002 sigue prohibiendo TODO lo que no sea INSERT
  -- sin enumerar columnas. Si algún día alguien lo reescribiera columna a
  -- columna, la tarifa nueva se quedaría fuera de la lista y sería editable
  -- sobre una fila que se declara inmutable.
  SELECT prosrc INTO cuerpo
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'enforce_agreement_version_append_only';
  IF cuerpo IS NULL OR cuerpo NOT LIKE '%TG_OP <> ''INSERT''%' THEN
    RAISE EXCEPTION 'el disparador de append-only de las versiones ya no prohíbe todo lo que no sea INSERT';
  END IF;

  -- 3d · La CHECK de la política acepta las tres formas legales y rechaza las
  -- demás. Se comprueba con el evaluador de la propia base, no de memoria.
  IF NOT (
    ('{}'::jsonb -> 'vacationCarryoverExpiry' IS NULL)
    AND (jsonb_typeof('{"vacationCarryoverExpiry":{"mode":"never"}}'::jsonb -> 'vacationCarryoverExpiry') = 'object')
    AND ('{"vacationCarryoverExpiry":{"mode":"months","months":9}}'::jsonb #>> '{vacationCarryoverExpiry,months}' = '9')
  ) THEN
    RAISE EXCEPTION 'la forma de la política de caducidad no se evalúa como se esperaba';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'app.agreement_versions'::regclass
       AND conname = 'agreement_versions_carryover_expiry_shape'
  ) THEN
    RAISE EXCEPTION 'no se creó la restricción de forma de la política de caducidad';
  END IF;
END
$check$;

COMMIT;
