# Runbook de despliegue — web en Vercel, base en Supabase, worker en host aparte

> Procedimiento de punta a punta. El **porqué** de cada decisión está en
> [`plan-vercel-supabase.md`](plan-vercel-supabase.md); aquí solo está el
> **cómo**, en el orden en que hay que hacerlo.
>
> Topología:
>
> | Pieza | Dónde | Por qué ahí |
> | --- | --- | --- |
> | Web (SvelteKit) | Vercel, región `fra1` | Ninguna ruta necesita estado en proceso ni larga duración |
> | Base de datos | Supabase, región UE | Postgres gestionado con copias del proveedor |
> | Adjuntos | Supabase Storage (API REST, clave de servicio) | Sin claves que crear a mano; el bucket lo crea la app, privado |
> | Cola de trabajos | Host aparte (§4.1–§4.5) **o** `pg_cron` llamando a la web (§4.6) | El demonio conserva `/health` y el sondeo de 1 s; el planificador en la base no cuesta nada ni añade proveedor |
> | ClamAV | **No desplegado** | No cabe en serverless y no hay host propio. Opcional: [adjuntos-sin-antivirus.md](../security/adjuntos-sin-antivirus.md) |
>
> **Bloqueo previo del ADR 0001**: revisión legal, política de retención y
> residencia UE. Este runbook cubre la residencia; los otros dos no son
> técnicos y siguen siendo decisión del propietario.

---

## 0. Antes de empezar

- [ ] Repositorio **privado** en GitHub.
- [ ] Dominio propio. **Sin proveedor de correo**: la aplicación no manda
      correo a nadie (migración 0029) y el acceso es por contraseña, así que no
      hay SPF, DKIM ni DMARC que configurar para ella.
- [ ] Un gestor de contraseñas donde guardar lo que se genere en §1.
- [ ] `pnpm install` y el repo en verde: `pnpm lint`, `pnpm --filter web check`,
      `pnpm test:unit`, `pnpm --filter web verify:bundle`.

Secretos a generar (una vez, y guardar):

```bash
openssl rand -base64 48                     # BETTER_AUTH_SECRET
openssl genpkey -algorithm ed25519 | base64 -w0   # SNAPSHOT_SIGNING_KEY_B64
openssl rand -hex 32                        # CLAMAV_TOKEN / CLAMAV_GATEWAY_TOKEN (solo con antivirus)
```

`SNAPSHOT_SIGNING_KEY_B64` **no es opcional en Vercel**: sin ella cada
instancia genera una clave efímera propia y el snapshot offline deja de
verificar entre invocaciones.

---

## 1. Crear el proyecto de Supabase (región UE)

1. Proyecto nuevo en `eu-central-1` (Fráncfort) o `eu-west-*`. **ADR 0001: la
   región no es negociable.** Es irreversible: un proyecto no se cambia de
   región.
2. Plan: **Free pausa el proyecto tras 7 días de inactividad**, lo que para una
   app doméstica significa que la interna se encuentra la app muerta un lunes.
   Decisión del propietario (§13.4 del plan).
3. Comprobación que decide el resto del despliegue —el bloqueante B-1—:

   ```sql
   select rolname, rolsuper, rolbypassrls, rolcreaterole
     from pg_roles where rolname in ('postgres','service_role');
   ```

   - **Con `rolbypassrls = true`**: no hay nada que hacer, sigue en §2.
   - **Sin `BYPASSRLS`**: las migraciones fallan al CREAR las diez funciones
     `SECURITY DEFINER` que hacen `SET row_security = off`. Hay que resolver
     B-1 (una migración que quite `FORCE ROW LEVEL SECURITY` de las tablas que
     esas funciones tocan) antes de continuar. **Ese trabajo no está en este
     runbook**: pertenece a la Fase 1 del plan.
4. Panel → *API settings* → **Exposed schemas**: dejar solo `public`. El
   esquema `app` no debe ser accesible por PostgREST.

---

## 2. Aplicar el esquema

Todo este paso va por **conexión directa (5432)** con el rol propietario: el
runner de migraciones toma un `pg_advisory_lock` de SESIÓN, que el pooler en
modo transacción no conserva.

```bash
export DIRECTA='postgresql://postgres:CLAVE@db.PROYECTO.supabase.co:5432/postgres'
```

1. **Roles de login.** `infra/postgres/00-create-roles.sh` es un script de
   `docker-entrypoint-initdb.d` y en Supabase no hay ese enganche: hay que
   ejecutar su SQL a mano una vez (bloqueante B-3), con dos ajustes:
   - el esquema de Better Auth se llama `casa_auth`, no `auth` (en Supabase
     `auth` es de GoTrue) — bloqueante B-4;
   - añadir `grant casa_clara_app, casa_clara_worker to postgres;` (nombres
     legados del proyecto anterior; ver
     [docs/despliegue/identificadores-legado.md](identificadores-legado.md))
     para poder ejecutar la suite RLS (B-5).
