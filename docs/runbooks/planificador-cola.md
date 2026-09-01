# Planificador de la cola de trabajos (pg_cron + pg_net → Vercel)

**Qué resuelve.** La aplicación fabrica trabajos desde hace tiempo —PDF de los
recibos, sincronización de calendarios enlazados, poda de los datos de
descubrimiento— y **nadie los ejecutaba**: no hay worker desplegado. Lo que se
notaba en casa: el calendario no se refrescaba solo y los recibos del mes no se
generaban.

> **Nota de 11/08/2026.** Este runbook hablaba también de avisos de rutina y de
> liquidación y de la auto-confirmación del parte semanal. Los tres se
> retiraron con la migración 0029 —no hay correo y no hay parte semanal—. Si
> aplicas este runbook sobre una instalación anterior, la propia 0029 deja en
> `dead` lo que hubiera encolado de los tres tipos retirados: no hace falta
> tocar la cola a mano.
>
> **Ampliación de esa misma tarde.** Vuelve **uno** de los tres, por el canal que
> sí existe: `notification.push` (migración 0032), que manda los avisos al móvil.
> Son **cinco** tipos de trabajo. Ese manejador **solo se registra si hay claves
> VAPID**; sin ellas la cola se vacía exactamente igual y ningún aviso llega a
> encolarse. El de rutinas NO vuelve, y las razones están en
> `docs/notificaciones.md` §6. Puesta en marcha del canal:
> `docs/runbooks/notificaciones-push.md`.
>
> **Enmienda de 31/08/2026.** Se suma un sexto: `notification.close_due_sweep`
> (migración 0034), el barrido mensual que encola el tercer aviso —«el mes
> está a punto de acabar», a quien administra, el penúltimo día del mes y solo
> si queda algo por cerrar—. **Son seis** tipos de trabajo ahora. Comparte la
> misma condición que `notification.push`: **solo se registra si hay claves
> VAPID**. El catálogo de avisos pasa de dos a tres — ver
> `docs/notificaciones.md` §0ter.

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
cabecera `x-housekeeper-job-token` y que el servidor compara **en tiempo
constante** (sha-256 de ambos lados y `timingSafeEqual`, así que ni la longitud
se filtra). Una instalación con el planificador ya programado bajo el nombre
legado sigue funcionando: el servidor también acepta la cabecera
`x-casa-clara-job-token` (nombre legado del proyecto anterior; ver
[docs/despliegue/identificadores-legado.md](../despliegue/identificadores-legado.md))
sin que haga falta reprogramar la tarea de cron.

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

El drenaje necesita además **un almacén de objetos**, porque de ahí sale el PDF
del recibo. Vale cualquiera de los dos caminos de §3 de `.env.example` —la clave
de servicio de Supabase (`SUPABASE_SERVICE_ROLE_KEY`) o las cuatro `S3_*`— y lo
elige la misma función que lo elige para los adjuntos, así que no hay que
declarar nada por segunda vez. **Sin ninguno de los dos el endpoint responde 503
y no toca la cola**: un drenaje a medias mandaría los recibos a `dead` por falta
de almacén, en silencio.

