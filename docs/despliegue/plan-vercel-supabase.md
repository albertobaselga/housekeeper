# Plan de despliegue en Vercel + Supabase — auditoría de viabilidad

> Auditoría técnica sobre `codex/brief-completion` (HEAD `b3aef10`).
> **Este documento no implementa nada.** Es el mapa de lo que hay que tocar,
> qué cuesta y qué decisiones quedan pendientes del propietario.
>
> Fecha: 8 de agosto de 2026.
>
> **Estado**: los bloqueantes de base de datos B-1 … B-5 (§3.1) ya están
> resueltos e implementados; el trabajo, la incompatibilidad adicional de
> `pg_trgm` que esta auditoría no había detectado y la sonda que lo reproduce
> todo están en [`supabase-esquema.md`](supabase-esquema.md). El resto del
> documento sigue vigente.

---

## 1. Veredicto

**Viable, pero no «tal cual».** El sistema está bien construido para lo que se
propuso —Docker Compose autogestionado— y esa misma calidad es la que choca con
Supabase: el modelo de autorización descansa en `FORCE ROW LEVEL SECURITY` +
funciones `SECURITY DEFINER` con `SET row_security = off`, y ese patrón exige un
rol con `BYPASSRLS` que Supabase probablemente no concede. Es el único
bloqueante duro de base de datos, y tiene arreglo conocido.

Lo demás es trabajo, no imposibilidad:

- **Web en Vercel**: cambio de adaptador y poco más. No hay ninguna ruta que
  dependa de estado en proceso ni de larga duración. Ninguna ruta hace
  streaming, ninguna lee del sistema de ficheros, ninguna usa `prerender`.
- **Worker**: no cabe en Vercel como está (es un bucle infinito), pero la
  primitiva de drenado ya existe y está exportada (`runOneJob`). Hay tres
  caminos reales, y el más barato cuesta ~2 €/mes.
- **ClamAV**: no existe en Vercel ni en Supabase. Es la decisión de producto
  más incómoda del expediente.
- **Repo público**: limpio. Se ha barrido el historial completo objeto a objeto.

**Esfuerzo estimado del camino completo: 7–13 jornadas de trabajo** repartidas
en 5 fases (§11 y §14), sin contar la revisión legal y la política de retención
que el ADR 0001 exige antes de tocar datos reales.

---

## 2. Qué se ha probado de verdad (y qué es sólo análisis)

Casi todo lo que sigue sobre la base de datos está **verificado empíricamente**,
no deducido. Se creó `housekeeper_deploy_probe` en el Postgres 18 local con un rol
`sb_postgres` que imita al `postgres` de Supabase (`NOSUPERUSER`, `CREATEROLE`,
`CREATEDB`, `NOBYPASSRLS`), con las extensiones preinstaladas en un esquema
`extensions` y con los roles `anon`/`authenticated`/`service_role` presentes,
igual que en un proyecto Supabase recién creado. Después se ejecutaron las 17
migraciones y las 5 suites SQL/RLS contra esa base.

| Afirmación | Cómo se comprobó |
| --- | --- |
| Las migraciones fallan sin `BYPASSRLS` | Ejecutadas; fallo reproducible en `0006` |
| El fallo ocurre al **crear** la función, no al llamarla | Aislado con dos funciones sonda |
| `NO FORCE ROW LEVEL SECURITY` lo arregla | Sonda equivalente creada y ejecutada con éxito |
| Un rol sin `BYPASSRLS` no puede autoconcedérselo | `ERROR: permission denied to alter role` |
| Las extensiones en `extensions` rompen `0007` | Ejecutado; `text search dictionary "public.unaccent" does not exist` |
| Con los dos arreglos, **todo lo demás pasa** | 17/17 migraciones y 5/5 suites SQL/RLS en verde |
| El patrón de sesión es compatible con el pooler | Lectura de código: todo es `set_config(..., true)` y `pg_advisory_xact_lock` |

Lo que **no** está verificado y hay que comprobar en el proyecto real (5 minutos):
si el rol `postgres` de tu proyecto Supabase tiene `BYPASSRLS`. Es una consulta:

```sql
select rolname, rolsuper, rolbypassrls, rolcreaterole
  from pg_roles where rolname in ('postgres','service_role');
```

De esa única respuesta depende que el bloqueante B-1 sea trivial o costoso.

---

## 3. Tabla de bloqueantes

Severidades: **BLOQUEANTE** (impide desplegar), **TRABAJO** (requiere código o
infraestructura nueva), **TRIVIAL** (configuración o una línea).

### 3.1 Base de datos / Supabase

| # | Severidad | Problema | Arreglo mínimo | Esfuerzo |
| --- | --- | --- | --- | --- |
| B-1 | **BLOQUEANTE** | `SECURITY DEFINER` + `SET row_security = off` sobre tablas con `FORCE RLS` falla en el `CREATE FUNCTION` si el propietario no tiene `BYPASSRLS`. Afecta a `0006:65-67`, `0006:112-114`, `0007:177-179`, `0007:215-217`, `0009:21-23`, `0009:57-59`, `0009:90-92`, `0012:13-15`, `0015:76-78`, `0015:153-155` | Si `postgres` tiene `BYPASSRLS`: nada. Si no: nueva migración `0018` que haga `NO FORCE ROW LEVEL SECURITY` sobre las tablas que tocan esas funciones (comprobado: la creación y la ejecución pasan). Pierde defensa en profundidad frente al propio dueño del esquema, **no** frente a la app | 0,5 – 1,5 j |
| B-2 | **BLOQUEANTE** | `CREATE EXTENSION IF NOT EXISTS unaccent` (`0007:3`) no hace nada en Supabase porque ya está instalada en el esquema `extensions`; después `app.unaccent_es` (`0007:8-16`) invoca `public.unaccent('public.unaccent'::regdictionary, …)` y explota. `ALTER EXTENSION … SET SCHEMA` tampoco funciona: `must be owner of extension` | Parametrizar el esquema de la extensión en `0007`, o crear en Supabase un envoltorio `public.unaccent` que delegue en `extensions.unaccent`. Ojo: `app.unaccent_es` es `IMMUTABLE` y alimenta columnas generadas e índices; cambiarla después obliga a reconstruir índices | 0,5 j |
| B-3 | **BLOQUEANTE** | El bootstrap de roles de login (`infra/postgres/00-create-roles.sh`) es un script de `docker-entrypoint-initdb.d`. En Supabase no existe ese punto de enganche | Convertirlo en migración o en un runbook SQL ejecutado una vez. Comprobado: `sb_postgres` (con `CREATEROLE`) **sí** puede crear `casa_clara_app_login` y hacer `GRANT casa_clara_app TO …`, porque en PG16+ quien crea un rol obtiene `ADMIN OPTION` sobre él | 0,5 j |
| B-4 | **BLOQUEANTE** | Better Auth escribe en un esquema llamado literalmente `auth` (`00-create-roles.sh:45-47`). En Supabase `auth` es de GoTrue y pertenece a `supabase_auth_admin` | Renombrar a `casa_auth`. El aislamiento se logra igual con `ALTER ROLE casa_clara_auth_login SET search_path TO casa_auth` — es un rol propio, no reservado, así que Supabase lo permite | 0,25 j |
| B-5 | TRABAJO | Para ejecutar la suite RLS contra Supabase, el rol propietario necesita **pertenencia** a `casa_clara_app`/`casa_clara_worker`, no sólo `ADMIN OPTION`: comprobado, `SET ROLE` falla si sólo hay admin | Añadir `GRANT casa_clara_app, casa_clara_worker TO postgres;` al runbook de bootstrap | 0,1 j |
| B-6 | TRIVIAL | El plan Free pausa el proyecto tras 7 días de inactividad | Plan Pro (25 USD/mes) desde el primer día, o asumir despertar manual | decisión, no trabajo |

> Los roles `casa_clara_app`, `casa_clara_worker` y `casa_clara_auth_login` que
> aparecen en esta tabla y en el resto del documento son nombres legados del
> proyecto anterior; ver
> [docs/despliegue/identificadores-legado.md](identificadores-legado.md).

**Buena noticia sobre el pooler** — y corrige la sospecha de partida. El código
**no** usa `set_config(..., false)` en ninguna parte. Todo es transaccional:

- `packages/server/src/database.ts:28-29` — `begin` y luego
  `set_config('app.user_id', $1, true)`; el tercer argumento `true` significa
  *local a la transacción*.
- `apps/web/src/lib/server/app-user.server.ts:30-31` — idéntico patrón.
- Los locks son `pg_advisory_xact_lock` (`packages/server/src/idempotency.ts:27`,
  `commands/extra-work.ts:416`, y los triggers de `0002`/`0003`/`0007`), es decir
  **de transacción**, no de sesión.
