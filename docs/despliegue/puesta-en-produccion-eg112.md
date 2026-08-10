# Puesta en producción de Casa EG112

> Documento de integración de seis auditorías independientes (build, variables,
> Supabase, siembra, worker, seguridad) sobre el estado del proyecto Vercel
> `housekeeper-web` y lo que falta para que sirva el hogar real **Casa EG112**
> contra Supabase.
>
> Punto de partida: HEAD `28c732f` (merge del PR #7, 2026-08-09 23:07 +0200).
> Cuando dos auditorías discrepan, aquí se resuelve la discrepancia y se dice
> cuál es correcta y por qué; las contradicciones pendientes están en el §6.

---

## 1. Estado actual

**Lo que hay desplegado.** El dominio `www.homekeeping.app` sirve la aplicación
Casa Clara construida y desplegada en Vercel, y la build es correcta: el
proyecto tiene *Root Directory* = `apps/web`, que es el ajuste bueno, y el
adaptador se elige solo porque la plataforma exporta `VERCEL=1`
(`apps/web/svelte.config.js:31-33`). Eso funciona **por un arreglo de ayer**:
antes de `93c8f05` el adaptador por omisión era `adapter-node`, que escribe en
`apps/web/build/` en vez de en `.vercel/output`, y el despliegue moría con «No
Output Directory named "public" found» **después de una build en verde**. El
proyecto no tiene ninguna de las variables de ejecución que la aplicación
necesita: solo están las que dejó la integración de Supabase (`POSTGRES_*`,
`SUPABASE_*`, `NEXT_PUBLIC_*`), y **ninguna de ellas la lee una sola línea de
este repositorio**. La base de datos de Supabase está vacía: el esquema no se ha
instalado nunca, no existen los roles `casa_clara_*` y no hay hogar dado de alta.
El `apps/worker` no está desplegado en ningún sitio.

**Qué está mal.** Sin `DATABASE_AUTH_URL` ni `BETTER_AUTH_SECRET`, `getAuth()`
devuelve `null` (`apps/web/src/lib/server/auth.server.ts:18-23`), `/api/auth`
responde 404 (`apps/web/src/hooks.server.ts:19-21`), las sesiones salen de un
`Map` en memoria del proceso (`apps/web/src/hooks.server.ts:44-50`) y `/login`
publica un **selector con cinco cuentas sintéticas** —nombre, inicial, rol y
correo— a cualquiera que abra el dominio
(`apps/web/src/routes/login/+page.server.ts:32-33` y `:44-54`). Sin
`DATABASE_URL` el pool es `null` y todas las pantallas caen a las maquetas de
`apps/web/src/lib/server/fixtures.server.ts` sin avisar. Es decir: un dominio
público, indexable (no hay `robots.txt` en `apps/web/static/`, que contiene
exactamente `icon.svg` y `manifest.webmanifest`), enseñando una casa inventada
con nombres de personas y una alergia infantil ficticia. No hay fuga de datos
reales porque todavía no hay datos reales; el problema es que **el mismo
mecanismo que hoy es inocuo se vuelve peligroso en el momento exacto en que se
conecte la base**, y por dos caminos distintos: el selector de fixtures sigue
vivo si se define `DATABASE_URL` sin `DATABASE_AUTH_URL`, y el fallback a
fixtures de cada `+page.server.ts` se dispara ante **cualquier** fallo de base de
datos, incluida la pantalla de Emergencias.

---

## 2. Riesgos ordenados por gravedad

### R1 — CRÍTICO. Selector de demostración servido en un dominio público

**Qué pasa.** `resolveMode()` devuelve `'fixture-selector'` en cuanto `getAuth()`
es nulo (`apps/web/src/routes/login/+page.server.ts:32-33`) y el `load` envía al
navegador la lista completa de cuentas sintéticas (`:44-54`). Cualquiera que
entre en `www.homekeeping.app/login` ve una casa con puerta abierta.

**Corrección entre auditorías.** Las auditorías de variables y de siembra
describen el selector como «expuesto»; la de seguridad matiza correctamente y
**tiene razón**: en este HEAD, pulsar una tarjeta **no** crea sesión fuera de
localhost. La acción está cerrada dos veces:

```
apps/web/src/routes/login/+page.server.ts:94
    if (getAuth()) error(404, 'Este entorno entra con contraseña');
apps/web/src/routes/login/+page.server.ts:95
    if (!dev && !isLocalHostname(url.hostname)) error(403, 'El acceso demo solo está disponible en local');
```

`dev` es constante de compilación (falsa en `vite build`) y `isLocalHostname`
solo acepta `localhost`, `127.0.0.1` y `::1`
(`apps/web/src/lib/server/synthetic.server.ts:30-32`). Además, `createDemoSession`
tiene un único llamador, esa misma acción (`:103`). Por tanto el daño de **hoy**
es fuga del censo de cuentas ficticias y una fachada engañosa, no un
administrador abierto.

**Pero eso no lo deja en «leve», por tres motivos concretos:**

1. **No sabemos de qué commit salió el artefacto que corre.** La reja entró en
   `4d8f20f`. Si el despliegue se subió a mano con `vercel deploy` desde un
   portátil, el bundle vivo puede ser anterior. Hay que comprobarlo hoy
   (§4, paso 0).
2. **La reja depende de una cabecera.** `url.hostname` sale del `Host` /
   `x-forwarded-host` que reconstruye el adaptador. Una puerta de administración
   no debe descansar en la normalización de una cabecera por la plataforma.
3. **Perdió su gemela.** `docs/despliegue/opciones-de-acceso.md:48` describe una
   «doble reja» que además exigía `ALLOW_SYNTHETIC_DATA_ONLY=true`. Hoy solo
   queda una.

**El escenario letal, que es el verdadero riesgo de R1.** El selector **no
depende de `DATABASE_URL`**, solo de `DATABASE_AUTH_URL` + `BETTER_AUTH_SECRET`
(`auth.server.ts:20`). Existe por tanto una combinación alcanzable por accidente:

> `DATABASE_URL` = base real de Casa EG112 · `DATABASE_AUTH_URL` ausente
> → **selector de fixtures vivo sobre datos reales**, con identidades que operan
> bajo RLS.

Y no es hipotético: es una configuración que el propio repositorio ejercita
(`apps/web/playwright.db.config.ts:52-55`, «login por selector demo (sin
`DATABASE_AUTH_URL`) pero con datos reales bajo RLS»). Los identificadores demo
son principales reales: `apps/web/src/lib/server/fixtures.server.ts:3-5` los
declara, `packages/db/fixtures/001_two_households.sql:12-16` los inserta como
`app.user_profiles.user_id`, y `hooks.server.ts:47` los mete tal cual en
`locals.user.id`, de donde van a `set_config('app.user_id', …)`
(`packages/server/src/database.ts:29`).

**Arreglo.**

- **Inmediato, sin desplegar nada:** activar *Deployment Protection* (Vercel
  Authentication) sobre `housekeeper-web` mientras dure la preparación. Es lo
  único que cierra el dominio sin depender de un despliegue.
- **Regla operativa indivisible:** `DATABASE_URL`, `DATABASE_AUTH_URL`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` y `SNAPSHOT_SIGNING_KEY_B64` **entran
  en la misma operación o no entra ninguna**.
- **Estructural (recomendado antes de meter datos reales):** que el camino
  fixture no esté en el bundle de producción, en vez de estar apagado por un
  `if`. Bandera de compilación en `apps/web/vite.config.ts`:

  ```ts
  define: {
    __FIXTURE_LOGIN__: JSON.stringify(process.env.CASA_CLARA_FIXTURE_LOGIN === 'true')
  }
  ```

  y `resolveMode()` / la acción `demo` colgando de ella. Con la constante falsa,
  Rollup elimina la rama entera: `listDemoUsers`, `getDemoUser` y
  `createDemoSession` dejan de estar referenciados desde `/login` y la función
  desplegada **no contiene código capaz de emitir una sesión fixture**. Es
  auditable con `grep` sobre `.vercel/output`, no una promesa. Las dos configs
  de Playwright (`apps/web/playwright.config.ts:39`,
  `apps/web/playwright.db.config.ts:54`) son el único consumidor legítimo y
  añaden `CASA_CLARA_FIXTURE_LOGIN=true` a su comando de build.

---

### R2 — CRÍTICO. Degradación silenciosa a datos inventados con la base real conectada

**Este es, técnicamente, el hallazgo más grave del expediente, y el único que no
se arregla al conectar Supabase: se activa al conectarlo.** Va segundo solo
porque R1 es lo visible hoy.

El patrón está replicado en todas las pantallas del hogar. Verificado literal:

```
apps/web/src/routes/h/[householdId]/emergency/+page.server.ts:5-9
  const live = locals.user ? await loadEmergencyContacts(...) : null;
  if (live) return { live, emergency: null };
  // Sin base de datos (o sin membresía autorizada) la demo conserva la maqueta.
  return { live: null, emergency: getEmergencyFixture() };
```

y el `null` que alimenta ese `if` lo produce un `catch` que se traga **cualquier**
fallo —pooler saturado, proyecto en pausa, timeout, red— y lo colapsa con «no
hay base de datos» y con «no te toca»:

```
apps/web/src/lib/server/contacts.server.ts:71-76
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) log.error('contacts unavailable', ...);
    return null;
  }
