# Instalación desde cero

Tres cosas distintas: montar el **entorno de desarrollo**, desplegar una
**instalación nueva** en Vercel + Supabase, y **dar de alta un hogar** dentro de
ella.

---

## Entorno de desarrollo local

### Requisitos

Node **24.18.0** (fijado en `.nvmrc`, `.node-version` y `engines`) y pnpm
**10.17.1**. Para todo lo que toque base de datos, un PostgreSQL **18** en el que
puedas crear bases y roles: las migraciones crean los roles de grupo
`casa_clara_app` y `casa_clara_worker`.

```bash
corepack enable
pnpm install --frozen-lockfile
```

### Modo demo, sin base de datos

```bash
pnpm dev        # http://localhost:5173, cuentas fixture en memoria
```

Sin `DATABASE_URL` la web sirve datos sintéticos y `/api/v1/sync` responde 503:
**nunca finge una confirmación**.

### Con base de datos de verdad

PostgreSQL portátil, sin Docker ni tocar el del sistema:

```bash
export PGBIN="$PG_HOME/usr/lib/postgresql/18/bin"
export LD_LIBRARY_PATH="$PG_HOME/usr/lib/x86_64-linux-gnu"

"$PGBIN/initdb" -D "$PGDATA" -U casa_admin
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p 54329 -k /tmp/ccpg-socket" -l "$PGDATA/log" start
"$PGBIN/createdb" -h 127.0.0.1 -p 54329 -U casa_admin casaclara_dev
```

Y el esquema, **en este orden**:

```bash
export DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
export APP_DB_PASSWORD='…' WORKER_DB_PASSWORD='…' AUTH_DB_PASSWORD='…'

pnpm --filter @casa-clara/db bootstrap    # roles casa_clara_*, esquema casa_auth
pnpm --filter @casa-clara/db migrate      # las 31 migraciones, en orden
```

**El bootstrap va antes que las migraciones, sin excepción**: la 0001 ya concede
sobre `casa_clara_app` y `casa_clara_worker`, así que esos roles tienen que
existir. Los roles son **del clúster, no de la base**: si ya existían de otra
instalación, el bootstrap sólo les repone la contraseña.

Verificado de punta a punta: `bootstrap` responde
`bootstrap ok: 5 roles casa_clara_*, esquema casa_auth presente`, `migrate`
imprime `Applied 31 migration(s).` y repetirlo dice
`Database is up to date; no migrations applied.`

### Arrancar contra esa base

```bash
export DATABASE_URL='postgresql://casa_clara_app_login:…@127.0.0.1:54329/casaclara_dev'
export DATABASE_AUTH_URL='postgresql://casa_clara_auth_login:…@127.0.0.1:54329/casaclara_dev'
export BETTER_AUTH_SECRET='…al menos 32 bytes aleatorios…'
export BETTER_AUTH_URL='http://localhost:5173'
pnpm dev
```

**Usa el rol de la aplicación (`casa_clara_app_login`), no el propietario.** Con
el propietario no hay RLS y estarías probando otra cosa.

---

## Alta de un hogar nuevo

El procedimiento completo, con qué se verifica en cada paso, está en
[docs/despliegue/alta-de-hogar.md](../../../docs/despliegue/alta-de-hogar.md).
Aquí va el resumen ejecutable y las trampas.

### 1. El fichero del hogar, fuera del repositorio

Un solo JSON en modo `600` alimenta el alta de cuentas **y** la del contrato.
Ejemplo **inventado** (el real vive fuera de Git):

```json
{
  "household": { "slug": "casa-ejemplo", "displayName": "Casa Ejemplo" },
  "people": [
    { "username": "rosa",  "name": "Rosa",  "email": "rosa@ejemplo.test",  "role": "family_admin" },
    { "username": "nuria", "name": "Nuria", "email": "nuria@ejemplo.test", "role": "family_admin" },
    { "username": "lucia", "name": "Lucia", "email": "lucia@ejemplo.test", "role": "employee_live_in" }
  ],
  "agreement": {
    "employeeUsername": "lucia",
    "createdByUsername": "rosa",
    "startsOn": "2026-01-07",
    "monthlySalaryCents": 123400,
    "currencyCode": "EUR",
    "contractedWeeklyMinutes": 2400,
    "annualVacationDays": 30,
    "schedule": {
      "from": "08:00", "to": "19:00", "longBreakMinutes": 120,
      "weekly": "Cinco jornadas de lunes a viernes. Fin de semana libre.",
      "restDays": ["sabado", "domingo"],
      "days": { "viernes": { "to": "15:00" } }
    },
    "extraWorkTypes": [
      { "code": "jornada_extra", "name": "Jornada extra", "unit": "per_shift",
        "rateCents": 5000, "referenceMinutes": 480, "active": true }
    ],
    "supplements": []
  }
}
```

