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
> | Adjuntos | Supabase Storage (endpoint S3) | El código ya habla S3 con `forcePathStyle` |
> | Worker + ClamAV | Host aparte (Fly.io u otro) | El worker es un demonio; ClamAV no cabe en serverless |
>
> **Bloqueo previo del ADR 0001**: revisión legal, política de retención y
> residencia UE. Este runbook cubre la residencia; los otros dos no son
> técnicos y siguen siendo decisión del propietario.

---

## 0. Antes de empezar

- [ ] Repositorio **privado** en GitHub.
- [ ] Dominio propio con SPF, DKIM y DMARC en el proveedor de correo elegido.
      Sin ellos los enlaces mágicos van a spam y la app queda inutilizable.
- [ ] Un gestor de contraseñas donde guardar lo que se genere en §1.
- [ ] `pnpm install` y el repo en verde: `pnpm lint`, `pnpm --filter web check`,
      `pnpm test:unit`, `pnpm --filter web verify:bundle`.

Secretos a generar (una vez, y guardar):

```bash
openssl rand -base64 48                     # BETTER_AUTH_SECRET
openssl genpkey -algorithm ed25519 | base64 -w0   # SNAPSHOT_SIGNING_KEY_B64
openssl rand -hex 32                        # CLAMAV_TOKEN / CLAMAV_GATEWAY_TOKEN
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
   - añadir `grant casa_clara_app, casa_clara_worker to postgres;` para poder
     ejecutar la suite RLS (B-5).
2. **Migraciones.**

   ```bash
   DATABASE_URL="$DIRECTA" pnpm db:migrate
   ```

   Criterio de salida: **17/17 migraciones aplicadas**. Repetir el comando debe
   aplicar 0: la idempotencia es parte del contrato.
3. **Suites SQL y RLS** contra el proyecto real, no contra una sonda local:

   ```bash
   TEST_DATABASE_URL="$DIRECTA" pnpm test:db
   TEST_DATABASE_URL="$DIRECTA" pnpm test:rls
   ```

   Criterio de salida: **5/5 suites en verde**. Si la matriz RLS falla, PARAR:
   es el aislamiento entre roles lo que está fallando.
4. **Better Auth**: crear el esquema `casa_auth`, el rol
   `casa_clara_auth_login` con `alter role … set search_path to casa_auth`, y
   correr `runAuthMigrations`.

---

## 3. Almacenamiento de adjuntos en Supabase Storage

El código usa el SDK de S3 con **exactamente tres operaciones** —`PutObject`,
`GetObject` y `ListObjectsV2` (esta última solo en las copias)— y con
`forcePathStyle: true` **cableado en el código**, que es justo lo que espera el
endpoint S3 de Supabase. No hay URLs prefirmadas, ni multipart, ni ACLs, ni
ciclo de vida: no hace falta adaptador ninguno.

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

**Política de acceso: los ficheros no son públicos NUNCA.**

- El bucket es privado y no lleva ninguna política que permita lectura anónima.
- Las credenciales S3 solo las tienen la web y el worker; no viajan al
  navegador.
- Los justificantes se sirven **proxeados** por
  `/api/v1/households/[id]/receipts/[expenseId]`, que exige sesión, comprueba
  la pertenencia al hogar y deja que RLS decida la fila. Sin fila, 404 —sin
  distinguir «no existe» de «no te toca»—.
- Esa ruta sirve el objeto **en flujo**, no materializado: una función de
  Vercel no puede devolver más de 4,5 MB de golpe y un justificante llega a
  10 MiB.
- Si algún día se pasa a URLs firmadas, deben ser de vida corta y seguir
  emitiéndose solo tras la comprobación de RLS.

**Comprobado sobre el ZIP de traspaso** (el otro candidato a pasarse de 4,5 MB):
con el corpus real del manual completo —59 ficheros Markdown, 47,6 KiB en
crudo— el ZIP que produce `zipSync` pesa **36,0 KiB**, unas 128 veces por
debajo del límite. `fflate` y `pdf-lib` son JavaScript puro y no dan ningún
problema en el runtime de Node de Vercel.

---

## 4. Desplegar el worker y ClamAV

El worker se despliega **tal cual**: mismo bucle de sondeo, mismo `/health`,
mismo `/metrics`, mismo apagado ordenado. No se convierte en función ni se
trocea.

### 4.1 Con Fly.io

```bash
fly launch --no-deploy --copy-config --config infra/fly/worker.fly.toml
fly secrets set -a casaclara-worker \
  DATABASE_URL='postgresql://casa_clara_worker_login:…@db.PROYECTO.supabase.co:6543/postgres' \
  S3_ENDPOINT='https://PROYECTO.supabase.co/storage/v1/s3' \
  S3_REGION='eu-central-1' S3_PRIVATE_BUCKET='casaclara' \
  S3_ACCESS_KEY_ID='…' S3_SECRET_ACCESS_KEY='…' \
  SMTP_HOST='…' SMTP_PORT='587' SMTP_FROM='Casa Clara <no-reply@casa.ejemplo.es>'
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
curl -s localhost:3001/metrics  # casa_clara_worker_processed_jobs_total …
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
línea `CASACLARA <token>` (comparación en tiempo constante) y a partir de ahí
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