2. **Migraciones.**

   ```bash
   DATABASE_URL="$DIRECTA" pnpm db:migrate
   ```

   Criterio de salida: la última migración aplicada es `0037_finance_endurecimiento.sql`
   y el runner no deja ninguna pendiente (imprime el recuento al terminar; la
   numeración tiene huecos históricos, así que el número total no es el del
   último fichero). Repetir el comando debe
   aplicar 0: la idempotencia es parte del contrato.
3. **Suites SQL y RLS** contra el proyecto real, no contra una sonda local:

   **SOLO PARA UN PROYECTO RECIÉN CREADO Y VACÍO**: `run-sql-tests.mjs` hace
   `DROP SCHEMA app CASCADE` y recarga fixtures; contra una base poblada borra
   la casa entera.

   ```bash
   TEST_DATABASE_URL="$DIRECTA" pnpm test:db
   TEST_DATABASE_URL="$DIRECTA" pnpm test:rls
   ```

   Criterio de salida: **todas las suites de `packages/db/tests/` en `ok`**,
   incluida la de RLS de finanzas (`030_finance_rls.sql`); el runner imprime
   cuántas ha ejecutado. Si la matriz RLS falla, PARAR:
   es el aislamiento entre roles lo que está fallando.
4. **Better Auth**: crear el esquema `casa_auth`, el rol
   `casa_clara_auth_login` con `alter role … set search_path to casa_auth`, y
   correr `runAuthMigrations`.
5. **Finanzas no añade variables de entorno**: SheetJS vive solo en el servidor
   y los extractos no se persisten, así que no hay bucket ni clave nuevos. Lo
   único que traen la 0036 y la 0037 es el esquema, su RLS de doble cerrojo y
   el endurecimiento. La carga de los datos históricos es una migración única
   aparte, con su propio runbook:
   [`../runbooks/migracion-home-finance.md`](../runbooks/migracion-home-finance.md) —
   **no se ejecuta sin confirmación explícita del propietario**.

---

## 3. Almacenamiento de adjuntos en Supabase Storage

La web elige el almacén sola: **si hay clave de servicio de Supabase usa
Supabase Storage por su API REST**; si no, usa S3 con las `S3_*`. Sin ninguno de
los dos, adjuntar responde 503 con un mensaje veraz en vez de fingir que sube.

### 3.1 Camino recomendado: Supabase Storage por su API REST

**Un solo paso manual, y es copiar y pegar.** No hay que crear el bucket ni
generar credenciales: la clave de servicio ya existe en cualquier proyecto de
Supabase y el bucket lo crea la propia app, privado, en la primera subida.

1. Panel de Supabase → **Project Settings → API Keys**.
2. Copiar la clave **secreta**. Según la edad del proyecto aparece como
   `service_role` (un JWT largo que empieza por `eyJ…`) o como
   `sb_secret_…`. Las dos sirven. **No** es la `anon` / `publishable`.
3. Vercel → *Project Settings → Environment Variables* → *Production*:

   ```
   SUPABASE_SERVICE_ROLE_KEY=<la clave secreta copiada>
   ```

4. Redesplegar y subir un justificante desde la app. Eso es todo.

Opcionales, solo si hace falta salirse de lo previsto:

```
SUPABASE_URL=https://PROYECTO.supabase.co   # si no, se deduce de DATABASE_URL
SUPABASE_STORAGE_BUCKET=casaclara           # por omisión, `casaclara`
```

> **Esa clave salta la RLS de Storage.** Va solo al servidor, jamás al
> navegador, y el control de acceso real de los justificantes no lo hace el
> bucket sino `app.storage_objects` + `app.documents` bajo RLS, igual que antes.

**Verificación de que el bucket nació bien**: Supabase → Storage → el bucket
`casaclara` debe aparecer con **Public: No**. Si por lo que sea se hubiera
creado público, cambiarlo ahí mismo.

**Acoplamiento que hay que recordar**: al crearlo, la app le pone al bucket el
mismo límite de tamaño y la misma lista de tipos que aplica la tubería. Esos
valores se fijan **una vez**, así que si algún día se admite un tipo nuevo de
justificante hay que ampliarlo también en Storage → el bucket → *Edit bucket*.
Si no, la subida fallará con un 503 honesto que no explicará por qué.

### 3.2 Camino alternativo: compatibilidad S3

Sigue soportado y es el que usa el worker (copias de seguridad) y Compose con
MinIO. El SDK de S3 se carga **bajo demanda**, así que en el camino de 3.1 no se
evalúa y no se paga en el arranque en frío de la función.

