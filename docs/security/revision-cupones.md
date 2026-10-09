# Revisión de seguridad del módulo Cupones

Fecha: 2026-10-09 · Base de la revisión: commit `914ac6c` de la rama
`feat/cupones` (migración `0039_coupons.sql`, servidor e interfaz). Complementa
a [security-baseline.md](security-baseline.md); el diseño está en la spec del
módulo (`docs/superpowers/specs/2026-10-03-modulo-cupones-design.md`, §4, §7 y
§9), y el formato es el de [revision-finanzas.md](revision-finanzas.md).

Todos los controles de esta página se **ejecutaron** el día de la fecha y la
columna «Resultado» recoge la salida real, no una expectativa. Las órdenes se
lanzan desde la raíz del repositorio, con Node 24 en el `PATH` y —las de base
de datos— contra un Postgres 18.4 **desechable** (contenedor
`hk-cupones-pg-5441`, `postgresql://<usuario>:<clave>@127.0.0.1:5441/hk_sec`),
migrado de cero por el propio runner de las suites: 39 migraciones, la última
`0039_coupons.sql`. Todos los datos son sintéticos y cada sonda escribe dentro
de una transacción que se **revierte**.

Mientras se ejecutaba, otra tarea tenía en curso cambios sin confirmar en tres
ficheros de interfaz (`cupones/+page.svelte`, `coupons/wallet.svelte.ts` y
`e2e/cupones.dbe2e.ts`). Ninguno toca la base, el servidor, la ruta de la foto,
la subida ni los registros, que es lo que aquí se mide.

## Controles verificados

| # | Control | Cómo se verifica | Resultado |
|---|---|---|---|
| 1 | Suites SQL: la matriz de cupones (`210_coupons.sql`) y las de siempre | `pnpm test:rls` y `pnpm test:db` con `TEST_DATABASE_URL` en `hk_sec` | **Verde.** `test:rls`: `# tests 3 passed, 0 failed of 3` (`020_rls_matrix.sql`, `030_finance_rls.sql`, `210_coupons.sql`). `test:db`: `# tests 22 passed, 0 failed of 22`. Código de salida 0 en los dos. |
| 2 | `coupons`, `coupon_uses` y `storage_objects` con RLS **activada y forzada** | consulta sobre `pg_class` (abajo) | **Verde.** Las tres, y también `documents` y `audit_events`, con `rls = t` y `force = t`. |
| 3 | Seis políticas, todas con el hogar del contexto y el papel de familia; ninguna cubre DELETE; privilegios justos | `pg_policies` + veredicto negativo + `information_schema.role_table_grants` | **Verde.** Tres políticas por tabla (leer, crear, cambiar). El veredicto «políticas de cupones o usos sin `tenant_context_matches` o sin `family_role()`, o con `cmd` DELETE/ALL» devuelve **0 filas**. `casa_clara_app`: `INSERT,SELECT,UPDATE` en las dos tablas; `casa_clara_worker` y `PUBLIC`: nada. |
| 4 | La foto: `storage_objects_read_coupon_photo` es permisiva, de solo lectura, `TO casa_clara_app`, y tiene índice | `pg_policies` de `storage_objects` + `pg_indexes` | **Verde.** `PERMISSIVE`, `{casa_clara_app}`, `SELECT`, `USING (tenant_context_matches(household_id) AND EXISTS (… coupon.photo_storage_object_id = storage_objects.id))`. `storage_objects_read` y `storage_objects_write` (0005) siguen intactas. `coupons_photo_idx ON app.coupons (household_id, photo_storage_object_id)` existe. |
| 5 | Lo que ve **cada papel**: cupones, usos, objetos de foto, nombres y auditoría | `SET ROLE casa_clara_app` + `app.set_household_context(…)`, el mismo contexto que usan las suites (tabla abajo) | **Verde.** La familia del roble ve 2 cupones, 2 usos y 2 fotos. La empleada, la segunda empleada, el apoyo y el acceso puntual: **0 / 0 / 0**, cero nombres y cero eventos de cupones. Sin contexto: todo a 0. El olivo no ve nada del roble. |
| 6 | Una membresía de familia caducada no abre contexto | `app.set_household_context` con una membresía que expiró ayer | **Verde.** `ERROR: active membership not found for authenticated identity`. La suite 210 lo comprueba además contra cupones, usos, fotos, nombres y alta. |
| 7 | `app.coupon_people()` no se puede usar fuera de la familia | `pg_proc` + la columna «nombres» de la matriz | **Verde.** `plpgsql`, `SECURITY DEFINER`, `proconfig = {search_path=pg_catalog, app, row_security=off}`; `EXECUTE`: `public = f`, `casa_clara_app = t`, `casa_clara_worker = f`. Devuelve 0 filas a la empleada, al apoyo, al acceso puntual y sin contexto. |
| 8 | Ruta de la foto: 404 opaco, `nosniff`, CSP `sandbox`, `no-store`, nombre sin datos del cupón | `vitest run tests/coupon-photo-route.test.ts tests/coupon-photo.integration.test.ts` | **Verde.** 12 + 6 pruebas. La ruta da **el mismo 404** («Ese cupón no tiene foto que enseñar») a quien no es del hogar, a un papel sin `coupon.access` (sin llegar a la base), a un id que no es uuid y a un cupón que no existe o no se ve. Cabeceras comprobadas: `content-type` de la lista blanca (cualquier otro tipo, `application/octet-stream`), `x-content-type-options: nosniff`, `content-security-policy` con `default-src 'none'` y `sandbox`, `cache-control` con `no-store`, `cross-origin-resource-policy: same-origin` y `content-disposition: inline; filename="cupon-<id>.jpg"`. Contra Postgres: la empleada, el apoyo y el acceso puntual reciben `null` (→ 404). |
| 9 | La página de la cartera no se guarda en el dispositivo | `vitest run tests/coupons-page-load.test.ts` | **Verde.** 3 pruebas: `private, no-store` con datos, con el 503 y en la demostración. |
| 10 | Los registros no llevan comercio, código, oferta ni notas | `grep` de toda llamada de registro en el código que toca el módulo (abajo) | **Verde.** Cinco llamadas en 26 ficheros, todas `log.error('<ámbito> unavailable', { code: errorCode(cause) })`. Cero `console.*`. La bandeja (`ackForError`, `packages/server/src/sync.ts:60-81`) solo devuelve códigos y `command_receipts` solo guarda `payload_hash`. |
| 11 | EXIF y GPS fuera de la foto (`alwaysReencode`) | `vitest run tests/attachment-prepare.test.ts` | **Verde.** 11 pruebas, 8 de ellas de `alwaysReencode`: «una foto pequeña también se reencoda: el EXIF y el GPS no viajan», «el nombre tampoco lleva la fecha y la hora de la cámara», «si el navegador no sabe abrir la foto, falla cerrado: el original no sale» y «lo que no es una imagen no se acepta como foto», entre otras. |
| 12 | El 409 de la subida no filtra lo ajeno | `vitest run` de `attachment-route`, `attachment-upload`, `attachment-pipeline` y `attachments.integration` | **Verde.** 2 + 9 + 12 + 19 pruebas. El 409 lleva solo `attachment_duplicate` y «Ese fichero ya lo subió alguien de la casa»: ni id del objeto, ni quién, ni cuándo, y no se sube nada. Con lo propio, 201 idempotente. La clave del objeto empieza por el hogar (`attachmentObjectKey`, `attachments.server.ts:135-137`), así que solo choca dentro de la misma casa. |
| 13 | La auditoría copia el código y la lee `family_admin` (riesgo aceptado, spec §9) | columnas «auditoría» de la matriz + lectura de `after_data` | **Comprobado, aceptado.** `family_admin` lee los 4 eventos de cupones del hogar, con `after_data->>'code'` (`FRUTA10`, `DROG2X1`) y las notas. `family_member` solo los 2 que firmó él. Empleada, apoyo y acceso puntual: 0. |
| 14 | Regla de enlace de la foto en el comando, y papel antes que nada | `vitest run src/coupons.integration.test.ts` (paquete `server`) | **Verde.** 25 pruebas. Entre ellas: «una foto que subió OTRA persona no se enlaza, ni siquiera siendo administración», «una foto de otro hogar no se enlaza», «un PDF propio no es la foto de un cupón» y «la empleada, el apoyo y el acceso puntual no escriben nada de cupones». |
| 15 | Sin entrada de navegación ni asunto de Hoy fuera de la familia | `vitest run` de `routing`, `today-decisions`, `coupons-seams` y las de capacidades | **Verde.** 56 pruebas; entre ellas «cupones es de la familia: una sola llave y ninguna ruta hija» y «la empleada, el apoyo y el acceso puntual no lo reciben nunca» (el asunto `cupones-caducan`). |