- La cola del worker reclama con `for update skip locked` dentro de un `begin`
  explícito (`apps/worker/src/queue.ts:33-62`).
- No hay `LISTEN`/`NOTIFY` en ninguna parte.
- No hay sentencias preparadas con nombre (`pg` usa el protocolo extendido con
  sentencias anónimas).

**Conclusión: el pooler de Supabase en modo transacción (puerto 6543) es
compatible con todo el código de aplicación y de worker.** Es además la cadena
que hay que usar en Vercel, donde cada instancia abre su propio pool.

El único uso de un lock de sesión es `packages/db/scripts/migrate.mjs:44`
(`pg_advisory_lock`), y el runner de migraciones debe ir por **conexión directa
(5432)**, no por el pooler. Igual el importador del manual, que hace
`set local row_security = off` (`packages/db/scripts/wiki-import.mjs:366`,
`seed-manual.mjs:147`) y por tanto necesita las mismas condiciones que B-1.

**Cadenas de conexión resultantes:**

| Consumidor | Puerto | Rol | Motivo |
| --- | --- | --- | --- |
| Web en Vercel (`DATABASE_URL`) | 6543 (pooler, transacción) | `casa_clara_app_login` | Muchas instancias efímeras |
| Better Auth (`DATABASE_AUTH_URL`) | 6543 | `casa_clara_auth_login` | El `search_path` de rol se aplica al abrir el backend |
| Worker | 6543 o 5432 | `casa_clara_worker_login` | Ambas valen; directa si el worker es un proceso fijo |
| Migraciones / importadores | **5432 directa** | `postgres` | Lock de sesión y DDL |

### 3.2 Web / Vercel

| # | Severidad | Problema | Arreglo | Esfuerzo |
| --- | --- | --- | --- | --- |
| V-1 | TRABAJO | `@sveltejs/adapter-node` (`apps/web/svelte.config.js:1,8`) | Sustituir por `@sveltejs/adapter-vercel`, fijar `runtime: 'nodejs22.x'` (o el que Vercel ofrezca para Node 24) y `regions: ['fra1']` o `['cdg1']` para mantener los datos en la UE. Ojo: el monorepo es pnpm workspaces con `workspace:*`, hay que configurar el *root directory* y el comando de build en Vercel | 0,5 – 1 j |
| V-2 | TRABAJO | `SNAPSHOT_SIGNING_KEY_B64` sin definir genera una clave Ed25519 **efímera por proceso** (`apps/web/src/lib/server/keys.server.ts:31-37`). En serverless cada instancia firma con una clave distinta y el snapshot offline deja de verificar entre invocaciones | Pasa de «recomendable» a **obligatoria**. Generar y fijar en Vercel | 0,1 j |
| V-3 | TRABAJO | `apps/web/src/lib/server/session.server.ts:6` guarda las sesiones demo en un `Map` en memoria. Es exactamente la rama que corre si faltan `DATABASE_AUTH_URL`/`BETTER_AUTH_SECRET` | En producción no se usa (Better Auth va por cookie firmada + BD). Pero conviene fallar ruidosamente si faltan esas variables, en vez de degradar en silencio al selector de fixtures (`auth.server.ts:45-50`) | 0,25 j |
| V-4 | TRABAJO | `GET /api/metrics` (`routes/api/metrics/+server.ts`) expone contadores de proceso. En Vercel cada invocación es un proceso nuevo: la métrica es ruido | Retirar la ruta en el despliegue Vercel o sustituirla por logs/OTel. También desaparece el `/metrics` del worker si se serverlessiza | 0,25 j |
| V-5 | TRABAJO | Descargas ZIP y PDF construidas **en memoria y devueltas de golpe**: `handover/+server.ts:25-31`, `employment-export/+server.ts:26-32`, `receipts/[expenseId]/+server.ts:31-37`. Vercel limita la respuesta de función a ~4,5 MB | Medir el traspaso real; si supera el límite, subir el ZIP a Storage y devolver una URL firmada. `fflate` y `pdf-lib` son JS puro y funcionan sin problema; el riesgo es el **tamaño**, no la librería | 0,5 – 1 j |
| V-6 | TRIVIAL | `ORIGIN` no existe en `adapter-vercel`; la comprobación CSRF pasa a derivar de `x-forwarded-host` | Quitar `ORIGIN` del inventario y fijar `BETTER_AUTH_URL` al dominio real. Sin ella, los enlaces mágicos apuntan a `http://localhost:3000` (`auth.server.ts:54`) | 0,1 j |
| V-7 | TRIVIAL | Los `nonce` CSP de SvelteKit (`svelte.config.js:16-35`) | Funcionan igual en `adapter-vercel`: SvelteKit los inyecta al renderizar. No hay páginas `prerender` (verificado: cero `export const prerender` en todo `src/routes`), así que no hay riesgo de nonce cacheado | — |
| V-8 | TRIVIAL | Tamaño del bundle de función | El build actual de servidor pesa **8,3 MB** (`apps/web/build/server`), incluido `@aws-sdk/client-s3`. El límite de Vercel son 250 MB descomprimidos. Sin problema | — |
| V-9 | TRIVIAL | Conexiones a Postgres | `db.server.ts:13` abre pool con `max: 5` y `auth-core.ts:56` otro con `max: 3`: **8 conexiones por instancia fría**. Con el pooler en modo transacción no es grave, pero conviene bajar a `max: 1-2` en Vercel | 0,1 j |

**Rutas revisadas una a una.** Ninguna depende de estado en proceso ni de larga
duración. Las 8 rutas de API (`/api/health`, `/api/metrics`, `/api/v1/sync`,
`attachments`, `employment-export`, `handover`, `receipts/[expenseId]`,
`snapshot`, `/api/v1/ics/[token]`) son peticiones cortas y con respuesta
completa. `POST /api/v1/sync` (`routes/api/v1/sync/+server.ts:45`) procesa un
lote de comandos en una transacción: encaja perfectamente en una función.
No hay `fs`, no hay `process.cwd()`, no hay lectura de ficheros del repo en
tiempo de ejecución. El service worker (`src/service-worker.ts`) se compila
igual con cualquier adaptador.

La única ruta con perfil de duración incómodo es
`POST /api/v1/households/[householdId]/attachments`, que hace escaneo antivirus
con **timeout de 30 s** (`attachment-deps.server.ts:10`) — pero eso depende de
la decisión sobre ClamAV, no de Vercel.

### 3.3 Worker, adjuntos, correo

| # | Severidad | Problema | Arreglo | Esfuerzo |
| --- | --- | --- | --- | --- |
| W-1 | **BLOQUEANTE** | El worker es un demonio: `apps/worker/src/index.ts:140` levanta un servidor HTTP, `:158-169` es un `while (!stopping)`, y todo son efectos de módulo. Importarlo arranca el bucle | Ver §5. La primitiva ya existe: `runOneJob(pool, handlers, maxAttempts)` está **exportada** (`queue.ts:95-114`) y devuelve `false` con la cola vacía | 0,5 – 2 j según opción |
| W-2 | ~~**BLOQUEANTE**~~ **RESUELTO** | Sin ClamAV no hay adjuntos. Y no hay bandera para desactivar sólo el escaneo: `scan` es miembro obligatorio de `AttachmentDependencies` (`attachments.server.ts:46`) y si falta `CLAMAV_HOST` se anula el paquete entero (`attachment-deps.server.ts:91-93`) | Hecho: `scan` es **opcional** y `CLAMAV_HOST` solo enciende el escaneo. La lectura ya no depende de él, el tipo se deduce de la firma real y se sirve con `nosniff` + CSP `sandbox`. Riesgo y reactivación en [security/adjuntos-sin-antivirus.md](../security/adjuntos-sin-antivirus.md) | — |
| W-3 | **BLOQUEANTE** | El transporte SMTP no admite credenciales: `nodemailer.createTransport({host, port, secure:false})` sin objeto `auth`, en los dos sitios (`apps/worker/src/integrations.ts:102-106`, `apps/web/src/lib/server/auth.server.ts:17-21`). No existen `SMTP_USER`/`SMTP_PASS` en el repo. Sólo ha hablado con Mailpit | Añadir `SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE` a ambos transportes | 0,25 j |
| W-4 | TRABAJO | Un enlace mágico que no se envía **no se nota**: `routes/login/+page.server.ts:113-121` traga la excepción para no filtrar existencia de usuarios y devuelve siempre `{ sent: true }` | Registrar el fallo en el log del servidor (sin el correo) manteniendo la respuesta genérica al usuario | 0,25 j |
| W-5 | TRABAJO | Agujero de arranque en frío: `ensurePruneDiscoveryScheduled` (`maintenance.ts:151`) y `ensureIcsSyncScheduled` (`ics.ts:815`) **se abstienen si la cola está vacía**, porque `job_queue.household_id` es NOT NULL y el worker no puede leer `app.households`. En un despliegue nuevo los trabajos periódicos nunca arrancan | Semilla manual de un job, o dar al worker una vía de lectura del hogar. Está documentado en `docs/runbooks/staging-synthetic.md`, pero es una trampa real en producción | 0,25 j |
| W-6 | TRIVIAL | El worker arrastra `sharp`, `tesseract.js` y `web-push` (`apps/worker/package.json:20-22`) para funciones que **ningún handler usa** (`integrations.ts:15-41`, `:108-118`) | Eliminarlas. Sin binarios nativos, el worker pasa a ser JS puro y cabe en cualquier runtime | 0,25 j |
| W-7 | TRIVIAL | Si `ALLOW_SYNTHETIC_DATA_ONLY=true` se cuela en producción, el worker rechaza todo destinatario que no sea `.demo/.test/.example/.invalid` (`integrations.ts:89-100`) y los jobs mueren. La web, en cambio, **sí** enviaría enlaces mágicos a direcciones reales: la guarda no cubre ese camino | No definirla en producción (el valor por omisión es el seguro). Considerar extender la guarda a `deliverMagicLink` | 0,1 j |
| W-8 | ~~TRIVIAL~~ **RESUELTO** | `docs/security/security-baseline.md:17` dice que los justificantes se sirven con URL firmada corta; en realidad la app **proxea los bytes** (`receipts/[expenseId]/+server.ts:25-37`) | Hecho: el control 5 del baseline ya describe el proxeo real, el bucket privado y las cabeceras de la respuesta | — |