1. Storage → **New bucket** → nombre `casaclara`, **Public bucket: NO**.
2. Storage → *S3 access keys* → generar par de credenciales.
3. Variables (van a Vercel **y** al host del worker):

   ```
   S3_ENDPOINT=https://PROYECTO.supabase.co/storage/v1/s3
   S3_REGION=eu-central-1          # la región REAL del proyecto: entra en la firma SigV4
   S3_PRIVATE_BUCKET=casaclara
   S3_ACCESS_KEY_ID=…
   S3_SECRET_ACCESS_KEY=…
   ```

El worker necesita **siempre** las `S3_*`: `pnpm backup:full` usa
`ListObjectsV2`, que no está en el camino REST.

### 3.3 Política de acceso: los ficheros no son públicos NUNCA

- El bucket es privado y no lleva ninguna política que permita lectura anónima.
- Las credenciales (clave de servicio o par S3) solo las tienen la web y el
  worker; no viajan al navegador.
- Los justificantes se sirven **proxeados** por
  `/api/v1/households/[id]/receipts/[expenseId]`, que exige sesión, comprueba
  la pertenencia al hogar y deja que RLS decida la fila. Sin fila, 404 —sin
  distinguir «no existe» de «no te toca»—.
- Esa ruta sirve el objeto **en flujo**, no materializado: una función de
  Vercel no puede devolver más de 4,5 MB de golpe y un justificante llega a
  10 MiB.
- Sale con `X-Content-Type-Options: nosniff` y
  `Content-Security-Policy: default-src 'none'; sandbox`, y con el `content-type`
  **deducido de los bytes** del fichero, no del que declaró quien lo subió.
- Si algún día se pasa a URLs firmadas, deben ser de vida corta y seguir
  emitiéndose solo tras la comprobación de RLS.

**El límite práctico de SUBIDA en Vercel son 4,5 MB**, no los 10 MiB del
servidor: la plataforma corta los cuerpos más grandes antes de que llegue nada
al código. Por eso la app **reduce las fotos en el propio móvil** antes de
enviarlas (`apps/web/src/lib/attachments/prepare.ts`). Un PDF grande no se puede
reducir: si pasa de ese tamaño, la subida falla con un mensaje que lo dice.

**Comprobado sobre el ZIP de traspaso** (el otro candidato a pasarse de 4,5 MB):
con el corpus real del manual completo —59 ficheros Markdown, 47,6 KiB en
crudo— el ZIP que produce `zipSync` pesa **36,0 KiB**, unas 128 veces por
debajo del límite. `fflate` y `pdf-lib` son JavaScript puro y no dan ningún
problema en el runtime de Node de Vercel.

---

## 4. Ejecutar la cola de trabajos (y, si se quiere, ClamAV)

> **El antivirus es OPCIONAL y hoy no está desplegado.** Sin `CLAMAV_HOST` los
> adjuntos funcionan igual, solo que sin escanear, así que ya **no** es un
> motivo para necesitar host propio. El riesgo asumido, lo que ocupa su lugar y
> el procedimiento exacto para reactivarlo están en
> [docs/security/adjuntos-sin-antivirus.md](../security/adjuntos-sin-antivirus.md).
> Lo que sigue sobre ClamAV describe cómo montarlo **el día que haya un host
> donde ejecutarlo**; el código no ha cambiado y lo único que hace falta para
> encenderlo son las variables.

Hay **dos maneras** de que los trabajos encolados se ejecuten de verdad, y son
excluyentes solo en el sentido de que basta con una:

- **Con host propio** (§4.1–§4.5): el worker se despliega **tal cual**, mismo
  bucle de sondeo, mismo `/health`, mismo `/metrics`, mismo apagado ordenado.
  No se convierte en función ni se trocea. Es también el único sitio donde
  cabría ClamAV, si algún día se quiere escaneo.
- **Sin host propio** (§4.6): el planificador vive en la propia base
  (`pg_cron` + `pg_net`) y llama cada pocos minutos a un endpoint de la web que
  vacía la cola con los mismos manejadores. Coste cero, ningún proveedor más.
  **Los adjuntos ya no atan a esta decisión**: funcionan con Supabase Storage y
  sin antivirus (§3.1).

Los dos pueden convivir sin coordinarse: el reclamo usa
`for update skip locked`.

### 4.1 Con Fly.io

```bash
fly launch --no-deploy --copy-config --config infra/fly/worker.fly.toml
fly secrets set -a casaclara-worker \
  DATABASE_URL='postgresql://casa_clara_worker_login:…@db.PROYECTO.supabase.co:6543/postgres' \
  S3_ENDPOINT='https://PROYECTO.supabase.co/storage/v1/s3' \
  S3_REGION='eu-central-1' S3_PRIVATE_BUCKET='casaclara' \
  S3_ACCESS_KEY_ID='…' S3_SECRET_ACCESS_KEY='…'
fly deploy --config infra/fly/worker.fly.toml

fly launch --no-deploy --copy-config --config infra/fly/clamav.fly.toml
fly secrets set -a casaclara-clamav CLAMAV_GATEWAY_TOKEN="$(openssl rand -hex 32)"
fly deploy --config infra/fly/clamav.fly.toml
```

