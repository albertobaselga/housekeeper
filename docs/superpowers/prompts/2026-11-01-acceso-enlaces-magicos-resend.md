# Prompt: acceso por enlaces mágicos con Resend y sesión deslizante de 15 días

Fecha de las decisiones: 2026-11-01 · Propietario: Alberto Baselga · Estado:
listo para ejecutar en una sesión futura · Orden recomendado: **2 de 4** (ver
`README.md` de esta carpeta). Los prompts del servidor MCP y de la web pública
**dependen** de este.

> **Cómo usar este prompt.** Léelo junto con
> `docs/superpowers/prompts/workflow-comun.md`. Cambia **cómo entra todo el
> mundo** en la aplicación, incluida la familia y la empleada que la usan hoy
> en producción, y vuelve a traer el correo que la migración 0029 retiró a
> propósito. Por eso lleva ADR, un corte comunicado y una red de emergencia
> explícita. Es un prompt corto en alcance y largo en cuidado.

---

## 1. Qué se construye y por qué

En palabras del propietario: *«Hay que integrar Resend para el envío de
emails y cambiar el login a magic links con TTL alto: 15 días mínimo, y cada
vez que estás activo en la app te extiende automáticamente esos 15 días como
si fuera una ventana deslizante».*

Hoy se entra con nombre de usuario y contraseña, nadie puede darse de alta
solo, no hay «he olvidado mi contraseña» y las contraseñas se reponen cara a
cara desde Ajustes (`docs/despliegue/acceso-produccion.md`). La sesión de
Better Auth dura **siete días y ya se renueva al usarla** (valores por defecto
`expiresIn` 7 días y `updateAge` 1 día; `auth-core.ts` no los toca). Funciona
para tres personas conocidas, pero choca con lo que viene:

- **El asistente no puede enseñar contraseñas.** Dar de alta a alguien desde
  ChatGPT o Claude (prompt del MCP) genera hoy una contraseña provisional que
  la pantalla enseña una sola vez; por un chat de terceros nadie debe verla.
  Con un enlace de acceso por correo, el alta no tiene nada que enseñar.
- **La web pública dará de alta a desconocidos** (prompt de la web pública),
  que necesitan entrar sin que nadie les dicte nada.
- **Siete días se quedan cortos.** Una persona que no abre la aplicación en
  una semana vuelve a la pantalla de acceso; el propietario quiere quince, con
  la misma renovación automática al usarla.

Criterio de éxito: cualquier persona de la casa teclea su nombre de usuario o
su correo en la pantalla de acceso, recibe en segundos un correo con un enlace
y un código, entra con uno u otro desde el móvil (también desde la aplicación
instalada en un iPhone), y no vuelve a ver la pantalla de acceso mientras use
la aplicación al menos una vez cada 15 días. La administración da de alta a
una persona y esa persona recibe su enlace sin que nadie le dicte nada. La
familia actual no pierde el acceso en el cambio.

## 2. Decisiones cerradas por el propietario (2026-11-01)

| # | Decisión | Elegido |
|---|---|---|
| D-proveedor | Quién manda el correo | **Resend.** Un solo proveedor, por su API HTTP, con el dominio del producto verificado. |
| D-acceso | Cómo se entra | **Enlaces mágicos por correo** son la vía de entrada de la aplicación. La contraseña deja de ser lo que se teclea en pantalla. |
| D-sesion | Cuánto dura la sesión | **15 días como mínimo, deslizantes**: cada actividad en la aplicación extiende la sesión otros 15 días desde ese momento. |
| D-correo | El correo vuelve | Se revierte, acotada, la decisión de la migración 0029 («la aplicación no manda correo a nadie»): manda **correos de acceso** y lo que los prompts posteriores añadan, nada más. Sin informes, sin avisos por correo. |

## 3. Decisiones propuestas por el redactor (revisables en la sesión, con argumentos)

### 3.1 Enlace y código, con los plugins que ya están instalados

- **Antes de tocar `auth-core.ts`, actualizar Better Auth.** La 1.6.26
  instalada arrastra dos avisos *high* en la auditoría de producción del
  workflow de seguridad (GHSA-q84f-53jg-9ppm, aprobación de *device login*;
  GHSA-r4xp-prcw-77qf, *OAuth Proxy*), corregidos en la 1.7.7. La primera
  tarea del plan es subir a la versión parcheada vigente, en commit propio,
  **y volver a comprobar** que los plugins y opciones que este prompt cita
  (`magicLink`, `emailOTP`, `admin.createUser` sin contraseña, `session`)
  siguen igual en esa versión; lo que haya cambiado se anota en el spec. Lo
  mismo vale para el prompt del servidor MCP.