### 3.4 Repositorio y publicación

| # | Severidad | Problema | Arreglo | Esfuerzo |
| --- | --- | --- | --- | --- |
| G-1 | TRIVIAL | Huecos en `.gitignore`: `.codex/`, `.agents/`, `scratchpad/`, `*.dump`, `*.sql.gz`, `.vscode/`, `.idea/` no están cubiertos | Añadirlos. **No** ignorar `*.sql` en bloque: `packages/db/migrations`, `fixtures` y `tests` son `.sql` legítimos | 0,1 j |
| G-2 | Criterio | El corpus del manual describe la distribución real de la casa: `packages/db/content/manual/la-casa-y-sus-zonas/010-distribucion-y-mapa-funcional.md:12-14` (tres plantas, garaje, patio inglés, suite de servicio en sótano), `020-almacenaje-y-reglas-de-colocacion.md:12-16`, y los suelos por estancia en `limpieza/020|030|040-ficha-operativa-*.md:10`. Sin dirección, sin nombres, sin códigos de alarma | Es una huella identificable de una vivienda concreta. Decisión del propietario: publicar, o mover el corpus a un repo privado y dejar en el público sólo fixtures sintéticas | decisión |
| G-3 | TRIVIAL | La persona demo se llama `Alberto` (`apps/web/src/lib/server/fixtures.server.ts:18-20`, `.env.example:6`) y `seed-manual.mjs:113` menciona «Emergencias Comunidad de Madrid» | Sólo nombre de pila y dominio `.demo`. Renombrar si se quiere cero vinculación | 0,1 j |
| G-4 | TRIVIAL | Resto de `C:*` de Windows en `.gitignore:18` | Cosmético | — |

**El barrido de secretos salió limpio.** Se recorrieron **los 2 075 blobs de la
base de objetos** (no sólo los commits alcanzables), los 177 commits, las 4 ramas
y las 223 entradas del reflog. Cero coincidencias de `AKIA*`, `sk_live_*`,
`ghp_*`, `github_pat_*`, `xoxb-*`, claves privadas PEM o IBAN.

**Sobre la URL secreta del calendario de Google: NO está en el repo ni en el
historial.** Cero coincidencias de `calendar.google.com`, `/calendar/ical/`,
`basic.ics` ni `private-[0-9a-f]{20,}` en ningún objeto de git. La captura
`docs/manual/capturas/familia-calendario-alta.png` se tomó con el formulario
vacío (sólo el marcador `https://…`). `apps/worker/src/ics.ts` no tiene ninguna
URL empotrada. La URL vive únicamente en la base de datos, que no se publica.

El `.env` de la raíz existe en disco pero **nunca ha estado versionado**
(`git log --all --diff-filter=A` sólo registra los `.example`), está cubierto por
`.gitignore:14-16` y su contenido es idéntico al `.env.example` salvo un
comentario. Los 177 commits están firmados por `Codex <codex@local.invalid>`:
ningún correo personal en los metadatos. Las capturas del manual llevan todas la
cabecera «Familia Roble · datos ficticios» y los teléfonos son de rangos no
asignables (`+34600000xxx`, `+34910000xxx`). El corpus del manual tiene 225
campos con el literal «Pendiente de completar por la familia»: el `.docx` de
origen nunca se subió.

---

## 4. Supabase: el detalle que decide

### 4.1 El fallo exacto

Ejecutando las migraciones como un rol tipo Supabase, `0006` muere:

```
applied 0005_rls.sql
query would be affected by row-level security policy for table "settlements"
```

No es el *uso* de la función: es su **creación**. PostgreSQL valida el cuerpo de
las funciones `LANGUAGE sql` al crearlas, y aplica antes las cláusulas `SET`
de la función. Con `row_security = off` y una tabla con `FORCE ROW LEVEL
SECURITY`, el planificador se niega salvo que el rol tenga `BYPASSRLS`.
Aislado con dos sondas:

```sql
-- A) LANGUAGE sql: falla en el CREATE
CREATE FUNCTION app_private.probe_sd() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off
AS $$ SELECT count(*) FROM app.settlements $$;
--> ERROR: query would be affected by row-level security policy for table "settlements"
--> HINT: To disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY.

-- B) la misma sin row_security = off: CREATE FUNCTION (pasa)

-- C) LANGUAGE plpgsql: el CREATE pasa, y falla al EJECUTAR
--> ERROR: query would be affected by row-level security policy for table "settlements"
```

Es decir: no es un problema cosmético de validación. **El patrón entero
—funciones definer que puentean RLS— está roto sin `BYPASSRLS`.**

### 4.2 Por qué no se puede conseguir `BYPASSRLS` a posteriori

```sql
ALTER ROLE sb_postgres BYPASSRLS;
--> ERROR: permission denied to alter role
CREATE ROLE cc_bypass NOLOGIN BYPASSRLS;
--> ERROR: permission denied to create role
--> DETAIL: Only roles with the BYPASSRLS attribute may create roles with the BYPASSRLS attribute.
```

Desde PG16 basta *tener* `BYPASSRLS` para concederlo, pero no se puede fabricar
de la nada. Si el `postgres` de Supabase no lo trae, no hay ruta hacia él: ni por
`service_role` (los atributos de rol **no se heredan** por pertenencia) ni
autoconcediéndoselo. Por eso B-1 es el bloqueante que hay que resolver primero.

### 4.3 El arreglo mínimo, comprobado

```sql
ALTER TABLE app.settlements NO FORCE ROW LEVEL SECURITY;
CREATE FUNCTION app_private.probe_noforce() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off
AS $$ SELECT count(*) FROM app.settlements $$;
--> CREATE FUNCTION
SELECT app_private.probe_noforce();  --> 2
```

**Qué se pierde exactamente.** `FORCE ROW LEVEL SECURITY` sólo afecta al
**propietario de la tabla**. Quitarlo no abre nada a `casa_clara_app` ni a
`casa_clara_worker`: esos roles no son propietarios y siguen sometidos a RLS
igual que hoy. Lo que se pierde es la protección contra un error del propio rol
de migraciones. Es defensa en profundidad real, pero es la capa exterior, no la
que aísla inquilinos. La alternativa cara —reescribir las diez funciones definer
para que fijen contexto RLS en vez de puentearlo, o añadir políticas explícitas
para el rol worker— son 3–5 jornadas y toca el corazón del modelo de seguridad.

### 4.4 Lo que sí funciona sin cambios

Con `BYPASSRLS` concedido, las extensiones en `public` y la pertenencia a los
roles de grupo, el resultado contra la base sonda fue:

```
applied 0007 … applied 0017        Applied 11 migration(s).
1..5
ok 1 - tests/010_schema_and_constraints.sql
ok 2 - tests/020_rls_matrix.sql
ok 3 - tests/030_menu_week_templates.sql
ok 4 - tests/040_ics_source_events.sql
ok 5 - tests/050_shopping_personal_and_archiving.sql
# tests 5 passed, 0 failed of 5
```