El worker **no publica nada en internet**: `/health` y `/metrics` viven en la
red privada de la organización.

```bash
fly proxy 3001:3001 -a casaclara-worker
curl -s localhost:3001/health   # {"status":"ok","lastSuccessfulPollAt":…}
curl -s localhost:3001/metrics  # housekeeper_worker_processed_jobs_total …
```

### 4.2 Con Docker Compose en cualquier host

`infra/compose.worker.yml` levanta las mismas dos piezas sin postgres, sin
minio, sin caddy y sin web. Variables en §1 de `.env.example`.

```bash
docker compose -f infra/compose.worker.yml up -d
```

### 4.3 Cómo llega la web al antivirus

Esta es la parte delicada. **clamd no tiene autenticación**: quien alcance su
puerto 3310 puede escanear lo que quiera y agotar el host. La web vive en
Vercel y no puede entrar en la red privada del host del worker, así que el
antivirus tiene que ser alcanzable desde internet — pero clamd desnudo, jamás.

Delante va `infra/clamav/gateway.mjs`: escucha en **TLS**, exige como primera
línea `HOUSEKEEPER <token>` (comparación en tiempo constante) y a partir de ahí
hace de tubería sin tocar un byte del diálogo INSTREAM. clamd escucha solo en
`127.0.0.1`.

| Componente | Variables |
| --- | --- |
| Host del worker | `CLAMAV_GATEWAY_TOKEN`, `CLAMAV_GATEWAY_CERT`, `CLAMAV_GATEWAY_KEY` |
| Web en Vercel | `CLAMAV_HOST` (nombre público de la pasarela), `CLAMAV_PORT=3311`, `CLAMAV_TLS=true`, `CLAMAV_TOKEN` (**el mismo valor** que `CLAMAV_GATEWAY_TOKEN`) |

Con una CA propia en vez de una pública, añadir `CLAMAV_TLS_CA_PEM` con el PEM
de la CA. **La verificación del certificado no se apaga nunca.**

En Compose local nada de esto se define: clamd está en una red `internal: true`
y el diálogo va en claro dentro de ella, como hasta ahora.

### 4.4 Qué pasa si el antivirus está configurado y está caído

Que la subida **falla, y lo dice** (sin `CLAMAV_HOST` este apartado no aplica:
no hay escaneo del que depender):

- El escaneo va SIEMPRE antes de tocar el almacén, y un error del socket no se
  confunde nunca con «limpio». La ruta responde **503** con «el antivirus del
  hogar no responde: la foto sigue en tu dispositivo y no se ha guardado nada»,
  y el fallo queda en el log del servidor con su código técnico. (Antes de este
  despliegue salía como 500 mudo de SvelteKit, sin log.)
- Un veredicto `infected` sigue siendo **422**, y no deja rastro en la base ni
  en el bucket.
- Con conexión, el alta de un gasto **no se bloquea**: se registra sin
  justificante y el mensaje explica qué pasó con la foto.
- Sin conexión, el gasto espera a que su foto suba —para que nunca quede un
  gasto con justificante huérfano—. Esa espera ahora **tiene fin**: tras cinco
  pasadas fallidas (o al primer rechazo definitivo del fichero) el cambio pasa
  al triaje «Cambios sin guardar» con el motivo real, deja de reintentarse
  solo, y allí se puede **Reintentar** (la foto sigue en el dispositivo) o
  **Descartar** (borra el cambio y su foto). Antes se quedaba en «pendiente de
  red» para siempre, sin que nadie lo notase.

### 4.5 El agujero de arranque en frío (W-5)

`ensurePruneDiscoveryScheduled` y `ensureIcsSyncScheduled` **se abstienen si la
cola está vacía**, porque `job_queue.household_id` es NOT NULL y el worker no
puede leer `app.households`. En una base nueva los trabajos periódicos no
arrancan solos. Tras dar de alta el hogar (§6) hay que sembrar el primer job a
mano, con la conexión directa:

```sql
-- El esquema es `app_private`, NO `app`: la cola vive fuera de `app` porque no
-- tiene ni un GRANT para el rol de la aplicación (migración 0005), y solo la
-- tocan el worker y el drenaje con el rol del worker. Escrito `app.job_queue`
-- esto no siembra nada: falla con «relation "app.job_queue" does not exist».
insert into app_private.job_queue (household_id, job_type, run_at, payload)
values ('<uuid-del-hogar>', 'ics.sync_all', now(), '{}'::jsonb);
```