> **Dos exigencias que se han retirado de esta lista** (11/08/2026), las dos
> porque tenían la cola de producción parada por una configuración que en
> realidad no faltaba:
>
> - **`SMTP_HOST` y `SMTP_FROM`.** Sin remitente configurado —y no lo hay,
>   porque no hay correo— el endpoint devolvía 503 en cada pasada del cron y no
>   se vaciaba nada. La migración 0029 retiró la salida de correo entera; si
>   siguen puestas en el panel de Vercel, se borran.
> - **Las cuatro `S3_*` en concreto.** El despliegue recomendado guarda los
>   adjuntos en Supabase Storage y no tiene credenciales S3 ningunas: pedirlas
>   aquí dejaba la cola sin vaciarse con el almacén perfectamente configurado al
>   lado. Ahora se pide almacén, no una marca de almacén.

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
      'x-housekeeper-job-token',
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
  'housekeeper-purga-respuestas-pgnet',
  '17 4 * * 0',
  $$delete from net._http_response where created < now() - interval '3 days'$$
);
```

### Frecuencia: por qué cada cinco minutos

La cadencia de cada trabajo **ya la lleva el trabajo dentro**: se re-encola a sí
mismo (`ics.sync_all` a +6 h, la poda a +7 d) o nace al cerrar un mes. El cron
**no marca el ritmo de los trabajos: marca cuánto tarda en enterarse la cola.**
Así que la pregunta real es cuánto puede esperar el trabajo más impaciente.

| Trabajo | Su propio ritmo | Cuánto duele el retraso |
| --- | --- | --- |
| `document.render_receipt` | al cerrar la cuenta del mes | **El que más**: alguien acaba de cerrar y está esperando el recibo |
| `ics.sync_source` / `ics.sync_all` | unas cuantas veces al día (+6 h) | Un cambio en el calendario del colegio puede esperar minutos, no horas |
| `notification.push` | dos veces al mes, y con hora propia | Ninguno: su `run_at` ya trae la ventana de silencio aplicada, así que cinco minutos de más no lo sacan de hora |
| `maintenance.prune_discovery` | semanal | Ninguno |

Con `*/5` el peor caso es **5 minutos**, que es lo que aguanta el PDF del recibo
sin que nadie recargue la página preguntándose si se ha roto algo.

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
  from cron.job where jobname like 'casa-clara-%' or jobname like 'housekeeper-%';

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
  -H "x-housekeeper-job-token: $JOB_RUNNER_TOKEN"
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
select cron.unschedule('housekeeper-purga-respuestas-pgnet');
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
otra con su `jobId`, `jobType`, `householdId` y duración. Ni nombres ni
contenido: solo identificadores técnicos.

---

## 7. Backfill de recibos históricos (Frente E)

Antes de la migración `0035_settlement_receipt_document.sql`, `document.render_receipt`
generaba el PDF y lo subía al almacén, pero no quedaba ningún registro en la
base: ni documento, ni fila que dijera «este objeto es EL recibo de esta
liquidación». Las liquidaciones cerradas ANTES de esa migración siguen así —
el PDF existe en el bucket, pero `app.settlement_receipts` no tiene su fila, y
`employment/+page.svelte` enseña «El recibo se está generando» para siempre en
vez de un enlace.

**No hay backfill automático** (fuera de alcance, ver el diseño de este
frente). Se corrige re-encolando el mismo trabajo: el PDF es determinista dado
el mismo snapshot canónico, así que el propio backfill es idempotente CONSIGO
MISMO — volver a lanzarlo produce el mismo `generatedAt`, el mismo hash y la
misma clave de objeto cada vez, y `app_private.record_settlement_receipt`
reutiliza el `storage_object` de la vez anterior en lugar de subir un segundo
PDF (ver el comentario de esa función en la migración 0035).

Ojo con `generatedAt`: **no puede ser `now()`**. El SQL de abajo usa
`settlement.closed_at`, que es estable, precisamente para esa idempotencia
consigo mismo; con `now()` cada ejecución del backfill generaría un hash y una
clave distintos. Eso no rompería nada de golpe —`record_settlement_receipt`
mira primero si ya existe fila para ese `settlement_id` y, si la hay, devuelve
su documento sin tocar nada más—, pero cada relanzamiento subiría un PDF nuevo
y huérfano sin que el registro llegara a apuntar a él: puro gasto de almacén,
repetido cada vez que alguien tuviera que volver a lanzar el mismo backfill.

Eso sí: la clave que produce el backfill (con `generatedAt = closed_at`) casi
seguro **no coincide** con la del render original en línea —el que disparó el
propio cierre, con `generatedAt = new Date().toISOString()` del instante real
del cierre (`packages/server/src/commands/settlement.ts`)—, así que la
primera vez que se lanza el backfill de una liquidación sube un PDF NUEVO a
una clave nueva. El objeto del render original queda huérfano en el bucket:
nadie lo referencia, nadie lo borra, y es inocuo (bytes de más, nada roto).

**El payload no se puede reconstruir desde `app.settlement_lines` sin más**: el
snapshot canónico que exige `document.render_receipt` (`householdName`,
`employeeName`, las líneas con su `concept`/`detail`/`amountCents`, los tres
totales y la `reference`) es justo la forma que ya fabrica `closeSettlement`
(`packages/server/src/commands/settlement.ts`) al cerrar. Reconstruirlo aquí
sería duplicar esa lógica; en su lugar, el SQL de abajo la re-arma leyendo las
líneas ya congeladas de la propia liquidación, que es exactamente lo que el
cierre real congeló y no cambia.

```sql
-- Ejecutar como el propietario de la migración (o cualquier rol con BYPASSRLS):
-- INSERT directo en app_private.job_queue, igual que hace el propio worker
-- (`createMaintenanceQueries`/`createPushQueries`/`createCloseDueQueries` en
-- apps/worker/src). NO usar app.enqueue_job: exige un contexto de sesión
-- completo (app.user_id/household_id/membership_id) que una operación de
-- mantenimiento entre hogares no tiene por qué tener.
begin;
set local row_security = off;

