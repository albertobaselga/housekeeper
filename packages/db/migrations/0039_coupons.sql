BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Módulo «Cupones» (docs/superpowers/specs/2026-10-03-modulo-cupones-design.md
-- §4). La cartera de cupones de la FAMILIA: una foto, unos pocos campos y el
-- registro de cada uso.
--
-- Tres decisiones del propietario se leen aquí, en la base, y no en la
-- interfaz:
--
--   1. SOLO LA FAMILIA (D-audiencia). `family_admin` y `family_member` leen y
--      escriben; la empleada, el apoyo y el acceso puntual ven CERO cupones,
--      cero usos y cero fotos. No es un filtro de la pantalla: es RLS.
--
--   2. DE TODA LA FAMILIA (D-reparto). Un cupón no tiene dueño: cualquiera de
--      los dos papeles edita, usa, anula usos, descarta y recupera los de
--      todos. Lo único personal es la FIRMA —quien guarda un cupón, quien lo
--      descarta, quien apunta un uso y quien lo anula lo hacen a su nombre—,
--      y la firma se comprueba en la base y no solo en el comando: en el
--      WITH CHECK y, donde hace falta ver la fila vieja (el descarte), en un
--      disparador.
--
--   3. REGISTRO, NO CONTROL (D-usos). La base no cuenta usos ni rechaza uno por
--      agotado, caducado o descartado: dos móviles sin red pueden gastar el
--      último uso a la vez, y lo que la casa quiere ver es que ocurrió. Por eso
--      NO hay disparador de invariante de usos ni bloqueo consultivo por cupón,
--      y nada se guarda en una columna que se pueda calcular: «disponible»,
--      «usado» y «caducado» salen en lectura de (max_uses, usos vivos,
--      expires_on, discarded_at) —packages/domain/src/coupons—.
--
-- SIN DELETE en ninguna de las dos tablas: un cupón se DESCARTA (y se puede
-- recuperar) y un uso se ANULA, como un completado de rutina (0031). No hay
-- GRANT de DELETE ni política que lo cubra: las dos rejas, no una.
--
-- LA FOTO NO PASA POR `app.documents`. Con `household` o `employment` la
-- empleada vería sus metadatos; con `private` el resto de la familia se
-- quedaría fuera. El cupón apunta directamente a su `storage_object` con una
-- FK compuesta (un cupón no puede citar la foto de otro hogar) y una política
-- permisiva nueva deja leer ese objeto a quien pueda leer el cupón. Qué objeto
-- se puede ENLAZAR —uno propio, vivo y de imagen— lo decide el comando
-- (spec §7.1) y, de respaldo, el disparador `coupons_photo_link`:
-- `family_admin` ve todos los objetos del hogar y, sin esa regla, podría
-- colgar de un cupón el justificante privado de otra persona. El respaldo
-- tiene un límite, explicado junto al disparador: la frontera real sigue
-- siendo el comando.
--
-- La auditoría copia la fila entera —código incluido— en `audit_events`, que
-- lee la administración. Es aceptable porque la administración ya es audiencia
-- del módulo (spec §9); no hay restrictiva como la de la 0037.
--
-- FORCE ROW LEVEL SECURITY va al FINAL del fichero (lección de la 0032): aquí
-- no hay ninguna función `SECURITY DEFINER` con `row_security = off`, pero la
-- regla de la casa se cumple igual, y el bloque $check$ del final lo comprueba.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Cupones ───────────────────────────────────────────────────────────────
CREATE TABLE app.coupons (
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  merchant text NOT NULL CHECK (length(btrim(merchant)) BETWEEN 1 AND 120),
  offer text NOT NULL CHECK (length(btrim(offer)) BETWEEN 1 AND 200),
  code text CHECK (code IS NULL OR length(btrim(code)) BETWEEN 1 AND 120),
  expires_on date,
  max_uses integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 999),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  photo_storage_object_id uuid NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  discarded_at timestamptz,
  discarded_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, photo_storage_object_id)
    REFERENCES app.storage_objects(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, discarded_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  -- Un descarte sin autor no se puede consultar, y un autor sin fecha es una
  -- fila que nadie sabe leer (mismo criterio que 0031).
  CONSTRAINT coupons_discard_is_complete
    CHECK ((discarded_at IS NULL) = (discarded_by_membership_id IS NULL))
);