Con el drenaje de §4.6 el agujero es más pequeño: ese endpoint re-arma las dos
cadenas periódicas en **cada** pasada, no solo al arrancar, así que basta con
que exista una fila cualquiera en la cola —el alta del hogar ya deja varias—
para que se enganchen solas. La siembra manual sigue siendo necesaria únicamente
en el caso extremo de una cola completamente vacía.

### 4.6 Sin host propio: el planificador en la base

`pg_cron` dispara cada cinco minutos una llamada con `pg_net` a
`POST /api/v1/jobs/run`, protegida por un secreto compartido que vive en el
Vault de Supabase (nunca en el SQL del cron). El endpoint ejecuta trabajos
durante un presupuesto de tiempo, para limpio y deja lo que sobra para la
pasada siguiente.

**Los comandos exactos, la justificación de la frecuencia y el diagnóstico
están en [`docs/runbooks/planificador-cola.md`](../runbooks/planificador-cola.md).**
Resumen de lo que hay que tener a mano: `JOB_RUNNER_TOKEN` y
`WORKER_DATABASE_URL` en Vercel (§6b y §1 de `.env.example`), y el token
también en `vault.create_secret`.

Criterio de salida del paso 4: **la cola se vacía sola**, y se comprueba con
hechos, no de palabra.

- `POST /api/v1/jobs/run` con su token responde **200** con
  `"stoppedBy":"empty"` (el SQL y el `curl` exactos, en §4 del runbook del
  planificador).
- `select status, job_type, count(*) from app_private.job_queue group by 1, 2`
  no deja nada en `dead` ni un `queued` con el `run_at` ya pasado.
- Un calendario enlazado deja de decir «Pendiente de la primera lectura».
- Y el efecto que se ve desde dentro de casa: **cerrar la cuenta de un mes deja
  su recibo archivado en PDF** en la pestaña Pagos del Contrato antes de cinco
  minutos.

**Avisos de rutina no hay, y no los esperes.** El catálogo está cerrado a tres
—el recibo listo, la cuenta del mes por pagar y el mes a punto de acabar— y
notificar rutinas está **prohibido por escrito**, que no es lo mismo que estar
pendiente de construir: [`../notificaciones.md`](../notificaciones.md) §6.1. Si
lo que quieres es probar el canal, el único aviso que sale de este paso es el
del recibo, y solo con las claves VAPID puestas (§5).

---

## 5. Desplegar la web en Vercel

1. **Proyecto**: importar el repositorio. Al ser un monorepo pnpm con
   dependencias `workspace:*`:
   - *Root Directory*: la raíz del repositorio (**no** `apps/web`).
   - *Install Command*: `pnpm install --frozen-lockfile`
   - *Build Command*: `pnpm --filter @housekeeper/web build`
   - *Output Directory*: `apps/web/.vercel/output` (lo detecta el adaptador).

   El adaptador se elige solo: `svelte.config.js` mira `VERCEL`, que la
   plataforma exporta en toda build suya, y pasa a `@sveltejs/adapter-vercel`
   sin que haya que declarar nada en el panel. `DEPLOY_TARGET` sigue mandando
   si se declara, así que `DEPLOY_TARGET=node` construye el servidor autónomo
   también desde Vercel.
2. **Node**: el repo fija 24.18.0 y `engines: node >=24 <25`. Seleccionar
   **Node 24.x** en *Project Settings → Node.js Version*. El adaptador está
   configurado con `runtime: 'nodejs24.x'`.