**Dos `family_admin`, siempre.** Es la red de recuperación de contraseñas.

### 2. Las personas

```bash
export DATABASE_AUTH_URL='postgresql://casa_clara_auth_login:…@…/…'
export SEED_DATABASE_URL="$DATABASE_URL"     # el propietario de las migraciones
export BETTER_AUTH_SECRET='…'

pnpm --filter @casa-clara/web seed:accounts --config /fuera/del/repo/hogar.json --dry-run
pnpm --filter @casa-clara/web seed:accounts --config /fuera/del/repo/hogar.json \
  > /fuera/del/repo/credenciales.txt
chmod 600 /fuera/del/repo/credenciales.txt
```

Imprime el **identificador del hogar** —apúntalo, hace falta en el paso 4— y las
contraseñas generadas, **una sola vez**.

> **La trampa que más cara sale, y no está en ningún runbook.**
> `DATABASE_AUTH_URL` **tiene que ser el rol `casa_clara_auth_login`**, cuyo
> `search_path` apunta a `casa_auth`. Si le pones el rol propietario (que no
> tiene `search_path` configurado), Better Auth crea sus tablas en `public`.
> El guion **termina con éxito, dice «creada» por cada persona e imprime las
> contraseñas** — y después no entra nadie: 401 para todo el mundo.
> Reproducido y verificado durante el ensayo de esta skill.
>
> Comprobación inmediata después del paso 2:
>
> ```sql
> select table_schema, table_name from information_schema.tables
>  where table_name in ('user','session','account');
> -- casa_auth.user / casa_auth.session / casa_auth.account
> -- Si salen en `public`, bórralas y repite el paso con el rol correcto.
> ```

### 3. El contrato