ALTER TABLE app.coupons ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN app.coupons.id IS
  'Lo genera el cliente: el alta es idempotente por (household_id, id) aunque «Reintentar» cambie el operationId (spec §7.1).';
COMMENT ON COLUMN app.coupons.max_uses IS
  'Usos que admite el cupón: 1 = un solo uso; NULL = sin límite. Es INVENTARIO, no control: la base no rechaza un uso de más (D-usos).';
COMMENT ON COLUMN app.coupons.photo_storage_object_id IS
  'Foto del cupón, sin pasar por app.documents. La ve quien ve el cupón (storage_objects_read_coupon_photo); qué objeto se puede enlazar lo decide el comando.';
COMMENT ON COLUMN app.coupons.discarded_at IS
  'Descartado: deja de estorbar en la lista por defecto y se puede recuperar. NULL = en la cartera. Nunca se borra.';

/*
 * Lo que pregunta la lista: los cupones del hogar, separados por descartados y
 * ordenables por caducidad.
 */
CREATE INDEX coupons_household_idx
  ON app.coupons (household_id, discarded_at, expires_on);

CREATE TRIGGER coupons_touch_updated_at
BEFORE UPDATE ON app.coupons
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

/*
 * Un cupón no cambia de hogar, de identificador ni de AUTORÍA. La política de
 * UPDATE deja a cualquiera de la familia editar cualquier cupón (D-reparto), y
 * un WITH CHECK no ve la fila vieja: sin este cerrojo, editar serviría además
 * para cambiar quién lo guardó, que es lo que la ficha enseña y lo que el
 * WITH CHECK del alta protege. Mismo criterio que
 * `keep_routine_completion_identity` (0031).
 *
 * El DESCARTE es la otra firma del cupón, y aquí se cuida como la anulación de
 * un uso: va a nombre de quien descarta y, mientras dura, no se reescribe.
 * La política de UPDATE no puede exigirlo, porque un WITH CHECK no distingue
 * «descartar ahora» de «editar un cupón que ya descartó otra persona», y lo
 * segundo es normal (D-reparto). Recuperar no firma nada: el descarte deja de
 * estar, y quién lo recuperó lo cuenta `audit_events`.
 *
 *   · Un descarte vigente no se vuelve a fechar ni a firmar, tampoco sin
 *     contexto: para cambiarlo se recupera y se descarta otra vez. El comando
 *     descarta con `WHERE discarded_at IS NULL` y nunca llega a este caso.
 *   · Descartar exige la firma de quien escribe cuando hay contexto. Sin él
 *     escribe solo el propietario (siembras, guiones), que no tiene un «yo»
 *     con el que comparar.
 */
CREATE FUNCTION app.keep_coupon_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'un cupón no cambia de hogar, de identificador ni de quién lo guardó'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.discarded_at IS NOT NULL AND NEW.discarded_at IS NOT NULL
    AND (NEW.discarded_at IS DISTINCT FROM OLD.discarded_at
      OR NEW.discarded_by_membership_id IS DISTINCT FROM OLD.discarded_by_membership_id) THEN
    RAISE EXCEPTION 'un descarte no se reescribe: se recupera y se vuelve a descartar'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.discarded_at IS NULL AND NEW.discarded_at IS NOT NULL
    AND app.context_is_complete()
    AND NEW.discarded_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'un cupón se descarta a nombre de quien lo descarta'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER coupons_keep_identity
BEFORE UPDATE ON app.coupons
FOR EACH ROW EXECUTE FUNCTION app.keep_coupon_identity();