```

Consecuencia concreta: durante un corte de base, la pantalla de **Emergencias**
del hogar real muestra sin ningún aviso los teléfonos y las instrucciones
inventados de `apps/web/src/lib/server/fixtures.server.ts:341-351` («Centro
Pediátrico Olmo · 910 000 111», «la llave general está bajo el fregadero») y la
alergia ficticia «Leo · sin lácteos» (`:234`). Una persona sola en casa, en una
urgencia, leyendo teléfonos falsos que la aplicación presenta como los de la
casa.

Mismo patrón en `today/+page.server.ts:11-13`, `menu/+page.server.ts:20-26`,
`employment/+page.server.ts:13`, `calendar/+page.server.ts:11`,
`contacts/+page.server.ts:9`, `recipes/+page.server.ts:18`,
`routines/+page.server.ts:11`, `wiki/+page.server.ts:13`,
`wiki/[slug]/+page.server.ts:32`, `search/+page.server.ts:26,41`,
`settings/+page.server.ts:39`.

**Arreglo.** La misma constante de compilación de R1: el fallback fixture debe
existir solo donde exista el login fixture.

```ts
if (live) return { live, emergency: null };
if (__FIXTURE_LOGIN__) return { live: null, emergency: getEmergencyFixture() };
error(503, 'Ahora mismo no podemos leer los datos de la casa. Vuelve a intentarlo en un momento.');
```

Y separar en `contacts.server.ts:71-76` el `AuthorizationError` (que es 403/404
legítimo) del error de infraestructura (que debe propagarse como 503). El 503
cae en el camino offline honesto —snapshot firmado + service worker—, que ya
distingue bien lo real de la fixture (`fixtures.server.ts:218-241`); es el
`load` de la página el que rompe la disciplina.

**Este es el arreglo que hay que hacer si solo se hace uno.**

---

### R3 — CRÍTICO (irreversible). Sembrar el acuerdo con `agreement:seed` deja un acuerdo mudo

`packages/db/scripts/seed-employment-agreement.mjs` **ejecuta sin error y
produce un acuerdo inservible**. Verificado: `grep extra_work_types
seed-employment-agreement.mjs` no devuelve nada, y `insertFirstVersion`
(líneas ~480-504) inserta **únicamente** en `app.agreement_versions`. El
relleno del catálogo de 0021 es un `INSERT … SELECT` que corre una sola vez, en
el momento de migrar (`packages/db/migrations/0021_agreement_terms_catalogue.sql:470-484`):
una versión creada **después** por el guion nace sin conceptos y nada la rellena.

Efecto medible: `registrableTypes` sale exclusivamente del catálogo filtrado por
la versión vigente (`apps/web/src/lib/server/employment.server.ts:412-419`), sale
vacío, y la empleada ve «Sin trabajo extra disponible — Este acuerdo no permite
registrar trabajo extra por ahora»
(`apps/web/src/lib/components/employment/ExtraWorkPendingCard.svelte:232-234`) y
«Tu acuerdo no contempla trabajo extra por ahora»
(`.../employment/condiciones/+page.svelte:59`).

**Por qué es irreversible.** Las versiones son inmutables
(`0002_employment.sql:68-98`) y el catálogo también (`0021:164-182`).
`stackAgreementVersion` exige `effectiveFrom > previous.effectiveFrom`
(`apps/web/src/lib/server/agreement-terms.server.ts:486-491`), así que quedaría
una ventana de días —desde `starts_on` hasta la v2— en la que la empleada no
puede registrar nada **nunca**, ni retroactivamente: el disparador de congelación
exige que el tipo sea el de la versión vigente el día trabajado (`0021:291-295`).
Y **no existe ninguna ruta en el código para cerrar o anular un acuerdo**.

> **RESUELTO.** El guion hace ahora las dos cosas: **se niega** a escribir si el
> JSON no declara `agreement.extraWorkTypes` —el fallo era silencioso, y eso era
> lo peor de él— y **acepta el catálogo completo y lo escribe** en la misma
> transacción, con el orden y las columnas reliquia de `insertVersion`. Retirarlo
> del todo habría dejado el alta de un hogar real en manos de un formulario sin
> `--dry-run`, sin idempotencia y sin marcha atrás sobre tablas que solo admiten
> INSERT; poder ensayar el alta antes de hacerla vale más aquí que en ningún otro
> sitio. Las cinco claves de 0002 (`overtimeHourlyRateCents`,
> `workedRestDayRateCents`, `workedRestDayCreditMinutes`, `allowsHourlyOvertime`,
> `allowsExtraShifts`) se rechazan diciendo adónde se fueron; las columnas
> reliquia se derivan del catálogo. `docs/despliegue/alta-de-hogar.md` §3 está
> reescrito con las dos vías y §8 con los huecos que sí quedan.

La otra vía sigue siendo la buena por defecto: la pantalla
`/h/<householdId>/employment/acuerdo`, acción `create`, escribe acuerdo +
versión + catálogo + complementos en una sola transacción bajo la RLS de la
administradora (`apps/web/src/routes/h/[householdId]/employment/acuerdo/+page.server.ts`
→ `createAgreement`, `apps/web/src/lib/server/agreement-terms.server.ts:406-453`).
`apps/web/tests/agreement-alta.integration.test.ts` la recorre entera desde un
hogar sin acuerdo hasta la empleada registrando una jornada extra.

---

### R4 — CRÍTICO. Usar `POSTGRES_URL` como `DATABASE_URL` apaga RLS de hecho

Es el atajo natural («ya está la cadena en el panel, la copio») y es peor que no
tener base de datos.

`POSTGRES_URL` autentica como `postgres`, que en Supabase es **propietario** de
las tablas y llega **sin `BYPASSRLS`**. Eso dispara
`packages/db/migrations/0018_rls_force_compat.sql:44-56`, que el runner ejecuta
entre migraciones (`packages/db/scripts/migrate.mjs:76-81,98-100`) y que hace
literalmente `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` sobre toda tabla de
`app`/`app_private` cuyo propietario sea el rol conectado. El propio fichero
explica que eso es seguro **porque `casa_clara_app` no es propietario de ninguna
tabla** (`:13-16`). Conectar la aplicación como `postgres` invierte esa premisa:
`set_config('app.user_id', …)` (`packages/server/src/database.ts:29`) y
`app.set_household_context()` (`:52`) seguirían ejecutándose, pero **ninguna
política se aplicaría**. Aislamiento entre hogares y entre roles: perdido.

**Arreglo.** `DATABASE_URL` = `casa_clara_app_login` y `DATABASE_AUTH_URL` =
`casa_clara_auth_login`, ambos por el pooler 6543. Las `POSTGRES_*` y las
`SUPABASE_*` se dejan donde están, inertes: **cero lecturas en todo el
repositorio**.

---

### R5 — CRÍTICO/ALTA. Sin worker, el calendario engaña y la autoconfirmación es una bomba

Hoy no se nota porque nadie encola nada (sin pool, `POST /api/v1/sync` responde
503, `apps/web/src/routes/api/v1/sync/+server.ts:33-34`). Empieza a doler el día
que se conecte la base.

- **`ics.sync_source` / `ics.sync_all` — el peor, y con engaño.** El calendario
  enlazado queda «Pendiente de la primera lectura» para siempre
  (`apps/web/src/routes/h/[householdId]/calendar/+page.svelte:79-84`). Peor:
  **pausar un calendario no lo pausa** — el borrado de eventos lo hace el job
  `ics.sync_source {clear:true}` (`packages/server/src/commands/rhythm.ts:394-405`
  → `app_private.replace_ics_source_events`,
  `0015_ics_source_events.sql:69-141`), pero las consultas de Calendario y Hoy
  leen `app.ics_source_events` sin mirar `ics_sources.enabled`
  (`apps/web/src/lib/server/calendar.server.ts:163-170`,
  `apps/web/src/lib/server/today.server.ts:441-462`). El manual promete lo
  contrario: «Dejar de mostrar un calendario borra sus eventos de la casa»
  (`docs/manual/index.html:1674`). Es una promesa de privacidad incumplida en
  silencio.
- **`time_report.autoconfirm` — bomba de relojería.**
  `app_private.autoconfirm_weekly_report` marca `confirmed_at =
  statement_timestamp()` (`0006_reminders_and_autoconfirm.sql:119-127`), no la
  fecha en que debió confirmarse. Arrancar el worker meses después
  **autoconfirma de golpe todos los partes atrasados con fecha de hoy**: un
  histórico falso, y precisamente en el módulo que sirve de prueba de la relación
  laboral. Mientras tanto, la empleada lee «la familia tiene tres días para
  confirmarla» (`WeeklyReportCard.svelte:138`) y el parte se queda «Enviado ·
  pendiente de confirmación» para siempre.

**Arreglo.** Desplegar el worker **antes o a la vez** que la base real, nunca
después. Recomendación en §5.

---

### R6 — ALTA. No se puede auditar qué está corriendo

No hay `vercel.json` en el repositorio (verificado: `find . -name vercel.json`,
excluyendo `node_modules`, no devuelve nada), toda la configuración vive en el
panel, y el despliegue vivo puede haber salido de un `vercel deploy` manual. Sin
conexión Git → Vercel, **ninguna afirmación de seguridad sobre producción es
verificable**. Arreglo: §4, pasos 0 y 1.

---

### R7 — ALTA. Dominio indexable, sin `robots.txt` y sin cabeceras de refuerzo

`apps/web/static/` contiene exactamente `icon.svg` y `manifest.webmanifest`.
`apps/web/src/hooks.server.ts:68-72` emite `X-Content-Type-Options`,
`Referrer-Policy` y `Permissions-Policy`, pero **no** `Strict-Transport-Security`
ni `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy`. Arreglo:
Deployment Protection ahora; `apps/web/static/robots.txt` con `Disallow: /`
mientras dure la preparación; `X-Robots-Tag: noindex, nofollow` junto a las tres
cabeceras actuales; y añadir HSTS (`max-age=63072000; includeSubDomains; preload`),
COOP y CORP. `X-Frame-Options` no hace falta: `frame-ancestors: ['none']` en
`apps/web/svelte.config.js:85` lo cubre. La CSP con nonce está bien planteada;
no tocarla.

---

### R8 — ALTA (latente). El ZIP de traspaso mezcla ficción con datos reales

```
apps/web/src/lib/server/handover.server.ts:201-202
  /** Contactos de la casa: la fuente vigente es la fixture compartida. */
  function renderContacts(): string { const { contacts } = getContactsFixture(); ... }