- **Plugin `magicLink` de Better Auth**, que la versión instalada (1.6.26) ya
  trae (`better-auth/plugins`, comprobado en el almacén de pnpm: opciones
  `sendMagicLink({ email, url, token }, ctx)`, `expiresIn` (300 s por
  defecto), `disableSignUp`, `storeToken`, `rateLimit`; el token se consume
  de forma atómica, un solo uso). Configuración propuesta: `storeToken:
  'hashed'`, `expiresIn` de 10–15 minutos, `disableSignUp: true`, y
  `callbackURL` validado con la misma regla que `isSafeNext` del `/login`
  actual (nada de redirecciones abiertas).
- **Cuidado con el relé de correo** (hallazgo de la comprobación del
  constructor, verificado en el código del plugin). En 1.6.26
  `disableSignUp` solo actúa al **verificar** el enlace; el endpoint de envío
  `POST /api/auth/sign-in/magic-link` crea el token y llama a `sendMagicLink`
  para **cualquier** correo, exista o no la cuenta. Con `/api/auth` montado
  entero (`hooks.server.ts`), la aplicación sería un relé de correo vía
  Resend hacia direcciones arbitrarias: coste, reputación del dominio y spam.
  Por eso los endpoints crudos de envío (`/sign-in/magic-link` y
  `/email-otp/send-verification-otp`) **se bloquean en `hooks.server.ts`** y
  el envío solo sale de la **form action de `/login`**, que resuelve
  «usuario o correo», comprueba en servidor que la cuenta existe y solo
  entonces llama a `auth.api.*`. Es además la única forma de aceptar el
  nombre de usuario, porque el cuerpo del plugin exige `email`. (`emailOTP`
  sí comprueba la existencia antes de enviar; se bloquea igual, por
  simetría.) Prueba de integración que demuestre que el endpoint crudo
  responde 404 y que un correo desconocido no genera ningún envío.
- **Además del enlace, un código de un solo uso en el mismo correo**, con el
  plugin `emailOTP` (también instalado: `sendVerificationOTP({ email, otp,
  type })`, `otpLength` 6, `expiresIn` 300 s, `allowedAttempts` 3, `storeOTP:
  'hashed'`). Motivo que no es cosmético: en un iPhone el enlace del correo
  abre Safari, y la aplicación **instalada** en la pantalla de inicio no
  comparte cookies con Safari; la persona entraría en el navegador y seguiría
  fuera en la app. Con un código de seis cifras lo teclea en la app instalada
  y listo. La pantalla de acceso ofrece las dos cosas: «Abre el enlace del
  correo o escribe aquí el código». Los dos plugins marcan el correo como
  verificado al entrar.
- **Qué se teclea en la pantalla de acceso**: el **nombre de usuario o el
  correo**, lo que la persona recuerde (`nuria` sigue siendo más fácil en un
  móvil que un correo sin erratas, que es justo el argumento con el que se
  eligió el plugin `username`). La pantalla responde **siempre lo mismo**
  («Si esa cuenta existe, le hemos enviado un enlace y un código»), exista o
  no, igual que hoy `SIGN_IN_FAILED` no distingue casos.
- **Límites de tasa** con `rateLimit.customRules` en la form action y en
  `/magic-link/verify` y `/email-otp/*`, en base como los actuales: pocas
  peticiones por minuto por cuenta y por IP. Un 429 es el único caso con
  mensaje distinto, como hoy.

### 3.2 Sesión: de 7 a 15 días, con la misma renovación

- La sesión **ya es deslizante**: Better Auth renueva al usarla pasado
  `updateAge`. El cambio real es `session.expiresIn` de 7 a **15 días**, y
  elegir `updateAge` (§4.5; `0` renueva en cada petición). Mirar también
  `deferSessionRefresh` (los GET no renuevan, los POST sí) y `freshAge`, y
  **verificar en la documentación de la versión instalada** cómo interactúan
  con la caché de cookie. Prueba de integración que lo demuestre: una sesión
  usada en el día 10 sigue viva en el día 24; una sin uso muere en el día 16.