/*
 * La regla de enlace de la foto (spec §7.1), también aquí. El comando la
 * comprueba primero y responde `coupon_photo_invalid`; esto es el respaldo,
 * por el motivo de siempre en esta casa: una regla de quién-puede-qué que vive
 * solo en TypeScript se salta con la siguiente vía de escritura que alguien
 * añada (0031, 0038).
 *
 * Y aquí importa: `storage_objects_read` (0005) enseña a `family_admin`
 * TODOS los objetos del hogar —el tique de un gasto de la empleada, un
 * justificante privado—, y la política de la foto de más abajo abre a toda la
 * familia cualquier objeto que cite un cupón. Esta reja impide que enlazar
 * sea, sin más, la forma de publicar lo ajeno.
 *
 * Lo que NO cierra: mira la autoría que el objeto declara HOY, y
 * `storage_objects_write` (0005, FOR ALL) deja a `family_admin` reescribir el
 * `created_by_membership_id` de un objeto ajeno para quedárselo, y después
 * enlazarlo. Ninguna vía de la aplicación hace UPDATE de `app.storage_objects`,
 * así que la frontera real es la regla del comando (§7.1) y esto es un
 * respaldo, no una garantía. Cerrar esa reescritura es cosa de
 * `storage_objects` y de otra migración, no de esta.
 *
 * Se exige una imagen VIVA que haya subido QUIEN la enlaza. Solo cuando la
 * foto cambia: editar el texto de un cupón cuya foto subió otra persona es
 * normal (D-reparto). Es un disparador y no un WITH CHECK porque un WITH CHECK
 * no ve la fila vieja y no sabría si la foto ha cambiado.
 *
 * Sin contexto de hogar no se comprueba nada: así escribe el propietario
 * (siembras, guiones). `casa_clara_app` sin contexto también llega aquí en
 * un INSERT, porque los disparadores BEFORE ROW corren ANTES que el WITH CHECK
 * de la política: sale sin comprobar nada y la para después la política. Ese
 * mismo orden hace que, con contexto, quien cite una foto que no subió se
 * lleve el 42501 de aquí antes de que la política hable. Por eso la suite 210
 * prueba la política con una foto propia de cada papel y, entre hogares, con
 * esta regla apagada.
 *
 * SECURITY INVOKER a propósito: la consulta pasa por la RLS de
 * `storage_objects` de quien escribe, que siempre ve lo que él mismo subió.
 */
CREATE FUNCTION app.enforce_coupon_photo_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NOT app.context_is_complete() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.photo_storage_object_id IS NOT DISTINCT FROM OLD.photo_storage_object_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.storage_objects AS photo
     WHERE photo.household_id = NEW.household_id
       AND photo.id = NEW.photo_storage_object_id
       AND photo.created_by_membership_id = app.current_membership_id()
       AND photo.deleted_at IS NULL
       AND photo.media_type IN ('image/jpeg', 'image/png', 'image/webp')
  ) THEN
    RAISE EXCEPTION 'la foto de un cupón tiene que ser una imagen viva que haya subido quien la enlaza'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER coupons_photo_link
BEFORE INSERT OR UPDATE OF photo_storage_object_id ON app.coupons
FOR EACH ROW EXECUTE FUNCTION app.enforce_coupon_photo_link();

-- ── 2. Usos ──────────────────────────────────────────────────────────────────
/*
 * Un uso es un HECHO con fecha y autor: «Marta lo usó el martes». Se apunta,
 * se puede anular si fue un error de dedo, y no se borra nunca. Sin motivo de
 * anulación, por lo mismo que en la 0031: es un toque equivocado, no una
 * corrección contable.
 *
 * `used_on` es la fecha LOCAL del hecho (Europe/Madrid) y la pone el cliente:
 * un uso apuntado sin red a las 23:50 y enviado a las 00:10 ocurrió el día
 * anterior. `recorded_at` es cuándo llegó a la base.
 */