```

`GET /api/v1/…/handover` exige `family_admin` y pool real, y produce un ZIP con
menús, rutinas y guía **reales** y una hoja `contactos.md` **inventada**: un
documento que se entrega a una canguro con teléfonos falsos entre datos
verdaderos. `app.contacts` existe desde `0013_contacts.sql` y hay cargador
(`contacts.server.ts:41-76`). Cablear `renderContacts` a `loadContacts` **antes
del primer traspaso real**.

---

### R9 — MEDIA. Clave de firma del snapshot efímera

Sin `SNAPSHOT_SIGNING_KEY_B64`, cada proceso genera su propio par Ed25519
(`apps/web/src/lib/server/keys.server.ts:31-37`). En Vercel hay N instancias: la
clave pública que viaja en el layout puede venir de otra instancia que la que
firmó, `verifySnapshotSignature` devuelve `'invalid'` y `sync.ts:308-310` **no
persiste el snapshot y sale sin mensaje**. El modo sin conexión —del que depende
la pantalla de Emergencias— deja de funcionar en silencio. Obligatoria.

---

### R10 — MEDIA. Comprobación de origen permisiva en los endpoints JSON

```
apps/web/src/routes/api/v1/sync/+server.ts:30-31   (idéntico en attachments/+server.ts:32-33)
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) error(403, 'Origen no permitido');
```

Sin cabecera `Origin` no se comprueba nada. Hoy lo mitiga la cookie
`SameSite=strict`, pero es una defensa que vive en la cookie, no en el endpoint.
Debe ser exigencia positiva. En el mismo bloque: `secure` de la cookie se calcula
como `url.protocol === 'https:'` (`login/+page.server.ts:103`,
`logout/+server.ts:10`) — otra propiedad de seguridad derivada de una cabecera;
debe ser `secure: !dev`.

---

### R11 — BAJA. `/api/health` y `/api/metrics` sin autenticación

`guardForPath` solo cubre `/h/…` (`apps/web/src/lib/auth/routing.ts:74`).
`/api/metrics` publica `rss` y `heapUsed` del proceso
(`apps/web/src/lib/server/health.server.ts:27-30`). No hay etiquetas por usuario,
así que el daño es inventario, no fuga. En Vercel no hay Prometheus que las
raspe: cerrarlas con token o borrar la ruta.

### R12 — BAJA. Service worker que sobrevive al cierre de sesión

`apps/web/src/service-worker.ts:47-63` cachea toda navegación `ok`, incluidas
pantallas del hogar. `logout/+server.ts:5-11` borra la cookie y la sesión de
servidor pero no invalida Cache API ni IndexedDB. En un móvil compartido, cerrar
sesión no borra lo que ya está en el dispositivo.

---

## 3. Antes de tocar nada: qué NO es un riesgo

Para no gastar esfuerzo donde no hace falta.

- **`ALLOW_SYNTHETIC_DATA_ONLY` es una etiqueta, no un cerrojo.** Se lee una vez
  (`hooks.server.ts:17` → `synthetic.server.ts:25-27`), viaja por layout data y
  termina pintando un párrafo (`AppShell.svelte:196-204`). No gobierna ninguna
  decisión de autorización, escritura, envío ni el selector de login. Con datos
  reales dentro **no protege nada** y además miente en un banner permanente. Su
  único efecto real llegaría con el worker: rechazar todo destinatario que no sea
  de dominio de prueba (`apps/worker/src/integrations.ts:88-100`), o sea, matar
  todos los avisos. **No definirla.**
- **`ENABLE_DEMO_PASSWORD_AUTH` ya no existe en el código.** Aparece en
  `.env.example:215`, `runbook-despliegue.md:287` y `plan-vercel-supabase.md:532`;
  `grep` sobre `apps/` y `packages/` no la encuentra. Quien configure producción
  leyendo esos documentos creerá que ha cerrado una puerta que no existe.
- **`SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` no van en Vercel.** `grep -rn SMTP
  apps/web` no devuelve nada; solo las lee el worker
  (`apps/worker/src/config.ts:54-56`). `.env.example:148` y
  `runbook-despliegue.md:283` están desfasados: el acceso ya no usa correo
  (`auth-core.ts:46-49`).
- **`ORIGIN`, `HOST`, `PORT` no aplican en Vercel.** Son de `adapter-node`; en
  Vercel el origen se deriva de `x-forwarded-host`. La auditoría de siembra pide
  definir `ORIGIN` en su paso 3: **eso es incorrecto**, y lo dice la propia
  `.env.example:183-186`. La protección CSRF efectiva es `csrf.checkOrigin` de
  SvelteKit, activa por omisión (`svelte.config.js:65-91` no la desactiva).
- **`DEPLOY_TARGET` no debe crearse.** Con ella ausente, el objetivo se deduce de
  `VERCEL` (`svelte.config.js:31-33`), que es lo correcto y está fijado por
  prueba en `apps/web/tests/deploy-target.test.ts:36-38`. Crearla con valor
  `node` reintroduce el fallo de `93c8f05`.
- **Las migraciones no se ejecutan en Vercel, y está bien así.** No existe ningún
  script `vercel-build` ni `postinstall` en el repositorio. Meterlas en el build
  las haría correr por el pooler y en cada despliegue.
- **No depende del worker:** el feed ICS de salida se genera en la petición
  (`apps/web/src/routes/api/v1/ics/[token]/+server.ts`); rutinas, menú, saldos,
  caducidad de membresías y cierre de liquidación son síncronos.

---

## 4. Runbook de puesta en producción

Ejecutable de arriba abajo. Cada paso lleva su verificación y su plan si falla.

### Paso 0 — Cortar la exposición y averiguar qué está corriendo (HOY)

```bash
# 0.a ¿La reja del §R1 está en el bundle desplegado?
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://www.homekeeping.app/login?/demo' \
  --data 'accountId=fixture:roble:admin'