- **Cerrar sesión** visible en «Tu acceso» («esta sesión» y «todas mis
  sesiones», con la lista de sesiones activas: dispositivo y última
  actividad). La administración puede cerrar las sesiones de otra persona
  desde Ajustes (`revokeUserSessions` del plugin `admin`, que
  `resetMemberPassword` ya usa). Revocar una membresía sigue dejando fuera al
  instante, porque la autorización se comprueba contra la base en cada
  petición y eso no cambia.
- El snapshot sin conexión conserva su concesión máxima de 24 horas (ADR
  0001): no se confunde la sesión con la validez de la foto offline.

### 3.3 Lo que cambia en las altas y en Ajustes

- **Alta de persona** (`$lib/server/staff-hire.server.ts`,
  `hireHouseholdMember`): deja de generar contraseña provisional
  (`generateInitialPassword`) y de marcar `must_change_password`; crea la
  cuenta **sin contraseña** (confirmado en 1.6.26: `createUser` del plugin
  `admin` admite `password` opcional y, sin ella, crea el usuario sin cuenta
  de credenciales, pensado para enlaces mágicos) y **envía el correo de
  bienvenida** con enlace y código. Personal dice «Le hemos enviado el acceso
  a m…@…» y ofrece «Reenviar».
- **La caducidad del enlace es global** (`expiresIn` no admite un valor
  distinto por envío en 1.6.26): el correo de bienvenida caducará casi
  siempre antes de que se lea. Se acepta: el correo dice «si el enlace ha
  caducado, escribe tu nombre de usuario en la pantalla de acceso y te
  mandamos otro», y Personal tiene «Reenviar». Una invitación duradera (días)
  exigiría un token y una tabla propios y queda fuera de la v1.
- **Cambiar el correo de una persona** desde Ajustes o Personal (decisión del
  redactor: con el correo como única puerta, una errata en el alta deja fuera
  a esa persona y hoy no hay ninguna acción que lo corrija). Acción de
  `family_admin` que actualiza **las dos copias** del correo, la de Better
  Auth (`admin.updateUser`) y `app.user_profiles.email` (nullable desde la
  0006, con `CHECK` solo de forma), y reenvía el enlace. Con su prueba, su
  fila en la matriz de seguridad y su párrafo en el manual.
- **`must_change_password` se retira**: la columna nació en la 0030 con el
  disparador `user_profiles_password_flag_guard` y la función
  `app.enforce_password_flag_transition`, vigilados por
  `packages/db/tests/150_personal_y_altas.sql`. La migración nueva los
  retira (o deja la columna en `false` con el disparador fuera, si el spec
  prefiere no borrar) y la suite 150 se ajusta. El redireccionamiento forzoso
  por `mustChangePassword` en `hooks.server.ts` deja de tener casos y se
  retira.
- **Ajustes → «Reponer la contraseña de otra persona»** pasa a ser **«Enviar
  un enlace de acceso»** a esa persona: mismo sitio, mismo papel
  (`family_admin`), sin nada que dictar.
- **«Tu acceso» → «Cambiar mi contraseña»** desaparece de la pantalla (ver la
  pregunta abierta sobre el respaldo).
- **El guion de alta** `apps/web/scripts/seed-household-accounts.mjs` deja de
  imprimir contraseñas (`--reset-passwords` cambia de sentido o desaparece):
  crea las cuentas y envía, o con una bandera nueva `--sin-correo` imprime un
  enlace de un solo uso para el alta inicial de una casa sin correo
  configurado todavía. El correo de cada persona pasa a ser **obligatorio de
  verdad** (hoy el `CHECK` solo exige la forma).

### 3.4 Resend

- Integración por **API HTTP** con `fetch` (sin SDK) o con el SDK oficial
  fijado: lo decide la investigación leyendo la documentación. Envío **en
  línea** desde `sendMagicLink`/`sendVerificationOTP` con tiempo de espera
  corto: la persona está mirando la pantalla; **no** va por la cola de
  trabajos (en producción la drena el planificador de la base cada cinco
  minutos, runbook §4.6, y exige un hogar; el worker en host propio sondea
  cada segundo, pero no está desplegado). Clave de idempotencia por envío.