### La matriz por papel (control 5) y su salida

Siembra sintética dentro de una transacción revertida: en el roble, la
administración guarda un cupón de un solo uso con código `FRUTA10` y una
nota, y la familia uno con `DROG2X1`, cada uno con su foto y un uso; una
tercera foto de la administración no la cita ningún cupón. En el olivo, un
cupón con su foto. Las dos altas del roble se escriben por la vía real
(`casa_clara_app` y contexto), para que la auditoría tenga autor. Después, para
cada papel, lo mismo que hacen las suites:

```sql
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context('10000000-0000-4000-8000-000000000001',
                                 '11000000-0000-4000-8000-000000000003');
SELECT (SELECT count(*) FROM app.coupons)          AS cupones,
       (SELECT count(*) FROM app.coupon_uses)      AS usos,
       (SELECT count(*) FROM app.storage_objects
         WHERE id IN (<las tres fotos citadas por cupones>)) AS fotos_cupon,
       (SELECT count(*) FROM app.storage_objects)  AS objetos_total,
       (SELECT count(*) FROM app.coupon_people())  AS nombres,
       (SELECT count(*) FROM app.audit_events
         WHERE entity_table IN ('coupons', 'coupon_uses')) AS auditoria;
```

| Quién | cupones | usos | fotos de cupón | objetos (todos) | nombres | auditoría de cupones | …con código |
|---|---|---|---|---|---|---|---|
| sin contexto (con identidad de la familia) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `family_admin` (roble) | 2 | 2 | 2 | 4 | 2 | 4 | 2 |
| `family_member` (roble) | 2 | 2 | 2 | 3 | 2 | 2 | 1 |
| empleada (roble) | **0** | **0** | **0** | 1 | **0** | **0** | 0 |
| segunda empleada (roble) | **0** | **0** | **0** | 1 | **0** | **0** | 0 |
| apoyo (`helper`, roble) | **0** | **0** | **0** | 0 | **0** | **0** | 0 |
| acceso puntual (`viewer`, roble) | **0** | **0** | **0** | 0 | **0** | **0** | 0 |
| `family_admin` (olivo) | 1 | 0 | 1 | 1 | 1 | 1 | 1 |
| empleada (olivo) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Cómo leer las columnas que no son cero fuera de la familia:

- **El objeto que ven las dos empleadas** es el justificante de la fixture
  (`fixture/casa-roble/receipt.txt`), citado por un documento de visibilidad
  `employment`. No es de cupones.
- **`family_member` ve 3 objetos**: las dos fotos de cupón (una la subió la
  administración y la ve solo por `storage_objects_read_coupon_photo`) y ese
  mismo justificante. **No ve** la tercera foto de la administración, la que no
  cita ningún cupón: la política nueva no abre cualquier objeto, solo el que
  cita un cupón. `family_admin` la ve por `storage_objects_read` (0005), como
  siempre.

```
     quien     |                  id                  |       created_by_membership_id
---------------+--------------------------------------+--------------------------------------
 family_member | aa100000-0000-4000-8000-000000000001 | 11000000-0000-4000-8000-000000000001
 family_member | aa100000-0000-4000-8000-000000000002 | 11000000-0000-4000-8000-000000000002
(2 rows)
```

### Las consultas de catálogo (controles 2 a 4) y su salida

```sql
SELECT c.relname AS tabla, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'app' AND c.relkind = 'r'
   AND c.relname IN ('coupons', 'coupon_uses', 'storage_objects', 'documents', 'audit_events')
 ORDER BY c.relname;
```

```
      tabla      | rls | force
-----------------+-----+-------
 audit_events    | t   | t
 coupon_uses     | t   | t
 coupons         | t   | t
 documents       | t   | t
 storage_objects | t   | t
(5 rows)
```

Las seis políticas del módulo (`with_check`/`qual` abreviados donde se repite
el `EXISTS` sobre `app.coupons`):

```
  tablename  |        policyname         |  cmd   | USING                                                         | WITH CHECK
-------------+---------------------------+--------+---------------------------------------------------------------+------------------------------------------------------------------------------------------------
 coupon_uses | coupon_uses_family_insert | INSERT | (sin USING)                                                   | tenant_context_matches(household_id) AND family_role() AND used_by_membership_id = current_membership_id() AND voided_at IS NULL AND EXISTS (… app.coupons …)
 coupon_uses | coupon_uses_family_read   | SELECT | tenant_context_matches(household_id) AND family_role() AND EXISTS (… app.coupons …) | (sin WITH CHECK)
 coupon_uses | coupon_uses_family_void   | UPDATE | tenant_context_matches(household_id) AND family_role() AND voided_at IS NULL | tenant_context_matches(household_id) AND family_role() AND voided_at IS NOT NULL AND voided_by_membership_id = current_membership_id() AND EXISTS (… app.coupons …)
 coupons     | coupons_family_insert     | INSERT | (sin USING)                                                   | tenant_context_matches(household_id) AND family_role() AND created_by_membership_id = current_membership_id() AND discarded_at IS NULL
 coupons     | coupons_family_read       | SELECT | tenant_context_matches(household_id) AND family_role()        | (sin WITH CHECK)
 coupons     | coupons_family_update     | UPDATE | tenant_context_matches(household_id) AND family_role()        | tenant_context_matches(household_id) AND family_role()
(6 rows)
```

Todas son `PERMISSIVE` y de `{public}`: `app.family_role()` es
`current_household_role() IN ('family_admin', 'family_member')`
(`0008_food_and_rhythm.sql:289-295`). El veredicto negativo, que es el que
manda:

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'app' AND tablename IN ('coupons', 'coupon_uses')
   AND (cmd IN ('DELETE', 'ALL')
        OR NOT (coalesce(qual, with_check) LIKE '%tenant_context_matches(household_id)%'
                AND coalesce(qual, with_check) LIKE '%family_role()%'));
```

```
 tablename | policyname | cmd
-----------+------------+-----
(0 rows)
```

Las tres de `storage_objects`:

```
            policyname             | permissive |      roles       |  cmd   | USING (abreviado)                                                                                         | WITH CHECK
-----------------------------------+------------+------------------+--------+-----------------------------------------------------------------------------------------------------------+------------------------------------------------------------------
 storage_objects_read              | PERMISSIVE | {public}         | SELECT | tenant_context_matches(household_id) AND (created_by = yo OR family_admin OR EXISTS (… app.documents …))  | (sin WITH CHECK)
 storage_objects_read_coupon_photo | PERMISSIVE | {casa_clara_app} | SELECT | tenant_context_matches(household_id) AND EXISTS (SELECT 1 FROM app.coupons coupon WHERE coupon.household_id = storage_objects.household_id AND coupon.photo_storage_object_id = storage_objects.id) | (sin WITH CHECK)
 storage_objects_write             | PERMISSIVE | {public}         | ALL    | tenant_context_matches(household_id) AND (created_by = yo OR family_admin)                                | tenant_context_matches(household_id) AND created_by = yo
(3 rows)
```

```
       indexname       |                                    indexdef
-----------------------+--------------------------------------------------------------------------------
 coupon_uses_live_idx  | CREATE INDEX … ON app.coupon_uses USING btree (household_id, coupon_id) WHERE (voided_at IS NULL)
 coupons_household_idx | CREATE INDEX … ON app.coupons USING btree (household_id, discarded_at, expires_on)
 coupons_photo_idx     | CREATE INDEX … ON app.coupons USING btree (household_id, photo_storage_object_id)