**La matriz RLS completa pasa con un propietario no superusuario.** Es la señal
más fuerte de viabilidad del expediente: el modelo de autorización no depende de
ser superusuario, sólo de poder puentear RLS en diez funciones concretas.

Sobre choques con los roles de Supabase: `anon`, `authenticated` y `service_role`
existían en la base sonda y **no interfieren**. Las migraciones sólo conceden a
`casa_clara_app`/`casa_clara_worker`, y `0001:17-18` revoca de `PUBLIC` en ambos
esquemas, así que `anon` no ve nada de `app`. Sí conviene revisar que PostgREST
no exponga el esquema `app`: en el panel de Supabase, *Exposed schemas* debe
quedarse en `public` (que en este diseño está vacío salvo `schema_migrations`).

---

## 5. El worker: tres opciones reales

Los 7 jobs, clasificados por lo que necesitan de verdad:

| Job | Red | Runtime | ¿SQL puro? |
| --- | --- | --- | --- |
| `ics.sync_source` (`ics.ts:690-714`) | HTTPS saliente arbitrario | segundos (fetch 10 s + expansión RRULE) | **No** |
| `ics.sync_all` (`ics.ts:742-762`) | — | ms | Sí |
| `notification.routine_due` (`ics.ts:655-671`) | SMTP | segundos | No |
| `notification.settlement_due` (`reminders.ts:91-122`) | SMTP | segundos | No |
| `time_report.autoconfirm` (`reminders.ts:130-135`) | — | ms | **Sí** — una llamada |
| `document.render_receipt` (`handlers.ts:57-64`) | S3 PutObject | sub-segundo | No (pdf-lib) |
| `maintenance.prune_discovery` (`maintenance.ts:67-88`) | — | ms | **Sí** — una llamada |

No hay expresiones cron ni tabla de horarios: la recurrencia se implementa
**reencolándose a sí mismo** (`ics.sync_all` a +6 h en `ics.ts:755-760`,
`prune_discovery` a +7 d en `maintenance.ts:81-86`, la escalada de liquidación a
+3 d en `reminders.ts:115-120`).

### Opción A — Vercel Cron drenando la cola

Un endpoint protegido (cabecera con secreto o `CRON_SECRET` de Vercel) que
ejecute `while (Date.now()-t0 < presupuesto && await runOneJob(pool, handlers, max))`.

- **Pros**: cero infraestructura extra, cero coste adicional, un solo proveedor,
  un solo despliegue. La refactorización es pequeña: extraer un
  `buildHandlers(pool, config)` de las ~35 líneas de `index.ts:74-110` y separar
  el shim de demonio del módulo de librería.
- **Contras**: en plan **Hobby el cron es como máximo diario**, lo que hace
  inservibles los avisos y la sincronización ICS; hace falta **Pro (20 USD/mes)**
  para cadencia por minuto. Latencia de cola igual al periodo del cron.
  `ics.sync_source` con varias fuentes lentas puede rozar el presupuesto de la
  función. Y desaparecen `/health` y `/metrics` del worker.
- **Coste**: 20 USD/mes de Vercel Pro (que probablemente ya quieras por otras
  razones: `maxDuration`, regiones, protección de despliegue).
- **Esfuerzo**: 1,5 – 2 j.

### Opción B — Host aparte ejecutando el worker actual sin cambios

Fly.io (Ámsterdam/Fráncfort), Railway o Render corriendo
`infra/docker/worker.Dockerfile` tal cual.

- **Pros**: **cero cambios de código**. Conserva `/health`, `/metrics`, el
  apagado ordenado y el sondeo de 1 s. Y —clave— es el sitio natural donde
  **también cabe ClamAV**, resolviendo W-2 de paso.
- **Contras**: un proveedor más que administrar, otro sitio donde rotar
  secretos, y una segunda superficie que endurecer.
- **Coste**: Fly.io `shared-cpu-1x` 256 MB ≈ **2 USD/mes** en Ámsterdam;
  Render Starter 7 USD/mes; Railway ~5–15 USD/mes. Un contenedor de ClamAV
  necesita ~1 GB de RAM para la base de firmas, lo que sube Fly a ~10 USD/mes.
- **Esfuerzo**: 0,5 j (más el endurecimiento del host).

### Opción C — `pg_cron` en Supabase para lo que es SQL, y externalizar el resto

`pg_cron` está disponible en Supabase.

- Encajan directamente: **`time_report.autoconfirm`** y
  **`maintenance.prune_discovery`** son una sola llamada a función definer, y
  ambas admiten una variante barredora (`autoconfirm` sin filtro de `id`
  eliminaría el job y su fila programada por parte). **`ics.sync_all`** es puro
  abanico de encolado y también cabe.
- No encajan: `ics.sync_source` (fetch HTTPS con guarda SSRF, `ics.ts:116-219`),
  `notification.*` (SMTP) y `document.render_receipt` (pdf-lib + S3).
- **Pros**: quita 3 de 7 tipos de la cola y elimina el agujero de arranque en
  frío W-5 para esos tres. `pg_cron` es fiable y no cuesta nada.
- **Contras**: parte la lógica en dos lenguajes y dos sitios; las reglas de
  negocio se reparten entre TypeScript y SQL programado. Los reintentos y el
  `dead-lettering` de la cola no aplican a los jobs de `pg_cron`.
- **Esfuerzo**: 1 j, y **sigue haciendo falta A o B** para los otros cuatro.

**Recomendación**: **B para el primer despliegue** (coste marginal, cero riesgo
de regresión, y resuelve ClamAV), evaluando **C** más adelante como
simplificación. A sólo tiene sentido si el objetivo explícito es no administrar
ningún servidor y se acepta pagar Vercel Pro y perder ClamAV.

> **Lo que se hizo, y por qué se separó de esta recomendación.** Ninguna de las
> tres se aplicó tal cual: se implementó **A, pero con el planificador en la
> base en vez de Vercel Cron**. Eso desactiva el único contra serio de A —el
> cron diario del plan Hobby— sin pagar Pro: `pg_cron` dispara con `pg_net` una
> llamada al endpoint cada cinco minutos. La refactorización fue la que este
> apartado anticipaba (`createJobHandlers` extraído a
> `apps/worker/src/registry.ts`, compartido por el demonio y el drenaje), así
> que **B sigue disponible sin cambios**: el demonio no se ha tocado. De C no se
> tomó nada: la lógica de los trabajos sigue entera en TypeScript y la cola
> conserva sus reintentos y su `dead-lettering`. ClamAV queda como estaba —el
> drenaje no lo necesita— y sigue exigiendo un host, que es el motivo por el que
> B no desaparece del mapa. Procedimiento en
> [`../runbooks/planificador-cola.md`](../runbooks/planificador-cola.md).

---

## 6. Adjuntos y ClamAV

> **Resuelto, y por una vía que no estaba en la lista.** Se eligió una variante
> de la opción 1 sin su peaje: el escáner pasó a ser **opcional** en vez de
> anular el paquete entero, con lo que los adjuntos siguen funcionando, la
> lectura queda desacoplada del escaneo y el outbox no se atasca. A cambio se
> reforzó lo que sí se puede comprobar sin antivirus (el tipo real de los bytes
> manda sobre el declarado, y la lectura sale con `nosniff` y CSP `sandbox`).
> El análisis que sigue es el de la auditoría, y sigue siendo válido como
> descripción de por qué las tres opciones originales no convencían.
> Riesgo asumido y reactivación: [security/adjuntos-sin-antivirus.md](../security/adjuntos-sin-antivirus.md).

Cómo está implementada la barrera (`attachments.server.ts:101-165`), en orden:
tamaño ≤ 10 MiB → lista blanca MIME (jpeg/png/webp/pdf) → **comprobación de
bytes mágicos** → sha-256 → **ClamAV** → clave determinista → transacción RLS con
deduplicación idempotente, y el `putObject` **dentro** de la transacción para que
un PUT fallido revierta la fila.

Es **fail-closed**, pero de forma poco elegante: un veredicto `infected` da 422
limpio (`+server.ts:18`), mientras que un ClamAV inalcanzable o con respuesta no
reconocida **no está capturado en ninguna parte** y sale como 500 de SvelteKit.
`attachments.server.ts` no importa ningún logger, así que una caída del antivirus
produce 500 mudos. Nunca se asume «limpio»: hay tests que lo fijan
(`apps/web/tests/attachment-deps.test.ts:85-103`).

**Opciones:**