- **Dominio de envío `homekeeping.app`** (el nombre comercial ya decidido)
  con SPF, DKIM y DMARC verificados en Resend **antes** de tocar producción,
  aunque la aplicación siga viviendo en su dominio actual: el dominio del
  remitente y el de la aplicación no tienen por qué coincidir. Remitente
  propuesto `acceso@homekeeping.app` (el propietario confirma el nombre).
- **Región UE**: el ADR 0001 exige residencia en la UE. Resend ofrece región
  europea; la investigación confirma cómo se activa en la cuenta y qué cubre,
  y el ADR lo deja escrito. Si no se puede garantizar, se para y se pregunta.
- **Plantillas** en castellano, texto plano y HTML sencillo, con el nombre del
  producto, el enlace, el código y su caducidad. **Ningún dato del hogar** en
  el correo: ni el nombre de la casa ni el papel. Logs con lista blanca:
  nunca el correo, el token ni el código.
- **Variables** `RESEND_API_KEY` y `MAIL_FROM` (y opcionalmente
  `MAIL_REPLY_TO`), destino `[vercel] [local]`, **dentro de la regla
  indivisible de identidad** (`IDENTITY_VARS` en `deployment-config.js`, con
  su lista exacta en `deployment-config.test.ts` y `boot-guard.test.ts`): si
  la única forma de entrar es por correo, una instalación **sin esas
  variables** no puede arrancar a medias y parecer sana (ADR 0003, ampliado).
  Resend **caído** en caliente es otra cosa: la aplicación arranca y el envío
  responde con un 503 veraz. Si la pregunta §4.1 conserva la contraseña como
  respaldo durante un tiempo, el ADR decide si en ese periodo la ausencia de
  Resend es fatal al arranque o solo obligatoria con aviso, y qué camino
  concreto tiene la contraseña de respaldo (por ejemplo, la acción
  `?/password` accesible solo por URL). En local y en los e2e de maqueta no
  hay Better Auth y nada de esto aplica; en las suites de Vitest con base, un
  **adaptador falso** captura los correos para leer el enlace y el código.

### 3.5 Lo que se reescribe porque afirmaba lo contrario

Estos ficheros vigilan hoy que el correo «no vuelva por descuido» o que el
acceso sea por contraseña. No se borran: se reescriben con el ADR para vigilar
la nueva frontera, conservando las reglas que siguen vigentes.

**Dónde se demuestra la identidad real** (decisión del redactor tras la
comprobación del constructor): las baterías e2e y dbe2e corren hoy **sin
Better Auth** (`apps/web/e2e/helpers.ts` y `playwright.db.config.ts`: sin
`DATABASE_AUTH_URL`, con el selector sintético) y **así se quedan**. La
identidad real se demuestra en **Vitest** con `TEST_DATABASE_URL`
(`auth.integration.test.ts`, `staff-hire.integration.test.ts`,
`app-user.integration.test.ts`), incluido el recorrido completo de enlace y
código con el adaptador falso. Una batería Playwright con identidad real sería
un job nuevo en CI y queda fuera de la v1.