CREATE TABLE app.coupon_uses (
  household_id uuid NOT NULL,
  id uuid NOT NULL,
  coupon_id uuid NOT NULL,
  used_on date NOT NULL,
  used_by_membership_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  voided_at timestamptz,
  voided_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, coupon_id)
    REFERENCES app.coupons(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, used_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, voided_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT coupon_uses_void_is_complete
    CHECK ((voided_at IS NULL) = (voided_by_membership_id IS NULL))
);

ALTER TABLE app.coupon_uses ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN app.coupon_uses.id IS
  'Lo genera el cliente: apuntar un uso es idempotente por (household_id, id), y «Deshacer» anula exactamente ese uso.';
COMMENT ON COLUMN app.coupon_uses.used_on IS
  'Fecha local del uso (Europe/Madrid), puesta por el cliente. No es recorded_at.';
COMMENT ON COLUMN app.coupon_uses.voided_at IS
  'Instante en que se anuló el uso. NULL = cuenta. Un uso anulado no se borra ni se desanula: si de verdad se usó, se apunta otro.';

/*
 * Índice parcial sobre lo VIVO: el recuento «2 de 5 usados» y la lista de usos
 * de la ficha solo miran usos no anulados; los anulados se leen de uno en uno,
 * por su clave primaria.
 */
CREATE INDEX coupon_uses_live_idx
  ON app.coupon_uses (household_id, coupon_id)
  WHERE voided_at IS NULL;

/*
 * Anular es la ÚNICA escritura que admite un uso, y solo una vez. La política
 * de UPDATE de más abajo obliga a que la fila resultante esté anulada y
 * firmada por quien escribe, pero un WITH CHECK no ve la fila vieja: sin este
 * cerrojo, la misma sentencia que anula podría además mover el uso de fecha,
 * de cupón o de autor, y borrar así el rastro de lo que se apuntó (criterio de
 * `keep_routine_completion_identity`, 0031, y de los append-only de 0020 y
 * 0022). Y un uso ya anulado queda congelado también para el propietario.
 *
 * No es un disparador de invariante de usos (D-usos): no cuenta nada ni
 * rechaza ningún uso nuevo. Solo vigila UPDATE.
 */
CREATE FUNCTION app.keep_coupon_use_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'un uso anulado no se desanula ni se vuelve a firmar: si se usó, se apunta otro uso'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.coupon_id IS DISTINCT FROM OLD.coupon_id
    OR NEW.used_on IS DISTINCT FROM OLD.used_on
    OR NEW.used_by_membership_id IS DISTINCT FROM OLD.used_by_membership_id
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'anular un uso no reescribe lo que se apuntó'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER coupon_uses_keep_record
BEFORE UPDATE ON app.coupon_uses
FOR EACH ROW EXECUTE FUNCTION app.keep_coupon_use_record();

-- ── 3. RLS: la familia del hogar, y nadie más ───────────────────────────────
/*
 * Una política por verbo, y ninguna para DELETE. Una sola `FOR ALL` no serviría:
 * su WITH CHECK valdría también para UPDATE, y exigir ahí
 * `created_by = yo` impediría que una persona de la familia editase el cupón
 * que guardó otra (D-reparto); además cubriría DELETE, y la segunda reja de
 * «no se borra» dependería solo de no haber concedido el privilegio.
 */
CREATE POLICY coupons_family_read ON app.coupons
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.family_role());

-- Un cupón se guarda a nombre de quien lo guarda y nace EN LA CARTERA: si
-- pudiera nacer descartado, el alta serviría para firmar un descarte a nombre
-- de otra persona, que es lo que `coupons_keep_identity` impide al editar.
CREATE POLICY coupons_family_insert ON app.coupons
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.family_role()
    AND created_by_membership_id = app.current_membership_id()
    AND discarded_at IS NULL
  );

-- Editar, descartar y recuperar: cualquiera de la familia, sobre cualquier
-- cupón. La autoría del alta y la firma del descarte las cuida
-- `coupons_keep_identity`.
CREATE POLICY coupons_family_update ON app.coupons
  FOR UPDATE USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

