# Planificador de la cola de trabajos (pg_cron + pg_net → Vercel)

**Qué resuelve.** La aplicación fabrica trabajos desde hace tiempo —avisos de
rutina y de liquidación, auto-confirmación del parte semanal, PDF de los
justificantes, sincronización de calendarios enlazados, poda de los datos de
descubrimiento— y **nadie los ejecutaba**: no hay worker desplegado. Lo que se
notaba en casa: el calendario no se refrescaba solo, no llegaban recordatorios,
los justificantes no se generaban y el parte semanal no se auto-confirmaba.

**Cómo se resuelve, sin host extra y sin coste.** El planificador vive en la
propia base: `pg_cron` dispara cada pocos minutos una llamada HTTP con `pg_net`
a un endpoint de la web en Vercel, y ese endpoint vacía la cola con los MISMOS
manejadores del worker (`apps/worker/src/registry.ts`). No hay una segunda
implementación de los trabajos, ni un proveedor más que administrar.

```
  pg_cron  ──cada 5 min──▶  pg_net  ──POST──▶  /api/v1/jobs/run  (Vercel)
                                                      │
                                                      ▼
                                        runOneJob() sobre app_private.job_queue
```

> **Este runbook lo aplica quien administra la instalación.** Nada de lo que hay
> aquí lo ejecuta el proyecto por su cuenta, y ninguno de estos comandos se ha
> lanzado contra producción.

---

## 0. Antes de empezar

- Acceso SQL al proyecto de Supabase con el rol **`postgres`** (el editor SQL
  del panel vale; también `psql` por la conexión directa del puerto 5432).
- Acceso al panel de **Vercel** del proyecto de la web.
- Extensiones ya instaladas en producción — comprobar, no reinstalar:

  ```sql
  select extname, extversion, extnamespace::regnamespace as esquema
    from pg_extension
   where extname in ('pg_cron', 'pg_net', 'supabase_vault')
   order by extname;
  ```

  Se espera `pg_cron` 1.6.4, `pg_net` 0.20.4 y `supabase_vault`. Los objetos de
  `pg_cron` viven siempre en el esquema `cron` y los de `pg_net` en `net`,
  independientemente del esquema donde esté registrada la extensión.

---

## 1. El secreto compartido

El endpoint no tiene sesión: su única puerta es un secreto que viaja en la
cabecera `x-casa-clara-job-token` y que el servidor compara **en tiempo
constante** (sha-256 de ambos lados y `timingSafeEqual`, así que ni la longitud
se filtra).

```bash
openssl rand -hex 32
```

Ese valor va a **dos sitios y ninguno más**: la variable `JOB_RUNNER_TOKEN` del
proyecto de Vercel y el Vault de Supabase.

### Por qué el Vault y no el propio SQL

`cron.schedule` guarda el comando **en texto plano** en `cron.job`, y cada
ejecución deja una copia en `cron.job_run_details`. Un secreto escrito ahí
acaba, sin que nadie lo decida, en cualquier `pg_dump` del esquema `cron`, en
la vista del panel de Supabase y en el historial de ejecuciones, donde no se
rota ni caduca. Las alternativas que se consideraron:

| Vía | Por qué no |
| --- | --- |
| El token literal dentro de `cron.schedule` | Texto plano en `cron.job` y en `cron.job_run_details`; imposible rotar sin reescribir la tarea |
| `ALTER DATABASE … SET app.job_token = '…'` | Texto plano en `pg_db_role_setting`, legible con `current_setting` desde cualquier sesión |
| Tabla propia con el token | Reinventa el Vault sin cifrado en reposo |
| **`supabase_vault`** | **Cifrado en reposo con una clave que no vive en la base; el comando del cron solo menciona el NOMBRE del secreto** |

`supabase_vault` ya está instalado, que es el argumento que cierra la
discusión: es la vía que Supabase recomienda y no añade nada nuevo que mantener.

```sql
-- El secreto y la URL, los dos fuera del comando del cron.
select vault.create_secret(
  'PEGA-AQUI-EL-VALOR-DE-JOB_RUNNER_TOKEN',
  'casa_clara_job_runner_token',
  'Secreto compartido del drenaje de la cola (POST /api/v1/jobs/run)'
);

select vault.create_secret(
  'https://casa.ejemplo.es/api/v1/jobs/run',
  'casa_clara_job_runner_url',
  'Endpoint de drenaje de la cola en Vercel'
);
```

Comprobación (devuelve el valor descifrado; hazla en una sesión que no quede
grabada en ningún sitio):

```sql
select name, length(decrypted_secret) as longitud
  from vault.decrypted_secrets
 where name like 'casa_clara_job_runner%';
```

---

## 2. Variables en Vercel

En el proyecto de la web, entorno **Production** (y Preview si se quiere probar
allí, con un token DISTINTO):