| Fichero | Qué afirma hoy | Qué pasa a afirmar |
|---|---|---|
| `packages/server/src/mail-retirement.integration.test.ts` | Ningún camino de correo | Solo los caminos de acceso mandan correo; ninguna función `SECURITY DEFINER` lee correos; el payload de un trabajo de cola es referencial (ids, nunca direcciones) |
| `packages/db/tests/140_retired_weekly_report_and_mail.sql` | Las tablas y funciones del correo semanal no existen | Lo mismo, más lo que la migración nueva añada |
| `packages/db/tests/150_personal_y_altas.sql` | El disparador de `must_change_password` | Su retirada (o su neutralización) |
| `apps/web/tests/auth.integration.test.ts` | `RESET_PASSWORD_DISABLED`; alta cerrada | El alta sigue cerrada; enlace y código funcionan con el adaptador falso; el endpoint crudo de envío responde 404; un correo desconocido no genera envío ni crea nada; sesión de 15 días deslizante |
| `apps/web/tests/staff-hire.integration.test.ts`, `staff.integration.test.ts`, `staff-model.test.ts`, `membership.test.ts`, `hire-form.test.ts` | Contraseña provisional (`result.password`, `passwordPending`, «entra y llega obligada a cambiar la contraseña») | Cuenta sin credenciales y correo de bienvenida enviado; «Reenviar»; cambio de correo |
| `apps/web/tests/deployment-config.test.ts`, `boot-guard.test.ts` | Lista exacta de `IDENTITY_VARS` (tres) | Lista con las de Resend |
| `apps/web/e2e/login.e2e.ts`, `login.dbe2e.ts`, `identidad.e2e.ts`, `identidad.dbe2e.ts`, `alta-persona.dbe2e.ts`, `family-settings.dbe2e.ts` | Lo que las pantallas dicen **sin identidad**: el selector, que `?/password` y `sign-up` no existen, que Personal «no gestiona cuentas de acceso», que «Tu acceso» ofrece «Cambiar tu contraseña» | Lo que esas pantallas dicen sin identidad **tras el cambio**: «Tu acceso» ya no ofrece contraseña; Personal explica que el acceso llega por correo; la pantalla de acceso nueva en modo maqueta. Siguen sin Better Auth |
| Código que nombra la contraseña provisional: `apps/web/src/lib/staff/model.ts`, `lib/server/access.server.ts`, `lib/server/fixtures.server.ts`, `lib/auth/types.ts`, `routes/h/[householdId]/personal/+page.svelte`, `account/+page.svelte`, `employment/alta/+page.svelte` | `passwordPending`, «Cambiar tu contraseña», la contraseña enseñada una vez | El acceso por correo, «Reenviar», sesiones activas |
| `docs/despliegue/acceso-produccion.md` | Todo el documento | Se reescribe: qué hay montado, cómo se crean las cuentas, cómo se cambia un correo, qué hacer si alguien no recibe el correo, la red de emergencia |
| `docs/despliegue/opciones-de-acceso.md` §5 y §8 | Veredicto: contraseña sin correo | Nota de cabecera: superado por el ADR nuevo, con enlace |
| `.claude/skills/operar-la-casa/` (SKILL.md trampa 2 y «Reponer la contraseña», `referencia-operaciones.md`, `referencia-instalacion.md`) | Contraseñas y reposición cara a cara | Enlaces, reenvío, cambio de correo, variables nuevas, humo nuevo |
| `docs/manual/index.html` | Capítulo de acceso y «Tu cuenta» | Cómo entrar con enlace o código, cerrar sesión, qué hacer si no llega el correo |
| `.env.example` §2 y §5 | «Correo — NO HAY» | Bloque de Resend en la regla indivisible; §5 cuenta la historia (0029 → ADR nuevo) |

### 3.6 ADR

`docs/adr/0004-acceso-por-enlaces-magicos-y-correo.md` (el 0004 está libre;
ajustar si otro prompt lo ocupa antes): contexto (por qué se eligió contraseña
sin correo en agosto y qué cambió: altas por asistente, altas públicas, sesión
más larga), decisión (enlaces y códigos por Resend, sesión deslizante de 15
días, correo acotado al acceso, variables en la regla indivisible, endpoints
crudos de envío bloqueados), consecuencias y **riesgos asumidos**: el correo
como punto único de fallo para entrar, la sesión larga en un dispositivo
compartido (el ordenador de la cocina), la dependencia de un proveedor
estadounidense con región UE; y **cómo se revierte**: la red de emergencia de
§4.1 y la vuelta a contraseña si hiciera falta.

## 4. Preguntas abiertas que la sesión cierra con el propietario antes del spec

1. **La contraseña, ¿se retira del todo o queda como red de emergencia sin
   pantalla?** Recomendación: **conservarla sin pantalla** durante un
   trimestre (el plugin `username` y `emailAndPassword` siguen configurados,
   el guion puede fijar una contraseña a la administración, la acción
   `?/password` queda accesible solo por URL, y la «Red 2» de
   `acceso-produccion.md`, el panel de la base de datos, sigue existiendo) y
   retirarla con una fecha escrita en el ADR. Un correo caído no puede dejar
   fuera a toda la casa el primer mes. La respuesta decide también el matiz
   de §3.4 sobre `IDENTITY_VARS`.
2. **¿Las tres personas reales tienen un correo que lean en su móvil?** Sobre
   todo la empleada. Si no, hay que resolverlo (crear uno, configurarlo en su
   teléfono) **antes** del corte, y el prompt no puede saberlo.
3. **Remitente**: `acceso@homekeeping.app` con nombre visible «Homekeeping»,
   ¿sí? ¿Y a quién llegan las respuestas (`MAIL_REPLY_TO`)?
