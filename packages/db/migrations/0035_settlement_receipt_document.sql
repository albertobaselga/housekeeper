BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- El recibo PDF, registrado y descargable.
--
-- El worker ya renderizaba el recibo determinista y lo subía al almacén
-- privado (`document.render_receipt`, `apps/worker/src/handlers.ts`), pero no
-- quedaba ni rastro en la base: ni un documento, ni una fila que dijera «este
-- objeto es EL recibo de esta liquidación». Sin eso no hay manera honesta de
-- ofrecer una descarga —¿cuál de los objetos del bucket es el bueno?— y cada
-- re-render (p. ej. un backfill histórico) habría creado un documento suelto
-- más, sin relación con los anteriores.
--
-- Esta migración añade la tabla que falta y la única puerta para escribirla:
--
--   1. `app.settlement_receipts` — una fila por liquidación, apuntando al
--      documento y al objeto de almacenamiento. Append-only: sin UPDATE ni
--      DELETE para la aplicación, igual que `app.command_receipts`.
--   2. `app_private.record_settlement_receipt(...)` — SECURITY DEFINER, GRANT
--      solo `casa_clara_worker`: hace el upsert de `app.storage_objects`,
--      inserta `app.documents` (visibilidad `employment`, dueña la propia
--      empleada del contrato) y la fila de `app.settlement_receipts`, las tres
--      cosas en una sola llamada e idempotente.
--
-- `app.settlements` NO se toca: una liquidación cerrada es inmutable por su
-- propio disparador (`enforce_settlement_transition`, 0003) y esa regla está
-- bien como está — el recibo es un documento COLGADO de la liquidación, no un
-- campo suyo.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Una fila por liquidación ──────────────────────────────────────────────
CREATE TABLE app.settlement_receipts (
  -- Una liquidación tiene, como mucho, UN recibo registrado: el PDF es
  -- determinista, así que un re-render del mismo contenido no crea una
  -- segunda fila (lo impide `record_settlement_receipt`, no esta PK).
  settlement_id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  bucket text NOT NULL CHECK (length(btrim(bucket)) > 0),
  object_key text NOT NULL CHECK (length(btrim(object_key)) > 0 AND object_key !~ '(^|/)\.\.(/|$)'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  rendered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (household_id, settlement_id)
    REFERENCES app.settlements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, document_id)
    REFERENCES app.documents(household_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE app.settlement_receipts IS
  'El recibo PDF registrado de una liquidación cerrada: qué documento y qué '
  'objeto de almacenamiento son EL recibo. Append-only, escrita únicamente por '
  'app_private.record_settlement_receipt (SECURITY DEFINER). Ver esa función.';

ALTER TABLE app.settlement_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.settlement_receipts FORCE ROW LEVEL SECURITY;

-- Mismo criterio que `settlements_read`/`settlement_lines_read` (0005): el
-- EXISTS sobre `app.settlements` hereda su propia RLS (`employee_row_visible`
-- con `include_family_member = false`), así que quien ve el recibo es
-- exactamente quien ve la liquidación — family_admin del hogar, y la
-- membresía `employee_membership_id` de ESA liquidación y ninguna otra.
-- family_member, helper y viewer no entran, igual que no entran en la propia
-- liquidación.
CREATE POLICY settlement_receipts_read ON app.settlement_receipts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.settlements AS settlement
       WHERE settlement.household_id = settlement_receipts.household_id
         AND settlement.id = settlement_receipts.settlement_id
    )
  );

-- SOLO SELECT para la aplicación: sin INSERT/UPDATE/DELETE. La única vía de
-- escritura es la función definer de abajo, con GRANT solo para el worker —
-- igual que `app.push_subscriptions` (0032) no da acceso directo al emisor.
GRANT SELECT ON app.settlement_receipts TO casa_clara_app;