insert into app_private.job_queue (household_id, job_type, payload, run_at)
select
  settlement.household_id,
  'document.render_receipt',
  jsonb_build_object(
    'settlementId', settlement.id,
    'receipt', jsonb_build_object(
      'householdName', household.display_name,
      'employeeName', employee_profile.display_name,
      'period', to_char(settlement.period_start, 'YYYY-MM'),
      -- Estable, NO now(): el backfill tiene que producir el mismo hash y la
      -- misma clave cada vez que se re-lance (ver el párrafo de arriba).
      'generatedAt', settlement.closed_at,
      'lines', (
        select jsonb_agg(
                 jsonb_build_object(
                   'concept', line.concept,
                   'detail', case when line.provenance ? 'unitCents' and (line.provenance->>'unitCents') is not null
                                  then (line.provenance->>'quantity') || ' × ' || (line.provenance->>'unitCents') || ' cts'
                                  else line.provenance->>'quantity' end,
                   'amountCents', line.amount_cents::text
                 )
                 order by line.line_number
               )
          from app.settlement_lines as line
         where line.household_id = settlement.household_id and line.settlement_id = settlement.id
      ),
      'salaryTotalCents', settlement.salary_total_cents::text,
      'reimbursementTotalCents', settlement.reimbursement_total_cents::text,
      'transferTotalCents', settlement.transfer_total_cents::text,
      'reference', 'liq-' || to_char(settlement.period_start, 'YYYY-MM') || '-' || left(settlement.id::text, 8)
    )
  ),
  now()
  from app.settlements as settlement
  join app.households as household on household.id = settlement.household_id
  join app.household_memberships as employee_membership
    on employee_membership.household_id = settlement.household_id
   and employee_membership.id = settlement.employee_membership_id
  join app.user_profiles as employee_profile on employee_profile.user_id = employee_membership.user_id
 where settlement.status = 'closed'
   and not exists (
     select 1 from app.settlement_receipts as receipt
      where receipt.household_id = settlement.household_id and receipt.settlement_id = settlement.id
   )
   -- Acotar aquí a los hogares/periodos concretos del backfill; sin filtro,
   -- esto re-encola TODAS las liquidaciones cerradas históricas de golpe.
   and settlement.household_id = '00000000-0000-0000-0000-000000000000'::uuid /* ← sustituir por el hogar */;

commit;
```

El resto lo hace la cola normal: el drenaje (worker o `pg_cron`) reclama cada
`document.render_receipt`, renderiza, sube (reutilizando el objeto si ya
existía) y esta vez SÍ registra. No se encola ningún aviso de «tu recibo ya
está» para estos re-renders históricos —`announceReceipt` también corre, y
avisar meses después de un recibo que ya se cobró hace tiempo sería ruido—,
así que conviene lanzar el backfill sin claves VAPID a mano si se quiere
evitarlo del todo, o aceptar el aviso si el canal ya está activo: no hay
manera de re-encolar el render sin re-disparar también el aviso, porque los
dos viven en el mismo trabajo por diseño (ver `apps/worker/src/handlers.ts`).