```

- **403** → la puerta está cerrada; el artefacto es coherente con este HEAD.
- **303 con `set-cookie: cc_demo_session`** → **el bundle desplegado es anterior a
  `4d8f20f`**. Hay una función servidor viva de commit desconocido. **Corta el
  dominio hoy** y no sigas hasta identificar el origen del artefacto.

```bash
# 0.b Sonda del modo fixture. /api/health NO sirve: devuelve ok incondicionalmente
#     sin tocar la base (health.server.ts:9-15). La que discrimina es /api/auth,
#     que hooks.server.ts:19-21 responde 404 exactamente mientras getAuth() sea null.
curl -s -o /dev/null -w '%{http_code}\n' https://www.homekeeping.app/api/auth/ok
# 404 → sigue en modo fixture (estado actual)
# 200 → Better Auth montado
```

**0.c** En el panel: *Settings → Deployment Protection → Vercel Authentication*
activada mientras dure toda esta preparación. Se desactiva en el paso 12.

**0.d** En el panel: *Settings → Git*, conectar el repositorio si no lo está, para
que a partir de aquí todo despliegue tenga commit conocido (R6).

### Paso 1 — Ajustes del proyecto Vercel

| Ajuste | Valor | Estado |
|---|---|---|
| Root Directory | `apps/web` | **Ya está bien. NO cambiar.** |
| Include source files outside of the Root Directory | **activado** | Verificar la casilla |
| Framework Preset | SvelteKit | Ya está bien |
| Node.js Version | 24.x | Ya está bien |
| Install Command | `pnpm install --frozen-lockfile --filter "@casa-clara/web..."` | Cambio recomendado |
| Build Command | `pnpm run build` | Igual al defecto del preset |
| Output Directory | vacío / override desactivado | El adaptador entrega Build Output API v3 |

**Contradicción resuelta.** `docs/despliegue/runbook-despliegue.md:262` dice
literalmente «*Root Directory*: la raíz del repositorio (**no** `apps/web`)».
**El runbook está equivocado y el panel está bien.** La razón es mecánica: el
adaptador escribe en una ruta relativa al cwd de la build
(`@sveltejs/adapter-vercel@6.3.4/index.js:47`, `const dir = '.vercel/output'`),
y ese cwd es `apps/web` porque ahí corre `vite build` (`apps/web/package.json:8`).
Vercel busca el Build Output API **dentro** del Root Directory: con `apps/web`
coinciden. Con la raíz, el adaptador seguiría escribiendo en
`apps/web/.vercel/output` y Vercel miraría en `<raíz>/.vercel/output`, que no
existe. Y apuntar el campo *Output Directory* a `apps/web/.vercel/output` es peor
todavía: ese campo designa un directorio **estático**, así que Vercel intentaría
servir como sitio estático un árbol con `config.json`, `functions/` y `static/`
sin `index.html` → **el mismo error que arregló `93c8f05`**, por otro motivo.

La casilla «Include source files outside of the Root Directory» **no es
opcional**: sin ella no existen `pnpm-workspace.yaml` ni `packages/*` durante la
build y el install muere en el primer `workspace:*`
(`apps/web/package.json:23-25`). Además el empaquetado de la función la necesita:
el adaptador traza dependencias con `@vercel/nft` y con pnpm los módulos reales
viven en `<raíz>/node_modules/.pnpm/…`, así que el ancestro común sube a la raíz
del repositorio.

**Recorte del install.** Verificado en local: `pnpm --filter "@casa-clara/web..."
ls --depth -1` selecciona exactamente `web`, `contracts`, `domain` y `server`. Sin
filtro se instalan los 6 proyectos, lo que arrastra `sharp` 0.35.3 (nativo, con
scripts habilitados en `pnpm-workspace.yaml:5-8`), `tesseract.js`, `nodemailer`,
`web-push`, `@aws-sdk/client-s3` y Playwright, a cambio de nada: `apps/web` no
depende de `@casa-clara/db` ni de `@casa-clara/worker` (las tres menciones a `db`
dentro de `apps/web` son comentarios).

**No añadir `.vercelignore`** para excluir `apps/worker`: si el directorio no
está, `pnpm install --frozen-lockfile` falla porque los *importers* del lockfile
no cuadran con los proyectos del workspace. El recorte correcto es por `--filter`.

**Verificación.** Un despliegue de prueba desde Git debe terminar en verde y sus
*Build Logs* deben contener las líneas de `pnpm install` y `vite build`. Si el log
está prácticamente vacío, el despliegue anterior era `--prebuilt` y esta cadena
nunca se había ejercitado en la plataforma.

**Si falla.** «No Output Directory named "public" found» tras build en verde →
alguien ha creado `DEPLOY_TARGET=node` o ha movido el Root Directory. Install que
muere en `workspace:*` → la casilla de ficheros externos está apagada (se apaga
sola al recrear el proyecto).

### Paso 2 — Fijar la configuración en el repositorio

Crear **`/home/abf/Github/hosekeeperApp/apps/web/vercel.json`** (en `apps/web`,
que es el Root Directory y el sitio donde el propio adaptador lo busca,
`index.js:52`):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "sveltekit",
  "installCommand": "pnpm install --frozen-lockfile --filter \"@casa-clara/web...\"",
  "buildCommand": "pnpm run build"
}
```

No meter `regions` (la pone el adaptador, `svelte.config.js:34,50`, y duplicarla
invita a conflicto) ni `crons` (no hay worker en Vercel). No crear `vercel.json`
en la raíz: con Root Directory en `apps/web`, Vercel no lo lee.

### Paso 3 — Cambios de código obligatorios antes de que haya datos reales

En una entrega propia, con pruebas, fusionada a `main` antes del despliegue que
lleve las variables reales.

1. **`__FIXTURE_LOGIN__`** en `apps/web/vite.config.ts`, y colgar de ella
   `resolveMode()` y la acción `demo` en `apps/web/src/routes/login/+page.server.ts`,
   la rama demo de `apps/web/src/hooks.server.ts:44-50`, y **todos** los
   `return { …: getXFixture() }` de los `+page.server.ts` listados en R2, que
   pasan a `error(503, …)`. Añadir la bandera al comando de build de
   `apps/web/playwright.config.ts:39` y `apps/web/playwright.db.config.ts:54`.
2. **Guardián de build** `apps/web/scripts/check-production-env.mjs`, encadenado
   en `apps/web/package.json:8` como `"build": "node scripts/check-production-env.mjs && vite build"`.
   Rechaza la build cuando `VERCEL_ENV === 'production'` y falte alguna de
   `DATABASE_URL`, `DATABASE_AUTH_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, o
   exista alguna de `ALLOW_SYNTHETIC_DATA_ONLY`, `CASA_CLARA_FIXTURE_LOGIN`, o
   `BETTER_AUTH_URL` no empiece por `https://`.

   **Por qué en la build y no en el arranque.** En Vercel la web es una función
   serverless: un `throw` en `init` no «no arranca», **falla cada petición**,
   incluidas las de quien ya estaba dentro, y la única persona capaz de
   arreglarlo es la que se acaba de quedar fuera. Si en cambio falla la build,
   **el despliegue anterior sigue sirviendo** y la configuración mala nunca llega
   a producción. Es el patrón que el worker ya usa
   (`apps/worker/src/config.ts:20-24`) trasladado al único momento en que fallar
   es gratis.
3. **`robots.txt`** en `apps/web/static/` y `X-Robots-Tag: noindex, nofollow` +
   HSTS + COOP + CORP en `apps/web/src/hooks.server.ts:68-72` (R7).
4. **Origen positivo** en `sync/+server.ts:30-31` y `attachments/+server.ts:32-33`,
   y `secure: !dev` en la cookie (R10).

Recomendado en la misma entrega o inmediatamente después: `handover.server.ts`
cableado a `loadContacts` (R8). ~~Y retirar `seed-employment-agreement.mjs` o
hacerlo abortar (R3)~~ — **ya hecho**: el guion se niega sin catálogo y lo
escribe cuando lo hay, y su batería lo comprueba fila a fila.

### Paso 4 — Instalar el esquema en Supabase

Todo desde el portátil, **nunca desde Vercel**.

```bash
export PATH=/tmp/codex-node24/bin:$PATH
cd /home/abf/Github/hosekeeperApp
pnpm install --frozen-lockfile

# Directa 5432, rol propietario. NO el pooler.
export DATABASE_URL='postgresql://postgres:<CLAVE_POSTGRES>@db.<REF>.supabase.co:5432/postgres?sslmode=verify-full'
```

**Por qué la directa y no el pooler.** `packages/db/scripts/migrate.mjs:68` toma
`pg_advisory_lock(hashtext('casa_clara_schema_migrations'))`, que es un cerrojo
**de sesión** (no `_xact_`) y se libera en `:124`; el pooler en modo transacción
devuelve la conexión física a otro cliente entre transacciones y el cerrojo queda
huérfano. Escribe `sslmode=verify-full` explícito: `pg-connection-string@2.14.0`
deja `ssl: undefined` si no pones nada, es decir, **conexión en claro**.

**Comprobaciones previas** (con el rol que va a migrar, no con el editor SQL del
panel, que corre como `supabase_admin` y falsearía el resultado). En esta máquina
no hay `psql`; usa un cliente `pg` mínimo desde el scratchpad.

```sql
-- a) PG15+ obligatorio: 0003 crea tres vistas WITH (security_invoker = true)
SELECT current_setting('server_version_num')::int >= 150000 AS soporta_security_invoker,
       current_setting('server_version_num')::int >= 160000 AS rama_grant_inherit_false;

-- b) La misma pregunta que hace el runner (migrate.mjs:37-43)
SELECT coalesce(bool_or(rolsuper OR rolbypassrls), false) AS can_bypass
  FROM pg_catalog.pg_roles WHERE rolname = current_user;

-- c) unaccent y pg_trgm deben estar en el esquema `extensions`
SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname IN ('unaccent','pg_trgm');

-- d) app/app_private/casa_auth AUSENTES; `auth` presente y de supabase_auth_admin
SELECT nspname, pg_get_userbyid(nspowner) FROM pg_namespace
 WHERE nspname IN ('app','app_private','casa_auth','auth','extensions','public');

-- e) Sin instalación previa
SELECT to_regclass('public.schema_migrations');   -- debe ser NULL

-- f) La conexión conserva estado de sesión (dos viajes SEPARADOS)
SELECT pg_try_advisory_lock(hashtext('casa_clara_schema_migrations'));
SELECT pg_advisory_unlock(hashtext('casa_clara_schema_migrations'));  -- debe dar true
```

Sobre (b): `can_bypass = false` es lo normal en Supabase y **es correcto**;
`migrate` intercalará `0018_rls_force_compat.sql` entre migraciones e imprimirá
`owner cannot bypass RLS; relaxing FORCE…` (`migrate.mjs:80`).

Sobre (d): si `auth` apareciera propiedad de `casa_clara_auth_login`, **para**:
`bootstrap.sql:112-118` renombraría el esquema de GoTrue y romperías la
autenticación de Supabase.

**Ejecución.**

```bash
# Guardadas fuera del repositorio, en 600. Las tres son necesarias.
export APP_DB_PASSWORD="$(openssl rand -base64 32)"
export WORKER_DB_PASSWORD="$(openssl rand -base64 32)"
export AUTH_DB_PASSWORD="$(openssl rand -base64 32)"

pnpm --filter @casa-clara/db bootstrap
```

Criterio de salida literal (`bootstrap.mjs:66-73`):

```
bootstrap ok: 5 roles casa_clara_*, esquema casa_auth presente, public.unaccent(regdictionary, text) resoluble
```

Si dice **4 o menos roles** o **`casa_auth ausente`**, para: falta ADMIN OPTION
(`bootstrap.sql:83`, `:105`). Solución: `GRANT casa_clara_auth_login TO postgres;`
y relanzar el bootstrap, que es idempotente. Si olvidas exportar las tres
contraseñas el bootstrap **no falla**: imprime `sin APP_DB_PASSWORD…: los roles
de login se crean sin tocar su contraseña` (`bootstrap.mjs:41-43`) y el síntoma
aparece días después, cuando la web no puede conectar.

```bash
pnpm --filter @casa-clara/db migrate
```

**Criterio de salida: `Applied 20 migration(s).`** Hay 20 ficheros en
`packages/db/migrations/` (0001…0018, 0020, 0021 — no existe 0019). Los
documentos están desfasados: `supabase-esquema.md:24` y `:215` dicen «las 18
migraciones», `runbook-despliegue.md:95` dice «17/17» y
`probe-supabase.mjs:246` imprime «18 migraciones» a pelo. **El número correcto es
20.**

```bash
pnpm --filter @casa-clara/db migrate   # -> Database is up to date; no migrations applied.
```

**Suites SQL — DESTRUCTIVAS. Solo ahora, con la base vacía.**

```bash
TEST_DATABASE_URL="$DATABASE_URL" pnpm --filter @casa-clara/db test:db
```

`packages/db/scripts/run-sql-tests.mjs:27-31` hace, sin preguntar y sin bandera
de confirmación, `DROP SCHEMA IF EXISTS app CASCADE`, `DROP SCHEMA IF EXISTS
app_private CASCADE`, `DROP TABLE IF EXISTS public.schema_migrations`, vuelve a
migrar y carga `packages/db/fixtures/001_two_households.sql`. `pnpm test:rls` hace
exactamente lo mismo (`resetAndProvision` en `:54` corre **antes** de filtrar qué
ficheros ejecutar). **A partir del alta del hogar, estos dos comandos son un
`DROP SCHEMA app CASCADE` con otro nombre.** `runbook-despliegue.md:96-104` y
`supabase-esquema.md:25` los recomiendan sin ese aviso: es el hueco más peligroso
de la documentación actual.

Criterio de salida: `# tests 7 passed, 0 failed of 7` (hay **siete** ficheros en
`packages/db/tests/`, no cinco como dicen los documentos).

**Dejar la base limpia y cerrar PostgREST:**

```sql
DROP SCHEMA IF EXISTS app CASCADE;
DROP SCHEMA IF EXISTS app_private CASCADE;
DROP TABLE IF EXISTS public.schema_migrations;
```
```bash
pnpm --filter @casa-clara/db migrate      # -> Applied 20 migration(s).
```
```sql
REVOKE ALL ON TABLE public.schema_migrations FROM anon, authenticated;
```

`migrate.mjs:12-18` crea `public.schema_migrations` **sin RLS**, y `public` es el
único esquema que expone PostgREST: sin ese `REVOKE`, los nombres y SHA-256 de
las migraciones quedan legibles desde internet con la clave anónima. Verificación
desde fuera, que es la que vale:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: <SUPABASE_ANON_KEY>" \
  'https://<REF>.supabase.co/rest/v1/schema_migrations?select=filename&limit=1'
# debe dar 401/404, nunca 200
```

Y en el panel, *API settings → Exposed schemas*: solo `public`.

**Si falla.**

- `ENETUNREACH` / `EAI_AGAIN` → el nombre directo de Supabase resuelve solo a
  IPv6 y este WSL2 no tiene salida IPv6. Salida correcta: **Supavisor en modo
  SESIÓN** (`postgresql://postgres.<REF>:CLAVE@aws-0-<region>.pooler.supabase.com:5432/postgres`),
  que sí conserva `pg_advisory_lock`. El que **no vale jamás** es el 6543.
- `SELF_SIGNED_CERT_IN_CHAIN` → descarga el CA del panel y usa
  `NODE_EXTRA_CA_CERTS=/ruta/prod-ca.crt` manteniendo `verify-full`. **No bajes a
  `sslmode=no-verify`**: por ahí viaja la contraseña de `postgres` y después todo
  el expediente laboral.
- `0007` muere con `operator class "gin_trgm_ops" does not exist` → el
  `search_path` no llegó. `bootstrap.sql:210-223` hace `ALTER ROLE … SET
  search_path`, que **no afecta a la sesión en curso**. Es la trampa de ejecutar
  el bootstrap a mano y migrar en la misma sesión.
- Cualquier otro fallo a mitad: **relanzar `migrate`**. Cada migración se aplica y
  se registra dentro de la **misma** transacción (`migrate.mjs:101-112`), así que
  nunca existe el estado «aplicada pero no registrada». Salta las ya aplicadas y
  continúa por la que falló.
- **Reversión, mientras no haya datos reales:** `DROP SCHEMA app CASCADE`, `DROP
  SCHEMA app_private CASCADE`, `DROP TABLE public.schema_migrations`, y repetir
  desde el bootstrap. **No toques `auth`, `storage`, `graphql`, `realtime`,
  `vault`, `extensions` ni `supabase_migrations`: son de Supabase.** Con datos
  reales dentro, la única reversión es restaurar copia desde el panel (§5).

### Paso 5 — Alta de las personas de Casa EG112

JSON del hogar **fuera del repositorio**, en `600`, con `household` + `people`
(tres personas, **dos `family_admin`**). **Quita el bloque `agreement` entero:**
ya no se usa por guion y dejarlo invita a ejecutarlo (R3).

```bash
export DATABASE_AUTH_URL='postgresql://casa_clara_auth_login:<PWD_AUTH>@<HOST_POOLER>:6543/postgres'
export SEED_DATABASE_URL="$DATABASE_URL"        # la directa 5432, propietario
export BETTER_AUTH_SECRET='<SECRETO>'           # el MISMO que irá a Vercel

pnpm --filter @casa-clara/web seed:accounts --config /ruta/hogar.json --dry-run
pnpm --filter @casa-clara/web seed:accounts --config /ruta/hogar.json > /ruta/credenciales.txt
chmod 600 /ruta/credenciales.txt
```

Este guion **sí es válido tal cual**: solo escribe identidad y membresía
(Better Auth, luego `app.households`, `app.user_profiles`,
`app.household_memberships`), y ni 0020 ni 0021 tocan esas tablas. Es
imprescindible: `disableSignUp: true` en todos los entornos
(`auth-core.ts:60`) y sin membresía viva `resolveAppUser` devuelve `null`
(`app-user.server.ts:44-47`), lo que produce login correcto seguido de
redirección eterna a `/login`.

**Apunta el id del hogar que imprime**: hace falta en el paso 9.

### Paso 6 — Variables en Vercel

`vercel env add` pide el valor por entrada estándar; ningún secreto va en la línea
de órdenes ni queda en el historial.

```bash
export PATH=/tmp/codex-node24/bin:$PATH
cd /home/abf/Github/hosekeeperApp/apps/web
vercel link --project housekeeper-web --scope <ÁMBITO>
```

**Las 13 obligatorias**, todas en `production`:

| Variable | Valor | Lector |
|---|---|---|
| `DATABASE_URL` | `postgresql://casa_clara_app_login:<PWD_APP>@<HOST_POOLER>:6543/postgres` | `apps/web/src/lib/server/db.server.ts:13` |
| `DATABASE_AUTH_URL` | `postgresql://casa_clara_auth_login:<PWD_AUTH>@<HOST_POOLER>:6543/postgres` | `auth.server.ts:20,25` |
| `BETTER_AUTH_SECRET` | `<openssl rand -base64 48>` — **el mismo del paso 5** | `auth.server.ts:20,26` |
| `BETTER_AUTH_URL` | `https://www.homekeeping.app` | `auth.server.ts:27` |
| `SNAPSHOT_SIGNING_KEY_B64` | `<openssl genpkey -algorithm ed25519 \| base64 -w0>` | `keys.server.ts:28` |
| `S3_ENDPOINT` | `https://<REF>.supabase.co/storage/v1/s3` | `attachment-deps.server.ts:130` |
| `S3_REGION` | `<región real del proyecto>` | `attachment-deps.server.ts:141` |
| `S3_PRIVATE_BUCKET` | `<nombre del bucket PRIVADO>` | `attachment-deps.server.ts:131` |
| `S3_ACCESS_KEY_ID` | `<clave S3 de Supabase Storage>` | `attachment-deps.server.ts:132` |
| `S3_SECRET_ACCESS_KEY` | `<secreto S3 de Supabase Storage>` | `attachment-deps.server.ts:133` |
| `CLAMAV_HOST` | `<nombre público de la pasarela>` | `attachment-deps.server.ts:122` |
| `CLAMAV_PORT` | `3311` | `attachment-deps.server.ts:123` |
| `CLAMAV_TLS` | `true` | `attachment-deps.server.ts:127` |
| `CLAMAV_TOKEN` | `<openssl rand -hex 32>`, el MISMO que `CLAMAV_GATEWAY_TOKEN` | `attachment-deps.server.ts:128` |

**Precisión sobre las cuatro de ClamAV** (aquí discrepan las auditorías y la
resolución importa): la guarda que devuelve `null` exige **solo** `CLAMAV_HOST`,
un `CLAMAV_PORT` entero y las cuatro de S3 —`attachment-deps.server.ts:134-136`—.
`CLAMAV_TLS` y `CLAMAV_TOKEN` **no** entran en esa guarda. Es decir: sin ellas la
dependencia se construye igual, pero la conexión con la pasarela falla o va **en
claro**, que es peor que no funcionar: el documento del hogar viajaría sin cifrar
entre Vercel y el host del worker. Son obligatorias por operación, no por
construcción. `CLAMAV_PORT` **debe** ser `3311`: el defecto `3310` es clamd
desnudo y la pasarela TLS escucha en `3311` (`infra/clamav/gateway.mjs:52`).
`S3_REGION` es formalmente opcional (defecto `eu-west-1`) pero entra en la firma
SigV4: si no coincide, **todas** las operaciones S3 fallan.

**Acoplamiento sorprendente que conviene conocer antes de decidir sobre ClamAV
(§5):** si `createAttachmentDependencies` devuelve `null`, no solo se rompe la
**subida** de adjuntos (503, `attachments/+server.ts:36-38`) sino también **ver un
justificante ya guardado** (503, `receipts/[expenseId]/+server.ts:20-21`), que no
escanea nada. La dependencia del antivirus está en el constructor, no en la
operación.

**Comprobar que no queda basura peligrosa:**

```bash
vercel env ls production | grep -E 'DEPLOY_TARGET|ALLOW_SYNTHETIC_DATA_ONLY|ENABLE_DEMO_PASSWORD_AUTH|CASA_CLARA_FIXTURE_LOGIN'
# no debe devolver nada
```

**No crear** `DEPLOY_TARGET`, `VERCEL_MAX_DURATION`, `VERCEL_DEPLOY_REGION`,
`VERCEL_NODE_RUNTIME` (los defectos del código ya son los correctos:
`fra1`, `nodejs24.x`, 60 s), ni `SMTP_*`, ni `ORIGIN`. Las `POSTGRES_*` y
`SUPABASE_*` se dejan donde están, inertes.

Nota de dimensionado: `db.server.ts:13` abre el pool con `max: 5` y
`auth-core.ts:97` otro con `max: 3` → **8 conexiones por instancia fría**. Con el
pooler no es grave, pero es lo que hay que mirar si aparecen errores de
saturación.

### Paso 7 — Redesplegar y verificar el corte

Las variables **no se aplican a despliegues ya hechos**. Redespliega desde Git.

```bash
# 1. Better Auth montado
curl -s -o /dev/null -w '%{http_code}\n' https://www.homekeeping.app/api/auth/ok
# debe dar 200. Si sigue en 404, faltan DATABASE_AUTH_URL o BETTER_AUTH_SECRET.

# 2. La puerta demo no existe
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://www.homekeeping.app/login?/demo' --data 'accountId=fixture:roble:admin'
# debe dar 404 (getAuth() no es nulo → login/+page.server.ts:94)
```

Y a ojo: **`/login` tiene que pedir usuario y contraseña, no tarjetas.** Si
siguen las tarjetas con la base conectada, estás exactamente en el escenario
letal de R1: **retira `DATABASE_URL` inmediatamente** hasta arreglar la identidad.

**Si falla.** Login correcto seguido de redirección eterna a `/login` → o falta
`DATABASE_URL` (`resolveAppUser` devuelve `null` y `hooks.server.ts:55-57`
redirige) o la persona no tiene membresía viva (paso 5). Sign-in rechazado desde
el dominio real → `BETTER_AUTH_URL` mal: por omisión vale `http://localhost:3000`
(`auth.server.ts:27`) y `auth-core.ts:53-78` no declara `trustedOrigins`.

### Paso 8 — El acuerdo de Casa EG112, desde la pantalla

Entrar como `family_admin` → **Pagos → «Administrar el acuerdo»**
(`/h/<id>/employment/acuerdo`). En el formulario de alta:

- Empleada, `startsOn`, `effectiveFrom = startsOn`, salario mensual, minutos
  semanales contratados, **`annualVacationDays = 30`**, motivo.
- **Conceptos: los que se hayan pactado, y ninguno más.** Para el caso de EG112,
  dos: «Jornada extra» (`jornada_extra`, `per_shift`, **480** minutos de
  referencia) y «Media jornada extra» (`media_jornada_extra`, `per_shift`,
  **240**), cada uno con su tarifa y `active` marcado. Los minutos de referencia
  son obligatorios en toda jornada (`0021:103`).
- **No añadas ningún concepto `per_hour`.** Eso es toda la desactivación de las
  horas sueltas: la política `extra_work_types_employee_read` (`0021:413-424`)
  exige `active AND rate_cents IS NOT NULL`, así que una fila inexistente y una
  fila inactiva son indistinguibles para ella y la tarifa horaria **no sale de
  Postgres**. No crearla es más limpio: no queda ninguna tarifa horaria escrita
  en ningún sitio.
- Complementos: solo si los hay, marcando bien «suma a la transferencia»
  (`adds_to_pay=true`) frente a «lo paga la casa» (`false`).
- **Vacaciones: ninguna fila más.** No hay tabla de saldo; los 30 días **son**
  `annual_vacation_days` de la versión. `app.vacation_periods` solo se llena
  cuando se disfruten días.

Las dos columnas reliquia (`overtime_hourly_rate_cents`,
`worked_rest_day_rate_cents`) son `NOT NULL` (`0002_employment.sql:47-48`) y la
pantalla ya las resuelve: `hourly?.rateCents ?? '0'`
(`agreement-terms.server.ts:303-328`). Con las horas desactivadas quedan en 0,
que es lo coherente.

**Verificación inmediata, entrando como la empleada.** En «Mis condiciones»:
salario, jornada, «30 días naturales al año» y **solo** la jornada extra con su
tarifa, **ninguna tarifa horaria**. En Pagos, la tarjeta de trabajo extra debe
ofrecer el formulario con «Jornada extra» en el desplegable, **no** el mensaje
«Sin trabajo extra disponible».

**Si falla.** «Esa persona ya tiene un acuerdo activo en este hogar» (`23505`,
`agreement-terms.server.ts:448-450`) es el índice único
`one_active_agreement_per_employee_idx` protegiéndote de un doble envío: no es un
error, es la red. **La pantalla no tiene `--dry-run` y no es idempotente por
repetición**; revisa el formulario antes de enviarlo, porque la versión es
inmutable y no hay ruta para anular un acuerdo.

**Si prefieres ensayarlo antes**, `agreement:seed` volvió a ser utilizable y es
la única vía con ensayo: escribe acuerdo, versión y catálogo, y `--dry-run` hace
rollback de verdad. Se ejecuta desde el portátil con la directa y el rol
propietario, igual que `migrate`. El formato del JSON y las dos vías, en
`docs/despliegue/alta-de-hogar.md` §3.

### Paso 9 — El manual

```bash
export DATABASE_URL='postgresql://postgres:<CLAVE>@db.<REF>.supabase.co:5432/postgres?sslmode=verify-full'
pnpm --filter @casa-clara/db manual:import --household "<ID_DEL_PASO_5>" --dry-run
pnpm --filter @casa-clara/db manual:import --household "<ID_DEL_PASO_5>"
```

Funciona igual contra Supabase. No toma cerrojos de sesión (a diferencia de
`migrate`), pero **sí necesita el rol propietario**, que en Supabase es `postgres`
por la directa. Condición: que `migrate` haya corrido antes, porque los módulos
hacen `set local row_security = off` (`wiki-import.mjs:364-366`,
`seed-manual.mjs:145-147`) y eso solo sirve porque `0018` ya quitó el `FORCE` de
las tablas del propietario.

**Aviso operativo real:** la plantilla de menú necesita un grupo de comensales
vivo. Si no lo hay, el guion avisa y sigue; hay que **repetir este paso** después
de crear el grupo desde la aplicación (`alta-de-hogar.md` §4, el aviso al pie).

### Paso 10 — Desde la aplicación

Grupo de comensales → **repetir el paso 9**. Calendario ICS: queda enlazado y
vacío hasta que haya worker.

### Paso 11 — El worker (ver §5)

**Antes de arrancarlo por primera vez contra datos reales, decidir qué se hace con
los partes atrasados** (R5). Lo limpio es no dejar que se acumulen: desplegarlo
**antes o a la vez** que la base real.

Y **sembrar un job en la cola** tras el alta del hogar, o los ciclos periódicos de
ICS y poda nunca se programan: `ensurePruneDiscoveryScheduled`
(`apps/worker/src/maintenance.ts:136-166`) y `ensureIcsSyncScheduled`
(`apps/worker/src/ics.ts:800-823`) se abstienen si la cola está vacía y **solo se
ejecutan una vez, al arrancar el proceso** (`apps/worker/src/index.ts:146-157`,
fuera del bucle). Enlazar el primer calendario ya sirve de semilla.

### Paso 12 — Cerrar

Desactivar Deployment Protection solo cuando los pasos 7 y 8 estén verificados.
Retirar entonces el `robots.txt` con `Disallow: /` si se quiere que el dominio sea
indexable, o dejarlo: es una casa privada.

### Paso 13 — Corregir la documentación

No es cosmético: cada uno de estos documentos, seguido al pie de la letra, produce
un fallo concreto.

| Fichero | Qué corregir |
|---|---|
| `docs/despliegue/runbook-despliegue.md:259-264` | *Root Directory* = `apps/web`; *Install Command* con `--filter "@casa-clara/web..."`; *Output Directory* vacío; casilla de ficheros externos activada. Explicar que `.vercel/output` es relativo al cwd de la build |
| `docs/despliegue/runbook-despliegue.md:95` y `:96-104` | «17/17» → **20**; y aviso destructivo sobre `test:db` / `test:rls` |
| `docs/despliegue/runbook-despliegue.md:283`, `.env.example:148-152` | `SMTP_*` no van en Vercel |
| `docs/despliegue/runbook-despliegue.md:81-87`, `:105-107` | Superado por `bootstrap.sql`; §1.3 declara B-1 sin resolver y sí lo resuelve `0018` |
| `docs/despliegue/supabase-esquema.md:24,215` | «18 migraciones» → **20** |
| ~~`docs/despliegue/alta-de-hogar.md` §3 y §8~~ | **Hecho.** §3 reescrito con las dos vías (pantalla y guion) y el catálogo obligatorio; §8 con los huecos que sí quedan |
| `docs/despliegue/opciones-de-acceso.md:30-60` | Describe `deliverMagicLink()`, tres modos de login y `demoCredentialFor()`: **nada de eso existe** |
| `.env.example:215`, `runbook:287`, `plan-vercel-supabase.md:531-533` | `ENABLE_DEMO_PASSWORD_AUTH` no existe en el código |
| `.env.example:69-72` | Justifica `BETTER_AUTH_URL` por los enlaces mágicos; el motivo real es el origen de confianza |
| `packages/db/scripts/probe-supabase.mjs:246` | Imprime «18 migraciones» a pelo |

---

## 5. Qué queda sin cubrir

### 5.1 El worker — recomendación: **host aparte, no Vercel Cron**

Hay exactamente 5 puntos de encolado y 7 tipos de job. Sin worker:

| Job | Qué se rompe | Gravedad |
|---|---|---|
| `ics.sync_source` | El calendario nunca se lee; **pausarlo no borra sus eventos** | Crítica |
| `ics.sync_all` | Ningún calendario se refresca tras el alta | Crítica |
| `time_report.autoconfirm` | Partes `submitted` eternos + autoconfirmación masiva con fecha falsa al arrancar | Alta |
| `notification.settlement_due` | Cero avisos de vencimiento ni escalada | Media |
| `notification.routine_due` | Cero correos de rutina (la rutina sí se ve en la app) | Baja |
| `document.render_receipt` | No se genera un PDF que nadie puede descargar | Baja |
| `maintenance.prune_discovery` | La retención declarada de 45/180 días no se aplica | Baja |

**Recomendación: opción (b), el worker tal cual en un host aparte.** Primero en
una máquina que ya esté encendida en casa; si no la hay, Fly.io. Razones:

1. **Es lo único que arregla el calendario**, que es el fallo crítico y el único
   con engaño visible al usuario. Ni Vercel Hobby ni `pg_cron` lo resuelven.
2. **Cero cambios de código.** `infra/fly/worker.fly.toml`,
   `infra/docker/worker.Dockerfile`, `infra/compose.worker.yml` y el
   procedimiento (`runbook-despliegue.md:154-184`) ya están escritos. La opción
   Vercel Cron exige extraer `buildHandlers` de `apps/worker/src/index.ts:74-110`,
   **añadir un segundo pool con `casa_clara_worker_login`** (la web corre como
   `casa_clara_app_login`, que **no tiene `USAGE ON SCHEMA app_private`**,
   `0001_identity_and_context.sql:19-20`) y **escribir un barrendero de jobs
   colgados que hoy no existe**: `claimNextJob` solo mira `status='queued'`
   (`apps/worker/src/queue.ts:41-46`) y pone `running` sin que nadie recupere las
   filas huérfanas. Es decir, introducir un modo de fallo silencioso nuevo para
   ahorrar 3 USD.
3. **Solo hace conexiones salientes.** El `healthServer` escucha en
   `0.0.0.0:3001` pero nadie necesita alcanzarlo desde fuera: una Raspberry Pi o
   el equipo de casa valen, **0 €/mes**, sin abrir puertos. El precio es la
   disponibilidad. Alternativa gestionada: Fly.io, `shared-cpu-1x`, región `fra`
   (coherente con el ADR 0001), ~2-3 USD/mes.

**No es cero-configuración:** `loadWorkerConfig` exige `S3_ENDPOINT`,
`S3_PRIVATE_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SMTP_HOST` y
`SMTP_FROM` y **aborta el arranque si falta cualquiera**
(`apps/worker/src/config.ts:20-24,46-57`), aunque los jobs que de verdad importan
aquí (autoconfirm e ICS) no toquen ni S3 ni SMTP.

**`pg_cron` como complemento, no como sustituto.** Encajan de verdad
`maintenance.prune_discovery` (una llamada a `app_private.prune_discovery_data`)
y `ics.sync_all` (solo encola). `time_report.autoconfirm` **no encaja tal cual**:
la función definer exige `target_report` (`0006:106-109`) y haría falta una
migración nueva con una variante barredora. Y **no cubre `ics.sync_source`**, que
es fetch HTTPS con guarda SSRF y expansión de RRULE
(`apps/worker/src/ics.ts:103-219,545-607`).

**El correo está roto aparte del worker.** `nodemailer.createTransport({host,
port, secure:false})` **sin objeto `auth`** (`apps/worker/src/integrations.ts:102-106`):
no hay `SMTP_USER`/`SMTP_PASS` en el repositorio. Solo habla con Mailpit. Ningún
proveedor real funcionará sin tocar código. Y hay una contradicción de producto
que hay que resolver antes: el manual afirma **dos veces** «Casa Clara no envía
correos a nadie en ningún momento» (`docs/manual/index.html:1673,1700`), y los
únicos correos del sistema son esos dos avisos. **Recomendación: no apuntar
`SMTP_HOST` a un proveedor real todavía** —cada aviso moriría tras 5 intentos
(`queue.ts:80-92`)— y decidir si esos dos avisos deben pasar a ser avisos en
pantalla, que es lo coherente con lo prometido.

**Falta observabilidad, y es lo que convierte un worker caído en invisible.** No
existe métrica de retraso de cola: `/api/metrics` publica uptime y memoria
(`health.server.ts:17-32`) y `/health` devuelve `ok` incondicionalmente (`:9-15`);
los contadores de jobs viven **dentro del worker** (`index.ts:112-138`), o sea, en
el proceso que puede no existir. **Recomendación:** añadir
`select count(*) from app_private.job_queue where status='queued' and run_at < now() - interval '1 hour'`
a `/api/metrics` o a un chequeo externo. Hoy, si el worker se cae, no hay
absolutamente ninguna señal.

Y una higiene independiente: **`document.render_receipt` debería retirarse o
completarse.** El handler sube el PDF a `${householdId}/receipts/…`
(`apps/worker/src/handlers.ts:47-63`) **y ahí acaba**: no inserta fila en
`app.documents` ni en `app.storage_objects`, y ninguna ruta de la web sirve esa
clave. Es un artefacto de solo escritura que nadie puede ver, mientras la web ya
renderiza PDF a demanda con `pdf-lib`
(`apps/web/src/lib/server/employment-export.server.ts:382-400`).

### 5.2 Adjuntos y antivirus — recomendación: decidir antes de prometerlos

`createAttachmentDependencies` devuelve `null` sin ClamAV, y eso rompe **subir**
adjuntos *y* **ver justificantes ya guardados** (§4, paso 6). Hay tres caminos:

1. **ClamAV en el mismo host del worker, detrás de la pasarela TLS**
   (`infra/clamav/gateway.mjs`), con `CLAMAV_TLS=true`, `CLAMAV_PORT=3311` y
   `CLAMAV_TOKEN` compartido. Es la opción completa. Coste: ~1 GB de RAM extra,
   que es lo que sube el presupuesto de Fly del rango bajo al alto.
2. **Sin ClamAV**: los adjuntos y los justificantes responden 503 hasta que lo
   haya. Es honesto y no rompe nada más, pero hay que saber que **incluye ver un
   justificante ya guardado**, no solo subirlo.
3. **Desacoplar el antivirus del constructor** para que ver un justificante ya
   escaneado no dependa de que ClamAV esté vivo. Es un cambio pequeño y arregla
   un acoplamiento que no tiene justificación.

Recomendación: **(2) hoy, (3) en la siguiente entrega, (1) cuando el worker lleve
un mes estable.** No prometer adjuntos en el manual hasta que exista (1) o (3).

### 5.3 Copias de seguridad — recomendación: verificar la vía antes de necesitarla

`apps/worker/scripts/full-backup.mjs:143` usa `pg_dump`, y **en esta máquina no
hay `pg_dump` ni `psql`**. `runbook-despliegue.md:397` da por hecho que existen.
Además el guion es deliberadamente **a demanda, no programado**
(`full-backup.mjs:1-12`), lo que significa que **hoy no hay ninguna copia
automática nuestra**: lo único que hay es la copia diaria y el PITR de Supabase
desde el panel.

Recomendaciones concretas:

- **Comprobar en el panel de Supabase qué retención y qué PITR tiene el plan
  contratado**, y anotarlo. Ese es el suelo real de recuperación.
- **Instalar el cliente de PostgreSQL** en la máquina del propietario y ejecutar
  `pnpm backup:full` una vez con `BACKUP_DATABASE_URL` + `S3_*`, **antes** de que
  haga falta. Una vía de copia sin ensayar no es una vía de copia.
- **Regla a partir del alta del hogar:** copia **antes de cada `pnpm migrate`**, y
  anotar en qué migración se estaba
  (`SELECT filename, applied_at FROM public.schema_migrations ORDER BY applied_at DESC LIMIT 5;`).
- **Grabar en el runbook, en rojo:** con datos reales, `pnpm test:db` y
  `pnpm test:rls` borran la casa entera (`run-sql-tests.mjs:27-31`).

### 5.4 Bug conocido, sin ruta desde la interfaz — recomendación: arreglar, no usar

`packages/server/src/commands/vacation.ts:224-250` (`set_vacation_entitlement`)
apila una versión nueva copiando salario, columnas reliquia, jornada y `terms`
**pero no copia el catálogo**: la versión N+1 nace con `extra_work_types` vacío.
Efecto: cambias los días de vacaciones y a partir de esa fecha la empleada deja de
poder registrar jornadas extra. Es un hueco de orden entre oleadas (el comando es
de 0020, el catálogo llegó en 0021).

Mitigación hoy: **ninguna pantalla lo invoca** —`setVacationEntitlement` está en
`apps/web/src/lib/employment/commands.ts:338` y ningún `.svelte` lo llama—. **No
lo uses.** Los días de vacaciones se cambian desde la pantalla del acuerdo, que sí
reescribe el catálogo entero (`agreement-terms.server.ts:332-381`).

---

## 6. Decisiones que necesita tomar el propietario

1. **¿Se para el dominio ahora?** Activar Deployment Protection sobre
   `housekeeper-web` hasta terminar la puesta en producción, o dejarlo público con
   la casa inventada dentro. Recomendación: **activarla hoy**, y correr antes el
   `curl` del paso 0.a; si devuelve 303 en vez de 403, el corte no es opcional.
2. **¿Se hacen los cambios de código de R1 y R2 antes de meter datos reales, o se
   acepta el riesgo?** Recomendación: **hacerlos**. R2 en particular es el único
   fallo que se *activa* al conectar Supabase, y afecta a la pantalla de la que
   depende una persona sola en casa. No es opinable.
3. **¿Dónde vive el worker: máquina de casa (0 €/mes) o Fly.io (~3 USD/mes)?** Y
   la condición asociada: **desplegarlo antes o a la vez que la base real**, nunca
   después, para no acumular partes que se autoconfirmarían en bloque con fecha
   falsa.
4. **¿Los dos avisos del sistema son correo o son avisos en pantalla?** Hoy el
   transporte SMTP no tiene autenticación (`integrations.ts:102-106`) y el manual
   promete dos veces que no se envían correos. Si son correo, hay que tocar código
   y contratar proveedor; si son pantalla, hay que rediseñar los dos handlers.
5. **¿Adjuntos con ClamAV desde el día 1, o 503 hasta que el worker esté
   estable?** Recuerda que sin ClamAV tampoco se puede **ver** un justificante ya
   guardado.
6. **Las cifras del acuerdo de Casa EG112**, que solo puede aportar el
   propietario: salario mensual, minutos semanales contratados, fecha de inicio,
   tarifa de la jornada extra y sus minutos de referencia, y si hay complementos
   recurrentes (y cuáles suman a la transferencia). Confirmado: 30 días de
   vacaciones y **ningún concepto por hora**.
7. **Los secretos y credenciales** que solo tiene el propietario: contraseña de
   `postgres` en Supabase, referencia y región del proyecto, claves S3 de Supabase
   Storage y nombre del bucket privado, y el `<ÁMBITO>` de Vercel.
8. **¿Se verifica hoy la vía de copia de seguridad** (instalar cliente de
   PostgreSQL y ejecutar `pnpm backup:full` una vez) **o se acepta depender solo
   del PITR de Supabase?**