4. **Dominio de envío desde ahora**: usar `homekeeping.app` como dominio
   remitente aunque la aplicación siga en su dominio actual (recomendado: no
   hay que volver a verificar nada cuando entre la web pública), o esperar.
5. **`updateAge`**: ¿renovar en cada petición (`0`, lo más fiel a «cada vez
   que estás activo») o una vez al día (menos escrituras)? Recomendación: una
   vez al día; para la persona es indistinguible.

## 5. Fuera de alcance

Passkeys (siguen siendo la «opción B» de `opciones-de-acceso.md`, para
después) · avisos o informes por correo · correo de la web pública (bienvenida
de alta, impago: lo añade su prompt sobre el adaptador de aquí) · invitaciones
duraderas de varios días · cambiar el nombre de usuario como identificador ·
varios correos por persona · SMS · inicio de sesión con Google o Apple ·
analítica de correos abiertos · una batería Playwright con identidad real.

## 6. Lee primero (además de la lista del workflow común)

| Fichero | Qué saber |
|---|---|
| `apps/web/src/lib/server/auth-core.ts`, `auth.server.ts` | La configuración canónica de Better Auth (una sola vez), plugins `username` y `admin`, `disableSignUp`, `rateLimit` en base, `runAuthMigrations` (la tabla `verification` que usan los dos plugins ya existe en el esquema base). El comentario habla del esquema `auth`; el real es `casa_auth` con `casa_clara_auth_login`: manda `docs/despliegue/identificadores-legado.md` |
| `apps/web/src/routes/login/+page.server.ts` y `+page.svelte` | Los dos modos (`password` y `fixture-selector`), `SIGN_IN_FAILED` idéntico para todo, `isSafeNext`, el 429 |
| `apps/web/src/hooks.server.ts` | Orden de la petición, `/api/auth` montado entero (donde se bloquean los endpoints crudos de envío), el redireccionamiento por `mustChangePassword` que se retira |
| `apps/web/src/lib/server/app-user.server.ts` | `resolveAppUser` y `must_change_password` |
| `apps/web/src/lib/server/staff-hire.server.ts` y `apps/web/tests/staff-hire.integration.test.ts` | `hireHouseholdMember`, `generateInitialPassword`, `auth.api.createUser`, y lo que la prueba afirma de la contraseña provisional |
| `apps/web/src/routes/h/[householdId]/settings/+page.server.ts` y `account/+page.server.ts` | `resetMemberPassword` (usa `setUserPassword` y `revokeUserSessions`) y `changePassword`, que cambian de sentido o desaparecen |
| `apps/web/scripts/seed-household-accounts.mjs` | El guion de alta: `username`, `email`, contraseñas generadas, `--reset-passwords`, `SEED_DATABASE_URL` |
| `apps/web/src/lib/server/deployment-config.js`, `boot-guard.server.ts`, `apps/web/tests/deployment-config.test.ts`, `boot-guard.test.ts` | `IDENTITY_VARS`, el guardián de arranque y las pruebas que fijan la lista exacta |
| `packages/db/migrations/0030_personal_y_altas.sql` y `packages/db/tests/150_personal_y_altas.sql` | Dónde nació `must_change_password`, su disparador y su suite |
| `apps/web/e2e/helpers.ts` y `apps/web/playwright.db.config.ts` | Las baterías de navegador corren sin `DATABASE_AUTH_URL` y con el selector sintético |
| `docs/despliegue/acceso-produccion.md` y `opciones-de-acceso.md` | Lo que hay montado y por qué se descartó el correo en agosto (§5 ya nombraba a Resend); las «redes» si se pierde el acceso |
| `docs/adr/0003-*.md` | La regla indivisible que se amplía |
| `packages/db/migrations/0029_retire_weekly_report_and_mail.sql`, `packages/server/src/mail-retirement.integration.test.ts`, `packages/db/tests/140_retired_weekly_report_and_mail.sql` | Qué se retiró, con qué guardianes y con qué reglas que siguen vigentes |
| `apps/web/e2e/login.*`, `identidad.*`, `alta-persona.dbe2e.ts`, `family-settings.dbe2e.ts`, `apps/web/tests/auth.integration.test.ts` | Las pruebas que afirman el estado actual |
| `apps/web/static/manifest.webmanifest` y `apps/web/src/service-worker.ts` | `display: standalone`, `scope` y cómo abre la PWA los enlaces: la razón del código |
| `.env.example` §2 y §5, `docs/notificaciones.md` | Dónde se documentan las variables y qué NO se notifica (el correo no cambia eso) |
| `infra/quality/lighthouserc.json` | `/login` es ruta medida: la pantalla nueva mantiene accesibilidad 1,0 y los presupuestos |