/*
 * Los usos heredan la visibilidad del cupón con un EXISTS que pasa por la RLS
 * de `app.coupons` (patrón `routine_completions_read`, 0008). Se repite además
 * el hogar y el papel: si mañana alguien abriera la lectura de cupones a otro
 * papel, los usos no le seguirían sin que nadie lo decida.
 */
CREATE POLICY coupon_uses_family_read ON app.coupon_uses
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND app.family_role()
    AND EXISTS (
      SELECT 1 FROM app.coupons AS coupon
       WHERE coupon.household_id = coupon_uses.household_id
         AND coupon.id = coupon_uses.coupon_id
    )
  );

-- Un uso se apunta a nombre de quien lo apunta y nace VIVO: si pudiera nacer
-- anulado, el alta serviría para firmar una anulación a nombre de otra persona.
CREATE POLICY coupon_uses_family_insert ON app.coupon_uses
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.family_role()
    AND used_by_membership_id = app.current_membership_id()
    AND voided_at IS NULL
    AND EXISTS (
      SELECT 1 FROM app.coupons AS coupon
       WHERE coupon.household_id = coupon_uses.household_id
         AND coupon.id = coupon_uses.coupon_id
    )
  );

/*
 * Anular. De las dos ramas de `routine_completions_void` (0031) aquí solo hace
 * falta una: allí revivir una ocurrencia anulada era necesario porque la clave
 * primaria es la ocurrencia; aquí volver a usar un cupón es OTRO uso, con otro
 * id, y una rama de «revivir» solo serviría para desanular.
 *
 *   · USING: solo usos VIVOS. Uno anulado no es candidato: desanularlo o
 *     volver a firmarlo no encuentra fila, que es como se ve desde fuera.
 *   · WITH CHECK: la fila queda anulada y firmada por quien anula. Cualquiera
 *     de la familia anula cualquier uso (D-reparto), pero a su nombre.
 *
 * Que la misma sentencia no cambie además la fecha, el cupón o el autor del
 * uso lo impide `coupon_uses_keep_record`.
 */
CREATE POLICY coupon_uses_family_void ON app.coupon_uses
  FOR UPDATE USING (
    app.tenant_context_matches(household_id)
    AND app.family_role()
    AND voided_at IS NULL
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.family_role()
    AND voided_at IS NOT NULL
    AND voided_by_membership_id = app.current_membership_id()
    AND EXISTS (
      SELECT 1 FROM app.coupons AS coupon
       WHERE coupon.household_id = coupon_uses.household_id
         AND coupon.id = coupon_uses.coupon_id
    )
  );

/*
 * La foto. `storage_objects_read` (0005) solo enseña un objeto a quien lo
 * subió, a `family_admin` o a quien vea un documento que lo cite; sin esto, la
 * familia no administradora no vería la foto de un cupón que guardó otra
 * persona. Esta política SUMA (las permisivas se combinan con OR) una vía más,
 * y nada más: el objeto tiene que estar citado por un cupón del hogar, y como
 * el EXISTS pasa por la RLS de `app.coupons`, solo lo cumple la familia. La
 * empleada, el apoyo y el acceso puntual siguen sin ver ni los metadatos.
 *
 * `TO casa_clara_app` por la lección de la 0037: el cuerpo lee `app.coupons`,
 * y una política de PUBLIC se evaluaría también para cualquier otro rol que
 * algún día lea `storage_objects` sin privilegio sobre los cupones —y le
 * rompería TODAS sus lecturas con «permission denied for table coupons»—.
 * La web entra con `casa_clara_app_login`, miembro de `casa_clara_app`.
 *
 * Ni `storage_objects_read` ni `documents_read` se tocan.
 */
CREATE POLICY storage_objects_read_coupon_photo ON app.storage_objects
  FOR SELECT TO casa_clara_app USING (
    app.tenant_context_matches(household_id)
    AND EXISTS (
      SELECT 1 FROM app.coupons AS coupon
       WHERE coupon.household_id = storage_objects.household_id
         AND coupon.photo_storage_object_id = storage_objects.id
    )
  );