| Variable | Valor | Nota |
| --- | --- | --- |
| `JOB_RUNNER_TOKEN` | el `openssl rand -hex 32` de §1 | obligatoria |
| `WORKER_DATABASE_URL` | `postgresql://casa_clara_worker_login:…@db.PROYECTO.supabase.co:6543/postgres` | **obligatoria**, ver abajo |
| `JOB_RUNNER_BUDGET_MS` | `8000` | opcional (por omisión 8000) |
| `JOB_RUNNER_LEASE_MS` | `300000` | opcional (por omisión 5 min) |
| `WORKER_MAX_JOB_ATTEMPTS` | `5` | opcional, mismo defecto que el demonio |

`SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT` y las cuatro `S3_*` ya estaban en la lista
de variables de la web (§3 y §5 de `.env.example`); el drenaje las necesita
también, porque de ahí salen los correos de los avisos y el PDF del
justificante. **Sin todas ellas el endpoint responde 503 y no toca la cola**:
un drenaje a medias mandaría los avisos a `dead` por falta de SMTP, en silencio.

### Por qué `WORKER_DATABASE_URL` y no `DATABASE_URL`

`app_private.job_queue` no tiene **ni un GRANT** para `casa_clara_app`
(migración 0005): encolar se hace por `app.enqueue_job`, y reclamar y mutar
filas es exclusivo del grupo `casa_clara_worker`. Que la web drene la cola no
cambia eso — abre una conexión aparte con el rol del worker. Si alguien pone
aquí la cadena de la aplicación, el endpoint fallará con «permission denied» en
vez de degradar silenciosamente los privilegios de la app.

---

## 3. Programar el drenaje

`pg_cron` ejecuta cada tarea con el rol que la programó. Conéctate como
`postgres` y asegura primero que ese rol puede llamar a `pg_net` (en muchos
proyectos ya lo puede; los `grant` son idempotentes):

```sql
grant usage on schema net to postgres;
grant execute on all functions in schema net to postgres;
```

Y ahora la tarea. Fíjate en que **el secreto no aparece**: solo su nombre.

```sql
select cron.schedule(
  'casa-clara-drenaje-cola',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
             where name = 'casa_clara_job_runner_url'),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-casa-clara-job-token',
      (select decrypted_secret from vault.decrypted_secrets
        where name = 'casa_clara_job_runner_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
```

`timeout_milliseconds := 15000` es deliberadamente mayor que el presupuesto del
endpoint (8 s) y que el corte de la función: si la plataforma tarda en arrancar
en frío, `pg_net` espera; nunca al revés.

Opcional — `pg_net` guarda la respuesta de cada llamada en `net._http_response`.
Si esa tabla crece más de lo que te apetece mirar, una limpieza semanal:

```sql
select cron.schedule(
  'casa-clara-purga-respuestas-pgnet',
  '17 4 * * 0',
  $$delete from net._http_response where created < now() - interval '3 days'$$
);
```

### Frecuencia: por qué cada cinco minutos

La cadencia de cada trabajo **ya la lleva el trabajo dentro**: se re-encola a sí
mismo (`ics.sync_all` a +6 h, la poda a +7 d, la escalada de liquidación a +3 d)
o nace con su fecha (`notification.*` a las 08:00 del día que toca,
`time_report.autoconfirm` a envío + 3 días). El cron **no marca el ritmo de los
trabajos: marca cuánto tarda en enterarse la cola.** Así que la pregunta real es
cuánto puede esperar el trabajo más impaciente.

| Trabajo | Su propio ritmo | Cuánto duele el retraso |
| --- | --- | --- |
| `document.render_receipt` | al cerrar la cuenta del mes | **El que más**: alguien acaba de cerrar y está esperando el justificante |
| `notification.routine_due` / `settlement_due` | una vez, a las 08:00 del día | Un aviso de las 08:00 que llega a las 08:20 ya llega tarde a un desayuno |
| `ics.sync_source` / `ics.sync_all` | unas cuantas veces al día (+6 h) | Un cambio en el calendario del colegio puede esperar minutos, no horas |
| `time_report.autoconfirm` | envío + 3 días | Ninguno |
| `maintenance.prune_discovery` | semanal | Ninguno |

Con `*/5` el peor caso es **5 minutos**, que es lo que aguanta el PDF del
justificante sin que nadie recargue la página preguntándose si se ha roto algo,
y deja los avisos de las 08:00 entregados como muy tarde a las 08:05.

Lo que cuesta: 288 llamadas al día ≈ **8.600 al mes**, frente al millón de
invocaciones del plan gratuito de Vercel. Una pasada con la cola vacía son
cinco viajes a Postgres (rescate, dos re-armes, un intento de reclamo y el
recuento) y termina en decenas de milisegundos.

Se consideró `*/15` (96 llamadas al día): ahorra invocaciones que no hacen
falta ahorrar y mete un cuarto de hora de espera en el único trabajo que alguien
mira de frente. Y se consideró `* * * * *` (cada minuto): 43.000 llamadas al mes
para ganar cuatro minutos en un caso y ninguno en el resto. **La frecuencia es
la expresión cron y nada más**: cambiarla es un `cron.unschedule` y volver a
programar, sin tocar el código.