1. **Desactivar adjuntos en el primer despliegue** (omitir `CLAMAV_HOST`).
   Lo que se degrada, medido: los adjuntos se usan **sólo para justificantes de
   gasto**. Wiki, contactos, emergencias, traspaso, calendario, menú, snapshot y
   expediente laboral **no dependen de ellos** (cero referencias a
   `storage_objects` en sus módulos). La subida devuelve 503, y la tarjeta de
   gastos **degrada con elegancia**: `ExpensesPendingCard.svelte:95-106` captura
   el fallo y registra el gasto con el aviso «El gasto se registra sin
   justificante». **Pero hay dos efectos colaterales serios**: (a) los
   justificantes ya guardados dejan de poder verse, porque la ruta de lectura
   está acoplada al mismo paquete de configuración
   (`receipts/[expenseId]/+server.ts:20-21`) aunque leer no necesite escáner;
   (b) la sincronización offline **se atasca**: un comando con `pendingBlob` no
   sale del outbox hasta que su foto suba (`lib/offline/sync.ts:136-174`), así
   que el gasto se queda indefinidamente en IndexedDB.
   → Si se elige esta vía, hay que **desacoplar la lectura del escaneo** (0,25 j)
   y decidir qué hacer con el outbox.
2. **Servicio externo de escaneo.** La costura está limpia: `scan` es un único
   método de la interfaz `AttachmentDependencies` (`attachments.server.ts:46`)
   con una sola implementación en producción. Sustituirlo por una llamada HTTP a
   un servicio de escaneo es contenido, no invasivo. Coste: el del proveedor, más
   el problema de mandar el fichero fuera de la UE si no se elige con cuidado.
3. **Mantener el worker en un host que sí tenga ClamAV** (opción B de §5).
   La web en Vercel llamaría al `clamd` de ese host por TCP. Requiere exponer el
   puerto 3310 con red privada o autenticación —no en internet abierto— y añade
   latencia a cada subida.

**Recomendación**: 3 si se elige B; si no, 1 con el desacople de lectura,
declarando explícitamente que la primera versión no acepta adjuntos.

---

## 7. Almacenamiento

**Sí, el código usa el SDK de S3** (`@aws-sdk/client-s3` 3.1105.0 en las dos
apps), y usa **exactamente tres operaciones**: `PutObjectCommand`
(`apps/worker/src/integrations.ts:65`, `attachment-deps.server.ts:108`) y
`GetObjectCommand` (`attachment-deps.server.ts:112`). **No hay URLs prefirmadas,
no hay multipart, no hay ACLs, no hay ciclo de vida de bucket.** No están ni
`@aws-sdk/s3-request-presigner` ni `@aws-sdk/lib-storage`.

**Supabase Storage sirve, con alta confianza.** `forcePathStyle: true` está
**cableado** en los dos clientes (`integrations.ts:47`,
`attachment-deps.server.ts:99`), que es justo lo que espera el endpoint S3 de
Supabase. Configuración:

```
S3_ENDPOINT=https://<ref>.supabase.co/storage/v1/s3
S3_REGION=<región del proyecto>     # p. ej. eu-central-1
S3_PRIVATE_BUCKET=<bucket privado>
S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY = credenciales S3 de Supabase
```

Dos matices: (a) la guarda de forma de clave en `putPrivateObject`
(`integrations.ts:62`) debe seguir casando; (b) como las descargas se **proxean**
en vez de firmarse, cada visualización de justificante cuesta una invocación de
función transmitiendo el fichero entero. Pasar a URLs firmadas de Supabase es una
mejora fácil (`getObject` es el único consumidor) y además cierra W-8.

Nota de rendimiento: `createAttachmentDependencies()` construye un `S3Client`
**nuevo por petición** (`attachment-deps.server.ts:96`). En serverless eso suma
al arranque en frío.

---

## 8. Correo

Sólo hay **dos caminos de envío**, ambos con nodemailer crudo, sin SDK de ningún
proveedor:

1. **Worker** (`integrations.ts:102-106`) — para `notification.settlement_due` y
   `notification.routine_due`. Transporte nuevo por correo, sin pool.
2. **Enlace mágico de Better Auth** (`auth.server.ts:14-38`).

Lo que hace falta:

- **W-3 es condición necesaria**: añadir `auth: { user, pass }` y `secure` a
  ambos transportes. Hoy `secure: false` está cableado y no existe ningún
  `SMTP_USER` en el repo. Ningún proveedor alojado acepta eso.
- **Dominio propio y registros DNS**: SPF, DKIM y DMARC. Sin ellos, los enlaces
  mágicos acaban en spam y la app queda inutilizable.
- **W-4**: hacer visible el fallo de envío en los logs.
- El enlace mágico se envía **en línea, bloqueando la respuesta HTTP**
  (`login/+page.server.ts:114-117`, con un `await import('nodemailer')` dinámico
  dentro). El resto del correo va por la cola con reintentos; el de autenticación
  no tiene ni cola ni reintento.

**Proveedores**, todos con SMTP estándar (por tanto sin cambio de código más allá
de W-3):

| Proveedor | Nivel gratuito | De pago | Notas |
| --- | --- | --- | --- |
| Resend | 3 000/mes, 100/día | 20 USD/mes | El más simple para dominio propio; también SMTP |
| Postmark | 100/mes de prueba | 15 USD/mes / 10 000 | Mejor entregabilidad transaccional; separa flujos |
| Amazon SES | — | ~0,10 USD/1 000 | El más barato con diferencia; región `eu-*` disponible; requiere salir del sandbox |

Para el volumen de un hogar (unas decenas de correos al mes), **cualquiera de los
tres cabe en el nivel gratuito o cuesta céntimos**. La elección es de comodidad y
de residencia de datos, no de coste.

---

## 9. Inventario de variables de entorno

No hay un módulo central de validación para todo el sistema. **Sólo el worker
valida al arrancar** (`apps/worker/src/config.ts:40`, invocado en
`index.ts:36`): si falta una clave obligatoria lanza `Falta la variable <KEY>` y
el proceso muere. **La web no valida nada**: todo se lee de forma perezosa por
`$env/dynamic/private` y degrada en silencio (pool `null`, auth `null`, 503).
Esa asimetría es la fuente de la mayoría de fallos silenciosos de esta auditoría.

### 9.1 Obligatorias en producción

| Variable | Componente | Definición | Nota para Vercel/Supabase |
| --- | --- | --- | --- |
| `DATABASE_URL` | web + worker + migraciones | `db.server.ts:13`, `config.ts:42`, `migrate.mjs:89` | **Cambia**: pooler 6543 para web/worker, directa 5432 para migraciones |
| `DATABASE_AUTH_URL` | web | `auth.server.ts:47` | **Cambia**: rol `casa_clara_auth_login`, esquema `casa_auth` (B-4) |
| `BETTER_AUTH_SECRET` | web | `auth.server.ts:47,53` | ≥ 32 bytes aleatorios |
| `BETTER_AUTH_URL` | web | `auth.server.ts:54` | **Cambia**: dominio real. Por omisión `http://localhost:3000` |
| `SNAPSHOT_SIGNING_KEY_B64` | web | `keys.server.ts:28` | **Pasa a obligatoria** en serverless (V-2) |
| `SMTP_HOST` | web + worker | `auth.server.ts:15`, `config.ts:54` | **Cambia**: proveedor real |
| `SMTP_PORT` | web + worker | `auth.server.ts:19`, `config.ts:55` | Por omisión `1025` (Mailpit); poner 587/465 |
| `SMTP_FROM` | web + worker | `auth.server.ts:23`, `config.ts:56` | Dirección del dominio propio |
| `SMTP_USER` / `SMTP_PASS` | web + worker | **no existen todavía** | **Hay que añadirlas** (W-3) |
| `SUPABASE_SERVICE_ROLE_KEY` | web | `supabase-storage.server.ts` | **Nueva**: adjuntos por la API REST de Supabase Storage. Es la única obligatoria para adjuntos en Vercel |
| `S3_ENDPOINT` | worker (y web solo sin Supabase) | `attachment-deps.server.ts`, `config.ts:47` | **Cambia**: endpoint S3 de Supabase |
| `S3_PRIVATE_BUCKET` | worker (y web solo sin Supabase) | `attachment-deps.server.ts`, `config.ts:49` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | worker (y web solo sin Supabase) | `attachment-deps.server.ts`, `config.ts:50-51` | Credenciales S3 de Supabase |
| `S3_REGION` | worker (y web solo sin Supabase) | `attachment-deps.server.ts`, `config.ts:48` | Por omisión `eu-west-1`; poner la del proyecto |

### 9.2 Opcionales con valor por omisión

