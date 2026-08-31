# El esquema de Housekeeper en Supabase

> Qué cambia respecto al despliegue autogestionado con Docker Compose, qué
> garantías de aislamiento se mantienen y con qué pruebas se demuestran.
>
> Resuelve los bloqueantes B-1 … B-5 de
> [`plan-vercel-supabase.md`](plan-vercel-supabase.md) §3.1, más una
> incompatibilidad que aquella auditoría no había detectado (§4 de este
> documento). Nada de lo que sigue está deducido: todo se ejecuta en la sonda
> `pnpm --filter @housekeeper/db probe:supabase`.

---

## 1. Instalación desde cero

Tres pasos, siempre por **conexión directa (5432)** y con el rol propietario del
esquema — nunca por el pooler, porque el runner usa `pg_advisory_lock` de sesión:

```bash
export DATABASE_URL='postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres'
export APP_DB_PASSWORD=… WORKER_DB_PASSWORD=… AUTH_DB_PASSWORD=…

pnpm --filter @housekeeper/db bootstrap   # roles, casa_auth y compatibilidad de extensiones
pnpm --filter @housekeeper/db migrate     # las 18 migraciones
pnpm --filter @housekeeper/db test:db     # opcional: las 5 suites SQL/RLS contra el proyecto real
```

El orden importa: `0001` ya concede sobre `casa_clara_app` y `casa_clara_worker`
(nombres legados del proyecto anterior; ver
[docs/despliegue/identificadores-legado.md](identificadores-legado.md)), así
que esos roles tienen que existir antes de la primera migración.

En Docker Compose no hay que hacer nada distinto de siempre: el mismo
`bootstrap.sql` lo aplica `infra/postgres/00-create-roles.sh` desde
`docker-entrypoint-initdb.d`, y compose lo monta en `/opt/housekeeper/bootstrap.sql`.

---

## 2. Qué cambia respecto al despliegue autogestionado

| # | Autogestionado | Supabase | Dónde |
| --- | --- | --- | --- |
| 1 | El propietario del esquema es superusuario y las tablas están en `FORCE ROW LEVEL SECURITY` | El propietario no puede puentear RLS, así que la migración `0018` levanta el **forzado** (no la RLS) | `packages/db/migrations/0018_rls_force_compat.sql` |
| 2 | `unaccent` y `pg_trgm` se instalan en `public` desde `0007` | Vienen preinstaladas en `extensions`; el bootstrap crea en `public` el diccionario y la función que `app.unaccent_es` espera | `packages/db/scripts/sql/bootstrap.sql` §5 |
| 3 | `similarity()` y `gin_trgm_ops` resuelven solos porque `pg_trgm` está en `public` | El bootstrap añade el esquema de las extensiones al `search_path` de los roles propios | `bootstrap.sql` §6 |
| 4 | Los roles de login los crea el arranque del contenedor de Postgres | Los crea `pnpm bootstrap` con un rol `CREATEROLE`, sin superusuario | `packages/db/scripts/bootstrap.mjs` |
| 5 | Better Auth escribe en un esquema llamado `auth` | Se llama `casa_auth`: en Supabase `auth` es de GoTrue | `bootstrap.sql` §4 |
| 6 | El rol de migraciones puede `SET ROLE` por ser superusuario | El bootstrap le concede **pertenencia** a `casa_clara_app` y `casa_clara_worker` | `bootstrap.sql` §3 |

Lo que **no** cambia: las 18 migraciones son las mismas y en el mismo orden, los
mismos `GRANT`/`REVOKE`, las mismas políticas RLS, las mismas funciones definer y
las mismas cinco suites de prueba. No hay una rama «Supabase» del esquema.

### 2.1 El forzado de RLS, en detalle

`SET row_security = off` dentro de una función `SECURITY DEFINER` — el patrón de
las diez funciones de `0006`, `0007`, `0009`, `0012` y `0015` — falla **en el
`CREATE FUNCTION`** si la tabla está forzada y el propietario no tiene
`BYPASSRLS`. La instalación desde cero muere en `0006` con
`query would be affected by row-level security policy for table "settlements"`.

`0018` recorre las tablas de `app` y `app_private` y les quita el forzado, con
dos condiciones:

- **Sólo si el rol conectado no puede puentear RLS** (`NOT (rolsuper OR
  rolbypassrls)`). En el clúster local y en CI el propietario es superusuario, la
  migración no toca nada y `FORCE` se conserva. No se degrada lo que no hace
  falta degradar.
- **Sólo sobre tablas cuyo propietario sea ese rol**, así que nunca alcanza a
  objetos de Supabase.

El runner (`packages/db/scripts/migrate.mjs`) ejecuta ese mismo fichero **antes
de cada migración pendiente** cuando el rol carece de `BYPASSRLS`. Hace falta
porque `0005`, `0007`, `0008`, `0013`, `0014`, `0015` y `0016` vuelven a forzar y
hay que relajar entre una migración y la siguiente: una migración `0018` que
corriese sólo al final llegaría tarde para una instalación desde cero. Reutiliza
el fichero de la migración en vez de duplicar el bloque, así que hay una sola
fuente de verdad.