-- ── 2. La única puerta de escritura ──────────────────────────────────────────
--
-- Firma mínima a propósito: `settlement` es lo único que hace falta para
-- resolver el hogar, la empleada y el mes — todo eso vive ya en
-- `app.settlements` y esta función corre con `row_security = off`, así que
-- puede leerlo sin que la RLS del worker (que no tiene ninguna) se lo impida.
CREATE FUNCTION app_private.record_settlement_receipt(
  settlement uuid,
  target_bucket text,
  key text,
  content_sha256 text,
  size bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  target app.settlements%ROWTYPE;
  existing_document_id uuid;
  new_storage_object_id uuid;
  new_document_id uuid;
BEGIN
  -- Idempotente: el PDF es determinista, así que re-renderizar el recibo de
  -- una liquidación que YA tiene fila no debe crear un segundo documento. Se
  -- comprueba y se sale ANTES de escribir nada más. Sin ambigüedad que
  -- calificar: ninguna de las dos tablas de abajo tiene una columna llamada
  -- `settlement` (la de settlement_receipts es `settlement_id`).
  SELECT document_id INTO existing_document_id
    FROM app.settlement_receipts
   WHERE settlement_id = settlement;
  IF FOUND THEN
    RETURN existing_document_id;
  END IF;

  SELECT * INTO target FROM app.settlements WHERE id = settlement;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'la liquidación % no existe', settlement USING ERRCODE = '22023';
  END IF;
  IF target.status <> 'closed' THEN
    RAISE EXCEPTION 'solo se registra el recibo de una liquidación cerrada' USING ERRCODE = '55000';
  END IF;

  -- `ON CONFLICT (bucket, object_key)` y no un INSERT liso: por esta línea NO
  -- se llega dos veces para la MISMA liquidación —el `IF FOUND` de más arriba
  -- ya sale antes— así que lo que este `ON CONFLICT` cubre es un
  -- `storage_object` que YA EXISTÍA para otra razón con esa clave exacta: el
  -- caso real es el backfill histórico (re-encolar `document.render_receipt`
  -- de liquidaciones cerradas antes de este frente, ver
  -- docs/runbooks/planificador-cola.md), y SOLO si su `generatedAt` reproduce
  -- el mismo hash que el render original. La reutilización no está
  -- garantizada: el render original en línea usa el instante real del cierre
  -- como `generatedAt` (`new Date().toISOString()` en
  -- `packages/server/src/commands/settlement.ts`), y el backfill usa
  -- `closed_at` (estable, pero no necesariamente idéntico byte a byte). Lo
  -- normal es que la clave del backfill NO coincida con la del render
  -- original: entonces este INSERT es liso (nada que reutilizar) y el objeto
  -- del render original queda huérfano en el bucket — inocuo, no un fallo.
  INSERT INTO app.storage_objects (
    household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
  ) VALUES (
    target.household_id, target_bucket, key, 'application/pdf', size, content_sha256,
    target.closed_by_membership_id
  )
  ON CONFLICT (bucket, object_key) DO UPDATE SET bucket = EXCLUDED.bucket
  RETURNING id INTO new_storage_object_id;

  INSERT INTO app.documents (
    household_id, storage_object_id, owner_membership_id, visibility, document_type, title,
    created_by_membership_id
  ) VALUES (
    target.household_id, new_storage_object_id, target.employee_membership_id, 'employment',
    'settlement_receipt', 'Recibo ' || to_char(target.period_start, 'YYYY-MM'),
    target.closed_by_membership_id
  )
  RETURNING id INTO new_document_id;

  INSERT INTO app.settlement_receipts (
    settlement_id, household_id, document_id, bucket, object_key, sha256, byte_size
  ) VALUES (
    settlement, target.household_id, new_document_id, target_bucket, key, content_sha256, size
  )
  -- Cinturón y tirantes: entre el SELECT de arriba y este INSERT, dos llamadas
  -- concurrentes para la MISMA liquidación podrían colarse las dos. Con la PK
  -- ya puesta, la segunda no rompe el trabajo.
  ON CONFLICT (settlement_id) DO NOTHING;

  IF NOT FOUND THEN
    -- Carrera perdida: otra llamada ganó primero. Se devuelve SU documento —el
    -- que acabamos de crear aquí queda huérfano, sin nadie que lo referencie y
    -- sin UPDATE/DELETE para la app que pueda tocarlo—.
    SELECT document_id INTO new_document_id
      FROM app.settlement_receipts
     WHERE settlement_id = settlement;
  END IF;

  RETURN new_document_id;
END
$$;

COMMENT ON FUNCTION app_private.record_settlement_receipt(uuid, text, text, text, bigint) IS
  'Registra el recibo PDF ya subido: upsert de app.storage_objects, inserta '
  'app.documents (visibility employment, dueña la empleada del contrato) y '
  'app.settlement_receipts. Idempotente por settlement_id. GRANT solo worker.';

REVOKE ALL ON FUNCTION app_private.record_settlement_receipt(uuid, text, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_settlement_receipt(uuid, text, text, text, bigint)
  TO casa_clara_worker;

COMMIT;