---

## 4. Comprobar que funciona

```sql
-- 1. La tarea existe y está activa.
select jobid, jobname, schedule, active, username
  from cron.job where jobname like 'casa-clara-%';

-- 2. Las últimas ejecuciones del planificador (esto solo dice que el SQL del
--    cron corrió, no lo que contestó la web).
select jobid, status, return_message, start_time
  from cron.job_run_details
 where jobid in (select jobid from cron.job where jobname = 'casa-clara-drenaje-cola')
 order by start_time desc limit 10;

-- 3. Lo que contestó la web DE VERDAD. 200 con cuerpo JSON = drenaje correcto;
--    401 = el token de Vercel y el del Vault no coinciden; 503 = falta alguna
--    variable en Vercel (o la base no responde).
select id, created, status_code, content
  from net._http_response order by created desc limit 10;

-- 4. Y el efecto: nada atascado.
select status, job_type, count(*)
  from app_private.job_queue group by 1, 2 order by 1, 2;
```

Un cuerpo de respuesta sano tiene esta pinta:

```json
{"ran":2,"remaining":0,"reclaimed":{"requeued":0,"dead":0},
 "stoppedBy":"empty","elapsedMs":143,"budgetMs":8000}
```

- `stoppedBy: "budget"` con `remaining` alto y sostenido en varias pasadas
  significa que la cola entra más rápido de lo que se vacía: sube
  `JOB_RUNNER_BUDGET_MS` (si el plan permite más de 10 s de función) o baja la
  expresión cron a `*/2`.
- `reclaimed.dead > 0` es un trabajo que agotó sus intentos: mira `last_error`
  en `app_private.job_queue` antes de re-encolarlo.

Prueba manual del extremo a extremo, desde tu máquina:

```bash
curl -si -X POST https://casa.ejemplo.es/api/v1/jobs/run \
  -H "x-casa-clara-job-token: $JOB_RUNNER_TOKEN"
# 200 y el JSON de arriba. Sin la cabecera: 401 {"error":"unauthorized"}.
```

Criterio de salida: una liquidación cerrada genera su PDF en el bucket en menos
de cinco minutos, y un feed ICS enlazado aparece en el calendario sin que nadie
toque nada.

---

## 5. Operación

**Pausar sin borrar** (una ventana de mantenimiento, una migración larga):

```sql
update cron.job set active = false where jobname = 'casa-clara-drenaje-cola';
-- y para volver:
update cron.job set active = true  where jobname = 'casa-clara-drenaje-cola';
```

**Rotar el secreto.** Primero el Vault, después Vercel — al revés hay una
ventana de 401. Da igual perder una o dos pasadas: la cola espera.

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'casa_clara_job_runner_token'),
  'EL-NUEVO-VALOR'
);
```

**Cambiar de dominio**: `vault.update_secret` sobre `casa_clara_job_runner_url`.
La tarea del cron no se toca.

**Retirar el planificador** (por ejemplo, si algún día vuelve a desplegarse el
worker como demonio en un host propio):

```sql
select cron.unschedule('casa-clara-drenaje-cola');
select cron.unschedule('casa-clara-purga-respuestas-pgnet');
```

Los dos ejecutores pueden convivir sin coordinarse: el reclamo usa
`for update skip locked`, así que el demonio y el drenaje se reparten los
trabajos y ninguno ejecuta el mismo dos veces.

---

## 6. Qué mirar cuando algo va mal

| Síntoma | Causa probable | Dónde mirar |
| --- | --- | --- |
| `cron.job_run_details` en `failed` con «permission denied for schema net» | Faltan los `grant` de §3 | §3 |
| `net._http_response` con `status_code = 401` | El token de Vercel ≠ el del Vault | §1, §5 |
| `status_code = 503` y cuerpo `job_runner_unavailable` | Falta alguna variable en Vercel | §2 |
| `status_code = 503` y cuerpo `job_queue_unavailable` | La base no responde o el rol no puede tocar la cola | `WORKER_DATABASE_URL` |
| `net._http_response` vacío | El cron no llega a llamar; mira `cron.job.active` y `cron.job_run_details` | §4 |
| Trabajos atascados en `running` | El ejecutor murió a mitad | Se rescatan solos pasado `JOB_RUNNER_LEASE_MS` (5 min); en la respuesta salen como `reclaimed.requeued` |
| Cola vacía y nada periódico | Base recién sembrada: `job_queue` sin ninguna fila que sirva de ancla | Sembrar el primer job a mano (§4.5 de `docs/despliegue/runbook-despliegue.md`); a partir de ahí el drenaje re-arma las cadenas solo |

**Registro.** Cada pasada deja una línea JSON en los logs de la función con el
logger que redacta: `{"scope":"web:jobs","msg":"job queue drained",
"counts":{"ran":…,"remaining":…,"requeued":…,"dead":…},"ms":…}`, y cada trabajo
otra con su `jobId`, `jobType`, `householdId` y duración. Ni correos, ni
nombres, ni contenido de los avisos.