| Variable | Componente | Por omisión | Definición |
| --- | --- | --- | --- |
| `SUPABASE_URL` | web | deducida de `DATABASE_URL` | `supabase-storage.server.ts` |
| `SUPABASE_STORAGE_BUCKET` | web | `casaclara` | `supabase-storage.server.ts` |
| `CLAMAV_HOST` | web | sin definir ⇒ **sin escaneo** | `attachment-deps.server.ts`. Definirla enciende el antivirus (§6) |
| `CLAMAV_PORT` | web | `3310` | `attachment-deps.server.ts` |
| `WORKER_HEALTH_PORT` | worker | `3001` | `config.ts:43` |
| `WORKER_MAX_JOB_ATTEMPTS` | worker | `5` | `config.ts:44` |
| `WORKER_POLL_INTERVAL_MS` | worker | `1000` | `config.ts:45` |
| `ALLOW_SYNTHETIC_DATA_ONLY` | web + worker | sin definir ⇒ `false` | `synthetic.server.ts:24`, `integrations.ts:78`. **Omitirla es el estado seguro** |
| `ENABLE_DEMO_PASSWORD_AUTH` | web | sin definir ⇒ `false` | `login/+page.server.ts:22`. **No definir en producción** |
| `NODE_ENV`, `HOST`, `PORT` | — | — | Los gestiona Vercel |

Los flags booleanos comparan **estrictamente contra `'true'`**: `TRUE`, `1` o
`yes` cuentan como falso.

### 9.3 Variables que **desaparecen** en Vercel/Supabase