3. **Variables** (todas en *Production*). El inventario completo, con el
   destino y el carácter de cada una, es `.env.example`; esta lista es la de
   este despliegue:

   ```
   DATABASE_URL=…:6543/postgres    # pooler, modo transacción
   DATABASE_AUTH_URL=…:6543/postgres
   BETTER_AUTH_SECRET=…
   BETTER_AUTH_URL=https://casa.ejemplo.es
   SNAPSHOT_SIGNING_KEY_B64=…
   SUPABASE_SERVICE_ROLE_KEY=…     # adjuntos, §3.1 (o las S3_* de §3.2)
   WORKER_DATABASE_URL=…:6543/postgres   # rol del WORKER; lo usa el drenaje (§4.6)
   JOB_RUNNER_TOKEN=…              # el MISMO valor que guarda el Vault de Supabase
   ```

   **Las dos últimas se olvidan porque el planificador parece cosa de la base**,
   y se paga caro: sin ellas `POST /api/v1/jobs/run` responde **503 y no toca la
   cola**, así que la cola no se vacía nunca. Y eso no se ve en ninguna pantalla
   —la web va, la sesión va—: lo que deja de ocurrir es todo lo que se cocina en
   la cola, o sea **el PDF del recibo del mes y la sincronización de los
   calendarios enlazados**, en silencio y sin una línea de registro.
   `WORKER_DATABASE_URL` lleva el rol del worker a propósito, porque
   `app_private.job_queue` no tiene **ni un GRANT** para el rol de la aplicación
   (migración 0005); poner ahí la cadena de la aplicación es de los pocos errores
   que sí se delatan solos, con «permission denied».

   **Avisos en el móvil**, si se quieren (§5b de `.env.example`; puesta en marcha
   completa en
   [`../runbooks/notificaciones-push.md`](../runbooks/notificaciones-push.md)):

   ```
   VAPID_PUBLIC_KEY=…
   VAPID_PRIVATE_KEY=…
   VAPID_SUBJECT=mailto:avisos@ejemplo.es
   ```

   **Las tres o ninguna, y el `sub` LIMPIO.** Un `sub` con corchetes angulares o
   espacios —el clásico `<mailto:…>` que se pega del propio panel de Vercel—
   hace que **Apple, y solo Apple**, conteste 403 BadJwtToken: el defecto
   aparecería únicamente en los iPhone de la casa, que es donde nadie prueba.
   Por eso las tres se validan juntas al arrancar (`push-channel.ts`) y un `sub`
   sucio se trata como si no hubiera claves: es preferible «aquí no hay canal»,
   que es verdad y se lee, a un interruptor encendido de cara a la persona y
   apagado de verdad para siempre.

   Sin las tres **no se rompe nada**: la aplicación funciona entera, no se encola
   ningún aviso, la cola se vacía igual y `/h/<hogar>/account` dice «Esta
   instalación no manda avisos al móvil» en vez de dibujar un interruptor que no
   puede funcionar. Esa frase es además la comprobación: si aparece, las claves
   **no** están puestas (o el `sub` no pasa la validación).

   **Opcionales**, solo si algún día hay antivirus (§4 y
   `docs/security/adjuntos-sin-antivirus.md`):

   ```
   CLAMAV_HOST= CLAMAV_PORT=3311 CLAMAV_TLS=true CLAMAV_TOKEN=
   ```

   `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` estaban aquí y **ya no van**: no hay
   correo (0029). Si siguen puestas en el panel de un despliegue antiguo, se
   borran: nadie las lee, y una variable sin lector solo sirve para hacer creer
   que hay un canal que no existe.

   **NO definir** `ALLOW_SYNTHETIC_DATA_ONLY` ni `HOUSEKEEPER_FIXTURE_LOGIN`: su
   ausencia es el estado seguro, y ahora está además impuesta. Definir
   cualquiera de las dos en una build de producción la detiene, con el
   despliegue anterior sirviendo mientras tanto.
   (`ENABLE_DEMO_PASSWORD_AUTH` figuraba aquí y **no existe en el código**: no
   la busques.)

   **Las cuatro primeras entran en la misma operación.** `DATABASE_URL`,
   `DATABASE_AUTH_URL`, `BETTER_AUTH_SECRET` y `BETTER_AUTH_URL` son una regla
   indivisible: con la base puesta y alguna de las otras ausente, la aplicación
   no sirve nada y responde 503 nombrando la que falta. Media configuración es
   peor que ninguna, porque dejaba en pie el camino sintético sobre datos
   reales. Ver
   [`../adr/0003-configuracion-indivisible-y-cuentas-sinteticas.md`](../adr/0003-configuracion-indivisible-y-cuentas-sinteticas.md).

   **`ORIGIN` no existe en Vercel** y no hay que ponerla: la comprobación CSRF
   de SvelteKit deriva el origen de `x-forwarded-host`. `HOST` y `PORT`
   tampoco: los gestiona la plataforma.

4. **Región**: `fra1` viene fijada en `svelte.config.js` para que el requisito
   de residencia viaje con el código. `VERCEL_DEPLOY_REGION` permite cambiar a
   `cdg1` sin tocar el fichero.

5. **Orden**: migraciones (§2) **primero**, despliegue después. Mientras B-1
   siga abierto, con aprobación manual entre ambos.

### 5.1 Qué se comprobó del cambio de adaptador

| Riesgo del informe | Resultado |
| --- | --- |
| Nonces CSP en los hooks | Sin riesgo: `hooks.server.ts` no toca la CSP —la inyecta SvelteKit al renderizar— y **no hay una sola página con `export const prerender`** en todo `src/routes`, así que no puede quedarse un nonce cacheado |
| `ORIGIN` / CSRF | El código **no lee `ORIGIN` en ninguna parte**: lo consume `adapter-node` internamente. En Vercel la comprobación de origen de SvelteKit se apoya en `x-forwarded-host`. La ruta de adjuntos, además, compara `origin` contra `url.origin` por su cuenta |
| Cookies | Las de sesión real las emite Better Auth por cookie firmada. El único `cookies.set` propio es el de la sesión demo en memoria, que solo corre sin `DATABASE_AUTH_URL`, y ya marca `secure` según el protocolo |
| `POST /api/v1/sync` | Petición corta con respuesta completa, un lote en una transacción: encaja en una función. Sin estado en proceso |
| ZIP del traspaso | **Medido**: 36,0 KiB con el corpus real completo (59 ficheros, 47,6 KiB en crudo). El límite de respuesta son 4,5 MB: margen de ×128 |
| PDF y `fflate` | JavaScript puro; ambos entran en el bundle del servidor sin binarios nativos |
| Justificantes | **Este sí se pasaba**: se proxeaban materializados y llegan a 10 MiB. Ahora van en flujo, donde el límite de 4,5 MB no aplica |
| Tamaño de la función | **8,9 MB** con `split: false` (todas las rutas comparten una función y el resto son enlaces simbólicos), frente a los 250 MB del límite |