Documentación externa a leer **en su versión vigente** con `dependency-expert`
y citar en el spec: Better Auth 1.6.26 (plugins `magicLink` y `emailOTP`,
opciones de `session`, `createUser` sin contraseña, `updateUser`,
`rateLimit.customRules`), Resend (API, dominios, SPF, DKIM, DMARC, región UE,
idempotencia, límites del plan, qué entrega el remitente de prueba sin dominio
verificado), y el comportamiento de cookies entre Safari y una PWA instalada
en iOS.

## 7. Workflow específico

Sigue las siete fases del workflow común con estas adiciones:

### Lo que el propietario prepara antes del spike (las credenciales no están en la máquina del agente)

- Una **base de identidad desechable** alcanzable desde un preview de Vercel
  (un proyecto de Supabase aparte, nunca el de producción), con su
  `DATABASE_AUTH_URL` y `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` propios en el
  entorno **Preview** del proyecto de Vercel (o en un proyecto de Vercel
  aparte).
- Una **cuenta de Resend** con el dominio `homekeeping.app` **verificado**
  desde el principio: el remitente de prueba de Resend solo entrega al dueño
  de la cuenta, y el spike tiene que probarse con los teléfonos de las otras
  dos personas.
- Un iPhone con la aplicación de preview instalada en la pantalla de inicio,
  y un Android.

### Fases

1. **Investigación** (`dependency-expert`): lo de §6 externo, con fecha y
   enlace, en `docs/superpowers/specs/YYYY-MM-DD-acceso-investigacion.md`.
   Incluye la respuesta a «¿región UE en Resend, cómo?» y la confirmación del
   comportamiento del relé de correo en la versión instalada.
2. **Spike corto y desechable**: enlace y código en el preview, con una cuenta
   sintética, probado desde el iPhone con la aplicación instalada (Safari
   frente a PWA) y desde Android. Lo aprendido va al spec; el código se tira.
3. **Spec y ADR**: `docs/superpowers/specs/YYYY-MM-DD-acceso-enlaces-magicos-design.md`
   con el flujo (diagrama de secuencia enlace y código), textos completos de la
   pantalla y de los correos, política de sesión, tabla de §3.5 con el detalle
   de cada reescritura, variables, red de emergencia, plan de corte. Revisión
   adversarial con `security-reviewer` **obligatoria**: relé de correo,
   enumeración, tasa, redirección abierta, reutilización del token, robo del
   correo, sesión larga en dispositivo compartido, cambio de correo por la
   administración, fuga en logs. Puerta: aprobación del propietario.
4. **Plan** (`docs/superpowers/plans/YYYY-MM-DD-acceso-enlaces-magicos.md`)
   por fases, cada una en verde al cerrar:
   1. Adaptador de Resend (real y falso), plantillas, variables en la regla
      indivisible con sus dos pruebas de lista exacta, pruebas unitarias de
      plantillas sin datos del hogar.
   2. Plugins `magicLink` y `emailOTP` en `auth-core.ts`, bloqueo de los
      endpoints crudos en el hook, form action de `/login` (usuario o correo,
      existencia, respuesta idéntica, tasa), pantalla `/login` nueva (a11y
      1,0 y presupuestos de Lighthouse), sesión de 15 días con su prueba de
      fechas.
   3. Altas sin contraseña provisional: `hireHouseholdMember`, Personal
      («Reenviar», cambio de correo), Ajustes («Enviar un enlace de acceso»,
      cambio de correo), «Tu acceso» (sesiones activas y cierre), guion de
      alta, migración que retira `must_change_password` y su disparador, y
      retirada del redireccionamiento en el hook.
   4. Reescritura de **todos** los guardianes y del código de la tabla §3.5,
      y el recorrido completo enlace/código en Vitest con el adaptador falso.
   5. Documentación: ADR, `acceso-produccion.md` entero, skill, manual,
      runbook (§5 variables, §7 humo), `.env.example`, README, baseline de
      seguridad.
   6. Producción con corte comunicado (abajo).