---

## 3. Qué garantías de aislamiento se mantienen, y cómo se demuestran

`FORCE ROW LEVEL SECURITY` somete **al propietario de la tabla** a sus propias
políticas. No tiene ningún efecto sobre quien no es propietario. Levantarlo
debilita una capa de defensa en profundidad frente a un error del rol de
migraciones; **no** toca el aislamiento entre hogares, que es lo que separa a la
familia de la empleada y a un hogar de otro.

Eso deja de ser una afirmación y pasa a ser una prueba en
`packages/db/tests/020_rls_matrix.sql`, que ahora abre con un bloque
**estructural** y cierra con uno **de comportamiento**.

### 3.1 Estructural — por qué el forzado no les afectaba

Para `casa_clara_app` y `casa_clara_worker`, la matriz falla si alguna de estas
tres deja de ser cierta:

1. Ninguno tiene `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole` ni
   `rolreplication`.
2. Ninguno posee tablas de `app`/`app_private`, ni puede actuar como el rol que
   las posee (`pg_has_role(…, relowner, 'USAGE')` y `'MEMBER'`, que cubre tanto
   la herencia como `SET ROLE`). Sin propiedad, `FORCE` era irrelevante para
   ellos desde el principio.
3. Todas las tablas de `app`/`app_private` siguen con RLS **activada**.

### 3.2 De comportamiento — qué siguen sin poder hacer

Tres intentos que deben fallar con `SQLSTATE 42501` bajo `SET ROLE
casa_clara_app`, y dos más bajo `casa_clara_worker`:

| Intento | Resultado exigido |
| --- | --- |
| `SET LOCAL row_security = off` y leer `app.settlements` | `query would be affected by row-level security policy` |
| `ALTER TABLE app.settlements NO FORCE ROW LEVEL SECURITY` | `must be owner of table settlements` |
| `ALTER TABLE app.settlements DISABLE ROW LEVEL SECURITY` | `must be owner of table settlements` |
| worker: `row_security = off` sobre `app_private.job_queue` | `query would be affected by row-level security policy` |
| worker: `NO FORCE` sobre `app_private.job_queue` | `must be owner of table job_queue` |

Es decir: la latitud que `0018` concede al propietario del esquema es
**exactamente** lo que los roles de ejecución siguen sin poder alcanzar, ni
usándola ni recuperándola.

### 3.3 El resto de la matriz, sin cambios

Encima de eso siguen corriendo las aserciones que ya existían y que son las que
miden el efecto observable: los cinco roles del brief (`family_admin`,
`family_member`, `employee_live_in`, `helper`, `viewer`) bajo un contexto del
hogar *roble*, cada uno con su recuento exacto de filas visibles y con **cero
filas del hogar *olivo***; el `INSERT` cruzado que debe ser rechazado; la
membresía caducada que no se puede seleccionar; y el contrato del worker, que ve
su cola y no ve ni liquidaciones ni contenido de la guía.

### 3.4 El invariante de esquema

`tests/010_schema_and_constraints.sql` exige ahora dos cosas por separado:

- **RLS activada en todas** las tablas de `app`/`app_private`. Absoluto, en todo
  despliegue.
- El estado de `FORCE` **uniforme y coherente** con la capacidad del propietario:
  puesto en todas donde ese rol puede puentear RLS, quitado en todas donde no.
  Un estado a medias — que dejaría una migración futura sin poder aplicarse — es
  rojo.

---

## 4. La incompatibilidad que faltaba en la auditoría: `pg_trgm`

`plan-vercel-supabase.md` recoge `unaccent` (B-2) pero no `pg_trgm`, y da el
mismo problema por una vía distinta. Comprobado con el rol de la sonda:

```
CREATE INDEX … USING gin (title gin_trgm_ops);
--> ERROR: operator class "gin_trgm_ops" does not exist for access method "gin"
SELECT similarity('hola', 'hala');
--> ERROR: function similarity(unknown, unknown) does not exist
```

Afecta al índice trigram de `0007:125` (fallo de migración) y, en tiempo de
ejecución, a `packages/server/src/wiki-search.ts` y
`apps/web/src/lib/server/wiki.server.ts`, que llaman a `similarity()` y
`word_similarity()` sin cualificar. La solución de `unaccent` no sirve aquí: no
hay forma razonable de envolver una clase de operadores.

El bootstrap añade el esquema de la extensión al `search_path` de los roles que
administramos (`ALTER ROLE … IN DATABASE … SET search_path TO "$user", public,
extensions`), que es lo mismo que hace Supabase de fábrica. La sonda lo verifica
**con el rol de la aplicación**, no con el propietario, ejecutando
`similarity()` y `app.unaccent_es()` como `casa_clara_app_login`.