Y se comprobó lo que no se rompe: `pnpm --filter @housekeeper/web build` sigue
produciendo `build/` con adapter-node por omisión, y `DEPLOY_TARGET=vercel`
produce `.vercel/output` con las 34 rutas y una sola función.

### 5.2 Si el despliegue muere con «No Output Directory named "public"»

Ese mensaje no habla de ficheros estáticos: es que la build se hizo con
adapter-node —deja el resultado en `build/`— y Vercel, al no encontrar
`.vercel/output`, buscó la carpeta estática de reserva. Ocurría cuando faltaba
`DEPLOY_TARGET=vercel` en el panel; desde que `svelte.config.js` detecta la
variable `VERCEL` no debería volver a pasar. Si reaparece, revisar que no haya
un `DEPLOY_TARGET=node` heredado en las variables del proyecto.

---

## 6. Dar de alta el hogar

**Esto es un hueco conocido del expediente.** El único sembrador que existe,
`apps/web/scripts/seed-demo-users.mjs`, se niega a ejecutarse salvo con
`ENABLE_DEMO_PASSWORD_AUTH=true` **y** `ALLOW_SYNTHETIC_DATA_ONLY=true`: es
explícitamente incapaz de crear un hogar de producción, y eso es deliberado.
Además `disableSignUp: true` impide que un enlace mágico cree cuentas.

Hace falta, por tanto, un procedimiento de alta real que **hoy no existe**:
crear el hogar, la primera cuenta de administración y su membresía por SQL
guiado con la conexión directa. Está fuera del alcance de este runbook y es
trabajo pendiente.

Una vez creado el hogar:

1. **Importar la Guía de la casa** (el corpus está versionado; no se migra
   nada, se reimporta). Ensayo primero, que no escribe nada:

   ```bash
   DATABASE_URL="$DIRECTA" pnpm --filter @housekeeper/db manual:import -- \
     --household <uuid> --dry-run
   ```

   Cautelas: requiere **conexión directa y rol propietario** (hace
   `set local row_security = off`); `manual:import` planta además rutinas, el
   contacto de Emergencias y la plantilla de menú —para solo la Guía, invocar
   `wiki-import.mjs --dir` directamente—; y `--docx` es **destructivo sobre el
   árbol de trabajo** (`rm -rf` de `content/manual/`).

2. **Calendario**: no hay nada que migrar. Volver a dar de alta la URL en la
   app; el alta encola una sincronización inmediata y la caché se repuebla en
   el acto. Aprovechar para **rotar la URL secreta en Google**: la actual ha
   vivido en una demo. Los tokens de `app.ics_feeds` son irrecuperables (solo
   se guarda su sha-256): cualquier URL de suscripción publicada hay que
   reemitirla.

3. **Nunca** ejecutar `seed-demo-users.mjs` ni cargar
   `packages/db/fixtures/001_two_households.sql` contra producción.

---

## 7. Humo posterior al despliegue

- [ ] `GET https://casa.ejemplo.es/api/health` → `{"status":"ok",…}`
- [ ] Login con nombre y contraseña, y las pantallas de Hoy, Guía, Calendario
      y Menú. No hay correo en el camino de acceso ni en ningún otro sitio.
- [ ] Con una concesión de Finanzas activa (Ajustes → tarjeta Finanzas), el
      Dashboard de `/h/<hogar>/finanzas` responde y pinta los KPIs; una cuenta
      sin concesión no ve el módulo en la navegación y recibe 403 por URL directa.
- [ ] Subir un justificante y volver a verlo desde la cuenta del mes.
- [ ] El banner de datos sintéticos **no** aparece, y el acceso demo con
      contraseña devuelve 403.
- [ ] **La cola drena.** `curl -si -X POST https://casa.ejemplo.es/api/v1/jobs/run
      -H "x-housekeeper-job-token: $JOB_RUNNER_TOKEN"` → 200 con
      `"stoppedBy":"empty"`; sin la cabecera, 401. Un **503** aquí es
      `WORKER_DATABASE_URL` o `JOB_RUNNER_TOKEN` sin poner (§5), y no se nota en
      ninguna otra parte.