```

Disparadores de `app.coupons`: `coupons_audit`, `coupons_keep_identity`,
`coupons_photo_link`, `coupons_touch_updated_at`; de `app.coupon_uses`:
`coupon_uses_audit`, `coupon_uses_keep_record`. Roles: `casa_clara_app` y
`casa_clara_worker` con `rolbypassrls = f` y `rolsuper = f`.
`casa_clara_app_login` no existe en este clúster porque lo crea
`packages/db/scripts/sql/bootstrap.sql`, no una migración; la web entra con él
y hereda de `casa_clara_app`.

### Los registros (control 10), con su salida

Los 26 ficheros `.ts`/`.svelte` que toca el módulo en servidor y cliente
(`coupons.server.ts`, `coupon-photo.server.ts`, `today.server.ts`,
`attachments.server.ts`, `commands/coupon.ts`, la ruta de sync, la de la foto,
la de adjuntos, la página `cupones`, `lib/coupons`, `components/coupons`,
`PhotoPicker.svelte` y `lib/attachments`), comprobados antes con `test -e`:

```
attachments.server.ts:208:   log.error('antivirus unavailable', { code: errorCode(cause) });
attachments.server.ts:274:   log.error('object store unavailable', { code: errorCode(cause) });
coupons.server.ts:204         → unreadable(log, 'coupons', cause)
coupon-photo.server.ts:62     → unreadable(log, 'coupon photo', cause)
today.server.ts:1377          → unreadable(log, 'today overview', cause)
```

`unreadable` (`data-source.server.ts:84-91`) registra
`log.error(\`${scope} unavailable\`, { code: errorCode(cause) })`, y
`errorCode` (`packages/server/src/logging.ts:94-103`) devuelve el código del
error si tiene ≤ 64 caracteres y no parece un correo, o el nombre del error:
**nunca** el mensaje ni el `detail` de Postgres, que es donde un `CHECK` roto
copiaría la fila con su código. El cargador de la foto ni siquiera lee
comercio, oferta, código ni notas (`CouponPhoto` solo tiene bucket, clave, tipo
y tamaño).

## Deuda previa: dos agujeros de la 0005 que la 0039 no corrige

Los dos son **anteriores a la 0039** y viven en las políticas de
`storage_objects` y `documents` de `0005_rls.sql`. Esta revisión no los cierra:
son de otra migración, con su propia suite, porque tocan a todos los adjuntos
de la casa y no solo a los cupones. Se documentan aquí porque la 0039 les da un
objetivo nuevo —la foto de un cupón, que lleva un código que vale dinero— y
porque la reproducción se hizo en esta revisión.

**Ninguno se alcanza desde la aplicación.** Los dos piden escribir SQL como
`casa_clara_app` con un contexto de hogar válido, y la única vía de escritura de
la web son los comandos, que comprueban la autoría del objeto antes de tocarlo:
`requireOwnCouponPhoto` (`commands/coupon.ts`) y `createReceiptDocument`
(`commands/expense.ts:34-68`, «no lo subiste tú»). Ningún código de la
aplicación hace `UPDATE` de `app.storage_objects` ni de `app.documents` (grep
vacío), y el único otro `INSERT INTO app.documents` es la función
`SECURITY DEFINER` del recibo de liquidación (0035), que crea su propio objeto.
Son, por tanto, rejas de la base que faltan, no puertas abiertas en la web.

### A. `storage_objects_write` deja a `family_admin` quedarse un objeto ajeno y enlazarlo

`storage_objects_write` (0005) es `FOR ALL`, con `USING` «lo subí yo o soy
`family_admin`» y `WITH CHECK` «`created_by` = yo». La administración puede, por
tanto, reescribir el `created_by_membership_id` de un objeto que subió otra
persona, y desde ese momento el disparador `coupons_photo_link` lo acepta como
suyo. Reproducción (tique sintético de la empleada, transacción revertida):

```
-- A.1 Enlazar el tique de la empleada tal cual: lo para coupons_photo_link
ERROR:  la foto de un cupón tiene que ser una imagen viva que haya subido quien la enlaza
-- A.2 Reescribir la autoría del objeto ajeno (storage_objects_write lo admite)
UPDATE 1
-- A.3 Y ahora enlazarlo: el disparador lo acepta como propio
INSERT 0 1
          sonda            | count
---------------------------+-------
 family_member ve el tique |     1
 la empleada ve su tique   |     0
```

Qué cambia con la 0039: antes, quedarse el objeto no le daba a la
administración nada que no viera ya (`storage_objects_read` le enseña todos).
Ahora, enlazarlo a un cupón **lo publica a `family_member`**, y la empleada
pierde de vista su propio tique.

### B. `documents_write` no exige que el objeto citado sea propio ni visible

`documents_write` (0005) solo exige `created_by_membership_id = yo` en el
`WITH CHECK`. La clave foránea `(household_id, storage_object_id)` se comprueba
sin RLS, así que cualquiera con membresía puede crear un documento que cite el
UUID de **cualquier** objeto de su hogar. Y `storage_objects_read` (0005) abre
un objeto a quien vea un documento que lo cite. Reproducción con la empleada y
la foto de un cupón de la familia (transacción revertida):

```
-- B.0 Antes: la empleada no ve la foto
 antes   |       0
-- B.1 Crea un documento privado suyo que cita el UUID de la foto: documents_write no mira el objeto
INSERT 0 1
-- B.2 Ahora storage_objects_read le enseña los metadatos
 momento |                  id                  |       bucket        |         object_key          | media_type | byte_size |  sha256_12   |       created_by_membership_id
 después | aa100000-0000-4000-8000-000000000001 | fixture-attachments | sec/roble/cupon-familia.jpg | image/jpeg |      2048 | 111111111111 | 11000000-0000-4000-8000-000000000002
-- B.3 Sigue sin ver el cupón (comercio, código): la RLS de coupons no se mueve
 cupones
       0
-- B.4 Encadena un gasto pendiente con ese documento como justificante
INSERT 0 1
-- B.5 La consulta de loadExpenseReceipt (receipts.server.ts) devuelve la clave del objeto
              documentId              |          objectKey          |       bucket        | mediaType
 aa600000-0000-4000-8000-000000000001 | sec/roble/cupon-familia.jpg | fixture-attachments | image/jpeg
-- B.6 Con visibilidad household, el objeto se abre también al apoyo y al acceso puntual
 apoyo          |       1
 acceso puntual |       1
```

Dos precisiones que esta reproducción añade a lo que se daba por hecho:

- **No son solo los metadatos.** Si además se encadena un gasto pendiente que
  cite ese documento (B.4 —`expenses_employee_insert` tampoco mira de quién es
  el documento—), la consulta de `loadExpenseReceipt` devuelve la clave del
  objeto, y la ruta `GET …/receipts/<gasto>` serviría **los bytes de la foto**.
  Por la aplicación no se llega: el comando `expense.submit` rechaza un objeto
  que no subió quien lo envía.
- **No es solo la empleada.** Con visibilidad `household` el objeto se abre a
  cualquier membresía del hogar, apoyo y acceso puntual incluidos (B.6).

Lo que sigue cerrado: el cupón (comercio, oferta, código, notas, usos) no se
ve en ningún paso, y para empezar hace falta conocer el UUID de la foto, que
solo viaja a la familia.

### Propuesta: una migración aparte

Ensayada sobre `hk_sec` dentro de una transacción revertida (no es un fichero
del repositorio; la suite completa no se ha corrido con ella puesta):

```sql
-- A. Un objeto de almacenamiento no cambia de autor ni de bytes. Lo único que
--    se puede tocar es lo que no es identidad (`deleted_at`).
CREATE FUNCTION app.keep_storage_object_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
    OR NEW.bucket IS DISTINCT FROM OLD.bucket
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size THEN
    RAISE EXCEPTION 'un objeto de almacenamiento no cambia de hogar, de bytes ni de quién lo subió'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER storage_objects_keep_identity
BEFORE UPDATE ON app.storage_objects
FOR EACH ROW EXECUTE FUNCTION app.keep_storage_object_identity();

-- B. Un documento solo cita un objeto que subió quien lo crea (restrictiva, de
--    la aplicación: la función del recibo de liquidación es SECURITY DEFINER y
--    no pasa por aquí) y, una vez creado, no cambia de objeto.
CREATE POLICY documents_cite_own_object_insert ON app.documents
  AS RESTRICTIVE FOR INSERT TO casa_clara_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.storage_objects AS object
     WHERE object.household_id = documents.household_id
       AND object.id = documents.storage_object_id
       AND object.created_by_membership_id = app.current_membership_id()
  ));

CREATE FUNCTION app.keep_document_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
    OR NEW.storage_object_id IS DISTINCT FROM OLD.storage_object_id THEN
    RAISE EXCEPTION 'un documento no cambia de hogar ni de fichero: se crea otro'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER documents_keep_object
BEFORE UPDATE ON app.documents
FOR EACH ROW EXECUTE FUNCTION app.keep_document_object();
```

Con eso puesto, la misma reproducción da:

```
-- A.2 con la propuesta: la reescritura de autoría se para
ERROR:  un objeto de almacenamiento no cambia de hogar, de bytes ni de quién lo subió
-- quien subió un objeto puede seguir marcándolo como borrado (columna libre)
UPDATE 1
-- B.1 con la propuesta: citar la foto ajena se para
ERROR:  new row violates row-level security policy "documents_cite_own_object_insert" for table "documents"
-- y el camino legítimo (justificante propio, como createReceiptDocument) sigue pasando
INSERT 0 1
-- y moverlo después a la foto ajena se para
ERROR:  un documento no cambia de hogar ni de fichero: se crea otro
```

Por qué un disparador en el `UPDATE` de `documents` y no una restrictiva: un
`WITH CHECK` no ve la fila vieja, y exigir «objeto propio» en cada `UPDATE`
impediría a la administración archivar un documento cuyo fichero subió otra
persona. Al llevarla al repositorio hacen falta, además, su bloque `$check$` y
una suite que reproduzca A y B como aquí; y conviene decidir si
`expenses_employee_insert` debe exigir también que `receipt_document_id` sea un
documento de la propia empleada (el eslabón B.4).

## Cerrado en la fase 2

| Hallazgo | Qué se hizo | Dónde se prueba |
|---|---|---|
| La página de la cartera se guardaba en el dispositivo. El service worker guarda en su caché de páginas toda navegación con éxito que no diga `no-store` (`storable()` de `apps/web/src/service-worker.ts`) y la sirve sin red o ante un 503. El HTML de `/h/<id>/cupones` lleva la cartera entera, códigos y notas incluidos: sin red se enseñaba (D-offline dice «solo con red») y en un móvil compartido se quedaba tras cerrar la sesión. | El `load` de la página responde `cache-control: private, no-store` siempre: con datos, con el 503 y en la demostración. Es la misma razón por la que la foto ya iba con `no-store`. | `apps/web/tests/coupons-page-load.test.ts` |
| La familia no administradora no veía quién guardó ni quién usó un cupón: la RLS de `user_profiles` (0005) solo le enseña su propio perfil. | `app.coupon_people()` (0039): plpgsql, `SECURITY DEFINER`, `row_security = off` dentro y la puerta del papel puesta por ella misma. Devuelve `(membership_id, display_name)` solo a la familia del hogar del contexto, y solo de quien firmó el alta de un cupón o un uso vivo de ese hogar. A cualquier otro papel, sin contexto o con la membresía caducada, cero filas. `EXECUTE` solo para `casa_clara_app`. No se abre `user_profiles`: eso daría también el nombre de la empleada, del apoyo y de quien ya no está. | `packages/db/tests/210_coupons.sql` (familia, olivo, sin contexto, caducada, empleada, segunda empleada, apoyo, acceso puntual y emisor de trabajos) y `apps/web/tests/coupons.integration.test.ts` |
| Una fecha escrita a mano fuera de 2000–2999 tumbaba la cartera entera al leerla. | `CHECK` de rango en `coupons.expires_on` y `coupon_uses.used_on`, el mismo del contrato (`couponDateSchema`). | `packages/db/tests/210_coupons.sql` |
| (Ronda 2, m1.) En GET, la página no tenía segunda reja propia. En SvelteKit 2.70.2, un `GET …/cupones/__data.json?x-sveltekit-invalidated=01` da el layout por válido y no ejecuta su `load`, que es el que responde 403; el de la página sí se ejecuta. La RLS ya le daba a la empleada, al apoyo y al acceso puntual una cartera vacía: no salía nada. | `loadCoupons` mira `can(membership.role, 'coupon.access')` con la membresía que acaba de leer la transacción, y sin la capacidad devuelve la cartera vacía **sin consultar** cupones, usos ni nombres. Ahora la frontera en GET son dos rejas: esta y la RLS. | `apps/web/tests/coupons.integration.test.ts` («a quien no tiene la capacidad ni se le pregunta…»: registra las consultas del cliente; con la reja quitada falla con 2 consultas a `app.coupon*`) |
| (Ronda 2, m3.) El texto del 409 decía «Esa foto ya la subió otra persona de la casa», y no siempre era verdad: también choca un PDF del gasto, y también la misma persona con una membresía anterior (`ownExisting` compara la membresía). Era texto, no seguridad. | «Ese fichero ya lo subió alguien de la casa.», en la ruta y en el cliente. | `apps/web/tests/attachment-upload.test.ts`, `attachment-pipeline.test.ts`, `attachments.integration.test.ts` |
| (Ronda 2, m4, en parte.) Faltaba la prueba de la empleada con sesión de verdad. | `e2e/cupones.dbe2e.ts`: con la sesión de la empleada no hay entrada «Cupones» en la navegación, la página responde **403** con «Esta parte la lleva la familia.» y la ruta de la foto, **404**. La revisión ejecutada completa (consultas a `pg_policies`, cabeceras, registros) es esta página. | `apps/web/e2e/cupones.dbe2e.ts` («la empleada no tiene cartera…») |

## Riesgos residuales aceptados

### R12 en este módulo: lo que sí se queda en el dispositivo

El riesgo de fondo es R12 (BAJA) de
`docs/despliegue/puesta-en-produccion-eg112.md`: cerrar la sesión no borra la
caché del service worker ni IndexedDB. Con la cartera fuera de la caché,
quedan dos cosas de cupones dentro de R12:

- **El HTML de Hoy.** Hoy sí se guarda (es la pantalla que se abre sin red), y
  su asunto `cupones-caducan` lleva el **comercio y la oferta** de los cupones
  que caducan en tres días. **No lleva el código.** En un móvil compartido, la
  siguiente persona que abra Hoy sin red vería esa copia.
- **La bandeja de salida (IndexedDB).** Es del hogar, no de la persona
  (`listOutbox(householdId)`, `performSyncFlush`). Un uso, un descarte o una
  edición hechos sin red se quedan ahí hasta enviarse, y el alta y la edición
  llevan los campos del cupón, **código incluido**. Si en ese dispositivo entra
  después la empleada, su sesión intenta enviarlos, el servidor los rechaza con
  `not_allowed` y su triaje en Hoy enseña «Cupón nuevo de «Comercio»» con
  «Descartar» (revisión de seguridad, m1).

  No se quita el comercio de ese texto: los datos ya están en IndexedDB, así
  que ocultarlo en el triaje no cierra la exposición, y en el caso normal —la
  misma persona en su móvil— es lo que le dice qué cupón no se pudo guardar.
  El arreglo de verdad es de R12: vaciar la caché y la bandeja al cerrar la
  sesión.
- **La autoría dentro de la familia** (revisión de seguridad, ronda 2, m2).
  La bandeja la envía la sesión que esté abierta cuando vuelve la red. Si Marta
  apunta sin red un uso, una anulación o un descarte, cierra la sesión y en ese
  mismo móvil entra Ana, la bandeja sale con la sesión de Ana, y la base firma
  con quien escribe (exige `used_by`, `voided_by` y `discarded_by` = la
  membresía actual): la ficha dirá «Usado el … por Ana». No sale nada de la
  familia, pero la autoría queda mal. Mismo arreglo de R12.

### El 409 de la subida confirma que esos bytes ya están en la casa

Subir exactamente los mismos bytes que un adjunto ya guardado en el hogar
responde 409 `attachment_duplicate` (spec §7.2). Cualquier miembro puede subir
adjuntos, incluidos la empleada y el acceso puntual, así que la respuesta
confirma que alguien de la casa subió ese fichero, y nada más: ni quién, ni
cuándo, ni el id del objeto (control 12). La clave del objeto lleva el hogar
delante, así que entre casas no hay choque. Para aprovecharlo hace falta tener
ya el fichero exacto, reencodado: el riesgo es despreciable. Antes del módulo
era un 500 con el mismo valor como oráculo. Aceptado.

### El EXIF y el GPS solo se quitan en el navegador

`prepareAttachment({ alwaysReencode: true })` redibuja siempre la foto del
cupón y no sube nunca el original (control 11). Un cliente que no sea la
aplicación, o un POST directo a `/api/v1/households/<id>/attachments`, puede
subir el original con su posición GPS, y después lo verá toda la familia. Es lo
que decide la spec (§9): la audiencia es la familia y quien sube expone sus
propios datos. Aceptado.

### La auditoría copia el código

`audit_events` guarda la fila entera del cupón, código y notas incluidos, y la
lee `family_admin` (control 13: `FRUTA10`, `DROG2X1`). Aceptable porque la
administración ya es audiencia del módulo (spec §9); por eso no hay una
restrictiva como la `audit_events_finance_lock` de la 0037. `family_member`
solo ve los eventos que firma él (`actor_membership_id = yo`, 0005), y la
empleada, el apoyo y el acceso puntual no ven ninguno.

### Los nombres de quien ya no está

`app.coupon_people()` no filtra por membresía vigente: si alguien que guardó un
cupón o apuntó un uso deja la casa, la familia sigue leyendo su nombre en esa
ficha. Es a propósito —es la autoría de lo que se ve— y solo sale de quien
firmó algo de la cartera; abrir `user_profiles` daría el de todos.

## Cómo volver a ejecutar esta revisión

Desde la raíz del repositorio, contra un Postgres **desechable** (nunca el de
desarrollo compartido ni producción). `pnpm test:rls` reinicia el esquema y
migra de cero, así que va primero: las sondas de abajo suponen una base recién
migrada con sus fixtures. Las suites de integración de `packages/server` dejan
filas en la base que reciben; si se corren antes, los recuentos de la matriz
salen mayores (los ceros, no).

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL='postgresql://<usuario>:<clave>@127.0.0.1:<puerto>/<base>'

# 1 · Suites SQL (reinician la base)
pnpm test:rls && pnpm test:db

# 2, 3 y 4 · Catálogo: RLS, políticas, veredicto negativo, privilegios, índice
psql "$TEST_DATABASE_URL" <<'SQL'
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'app' AND c.relname IN ('coupons', 'coupon_uses', 'storage_objects');
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
 WHERE schemaname = 'app' AND tablename IN ('coupons', 'coupon_uses', 'storage_objects')
 ORDER BY 1, 2;
SELECT tablename, policyname, cmd FROM pg_policies                         -- 0 filas
 WHERE schemaname = 'app' AND tablename IN ('coupons', 'coupon_uses')
   AND (cmd IN ('DELETE', 'ALL')
        OR NOT (coalesce(qual, with_check) LIKE '%tenant_context_matches(household_id)%'
                AND coalesce(qual, with_check) LIKE '%family_role()%'));
SELECT grantee, table_name, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
 WHERE table_schema = 'app' AND table_name IN ('coupons', 'coupon_uses') GROUP BY 1, 2;
SELECT indexname FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'coupons_photo_idx';
SELECT oid::regprocedure, prosecdef, proconfig,
       has_function_privilege('public', oid, 'EXECUTE') AS public_exec
  FROM pg_proc WHERE oid = 'app.coupon_people()'::regprocedure;
SQL

# 5 · Matriz por papel (se revierte; los cuatro papeles de fuera, todo a 0)
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.storage_objects (id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id) VALUES
 ('aa100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'fixture-attachments', 'sec/cupon-1.jpg', 'image/jpeg', 2048, repeat('1', 64), '11000000-0000-4000-8000-000000000001'),
 ('aa100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'fixture-attachments', 'sec/cupon-2.png', 'image/png', 2048, repeat('2', 64), '11000000-0000-4000-8000-000000000002');
INSERT INTO app.coupons (household_id, id, merchant, offer, code, photo_storage_object_id, created_by_membership_id) VALUES
 ('10000000-0000-4000-8000-000000000001', 'aa200000-0000-4000-8000-000000000001', 'Súper Sintético', '10 % en fruta', 'FRUTA10', 'aa100000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000001', 'aa200000-0000-4000-8000-000000000002', 'Droguería Ficticia', '2x1', 'DROG2X1', 'aa100000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002');
INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id) VALUES
 ('10000000-0000-4000-8000-000000000001', 'aa300000-0000-4000-8000-000000000001', 'aa200000-0000-4000-8000-000000000002', '2026-10-08', '11000000-0000-4000-8000-000000000002');
SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;
DO $matriz$
DECLARE
  who record;
BEGIN
  FOR who IN SELECT * FROM (VALUES
    ('family_admin',   'fixture:roble:admin',     '11000000-0000-4000-8000-000000000001'::uuid),
    ('family_member',  'fixture:roble:family',    '11000000-0000-4000-8000-000000000002'::uuid),
    ('empleada',       'fixture:roble:employee',  '11000000-0000-4000-8000-000000000003'::uuid),
    ('empleada 2',     'fixture:roble:employee2', '11000000-0000-4000-8000-000000000006'::uuid),
    ('apoyo',          'fixture:roble:helper',    '11000000-0000-4000-8000-000000000004'::uuid),
    ('acceso puntual', 'fixture:roble:viewer',    '11000000-0000-4000-8000-000000000005'::uuid)
  ) AS t(label, user_id, membership_id) LOOP
    PERFORM set_config('app.user_id', who.user_id, true);
    PERFORM app.set_household_context('10000000-0000-4000-8000-000000000001', who.membership_id);
    RAISE NOTICE '% | cupones % | usos % | fotos % | nombres %', who.label,
      (SELECT count(*) FROM app.coupons), (SELECT count(*) FROM app.coupon_uses),
      (SELECT count(*) FROM app.storage_objects WHERE id::text LIKE 'aa1%'),
      (SELECT count(*) FROM app.coupon_people());
  END LOOP;
END
$matriz$;
ROLLBACK;
SQL
#   → family_admin | cupones 2 | usos 1 | fotos 2 | nombres 2
#     family_member | cupones 2 | usos 1 | fotos 2 | nombres 2
#     empleada | cupones 0 | usos 0 | fotos 0 | nombres 0   (y lo mismo empleada 2, apoyo, acceso puntual)

# 8, 9, 11, 12, 15 · Web (las de integración crean su propia base en el clúster)
(cd apps/web && npx vitest run --no-file-parallelism \
  tests/coupon-photo-route.test.ts tests/coupon-photo.integration.test.ts \
  tests/coupons-page-load.test.ts tests/attachment-prepare.test.ts \
  tests/attachment-route.test.ts tests/attachment-upload.test.ts \
  tests/attachment-pipeline.test.ts tests/attachments.integration.test.ts \
  tests/coupons.integration.test.ts tests/today-decisions.test.ts \
  tests/routing.test.ts tests/coupons-seams.test.ts tests/capabilities.test.ts)

# 14 · Comandos (deja filas en la base: después de las sondas SQL)
(cd packages/server && npx vitest run src/coupons.integration.test.ts)

# 10 · Registros: primero que los caminos existen, luego el grep
F="apps/web/src/lib/server/coupons.server.ts apps/web/src/lib/server/coupon-photo.server.ts
   apps/web/src/lib/server/today.server.ts apps/web/src/lib/server/attachments.server.ts
   packages/server/src/commands/coupon.ts apps/web/src/routes/api/v1/sync/+server.ts
   apps/web/src/routes/api/v1/households/[householdId]/coupons
   apps/web/src/routes/api/v1/households/[householdId]/attachments
   apps/web/src/routes/h/[householdId]/cupones apps/web/src/lib/coupons
   apps/web/src/lib/components/coupons apps/web/src/lib/components/PhotoPicker.svelte
   apps/web/src/lib/attachments"
for f in $F; do test -e "$f" || echo "CONTROL ROTO: no existe $f"; done
find $F -type f \( -name '*.ts' -o -name '*.svelte' \) | wc -l                  # 26
grep -rnE "log\.(debug|info|warn|error)\(|console\.|unreadable\(log" $F
#   → solo `{ code: errorCode(cause) }`; ningún comercio, código, oferta ni nota
```

Las reproducciones de la deuda previa (A y B) y la prueba de la propuesta son
las transacciones de la sección anterior, también revertidas.

## Lo que queda fuera y por qué

- **El navegador.** La prueba de la empleada con sesión de verdad (sin entrada
  en la navegación, 403 en la página, 404 en la foto) vive en
  `apps/web/e2e/cupones.dbe2e.ts` y no se ha relanzado aquí: necesita levantar
  la aplicación contra una base, y ese fichero lo estaba cambiando otra tarea.
  Lo que sí se ejecutó cubre las mismas tres rejas por debajo: la capacidad en
  la ruta de la foto (control 8), la capacidad del cargador antes de consultar
  (`coupons.integration.test.ts`, «a quien no tiene la capacidad ni se le
  pregunta…») y la RLS (controles 1 y 5).
- **Producción.** Nada de esta página se ha medido en Supabase. Allí el
  propietario tiene `BYPASSRLS` y las tablas conservan el forzado (ver
  [revision-finanzas.md](revision-finanzas.md)); en cualquier caso la RLS se
  aplica igual al rol de la aplicación, que no es propietario. Tras migrar,
  basta con repetir el veredicto negativo del control 3 y la sonda sin contexto
  (`SET ROLE casa_clara_app;` y los tres recuentos a 0).
- **La deuda previa A y B** no se corrige en esta rama, por lo dicho arriba.
- **R12** (la caché del dispositivo tras cerrar la sesión) es un riesgo de toda
  la aplicación con su propio arreglo pendiente; aquí solo se cuenta qué deja el
  módulo dentro.