`ORIGIN` (V-6), `HOST`, `PORT`, todo el bloque de Compose
(`POSTGRES_*`, `APP_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `AUTH_DB_PASSWORD`,
`MINIO_*`, `CADDY_*`, `STAGING_HOST`, `RELEASE_TAG`, `GRAFANA_*`,
`PROMETHEUS_PORT`, `BACKUP_RETENTION_DAYS`, `MAILPIT_*`), y las 15 claves
`DEMO_*_{NAME,EMAIL,PASSWORD}` junto con `SEED_DATABASE_URL` (sólo semillas
sintéticas).

Ya hay tres variables **muertas** que conviene borrar de una vez:
`PUBLIC_ORIGIN` (`compose.local.yml:16`), `APP_ENV` (`compose.staging.yml:5`) y
`S3_FORCE_PATH_STYLE` (`compose.local.yml:10`) — esta última porque
`forcePathStyle: true` está cableado en el código.

### 9.4 Sólo pruebas / CI

`TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `E2E_PORT`, `E2E_SHOT_DIR`,
`PLAYWRIGHT_JUNIT_OUTPUT_NAME`, `CI`, `TZ`.

---

## 10. Migración de datos

Punto de partida: **base limpia**. El propietario sólo quiere conservar la Guía
de la casa (importada del manual) y el calendario.

1. **Bootstrap del esquema** (conexión directa 5432, rol `postgres`):
   `pnpm db:migrate` con B-1, B-2 y B-3 ya resueltos, más el SQL de roles de
   login convertido desde `infra/postgres/00-create-roles.sh`, más
   `GRANT casa_clara_app, casa_clara_worker TO postgres;` (B-5).
2. **Better Auth**: crear el esquema `casa_auth`, el rol `casa_clara_auth_login`
   con `search_path`, y correr `runAuthMigrations` (`auth-core.ts:81-84`).
3. **Crear el hogar real y las membresías.** *Esto es un hueco*: hoy sólo existe
   `apps/web/scripts/seed-demo-users.mjs`, que **se niega a ejecutarse** salvo con
   `ENABLE_DEMO_PASSWORD_AUTH=true` **y** `ALLOW_SYNTHETIC_DATA_ONLY=true`
   (`seed-demo-users.mjs:33,39`) — es decir, es explícitamente incapaz de crear un
   hogar de producción. Hay que escribir un procedimiento de alta real
   (SQL guiado o un pequeño comando), y decidir cómo entra la primera cuenta de
   administración dado que `disableSignUp: true` (`auth-core.ts:37`) impide que un
   enlace mágico cree cuentas.
4. **Importar la Guía.** El corpus está versionado
   (`packages/db/content/manual/**`: 59 ficheros Markdown en 7 espacios), así que
   no hay que migrar nada: se reimporta.

   ```bash
   # ensayo, no escribe nada
   DATABASE_URL='<directa 5432>' pnpm --filter @housekeeper/db manual:import -- \
     --household <uuid-del-hogar> --dry-run
   ```

   **Es idempotente de verdad**, y está probado: la migración
   `0017_wiki_import_hash` existe precisamente para eso (guarda el hash sha-256
   del contenido en `wiki_revisions.import_hash` en vez de contaminar el
   `summary`, que es el subtítulo que ve el usuario). Un segundo pase idéntico
   crea 0 revisiones; editar un fichero crea exactamente una revisión en esa
   página. `import-manual.mjs:97-115` ejecuta **siempre** un dry-run del corpus
   antes de escribir nada.

   Tres cautelas:

   - **Requiere conexión directa (5432) y rol propietario**, porque hace
     `set local row_security = off` (`wiki-import.mjs:366`). Depende de la misma
     decisión que B-1.
   - **`manual:import` no importa sólo la Guía.** También ejecuta
     `seed-manual.mjs`, que planta 5 rutinas, el contacto de Emergencias (112) y
     la plantilla de menú semanal. Si sólo se quiere la Guía, invocar
     directamente `node scripts/wiki-import.mjs --household … --membership …
     --dir packages/db/content/manual`.
   - **`manual:import --docx` es destructivo sobre el árbol de trabajo**:
     `convert-manual.mjs:1007` hace `rm -rf` de `content/manual/` antes de
     regenerarlo. No usar ese flag salvo que se quiera reconvertir desde el Word.

   Si la familia ha editado notas en la app desde la última conversión, hay una
   ruta limpia: **el ZIP de traspaso es un corpus válido para el importador**.
   `handover.server.ts:88-135` emite el mismo árbol de carpetas con frontmatter
   que consume `wiki-import.mjs --dir`, y hay un test de ida y vuelta que lo fija
   (`apps/web/tests/handover-roundtrip.integration.test.ts:130`). Es decir:
   descargar el traspaso «familia» de la demo → descomprimir → importar con
   `--dir` en producción.

   Antes de importar conviene revisar los 225 campos «Pendiente de completar por
   la familia» (8 notas siguen en `draft` exactamente por eso): con datos reales,
   esa Guía deja de ser sintética y entra de lleno en la política de retención
   que el ADR 0001 exige.

5. **El calendario**: no hace falta migrar nada, y está confirmado por el
   esquema. No existe ninguna tabla local de eventos —se enumeraron todos los
   `CREATE TABLE` de las 17 migraciones—. Sólo hay tres tablas ICS:
   `app.ics_sources` (la suscripción: url + etiqueta), `app.ics_source_events`
   (caché derivada, migración 0015) y `app.ics_feeds` (los feeds que la app
   *publica*). La caché la reconstruye entera el job `ics.sync_source`:
   `app_private.replace_ics_source_events` poda y reinserta la ventana
   `[hoy−7d, hoy+90d]`, no fusiona.

   **Procedimiento: volver a dar de alta la URL del calendario en la app de
   producción.** El alta encola una sincronización inmediata
   (`commands/rhythm.ts:372-394`), así que el calendario se repuebla en el acto.
   Aprovecha para rotar la URL en Google: la actual ha vivido en una demo.

   **Lo único irrecuperable son los tokens de `app.ics_feeds`**: sólo se guarda
   su sha-256 (`0008:236`). Cualquier URL de suscripción publicada hacia fuera
   hay que reemitirla y volver a repartirla.

6. **Datos de referencia**: los 14 alérgenos de la UE (`app.eu_allergens`) los
   siembra la propia migración `0008:13-27`. No hay nada más que sembrar: la
   migración `0010_wiki_templates` **no crea ninguna plantilla**, sólo añade la
   columna `is_template`; una base nueva tiene cero plantillas y la familia marca
   la suya desde la app.
7. **Nunca ejecutar** `seed-demo-users.mjs` ni cargar
   `packages/db/fixtures/001_two_households.sql` contra producción. La primera se
   niega ella sola; la segunda no la aplica nunca `migrate.mjs` (sólo la cargan
   los arranques de test).
8. **Verificación**: dejar `ALLOW_SYNTHETIC_DATA_ONLY` sin definir y comprobar
   que el banner de datos sintéticos ha desaparecido y que el login por
   contraseña demo devuelve 403.

**Un cabo suelto que conviene saber antes de traspasar nada**: el
`contactos.md` del ZIP de traspaso lee una **fixture cableada**, no
`app.contacts` (`handover.server.ts:201-209`), pese a que `app.contacts` es una
tabla real desde la migración 0013 y `seed-manual.mjs:207` escribe el 112 ahí.
La hoja de contactos del traspaso **no refleja los contactos reales del hogar**.

---

## 11. Plan por fases

### Fase 0 — Publicar el repo (0,5 j)

Cerrar G-1 (huecos de `.gitignore`), decidir G-2 (corpus del manual), y publicar.
No hay nada que reescribir del historial. Mantener el `gitleaks` que ya corre
sobre el historial completo (`.github/workflows/security.yml`).

### Fase 1 — Desbloquear la base de datos (1,5 – 3 j)

Comprobar `rolbypassrls` en un proyecto Supabase real. Resolver B-1, B-2, B-3,
B-4, B-5. Criterio de salida: **17/17 migraciones y 5/5 suites SQL/RLS en verde
contra un Supabase real**, no contra la sonda local.

### Fase 2 — Web en Vercel, sin adjuntos y sin worker (2 – 3 j)

V-1 (adaptador), V-2, V-3, V-6, V-9, W-3 (SMTP con credenciales), W-4.
Correo con dominio propio y DNS. Medir V-5 (tamaños de ZIP) con datos reales.
Criterio de salida: enlace mágico que llega a una bandeja real, login, y las
pantallas de Hoy / Guía / Calendario / Menú funcionando en el dominio definitivo.

### Fase 3 — Worker y trabajos periódicos (1 – 2,5 j)

Ejecutar la decisión de §5. Cerrar W-5 (arranque en frío) y W-6 (dependencias
muertas). Criterio de salida: el calendario se sincroniza solo y llega un aviso
de rutina de verdad.

### Fase 4 — Adjuntos (0,5 – 3 j)

Ejecutar la decisión de §6. Si se aplaza, cerrar al menos el desacople de la
lectura de justificantes y decidir el comportamiento del outbox offline.

### Fase 5 — Cerrar los huecos de CI (1 – 1,5 j)

Añadir `test:e2e:db` al pipeline (18 specs que hoy no corren), dar Postgres a los
tests de integración de `@housekeeper/web` y `@housekeeper/worker`, y disparar
`browser-quality.yml` también en la rama de despliegue. **Puede hacerse en
paralelo con las fases 1-4, y conviene**: son las pruebas que validan justo lo
que estas fases tocan.

**Bloqueo previo del ADR 0001**: revisión legal, política de retención, host UE,
dominio, SMTP y secretos. Este plan cubre los tres últimos; los tres primeros no
son técnicos y siguen pendientes.

---

## 12. CI/CD

### 12.1 Qué hay hoy

Tres workflows, **y ningún despliegue**: `.github/workflows/ci.yml`,
`browser-quality.yml` y `security.yml`. No existe CD; `infra/compose.staging.yml`
se levanta a mano (`docs/runbooks/staging-synthetic.md`).

Lo que ya está bien resuelto y **no hay que rehacer**:

- **Hay servicio de Postgres**, en el job `database` (`ci.yml:64-85`,
  `postgres:18.4-alpine` con `--data-checksums`). Ese job encadena
  `db:migrate` → `test:db` → `test:rls` → tests de `@housekeeper/server` →
  `test:import` → **`db:migrate` otra vez para probar idempotencia**
  (`ci.yml:101-102`).
- **Guardas anti-falso-verde**, que son la mejor parte del expediente.
  `scripts/ci/run-tests-nonempty.sh` falla con código 65 si la salida contiene
  `no tests found` o si **no encuentra un recuento positivo**; y
  `assert-junit-nonempty.py` falla si el JUnit no existe, no parsea o suma cero
  casos. Nacieron de un falso verde real en WSL
  (`docs/architecture/delivery-quality-contract.md:29`).
- **Puerta de bundle**: `apps/web/scripts/verify-today-bundle.mjs` afirma cuatro
  cosas — que `WikiEditor.svelte` no entra en el grafo inicial de Hoy, que sí está
  detrás de un import dinámico, que el JS inicial de Hoy **no pasa de 120 000
  bytes** (`:30-36`), y que la cadena `'Centro Pediátrico Olmo'` (corpus de
  fixtures sólo-servidor) **no se ha filtrado a ningún chunk de cliente**
  (`:49-54`).
- **Lighthouse**: `infra/quality/lighthouserc.json` exige accesibilidad **100
  clavada** (`minScore: 1`), LCP ≤ 2 s, TBT ≤ 200 ms y script ≤ 120 KiB.
- **axe**: `apps/web/e2e/critical.a11y.ts` exige cero violaciones `serious` o
  `critical` en login, Hoy, Emergencias y el panel «Más» móvil.
- **Secretos**: gitleaks sobre el **historial completo** (`fetch-depth: 0`) más
  `pnpm audit --prod --audit-level high` y `dependency-review`.
- **Compose**: `validate-compose.py` exige imágenes con tag fijo (nada de
  `:latest`), healthcheck en todo servicio de larga vida y Postgres `18.*`.

### 12.2 Huecos reales del CI actual (no documentados en ninguna parte)

> **Estado: los huecos 1, 2, 3 y 4 están cerrados.** `.github/workflows/ci.yml`
> ejecuta ahora `test:e2e:db` (job `e2e-database`, 18 specs / 72 pruebas), da
> Postgres a la integración de web y worker (job `integration`), corre las
> baterías de navegador también en push, y emite JUnit del worker por línea de
> órdenes. Además `scripts/ci/assert-suite-coverage.py` falla si vuelve a
> aparecer un fichero de spec que ningún job ejecute. Sigue abierto el hueco 5
> (el presupuesto de `/today` que LHCI no recoge). Lo que sigue se conserva como
> registro de qué faltaba y por qué importaba.

Esto importa para un despliegue porque son las pruebas que **creerías** que te
protegen y no se están ejecutando:

1. **18 de las 27 specs de Playwright nunca corren en CI.** `pnpm test:e2e` es
   `--project=e2e`, que sólo casa `*.e2e.ts`. Los 18 ficheros `*.dbe2e.ts`
   necesitan `playwright.db.config.ts` vía `test:e2e:db`, y **ningún workflow lo
   invoca**. Es la batería de aceptación entera de familia y empleada.
2. **Los tests de integración de web y worker nunca ven una base de datos.**
   Están todos bajo `describe.runIf(Boolean(adminUrl))`, y el job `unit` no tiene
   Postgres. El job `database` sólo ejecuta `@housekeeper/server`, nunca
   `@housekeeper/web` ni `@housekeeper/worker`. Y las guardas anti-falso-verde no
   lo detectan, porque los tests *no* de integración de esos paquetes ya dan un
   recuento positivo.
3. **`browser-quality.yml` no corre en push a `main`** (`:3-5`), sólo en PR.
4. `packages/db` no tiene script `test`, así que `test:unit` se lo salta;
   `apps/worker` no tiene config de vitest, así que no emite JUnit.
5. El presupuesto de `/today` en `infra/quality/lighthouse-budget.json` está
   muerto: LHCI sólo recoge `/login` y `/offline`.

### 12.3 Pipeline propuesto para desplegar

**Lo que debe bloquear un despliegue** (además de todo lo que ya bloquea un PR):

| Puerta | Qué corre | Por qué bloquea |
| --- | --- | --- |
| Análisis estático | `lint`, `typecheck`, `build`, `verify:bundle` | Ya existe |
| Unitarios | `test:unit` con las guardas de recuento | Ya existe |
| **Base de datos** | `db:migrate` desde cero → `test:db` → `test:rls` → `test:import` → `db:migrate` otra vez | Ya existe. **Debe correr contra un Postgres configurado como Supabase** (propietario no superusuario) o dejará de detectar B-1 y B-2 |
| **E2E con base de datos** | `test:e2e:db` — **hueco 1**, hay que añadirlo | Es la única prueba de que los 5 roles ven lo que deben bajo RLS real |
| Integración web + worker | `@housekeeper/web` y `@housekeeper/worker` con `TEST_DATABASE_URL` — **hueco 2** | Hoy son inertes |
| Navegador | `test:e2e`, `test:a11y`, `test:lighthouse` | Existe, pero hay que dispararlo también en la rama de despliegue |
| Seguridad | gitleaks historial completo, `pnpm audit`, dependency-review | Ya existe |
| **Migraciones en producción** | `db:migrate` contra Supabase por **conexión directa**, como paso previo y separado del despliegue de la web | El runner usa `pg_advisory_lock` de sesión: no puede ir por el pooler |
| **Humo post-despliegue** | `GET /api/health` y un login de enlace mágico real | Un SMTP mal configurado **no da error visible** (W-4) |

Dos avisos de fontanería para el workflow de despliegue:

- El repo fija Node **24.18.0** y pnpm **10.17.1** (`.github/actions/setup`,
  `package.json` `engines: node >=24 <25`). Vercel tiene que ofrecer un runtime
  compatible o habrá que relajar `engines`.
- Vercel construye desde el repo: hay que configurar *root directory* y comando
  de build para un monorepo pnpm con dependencias `workspace:*`, y evitar que el
  build de Vercel sea el único que nunca pasa por `verify:bundle`.

Recomendación de orden: **migraciones primero, despliegue después**, con paso
manual de aprobación entre ambos mientras B-1 siga sin estar cerrado. Y mantener
staging sintético como exige `docs/acceptance/brief-v2-adapted.md:59-61`: cero
defectos P0/P1, con los artefactos de CI como evidencia.

### 12.4 Copias de seguridad

Existe tooling (`infra/backup/db-backup.sh` con `pg_dump --format=custom
--compress=zstd:9`, verificación con `pg_restore --list` antes de publicar, y
sha256), y un ensayo de restauración que nunca toca la base viva
(`docs/runbooks/backup-restore.md:28-51`). Pero el propio runbook avisa en su
línea 3: *«No es un diseño de backup de producción»*, y su limitación conocida
(`:21`) es que el volumen vive en el mismo host. **En Supabase esto cambia de
naturaleza**: el plan Pro trae copias diarias gestionadas y PITR de pago. Lo que
sigue faltando —y el ADR 0001 lo exige— es una copia cifrada fuera del proveedor
y un RPO/RTO acordado. El script de `pg_dump` sigue siendo útil exactamente para
eso, apuntado a la conexión directa de Supabase.

---

## 13. Decisiones que necesita tomar el propietario

Ninguna de estas es de gusto: todas cambian la arquitectura, el coste o el perfil
de riesgo, y ninguna se puede tomar desde el código.

1. **¿Se acepta perder `FORCE ROW LEVEL SECURITY` si el `postgres` de Supabase no
   tiene `BYPASSRLS`?** (B-1). Es *la* decisión del expediente. Aceptarlo cuesta
   medio día y debilita la capa exterior de defensa —no el aislamiento entre
   inquilinos—. Rechazarlo obliga a reescribir diez funciones definer (3–5
   jornadas tocando el corazón del modelo de seguridad) o a abandonar Supabase
   por un Postgres donde sí haya superusuario.

2. **¿Dónde vive el worker?** Vercel Cron (0 € extra pero exige Vercel Pro y
   deja la cadencia atada al cron), host aparte tipo Fly.io (~2 USD/mes, cero
   cambios de código, y es donde también cabría ClamAV), o partirlo entre
   `pg_cron` y algo externo. Determina el coste recurrente y cuántos proveedores
   hay que administrar.

3. **¿Qué pasa con los adjuntos en la primera versión?** Desactivarlos (con dos
   efectos colaterales que hay que arreglar: los justificantes ya guardados dejan
   de verse y el outbox offline se atasca), pagar un servicio de escaneo externo,
   o mantener ClamAV en el host del worker. Afecta a lo que la interna puede
   hacer desde el móvil el primer día.

4. **¿Supabase Free o Pro?** Free pausa el proyecto tras 7 días de inactividad
   —inaceptable para una app doméstica— y da 500 MB. Pro son 25 USD/mes con
   copias diarias y sin pausas. Súmale ~20 USD de Vercel Pro si eliges la opción
   A del worker.

5. **¿Se publica el corpus del manual?** (G-2). No hay dirección, nombres ni
   códigos, pero describe la distribución real de la vivienda planta por planta y
   los suelos por estancia. Alternativa: repo público con fixtures sintéticas y
   el corpus real en un repo privado.

6. **¿Qué proveedor de correo y qué dominio?** Sin dominio propio con SPF/DKIM/
   DMARC, los enlaces mágicos van a spam y la app es inusable. Resend es lo más
   cómodo, SES lo más barato, Postmark el de mejor entregabilidad.

7. **¿Región y residencia de datos?** El ADR 0001 exige host UE. Supabase debe
   crearse en `eu-central-1` o `eu-west-*`, Vercel fijar `regions: ['fra1']` o
   `['cdg1']`, y el proveedor de correo tiene que tener endpoint europeo. Si se
   externaliza el escaneo antivirus, también.

8. **¿Cómo entra la primera cuenta de administración?** `disableSignUp: true`
   (`auth-core.ts:37`) impide que un enlace mágico cree cuentas, y el único
   sembrador existente se niega a correr fuera de un entorno declarado sintético.
   Hace falta un procedimiento de alta de producción que hoy no existe.

9. **¿Se rota la URL secreta del calendario de Google?** No está filtrada —se ha
   verificado objeto a objeto en todo el historial de git— pero ha vivido en una
   demo. Rotarla al migrar es gratis.

10. **¿Se acepta que la primera versión no tenga métricas ni `/health` reales?**
    En serverless los contadores de proceso pierden sentido (V-4). Si se quiere
    observabilidad, hay que elegir destino (OTel, Logtail, Grafana Cloud) y eso
    es otro proveedor y otro coste.

11. **¿Se despliega antes o después de cerrar los huecos de CI?** Hoy la batería
    de aceptación de los 5 roles bajo RLS real (18 specs `*.dbe2e.ts`) **no se
    ejecuta en ningún workflow**, y los tests de integración de web y worker son
    inertes porque su job no tiene base de datos. Es cerrable en 1–1,5 jornadas.
    Desplegar antes significa migrar a Supabase sin la red que valida
    precisamente lo que la migración toca.

12. **¿Qué se hace con las copias de seguridad?** El plan Pro de Supabase trae
    copias diarias gestionadas, pero el ADR 0001 exige política de retención y el
    propio runbook admite que lo actual «no es un diseño de backup de
    producción». Hace falta decidir RPO/RTO y si hay copia cifrada fuera del
    proveedor.

---

## 14. Resumen de esfuerzo

| Fase | Contenido | Esfuerzo |
| --- | --- | --- |
| 0 | Publicar el repo | 0,5 j |
| 1 | Desbloquear Supabase (B-1 … B-5) | 1,5 – 3 j |
| 2 | Web en Vercel + correo | 2 – 3 j |
| 3 | Worker | 1 – 2,5 j |
| 4 | Adjuntos | 0,5 – 3 j |
| 5 | Huecos de CI (en paralelo) | 1 – 1,5 j |
| | **Total** | **6,5 – 13,5 jornadas** |

Coste recurrente mínimo estimado: **Supabase Pro 25 USD/mes** + **Fly.io ~2–10
USD/mes** para el worker (o Vercel Pro 20 USD/mes si se elige la opción A) +
correo (0 USD en el nivel gratuito de Resend o SES para este volumen).
Entre **27 y 55 USD/mes** según las decisiones 2, 3 y 4.

---

## Anexo — cómo reproducir las pruebas de esta auditoría

Se usó una base desechable, sin tocar el puerto 4381 ni `housekeeper_docs`:

```bash
export PATH=/tmp/codex-node24/bin:$PATH
export PGBIN=/tmp/housekeeper-pg18.mwJavm/root/usr/lib/postgresql/18/bin
export LD_LIBRARY_PATH=/tmp/housekeeper-pg18.mwJavm/root/usr/lib/x86_64-linux-gnu

# 1. Rol que imita al `postgres` de Supabase
$PGBIN/psql "postgresql://casa_admin@127.0.0.1:54329/postgres" -c \
  "CREATE ROLE sb_postgres LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS NOREPLICATION;"
$PGBIN/psql "postgresql://casa_admin@127.0.0.1:54329/postgres" -c \
  "CREATE DATABASE housekeeper_deploy_probe OWNER sb_postgres;"

# 2. Extensiones donde las pone Supabase
$PGBIN/psql "postgresql://casa_admin@127.0.0.1:54329/housekeeper_deploy_probe" -c \
  "CREATE SCHEMA extensions; CREATE EXTENSION unaccent SCHEMA extensions; CREATE EXTENSION pg_trgm SCHEMA extensions;"

# 3. Migraciones -> falla en 0006 (B-1) y luego en 0007 (B-2)
DATABASE_URL="postgresql://sb_postgres@127.0.0.1:54329/housekeeper_deploy_probe" \
  node packages/db/scripts/migrate.mjs

# 4. Suites SQL/RLS (pasan 5/5 una vez resueltos B-1, B-2 y B-5)
TEST_DATABASE_URL="postgresql://sb_postgres@127.0.0.1:54329/housekeeper_deploy_probe" \
  node packages/db/scripts/run-sql-tests.mjs
```

Limpieza: `DROP DATABASE housekeeper_deploy_probe; DROP ROLE sb_postgres;`.