- [ ] **El recibo llega hasta el final.** Cerrar la cuenta de un mes y
      comprobar, en la pestaña Pagos del Contrato y antes de cinco minutos, que
      aparece «Recibo archivado (PDF)» y que se descarga. Es la prueba de que la
      cola, el almacén y el registro de la 0035 están los tres puestos.
- [ ] **Los avisos, solo si se quieren.** `/h/<hogar>/account`: si dice «Esta
      instalación no manda avisos al móvil», faltan las tres VAPID (o el `sub`
      no pasa la validación). Si ofrece el interruptor, encenderlo **en un
      teléfono de verdad** y esperar un aviso real: el `sub` sucio solo rompe
      los iPhone.
- [ ] `fly proxy 3001:3001 -a casaclara-worker` → `/health` y `/metrics`.

Nota sobre `GET /api/metrics` de la **web**: en serverless cada invocación es
un proceso nuevo, así que sus contadores de proceso son ruido. Se deja porque
sigue siendo útil en el despliegue autogestionado, pero no debe conectarse a
ningún Prometheus apuntando a Vercel. Los del **worker** sí son reales: es un
proceso de larga vida.

---

## 8. Copia de seguridad completa, a demanda

El propietario quiere copias **cuando las pida**, no automáticas. Un solo
comando hace las dos mitades:

```bash
export BACKUP_DATABASE_URL="$DIRECTA"     # DIRECTA (5432): pg_dump no va por el pooler
export S3_ENDPOINT=… S3_REGION=… S3_PRIVATE_BUCKET=… \
       S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
pnpm backup:full
```

Qué hace, en orden:

1. `pg_dump --format=custom --compress=zstd:9` de la base **y lo verifica con
   `pg_restore --list`** antes de dar el fichero por bueno.
2. Descarga todos los objetos del bucket con el mismo SDK de S3 que usa la app
   (paginación incluida), y falla si el recuento descargado no coincide con el
   listado.
3. Escribe `SHA256SUMS` de todo y un `manifest.json` con qué se copió y de
   dónde. La cadena de conexión **no** se escribe: llevaría la contraseña.
4. Solo entonces el directorio recibe su nombre definitivo. Una copia
   interrumpida se queda como `…​.partial` y no se puede confundir con una buena.

Resultado:

```
artifacts/backups/20260808T210358Z/
├── base.dump          # pg_dump custom, zstd:9, verificado
├── objetos/…          # el bucket entero, con su jerarquía de claves
├── SHA256SUMS
└── manifest.json
```

Con `BACKUP_DIR` se elige otro destino. Con `PG_DUMP` / `PG_RESTORE`, otras
rutas de los binarios.

**Lo que este comando NO hace, y el ADR 0001 exige**: cifrar la copia y
guardarla FUERA del proveedor. Mientras eso no se decida (RPO/RTO incluidos),
la copia queda donde la deje quien la ejecute. Restaurar es el camino inverso y
está en [`../runbooks/backup-restore.md`](../runbooks/backup-restore.md).

---

## 9. La bandera de datos sintéticos

**Comprobación de un solo comando**, que sustituye a leer esta sección entera:

```bash
curl -s https://www.homekeeping.app/api/health
# {"status":"ok",…,"synthetic":false,"fixtureLogin":false}
```

`synthetic: true` en producción es un incidente: significa que la bandera está
puesta. `fixtureLogin: true` es peor: significa que el paquete desplegado lleva
dentro el selector de cuentas sintéticas. Ninguna de las dos debería poder
llegar ahí —la build las rechaza y el arranque también—, así que si aparecen,
lo que hay que revisar es cómo se subió ese despliegue.

`ALLOW_SYNTHETIC_DATA_ONLY` **no se define en producción**, y su ausencia es
segura:

- **Nada de producción depende de que esté puesta.** Sus consumidores tratan
  «sin definir» como el comportamiento normal: el banner no se pinta y las
  semillas demo se niegan a ejecutarse.
- **Apagarla no enciende ningún camino peligroso; enciende una guarda.** La
  única comprobación que se invierte es la del acceso demo con contraseña:
  `demoPasswordBlocked` devuelve **true** —bloqueado— precisamente cuando la
  bandera está apagada y el origen no es local. Y la acción demo ya responde
  403 antes de eso fuera de `localhost`.
- Los booleanos se comparan contra la cadena `'true'` exactamente: `TRUE`, `1`
  o `yes` cuentan como falso.

**Hueco W-7, cerrado por retirada.** La guarda de destinatarios sintéticos solo
cubría el correo del worker, y el enlace mágico de la web no pasaba por ella:
un staging declarado sintético podía mandar un enlace a una dirección real. Ya
no hay por dónde: ni enlace mágico (el acceso es por contraseña) ni salida de
correo (0029). No queda nada que guardar, así que la guarda se fue con lo que
guardaba.