### 4.1 `unaccent`, y por qué no cabía en una migración

`app.unaccent_es` (`0007:8-16`) invoca
`public.unaccent('public.unaccent'::regdictionary, …)`. En Supabase la extensión
está en `extensions`, `CREATE EXTENSION IF NOT EXISTS unaccent` no hace nada y
`ALTER EXTENSION … SET SCHEMA` da `must be owner of extension`.

El arreglo tiene que correr **antes** de `0007`, así que una migración nueva
llegaría tarde; y `0007` ya está aplicada con su checksum en los despliegues
existentes, así que editarla abortaría el runner. Por eso vive en el bootstrap,
que crea en `public`:

- un diccionario `public.unaccent` clonado del de la extensión, **con sus mismas
  opciones** (`dictinitoption`), no con valores por omisión;
- una función `public.unaccent(regdictionary, text)` que delega en la real.

`app.unaccent_es` sigue siendo `IMMUTABLE` y sigue devolviendo lo mismo, así que
las columnas generadas y los índices de expresión de `0007` **no hay que
reconstruirlos**. La sonda lo comprueba con un texto acentuado.

---

## 5. El resto del §Supabase, revisado

| Punto | Estado |
| --- | --- |
| `GRANT`/`REVOKE` a `casa_clara_app` / `casa_clara_worker` | Funcionan sin superusuario. `0001` revoca de `PUBLIC` en `app` y `app_private`, así que `anon` no ve nada |
| `anon`, `authenticated`, `service_role` | Presentes en la sonda; no interfieren. Aun así, en el panel de Supabase *Exposed schemas* debe quedarse en `public` para que PostgREST no publique `app` |
| `CREATE EXTENSION IF NOT EXISTS` en `0007` | No falla: con la extensión ya instalada en otro esquema es un no-op |
| Propiedad de objetos | Todo lo que crean las migraciones queda del rol que migra. `0018` sólo toca tablas de ese propietario |
| `gen_random_uuid()` | Es de `pg_catalog` desde PG13; no depende de `pgcrypto` ni del `search_path` |
| B-5 (pertenencia a los grupos) | La concede el bootstrap. Sin ella `SET ROLE` falla y la matriz RLS no se puede ejecutar contra el proyecto |
| Esquema `auth` de GoTrue | Intacto: el renombrado de un despliegue existente exige `nspowner = casa_clara_auth_login`, así que nunca alcanza al de Supabase |

---

## 6. La sonda

`packages/db/scripts/probe-supabase.mjs` (`pnpm --filter @housekeeper/db
probe:supabase`) reproduce en el Postgres local las tres condiciones que separan
un proyecto Supabase recién creado del despliegue autogestionado:

1. rol propietario `NOSUPERUSER`, `NOBYPASSRLS`, con sólo `CREATEROLE` y `CREATEDB`;
2. `unaccent` y `pg_trgm` preinstaladas en `extensions` y de otro dueño;
3. `anon`, `authenticated` y `service_role` ya creados.

Y sobre eso instala **todo**: bootstrap, las 18 migraciones, una segunda pasada
para la idempotencia, las 5 suites SQL/RLS, la comprobación de búsqueda con el
rol de la aplicación y el recuento final de RLS.

Antes de empezar comprueba que no se está engañando: si el rol resulta ser
superusuario, tener `BYPASSRLS` o resolver ya `public.unaccent`, aborta en vez de
dar un verde vacío.

```bash
PROBE_ADMIN_URL='postgresql://casa_admin@127.0.0.1:54329/postgres' \
  pnpm --filter @housekeeper/db probe:supabase
```

Con `--keep` conserva la base para inspeccionarla. Los roles de grupo son
globales del clúster: en vez de recrearlos, la sonda reproduce con un
`GRANT … WITH ADMIN OPTION` el estado al que llega Supabase, donde los crea el
propio rol `postgres` y por eso obtiene esa opción (PG16+).

---

## 7. Lo que sigue sin estar comprobado contra un proyecto real

- **`rolbypassrls` del `postgres` de tu proyecto.** Si resultara tenerlo, `0018`
  no hace nada y `FORCE` se conserva tal cual: la solución no obliga a renunciar
  a nada donde no hay que renunciar.
- El renombrado `auth` → `casa_auth` sobre un despliegue **con datos** sólo se ha
  ejercitado en local. En Supabase se parte de base limpia, así que el camino que
  importa es el de creación.
- La sonda corre contra PostgreSQL 18.4; Supabase va por 15 o 17 según cuándo se
  creara el proyecto. El único punto con sintaxis exclusiva de PG16+ — el
  `GRANT … WITH INHERIT FALSE, SET TRUE` que permite crear `casa_auth` con
  `AUTHORIZATION` — está detrás de una comprobación de `server_version_num`,
  pero esa rama no se ha ejecutado contra un PG15 de verdad.