-- ── 4. Grants y auditoría ────────────────────────────────────────────────────
-- Explícitos: no hay privilegios por defecto y el GRANT ON ALL TABLES de la
-- 0005 solo alcanzó a las tablas de entonces. Sin DELETE. Nada para
-- `casa_clara_worker`: no hay avisos push de cupones (el aviso es un asunto de
-- Hoy que calcula la web).
GRANT SELECT, INSERT, UPDATE ON app.coupons, app.coupon_uses TO casa_clara_app;

DO $audit_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['coupons', 'coupon_uses'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON app.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event()',
      table_name, table_name
    );
  END LOOP;
END
$audit_triggers$;

-- ── 5. FORCE, al final ───────────────────────────────────────────────────────
ALTER TABLE app.coupons FORCE ROW LEVEL SECURITY;
ALTER TABLE app.coupon_uses FORCE ROW LEVEL SECURITY;

-- ── Aserción: lo que esta migración promete, comprobado sobre el catálogo ────
DO $check$
DECLARE
  coupon_table text;
BEGIN
  FOREACH coupon_table IN ARRAY ARRAY['coupons', 'coupon_uses'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = to_regclass('app.' || coupon_table)
         AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'app.% tiene que salir de aquí con RLS activada y forzada', coupon_table;
    END IF;
    -- Sin política que cubra DELETE, y sin el privilegio.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'app' AND tablename = coupon_table AND cmd IN ('DELETE', 'ALL')
    ) THEN
      RAISE EXCEPTION 'app.% tiene una política que cubre DELETE', coupon_table;
    END IF;
    IF has_table_privilege('casa_clara_app', 'app.' || coupon_table, 'DELETE')
       OR has_table_privilege('casa_clara_worker', 'app.' || coupon_table, 'SELECT') THEN
      RAISE EXCEPTION 'privilegios de más sobre app.%', coupon_table;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
       WHERE schemaname = 'app'
         AND (tablename, policyname, cmd) IN (
           ('coupons', 'coupons_family_read', 'SELECT'),
           ('coupons', 'coupons_family_insert', 'INSERT'),
           ('coupons', 'coupons_family_update', 'UPDATE'),
           ('coupon_uses', 'coupon_uses_family_read', 'SELECT'),
           ('coupon_uses', 'coupon_uses_family_insert', 'INSERT'),
           ('coupon_uses', 'coupon_uses_family_void', 'UPDATE')
         )) <> 6 THEN
    RAISE EXCEPTION 'faltan políticas de cupones o de usos';
  END IF;

  -- Las firmas: que existan las políticas no basta si su WITH CHECK no firma.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupons' AND policyname = 'coupons_family_insert'
       AND with_check LIKE '%created_by_membership_id = %current_membership_id()%'
       AND with_check LIKE '%discarded_at IS NULL%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupon_uses' AND policyname = 'coupon_uses_family_insert'
       AND with_check LIKE '%used_by_membership_id = %current_membership_id()%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'coupon_uses' AND policyname = 'coupon_uses_family_void'
       AND with_check LIKE '%voided_by_membership_id = %current_membership_id()%'
  ) THEN
    RAISE EXCEPTION 'alguna escritura de cupones no exige la firma de quien escribe, o un cupón puede nacer descartado';
  END IF;

  -- La de la foto, PERMISIVA (suma una vía; una restrictiva taparía las demás
  -- fotos y justificantes) y solo de lectura.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'storage_objects'
       AND policyname = 'storage_objects_read_coupon_photo'
       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'
       AND qual LIKE '%photo_storage_object_id = storage_objects.id%'
  ) THEN
    RAISE EXCEPTION 'falta la política permisiva de lectura de la foto del cupón';
  END IF;

  -- Y lo que esa política abre está acotado por la regla de enlace, al dar de
  -- alta (bit 4) y al cambiar la foto (bit 16).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.coupons') AND tgname = 'coupons_photo_link'
       AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0
  ) THEN
    RAISE EXCEPTION 'falta la regla de enlace de la foto en la base';
  END IF;
END
$check$;

COMMIT;