5. **Verificación**: lo del workflow común; además, la prueba de que el enlace
   solo vale una vez y caduca, la de respuesta idéntica, la del endpoint crudo
   bloqueado, la de tasa, la de sesión deslizante, y la revisión de seguridad
   **ejecutada** en `docs/security/revision-acceso.md`.
6. **Producción**, con orden propio:
   1. Dominio de envío verificado en Resend (DNS) y correo de prueba enviado
      desde la cuenta real: **antes** de todo.
   2. Confirmar con el propietario que las tres personas tienen correo en el
      móvil, que el correo registrado de cada una es el correcto, y avisarles
      del cambio y de la fecha.
   3. ⚠️ Variables `RESEND_API_KEY` y `MAIL_FROM` en Vercel **y** migraciones
      (las de Better Auth por `runAuthMigrations`, la de la aplicación por
      `db:migrate`) **antes** del merge, con confirmación.
   4. Merge en un momento tranquilo, con el propietario delante. Las sesiones
      abiertas de la familia **siguen válidas**: nadie se queda fuera en el
      despliegue.
   5. Humo: pedir el enlace con la cuenta del propietario, recibirlo, entrar
      por enlace en el navegador y por código en la aplicación instalada;
      cuenta inexistente → misma respuesta y ningún correo; `POST
      /api/auth/sign-in/magic-link` directo → 404; sexto intento → 429;
      cerrar una sesión desde «Tu acceso»; dar de alta a una persona de
      prueba y recibir su correo (y retirar su acceso después); `/api/health`;
      Hoy sin 503. Con cada una de las otras dos personas, entrar una vez
      delante del propietario.
   6. Copia posterior y nota en el runbook.

## 8. Riesgos conocidos

- **El correo como punto único de fallo para entrar.** Red de emergencia
  escrita (§4.1) y Resend monitorizado por el humo. Si Resend cae, nadie
  nuevo entra, pero las sesiones de 15 días siguen: el impacto real es menor
  que con sesiones de una semana.
- **Relé de correo por el endpoint crudo del plugin.** Resuelto bloqueándolo
  en el hook y enviando solo desde la form action tras comprobar la cuenta;
  la prueba de integración lo vigila y el humo lo comprueba en producción.
- **La PWA en iOS y las cookies.** Resuelto con el código; el spike lo
  demuestra en un dispositivo real antes del spec.
- **Entregabilidad**: un correo de acceso en la carpeta de spam deja fuera a
  la persona. DMARC, dominio dedicado al producto, texto plano junto al HTML,
  sin imágenes ni enlaces de seguimiento. El humo mira la carpeta de spam.
- **Una errata en el correo de alguien** la deja fuera: por eso entra el
  cambio de correo por la administración (§3.3) y, mientras no exista, la
  «Red 2» (panel de la base).
- **Sesión larga en un dispositivo compartido.** Riesgo asumido en el ADR;
  «Cerrar sesión» visible y cierre remoto desde «Tu acceso» y Ajustes.
- **Revertir una decisión documentada con guardianes.** Los guardianes de la
  0029 existen porque el correo ya volvió una vez «por descuido»; se
  reescriben con intención, nunca se borran, y el ADR explica el cambio.
- **Cambiar la puerta de la casa real.** Corte comunicado, propietario
  delante, contraseña de respaldo sin pantalla el primer trimestre si §4.1 lo
  decide así, y la «Red 2» intacta.

## 9. Criterio de hecho

En producción, las tres personas entran con enlace o código desde su móvil,
también desde la aplicación instalada; una cuenta inexistente recibe la misma
respuesta y no provoca ningún envío; el endpoint crudo de envío no existe
desde fuera; la sesión dura 15 días deslizantes y se puede cerrar desde «Tu
acceso»; dar de alta a una persona envía su acceso por correo, Ajustes puede
reenviarlo y corregir el correo; no hay contraseña provisional ni
redireccionamiento por `mustChangePassword`; las variables de Resend están en
la regla indivisible; los guardianes de la 0029 y de la 0030 vigilan la
frontera nueva; ADR aceptado; revisión de seguridad ejecutada;
`acceso-produccion.md`, skill, manual, runbook, `.env.example` y memoria del
agente al día; copias anterior y posterior.