Ver [referencia-operaciones.md § Contratos](referencia-operaciones.md#contratos).
Lo esencial: **nunca sin catálogo de trabajo extra**, y ensaya con `--dry-run`.

```bash
pnpm --filter @casa-clara/db agreement:seed --config /fuera/del/repo/hogar.json --dry-run
pnpm --filter @casa-clara/db agreement:seed --config /fuera/del/repo/hogar.json
```

Si el horario no cuadra con `contractedWeeklyMinutes`, imprime un `AVISO` con las
dos cifras y **guarda igual**. No lo ignores.

### 4. El manual de convivencia

```bash
HOUSEHOLD=$(psql "$DATABASE_URL" -Atc "select id from app.households where slug = 'casa-ejemplo'")
pnpm --filter @casa-clara/db manual:import --household "$HOUSEHOLD" --dry-run
pnpm --filter @casa-clara/db manual:import --household "$HOUSEHOLD"
```

Idempotente por contenido. Verificado: vuelca 7 apartados, 52 notas, 5 rutinas y
el contacto del 112.

**Avisará de que se salta la plantilla de semana si no hay grupo de comensales.**
Crea el grupo desde Menú y **vuelve a pasar el importador**.

### 5. Lo que sólo se hace desde la aplicación

El grupo de comensales y el calendario ICS. No tienen guion a propósito: son
decisiones del hogar y quedan con autoría. Ver
[alta-de-hogar.md §5](../../../docs/despliegue/alta-de-hogar.md).

---

## Despliegue nuevo en Vercel + Supabase

El procedimiento paso a paso —proyecto de Supabase en región UE, esquema,
almacén de adjuntos, cola, adaptador y variables— está en
[docs/despliegue/runbook-despliegue.md](../../../docs/despliegue/runbook-despliegue.md).
Decisiones y porqués: [plan-vercel-supabase.md](../../../docs/despliegue/plan-vercel-supabase.md).

**Lo que cambia respecto de local**, y nada más:

- `bootstrap` y `migrate` van por la **conexión directa (5432)** con el rol
  `postgres`: los dos toman cerrojos de sesión y el *pooler* en modo transacción
  no los conserva.
- Ese rol no puede saltarse RLS, así que `migrate` intercala
  `0018_rls_force_compat.sql` entre migraciones. Lo dice por pantalla; **es
  normal**.
- La `DATABASE_URL` de la **aplicación** es la del *pooler* (6543) con
  `casa_clara_app_login`. La aplicación no migra ni siembra nunca.
- El esquema de Better Auth se llama `casa_auth`, no `auth`: en Supabase `auth`
  pertenece a GoTrue.
- Sin host propio para el worker, la cola la drena `pg_cron` → `pg_net` →
  `POST /api/v1/jobs/run`. Ver
  [referencia-mantenimiento.md](referencia-mantenimiento.md#el-planificador-de-la-cola).

---

## Las variables de entorno

**El inventario completo y comentado es [`.env.example`](../../../.env.example)**,
que dice de cada variable dónde va (`[local]`, `[vercel]`, `[worker]`, `[ops]`,
`[ci]`) y su carácter. No lo dupliques: léelo.

Lo que esta skill añade es el **criterio**: qué pasa de verdad si falta cada una.

> Los booleanos se comparan contra la cadena `'true'` **exactamente**: `TRUE`,
> `1` o `yes` cuentan como falso.

### Las cuatro imprescindibles

`apps/web/src/lib/server/deployment-config.js` aplica la **regla indivisible**:
base e identidad entran juntas o no entra ninguna.

| Variable | Sin ella |
|---|---|
| `DATABASE_URL` | No hay datos reales. La regla ni se despierta: la demo local arranca igual |
| `DATABASE_AUTH_URL` | **Con `DATABASE_URL` puesta, la build muere y el servidor no arranca** |
| `BETTER_AUTH_SECRET` | Ídem |
| `BETTER_AUTH_URL` | Ídem. Además tiene que ser `https` (o un nombre local): las cookies de sesión no viajan por otra cosa |

Se comprueba **dos veces**: en `scripts/check-deployment-config.mjs` antes de
`vite build` (fallar ahí es gratis, el despliegue anterior sigue sirviendo) y en
`hooks.server.ts` al arrancar (por si el paquete llega a un entorno con otras
variables). El mensaje **nombra las que faltan, una a una**.

### Lo que degrada en silencio

Esto es lo importante. Todas estas **faltan sin que nada se queje**, y por eso se
llegó a producción sin ellas:

| Variable | Qué se rompe | Parece sano porque… | Cómo se comprueba DE VERDAD |
|---|---|---|---|
| `SNAPSHOT_SIGNING_KEY_B64` | Cada instancia firma el snapshot offline con una **clave efímera propia**: deja de verificar entre arranques en frío | **`GET /api/v1/households/<h>/snapshot` responde 200.** Verificado | Reiniciar el proceso y comprobar que un snapshot anterior sigue validando. La build lo avisa, pero **no tumba el servicio** a propósito |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` · `VAPID_SUBJECT` | No hay avisos push. **Las tres o ninguna** | La aplicación funciona entera y no encola ningún aviso | `/h/<hogar>/account` dice «Esta instalación no manda avisos al móvil». Si lo dice, **no están puestas**. Verificado |
| `SUPABASE_SERVICE_ROLE_KEY` (o las cuatro `S3_*`) | No hay depósito de adjuntos: no se pueden subir justificantes | Todo lo demás va | `POST /api/v1/households/<h>/attachments` → **503** `Los adjuntos requieren la base de datos y el almacén…`. Verificado. Sube un justificante de verdad y vuelve a verlo |
| `WORKER_DATABASE_URL` | El drenaje de la cola no puede tocar `app_private.job_queue` | La web va | `POST /api/v1/jobs/run` con su token → 200 y JSON. Sin ella, 503 |
| `JOB_RUNNER_TOKEN` | **La cola no se vacía**: ni PDF de recibos ni sincronización de calendarios | Nada falla a la vista | `POST /api/v1/jobs/run` sin cabecera → **503 `job_runner_unavailable`** si falta configuración, 401 si el token no coincide. Verificado |
| `CLAMAV_HOST` | Los adjuntos **no se escanean** | Adjuntar funciona igual | Decisión asumida en producción: [adjuntos-sin-antivirus.md](../../../docs/security/adjuntos-sin-antivirus.md) |
| `S3_REGION` | Entra en la firma SigV4; si no es la región real, las subidas fallan | Por omisión `eu-west-1`, que puede no ser la tuya | Subir un objeto |

### Las que NO deben definirse en producción

| Variable | Por qué |
|---|---|
| `ALLOW_SYNTHETIC_DATA_ONLY` | Declara «aquí no hay datos reales». Con `VERCEL_ENV=production` **la aplicación no arranca**, y la build la rechaza por existir — ni siquiera a `"false"`: una variable presente en el panel es una que alguien puede voltear un martes |
| `CASA_CLARA_FIXTURE_LOGIN` | Mete el selector de cuentas sintéticas **dentro del paquete**. Sus dos únicos consumidores legítimos son `playwright.config.ts` y `playwright.db.config.ts` |
| `SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT` | **Ya no existen** (migración 0029): la aplicación no manda correo a nadie. Si siguen en el panel de un despliegue anterior, **se borran**: hacen creer que hay un canal de aviso que no existe |
| `BACKUP_DATABASE_URL` | Es de la máquina de quien administra. **Nunca** en Vercel ni en el worker |

> En desarrollo, `vite dev` **siempre** lleva el selector de cuentas sintéticas
> dentro, sin declarar nada: por eso `/api/health` responde `"fixtureLogin":true`
> en local. En un paquete construido sin la variable, `?/demo` responde 404
> porque no existe ninguna acción con ese nombre.

---

## Lista de comprobación posterior al despliegue

No vale con leerla: **cada línea se ejecuta**. Las tres primeras son las que se
saltaron la vez que esto llegó a producción a medias.

```bash
BASE=https://casa.ejemplo.es
```

- [ ] **La bandera de entorno.** `curl -s $BASE/api/health` →
      `"synthetic":false` **y** `"fixtureLogin":false`. Las dos. Un
      `"fixtureLogin":true` en producción significa que el paquete lleva dentro
      el selector de cuentas de mentira.
- [ ] **La entrada es real.** `$BASE/login` pide **usuario y contraseña**. Si
      muestra tarjetas de cuentas, falta la base de identidad y **no estás
      sirviendo datos reales**.
- [ ] **Cada persona entra** con la contraseña que se le dictó y cae en «Hoy».
- [ ] **Los adjuntos tienen dónde caer.** Sube un justificante de verdad desde la
      cuenta del mes y **vuelve a verlo**. Un 503 aquí es el depósito sin
      configurar — no es transitorio.
- [ ] **Los avisos están puestos.** Entra en `/h/<hogar>/account`. Si dice
      «Esta instalación no manda avisos al móvil», faltan las claves VAPID.
      Si ofrece el interruptor, **enciéndelo en un teléfono de verdad y espera un
      aviso real**: el `sub` sucio sólo rompe los iPhone.
- [ ] **La firma del snapshot sobrevive a un reinicio.** Con
      `SNAPSHOT_SIGNING_KEY_B64` puesta, un snapshot pedido antes de un
      despliegue sigue validando después. Sin ella responde 200 igual: el 200 no
      prueba nada.
- [ ] **La cola drena.** `curl -si -X POST $BASE/api/v1/jobs/run -H "x-casa-clara-job-token: $JOB_RUNNER_TOKEN"`
      → 200 con `{"ran":…,"remaining":…,"stoppedBy":"empty",…}`. Sin la cabecera,
      401. Y el efecto real: **cierra un mes y comprueba que el PDF aparece en
      menos de cinco minutos**.
- [ ] **Un calendario enlazado se rellena solo.** Si sigue en
      `Pendiente de la primera lectura` pasada una hora, la cola no está drenando.
- [ ] **El aislamiento por hogar.** Entra como la empleada y pide
      `/h/<hogar>/settings`: tiene que ser **403**. Verificado en el ensayo:
      `settings`, `personal` y `employment/acuerdo` dan 403 a `employee_live_in`.
- [ ] **El catálogo del contrato llegó.** Como la empleada, en Contrato: la
      tarjeta de trabajo extra **ofrece el formulario** con los conceptos
      pactados. Si dice «Sin trabajo extra disponible», el contrato nació mudo:
      **para aquí** y léete
      [§ Contratos](referencia-operaciones.md#contratos).
- [ ] **Y puede usarlo.** Registra una jornada extra de prueba con fecha de hoy.
      Tiene que aceptarse.