### 4.4 Qué pasa si el antivirus está caído

Que la subida **falla, y lo dice**:

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
insert into app.job_queue (household_id, job_type, run_at, payload)
values ('<uuid-del-hogar>', 'ics.sync_all', now(), '{}'::jsonb);
```

Criterio de salida del paso 4: el calendario se sincroniza solo y llega un
aviso de rutina de verdad.

---

## 5. Desplegar la web en Vercel

1. **Proyecto**: importar el repositorio. Al ser un monorepo pnpm con
   dependencias `workspace:*`:
   - *Root Directory*: la raíz del repositorio (**no** `apps/web`).
   - *Install Command*: `pnpm install --frozen-lockfile`
   - *Build Command*: `pnpm --filter @casa-clara/web build`
   - *Output Directory*: `apps/web/.vercel/output` (lo detecta el adaptador).

   El adaptador se elige solo: `svelte.config.js` mira `VERCEL`, que la
   plataforma exporta en toda build suya, y pasa a `@sveltejs/adapter-vercel`
   sin que haya que declarar nada en el panel. `DEPLOY_TARGET` sigue mandando
   si se declara, así que `DEPLOY_TARGET=node` construye el servidor autónomo
   también desde Vercel.
2. **Node**: el repo fija 24.18.0 y `engines: node >=24 <25`. Seleccionar
   **Node 24.x** en *Project Settings → Node.js Version*. El adaptador está
   configurado con `runtime: 'nodejs24.x'`.
3. **Variables** (todas en *Production*, ver `.env.example`):

   ```
   DATABASE_URL=…:6543/postgres    # pooler, modo transacción
   DATABASE_AUTH_URL=…:6543/postgres
   BETTER_AUTH_SECRET=…
   BETTER_AUTH_URL=https://casa.ejemplo.es
   SNAPSHOT_SIGNING_KEY_B64=…
   S3_ENDPOINT= S3_REGION= S3_PRIVATE_BUCKET= S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY=
   SMTP_HOST= SMTP_PORT=587 SMTP_FROM=
   CLAMAV_HOST= CLAMAV_PORT=3311 CLAMAV_TLS=true CLAMAV_TOKEN=
   ```

   **NO definir** `ALLOW_SYNTHETIC_DATA_ONLY` ni `CASA_CLARA_FIXTURE_LOGIN`: su
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

Y se comprobó lo que no se rompe: `pnpm --filter @casa-clara/web build` sigue
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
   DATABASE_URL="$DIRECTA" pnpm --filter @casa-clara/db manual:import -- \
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
- [ ] Enlace mágico a una bandeja real: llega, y el enlace apunta al dominio
      definitivo (no a `localhost:3000`). **Un SMTP mal configurado no da error
      visible**: el formulario responde siempre `{ sent: true }` para no
      filtrar qué cuentas existen.
- [ ] Login y las pantallas de Hoy, Guía, Calendario y Menú.
- [ ] Subir un justificante y volver a verlo desde la cuenta del mes.
- [ ] El banner de datos sintéticos **no** aparece, y el acceso demo con
      contraseña devuelve 403.
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

- **Nada de producción depende de que esté puesta.** Sus cuatro consumidores
  tratan «sin definir» como el comportamiento normal: el banner no se pinta, la
  política de correo del worker deja pasar la entrada intacta, y las semillas
  demo se niegan a ejecutarse.
- **Apagarla no enciende ningún camino peligroso; enciende una guarda.** La
  única comprobación que se invierte es la del acceso demo con contraseña:
  `demoPasswordBlocked` devuelve **true** —bloqueado— precisamente cuando la
  bandera está apagada y el origen no es local. Y la acción demo ya responde
  403 antes de eso fuera de `localhost`.
- Los booleanos se comparan contra la cadena `'true'` exactamente: `TRUE`, `1`
  o `yes` cuentan como falso.

**Hueco conocido que sigue abierto (W-7):** la guarda de destinatarios
sintéticos solo cubre el correo del **worker**. El enlace mágico de la web no
pasa por ella, así que un staging declarado sintético **sí** enviaría un enlace
a una dirección real si alguien la escribe. No afecta a producción —donde la
bandera no está puesta— pero contradice el control 9 en staging.
