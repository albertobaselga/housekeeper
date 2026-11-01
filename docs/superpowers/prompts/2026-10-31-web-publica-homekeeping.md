# Prompt: web pública de Homekeeping, alta de hogares y cobro con Stripe, del diseño a producción

Fecha de las decisiones: 2026-10-31 · Propietario: Alberto Baselga · Estado:
listo para ejecutar en una sesión futura · Orden recomendado: **4 de 4** (ver
`README.md` de esta carpeta). **Depende** del prompt de acceso
(`2026-11-01-acceso-enlaces-magicos-resend.md`): el correo transaccional, el
proveedor (Resend) y la entrada por enlace mágico ya existen cuando este
prompt se ejecuta; aquí solo se usan.

> **Cómo usar este prompt.** Léelo junto con
> `docs/superpowers/prompts/workflow-comun.md`. Esta funcionalidad **cambia el
> modelo del producto**: de una instalación que sirve a casas conocidas y
> cuyas cuentas nacen de un guion, a un servicio que **desconocidos contratan
> y pagan**. Varias decisiones vigentes del repositorio (sin alta pública, sin
> correo, nombre genérico sin sesión) se sustituyen aquí por otras, cada una
> con su ADR. Trátalo con el cuidado de un cambio de arquitectura, no de una
> página de marketing.

---

## 1. Qué se construye y por qué

**Homekeeping** (`https://www.homekeeping.app/`) es el nombre y la casa del
producto. Se construye:

1. **Una web pública** que explica qué hace la aplicación y para quién, con un
   diseño **creativo, vistoso y animado**, que se entienda que es para
   **familias normales**: no hace falta nada especial, solo tener una casa que
   llevar. El mensaje, en palabras del propietario: alinear a todas las
   personas que viven contigo, llevar las operaciones de la casa en digital,
   gestionar bien a quien trabaja en ella y, además, **configurarlo todo
   hablando con tu asistente** (ChatGPT o Claude) para tener una aplicación
   personalizada al máximo para tu hogar. Que se vea que **se instala en el
   móvil** desde el navegador. Optimizada para **SEO** y para **GEO**
   (*generative engine optimization*: que los asistentes de IA la encuentren,
   la entiendan y la citen).
2. **Un formulario de contratación** que crea un **hogar nuevo** (un tenant)
   de forma inmediata, conectado con **Stripe** para cobrar una **licencia
   mensual por hogar**. De momento con una cuenta de Stripe **en modo
   prueba**; la activación comercial vendrá después.
3. **Páginas legales**: condiciones de contratación, privacidad, cookies y
   aviso legal.

Criterio de éxito: una persona que no conoce el producto entra en
`homekeeping.app` desde el móvil, entiende en treinta segundos qué resuelve,
contrata con su tarjeta (de prueba) y en pocos minutos tiene el correo de
bienvenida y está dentro de su casa recién creada, con la aplicación
instalable en la pantalla de inicio (la bienvenida se envía en línea tras el
commit del webhook, §3.3.3, no por la cola de cada cinco minutos).
La portada saca 100 en accesibilidad y cumple los presupuestos de rendimiento
del repositorio. La familia que ya usa la aplicación no nota nada, salvo el
nombre.

## 2. Decisiones cerradas por el propietario (2026-10-31)

| # | Decisión | Elegido |
|---|---|---|
| D-nombre | Nombre comercial y dominio | **Homekeeping**, `https://www.homekeeping.app/`. Sustituye al nombre genérico de `app-title.ts` y al `short_name` «Hogar» del manifiesto; «Housekeeper» sigue siendo el nombre del **repositorio**. |
| D-plazas | Límites por hogar | **5 plazas de familia** (administración, miembros, apoyo y acceso puntual, sumados) y **3 de personal interno** (`employee_live_in`). Son **fijos**: no se cambian desde la aplicación ni hay planes distintos a priori. |
| D-precio | Precio | **19,90 € al mes por hogar, IVA incluido**, sin descuentos en el MVP. |
| D-prueba | Periodo de prueba | **14 días con tarjeta**: Stripe cobra el día 15 si no se cancela. |
| D-stripe | Pasarela | **Stripe**, en **modo prueba** hasta que el propietario active la cuenta comercial. Ninguna otra pasarela. |
| D-ubicacion | Dónde vive la web pública | **En la misma aplicación SvelteKit**, como rutas públicas **prerrenderizadas**. Un solo dominio, un solo despliegue; el alta y los webhooks usan el servidor que ya existe. |
| D-legal | Páginas legales | Condiciones de contratación, política de privacidad, política de cookies y aviso legal, en castellano. |
| D-estilo | Diseño | Muy visual, con animación, creativo y profesional, pero que hable a familias, no a empresas. Instalable y que se vea. |

## 3. Decisiones propuestas por el redactor (revisables en la sesión, con argumentos)

### 3.1 Rutas y estructura

- **Públicas, prerrenderizadas** (`export const prerender = true`), sin
  sesión y sin consultar la base: `/` (portada), `/funciones` (o secciones
  ancladas de la portada si el diseño lo prefiere), `/precios`, `/asistentes`
  (la promesa del LLM; si el servidor MCP aún no está en producción, se
  presenta como «muy pronto» y no como disponible), `/manual` (el manual
  publicable que ya genera `scripts/construir-manual-publicable.mjs`),
  `/legal/aviso-legal`, `/legal/privacidad`, `/legal/cookies`,
  `/legal/condiciones`, `/contacto`.
- **Dinámicas**: `/alta` (formulario → Stripe Checkout), `/alta/gracias`
  (vuelta de Checkout: «estamos preparando tu casa», y el correo que llega),
  `/alta/cancelado`, `/api/v1/billing/webhook` (Stripe), `/api/v1/billing/portal`
  (portal de cliente de Stripe, con sesión de administración).
- **La raíz cambia de comportamiento, y es dinámica** (decisión del redactor
  tras la comprobación del constructor). Hoy `/` redirige a `/login` o a Hoy.
  Propuesta: **sin sesión, la portada; con sesión, Hoy**. Eso obliga a que
  `/` sea **SSR y no prerrenderizada**: una página prerrenderizada no lee
  cookies y en Vercel se sirve estática antes del hook. Dependen de que `/`
  caiga en la casa con sesión: `start_url` y `scope` del manifiesto, el clic
  en una notificación push (`apps/web/src/service-worker.ts`, destino `/`),
  `+error.svelte` fuera de un hogar y la vuelta de `/login`. La portada en
  `/` se renderiza en servidor **sin tocar la base** para anónimos (y así
  puede decir en caliente si la contratación está abierta); el **resto** de
  páginas públicas sí se prerrenderiza. `/login` se mantiene (es la URL que
  la familia ya tiene) y la portada enlaza «Entrar».
- `guardForPath` **no conoce rutas públicas ni debe**: devuelve `null` para
  todo lo que no cuelga de `/h/`, y el hook entonces no hace nada. Lo que
  importa: la comprobación de capacidad para POST del hook es solo de `/h/`,
  así que `/alta` (tasa, validación, respuesta idéntica exista o no la cuenta)
  y `/api/v1/billing/webhook` (firma, idempotencia) llevan **sus propias
  rejas**. `robots.txt` excluye `/h/`, `/api/`, `/login`, `/alta/*`;
  `sitemap.xml`, `llms.txt`, JSON-LD (`Organization`, `SoftwareApplication`
  con `Offer`, `FAQPage`), Open Graph con imágenes generadas (sintéticas) y
  `canonical` con `www`.
- **Nada de la web pública entra en el grafo inicial de Hoy ni al revés**:
  `verify-today-bundle.mjs` destierra `src/lib/marketing/` (o el nombre que
  se elija) y un test espejo garantiza que la portada no arrastra el shell de
  la aplicación.

### 3.2 Nombre e identidad

- `APP_NAME = 'Homekeeping'`, y en el manifiesto **los dos campos**: `name`
  (el test `app-title.test.ts` lo compara con `APP_NAME`) y `short_name` (lo
  compara con `APP_HOME_SCREEN_NAME`, hoy «Hogar»). Con sesión sigue mandando
  el nombre del hogar. Se actualiza el comentario de `app-title.ts`, el aviso del
  README y la skill: la regla pasa a ser «Homekeeping es el producto; el
  hogar manda con sesión; Housekeeper es el repositorio».
- Identidad visual propia del sitio público (tipografía, color, movimiento)
  **coherente** con la aplicación, no idéntica: `docs/ux/sistema-movil.md` es
  el sistema de la app; la portada puede ser más expresiva, pero comparte
  tokens de color y la voz. Usar la skill `frontend-design` y el precedente de
  `docs/ux/` para no caer en la estética genérica de plantilla.
- **Animación con responsabilidad**: CSS y transiciones de Svelte o la Web
  Animations API; `prefers-reduced-motion` respetado en **todo** (la versión
  sin movimiento es la de referencia para accesibilidad); ninguna librería de
  animación que rompa el presupuesto de script de `lighthouserc.json`
  (120 KiB) ni el LCP de 2 s. Vídeo o Lottie solo si pasan los presupuestos
  medidos, nunca autoplay con sonido.
- **Material visual**: las capturas sintéticas de `docs/manual/capturas/` y
  maquetas del modo demostración; ninguna captura con datos reales.

### 3.3 Alta de un hogar (el flujo de contratación)

1. `/alta`: nombre del hogar, nombre de la persona, correo y dos casillas sin
   premarcar: las condiciones de contratación (que **incluyen** el anexo de
   encargo de tratamiento, §3.6) y la política de privacidad. Nada más. No hay
   contraseña que pedir ni establecer: desde el prompt de acceso se entra con
   un **enlace o un código por correo**, y el correo de bienvenida **es** ese
   primer acceso (el correo queda verificado de paso). El nombre de usuario,
   que la base y el guion siguen exigiendo, se **deriva del correo** y la
   persona puede cambiarlo en «Tu acceso» (decisión del redactor). Si el
   correo **ya tiene cuenta** (una persona con dos casas es un caso que el
   código admite), el recorrido visible es idéntico, el webhook **vincula** en
   vez de crear, y el correo dice «tu nueva casa está lista».
2. El servidor crea una **solicitud** (`app_private.household_signups` o
   similar: correo, nombre del hogar, estado, ids de Stripe, creada, expira)
   y una **Stripe Checkout Session** en modo suscripción: precio de 19,90 €
   con **impuesto incluido** (`tax_behavior: inclusive`) y **Stripe Tax**
   activado, **14 días de prueba**, `customer_email`, `locale: 'es'`,
   `metadata.signupId`, URLs de éxito y cancelación. Dirección de facturación
   obligatoria; países permitidos **solo España** en v1 (revisable).
3. **Webhook** `checkout.session.completed` (firma verificada,
   **idempotente** por `event.id` en una tabla de eventos procesados). Crea el
   **hogar** (`slug` único derivado del nombre), el **perfil**, la **cuenta de
   Better Auth** (por la API de servidor, no por el endpoint público:
   `disableSignUp` **se conserva**), la **membresía `family_admin`** y la fila
   de **suscripción** (`stripe_customer_id`, `subscription_id`, `status`,
   `trial_end`, `current_period_end`). Envía el **correo de bienvenida**, que
   es un enlace y un código de acceso de un solo uso como los de cualquier
   alta (prompt de acceso), **en línea tras el commit** con el adaptador de
   Resend que ya existe, no por la cola de trabajos: el planificador corre
   cada cinco minutos y la persona está esperando. Tres hechos del repositorio
   que el spec tiene que resolver, no dar por hechos:
   - **Hoy solo el rol propietario puede crear un hogar.** `app.households`
     no tiene política de INSERT (0005), la 0038 añade la política
     **restrictiva** `memberships_no_admin_from_app` que prohíbe insertar
     `family_admin` a cualquier rol sometido a RLS, y `casa_clara_app` y
     `casa_clara_worker` son `NOBYPASSRLS`. Por eso el alta la hace
     `apps/web/scripts/seed-household-accounts.mjs` con `SEED_DATABASE_URL`
     (el propietario). El webhook necesita un **camino deliberado y acotado**
     que la migración abra y la suite demuestre: la recomendación del
     redactor es un rol de login dedicado para el alta
     (`casa_clara_signup_login`, variable `SIGNUP_DATABASE_URL` en el grupo
     indivisible, **nunca** el propietario en Vercel) con políticas que solo
     le permitan crear un hogar y **la primera** membresía `family_admin` de
     un hogar que aún no tiene ninguna; la alternativa es una función
     `SECURITY DEFINER` con esas mismas comprobaciones dentro, sabiendo que la
     0029 y la suite 140 tratan esas funciones como superficie y que el
     `DO $check$` de la 0038 exige que ningún `with_check` contenga
     `family_admin`. Lo decide el spec con `security-reviewer`.
   - **No cabe en una sola transacción.** La cuenta de Better Auth se escribe
     por su propio pool a `DATABASE_AUTH_URL` (esquema `casa_auth`); las filas
     de `app` por otro rol y otra conexión. El alta es **idempotente en dos
     pasos con compensación** (Stripe reintenta el webhook): primero la
     solicitud pasa a «creando», luego las filas de `app`, luego la cuenta,
     y cada paso sabe reanudar si el anterior ya se hizo.
   - **La casa nace vacía.** No existen plantillas globales: la migración
     0010 solo añade `is_template` a `app.wiki_spaces` y la clonación es
     dentro del mismo hogar. En v1 cada pantalla recibe a la familia nueva con
     su estado vacío, que ya explica qué hacer; una «casa de ejemplo» o una
     guía inicial es una fase futura con su propio modelo.
4. `/alta/gracias` consulta el estado de la solicitud (sondeo corto) y dice
   la verdad: «tu casa está lista, mira el correo» o «estamos terminando;
   si en unos minutos no tienes correo, escríbenos». Si el webhook falló, el
   aviso al propietario **no** puede ir por la cola (`job_queue.household_id`
   es `NOT NULL` y no hay hogar): queda en la solicitud y en los registros.
5. **Estados de la suscripción** y qué hacen con la casa: `trialing` y
   `active` (todo); `past_due` (todo, con aviso en Hoy y en Ajustes y enlace
   al portal de Stripe, durante el periodo de gracia que marque Stripe);
   `unpaid` o `canceled` → **`suspended`**: **solo lectura para toda la casa**
   (los comandos devuelven un rechazo claro, la interfaz lo dice en cada
   pantalla) con enlace al portal para reactivar; a los 30 días de suspensión,
   el hogar se **archiva** (`archived_at`) y deja de ser accesible. Ojo:
   `households.archived_at` existe desde la 0001 pero **nada lo honra**
   (`resolveAppUser` y `withAuthorizedTransaction` filtran la membresía, no el
   hogar): «archivado → inaccesible» es código y RLS nuevos, con su prueba. El
   borrado definitivo es una decisión aparte con política de retención escrita.
   Cada transición llega por webhook (`customer.subscription.updated|deleted`,
   `invoice.payment_failed|paid`) y se escribe en la suscripción; nunca se
   infiere en caliente llamando a Stripe desde el `load`.
6. **Portal de cliente de Stripe** desde Ajustes (solo `family_admin`):
   tarjeta, facturas, cancelar. La aplicación no guarda ningún dato de
   tarjeta.
7. **El hogar que ya está en producción** no pasa por Stripe: se marca
   `billing_exempt` en la migración, con comentario, y no ve ningún aviso de
   cobro.

### 3.4 Plazas

- **Disparador** en `app.household_memberships` que impide la membresía
  activa número 6 de familia (`family_admin` + `family_member` + `helper` +
  `viewer`) y la número 4 de `employee_live_in`, con un código que el comando
  y la form action traduzcan («La casa tiene las 5 plazas de familia
  ocupadas; retira un acceso para dar otro»). Los límites viven en **una
  función SQL** y en **una constante del contrato**, con un test que compara
  ambas. Las membresías caducadas o revocadas no cuentan.
- Ajustes y Personal muestran «3 de 5 plazas de familia · 1 de 3 de personal».
- Antes de la migración, **comprobar que el hogar real cumple** (la sesión
  prepara la consulta y el propietario la ejecuta). Si no cumple, la
  migración no se aplica hasta decidir qué hacer.

### 3.5 Correo: lo que este prompt añade sobre lo que ya existe

El correo transaccional, **Resend**, el dominio de envío verificado y la
entrada por enlace o código **ya existen** cuando este prompt se ejecuta
(prompt `2026-11-01-acceso-enlaces-magicos-resend.md`, con su ADR y la
reescritura de los guardianes de la 0029). Aquí solo se añaden plantillas:

- **Bienvenida del alta** (es el primer acceso: enlace y código, §3.3.3), en
  línea tras el commit del webhook.
- **Aviso de impago y de suspensión** a la administración del hogar, por la
  **cola de trabajos** (`app_private.job_queue`), respetando las dos reglas
  que los guardianes de la 0029 siguen vigilando: **payload referencial**
  (ids, nunca direcciones ni nombres, porque se copia a `app.audit_events`
  para siempre) y **ninguna función `SECURITY DEFINER` lee correos**. El
  manejador del worker leerá `app.user_profiles.email` con el GRANT o la
  política que el prompt de acceso haya dejado (o que esta migración añada).
  Stripe manda sus propios recibos y avisos de impago; no se duplican.
- **Acuse de `/contacto`** a quien escribe y aviso al propietario.
- **Regla indivisible, pero blanda, para Stripe**: las variables de Stripe (y
  `SIGNUP_DATABASE_URL` si existe) forman un grupo; si falta una, `/alta`
  responde 503 con un mensaje veraz y la portada (SSR) dice «la contratación
  está cerrada por el momento», nunca finge. **No** se meten en
  `IDENTITY_VARS` del guardián de arranque (`boot-guard.server.ts`): ese
  guardián responde 503 a **toda** petición y tumbaría la casa real por una
  variable de cobro ausente. Es una segunda regla, del mismo estilo, que solo
  cierra la contratación. Documentado en `.env.example`,
  `deployment-config.js` y el humo. (Las variables de Resend sí están en la
  indivisible: sin correo no entra nadie, y eso lo decidió el prompt de
  acceso.)

### 3.6 Legal

Borradores completos en castellano en `docs/legal/` (fuente) y publicados en
`/legal/*`, con **marcadores** para los datos del titular (`[[TITULAR]]`,
`[[NIF]]`, `[[DOMICILIO]]`, `[[CORREO]]`) que el propietario rellena **fuera
del redactor automático** y antes de publicar (son datos públicos de empresa,
no datos del hogar; aun así, no se inventan):

- **Aviso legal** (LSSI-CE): titular, contacto, condiciones de uso del sitio.
- **Política de privacidad** (RGPD y LOPDGDD): responsable, finalidades,
  bases jurídicas, encargados (Vercel, Supabase en la UE, Stripe, el proveedor
  de correo), **proveedores de asistentes de IA solo si la persona conecta el
  suyo** (enlaza con el ADR 0004 del prompt del MCP), plazos, derechos. Y el
  punto delicado: **el cliente es responsable del tratamiento** de los datos
  de la persona que trabaja en su casa y Homekeeping es **encargado**; hace
  falta un **anexo de encargo de tratamiento** que forma parte de las
  condiciones de contratación (se acepta con ellas, sin una tercera casilla).
- **Política de cookies**: en v1 **solo cookies técnicas** (sesión), sin
  analítica de terceros, luego **sin banner**; si se añade analítica, será sin
  cookies y respetuosa (Plausible o similar, servidor UE), y el ADR lo dirá.
- **Condiciones de contratación**: objeto, precio con IVA, prueba de 14 días,
  renovación mensual, cancelación en cualquier momento desde el portal,
  **derecho de desistimiento de 14 días** para consumidores, plazas, qué pasa
  al suspender y al archivar, exportación de datos, disponibilidad razonable
  sin SLA, cambios de precio con aviso, ley y fuero.

**Revisión legal profesional obligatoria antes de cobrar a nadie.** El ADR
0001 ya la exigía para la puesta en producción; vender a terceros la convierte
en bloqueante de la fase 6. El agente redacta borradores sólidos y los marca
«BORRADOR · pendiente de revisión legal»; el propietario decide quién los
revisa. Esto es un hecho, no una opinión del redactor.

### 3.7 ADR

`docs/adr/0005-homekeeping-alta-publica-y-cobro.md` (el número se ajusta al
que corresponda): contexto (de casas conocidas a servicio contratable),
decisión (alta solo tras pago en Stripe, con `disableSignUp` intacto; correo
transaccional acotado; nombre de producto; plazas fijas; suspensión por
impago en solo lectura), consecuencias (qué se mantiene de la 0029 y del ADR
0003, qué se revierte, cómo se apaga el alta con una sola variable), y la
dependencia de la revisión legal.

### 3.8 Demostración pública (recomendada, opcional)

El código ya sabe funcionar **sin base de datos** con cuentas sintéticas
(`HOUSEKEEPER_FIXTURE_LOGIN`, modo maqueta, ADR 0003). Un **segundo proyecto
de Vercel** en `demo.homekeeping.app`, sin `DATABASE_URL`, da una
demostración interactiva real enlazada desde la portada («Pruébala sin
registrarte») sin tocar producción ni inventar nada. El banner de datos
sintéticos ya existe y se queda. Si se hace, entra en el runbook como
despliegue aparte.

### 3.9 SEO y GEO

Contenido en castellano con una idea por página, títulos que responden a
preguntas reales («cómo llevar la casa con una empleada interna», «menú
semanal y lista de la compra de la familia», «rutinas de la casa para todos»),
una página de **preguntas frecuentes** con JSON-LD, `llms.txt` que resume el
producto para asistentes, metadatos completos, imágenes con `alt` real,
`sitemap.xml` y `robots.txt`, y rendimiento medido: la portada entra en
`infra/quality/lighthouserc.json` con los mismos umbrales que `/login`
(accesibilidad 1,0; LCP ≤ 2 s; TBT ≤ 200 ms; script ≤ 120 KiB) y, además,
**SEO ≥ 0,95**. Sin analítica de terceros en v1 (ver cookies).

## 4. Preguntas abiertas que la sesión cierra con el propietario antes del spec

1. **Dónde vive hoy la aplicación de la familia.** Si está en otro dominio,
   pasar a `homekeeping.app` es un **corte**: `BETTER_AUTH_URL` cambia, las
   sesiones se invalidan, la PWA instalada apunta al dominio viejo.
   Recomendación: añadir `homekeeping.app` y `www` a Vercel, redirigir el
   dominio viejo con 308, avisar a las tres personas, pedirles reinstalar la
   PWA, y hacerlo en un momento tranquilo con el propietario delante.
   Alternativa: la app sigue en su dominio y el público en `homekeeping.app`
   (misma app, dos dominios, `trustedOrigins`), menos limpio para SEO.
2. **Datos del titular** para el aviso legal y las condiciones: ¿persona
   física o sociedad? Quién revisa lo legal.
3. **Países** de venta en v1: recomendación solo España (IVA y lengua).
4. **Demostración pública** (§3.8): ¿sí o no?
5. **Analítica**: ninguna (recomendado en v1) o una sin cookies en la UE.
6. **Nombre del correo remitente** (`hola@homekeeping.app`) y quién recibe
   `/contacto`.
7. **El camino de alta en la base** (§3.3.3): rol de login dedicado
   (recomendado) o función `SECURITY DEFINER`. Es una decisión de seguridad
   que el propietario debe conocer aunque la proponga `security-reviewer`.

## 5. Fuera de alcance (v1)

Planes múltiples o descuentos · pago anual · cambiar las plazas por hogar ·
varios idiomas (la estructura queda preparada, no se traduce) · tiendas de
aplicaciones · analítica con cookies · migrar el hogar actual al cobro ·
borrado definitivo de hogares (se archivan; la retención se decide aparte) ·
facturación fuera de Stripe · chat de soporte · blog.

## 6. Lee primero (además de la lista del workflow común)

| Fichero | Qué saber |
|---|---|
| `apps/web/src/lib/app-title.ts`, `apps/web/static/manifest.webmanifest`, `apps/web/tests/app-title.test.ts` | La regla del nombre que este prompt cambia |
| `apps/web/src/routes/+page.server.ts`, `+layout.svelte`, `+layout.server.ts`, `login/` | La raíz y el acceso actuales |
| `apps/web/src/lib/auth/routing.ts` y `apps/web/src/hooks.server.ts` | `guardForPath` solo gobierna `/h/`; fuera de ahí el hook no protege nada y cada ruta pública se defiende sola |
| `apps/web/src/lib/server/auth-core.ts`, `deployment-config.js`, `boot-guard.server.ts` | `disableSignUp` (se conserva), la regla indivisible (`IDENTITY_VARS`, que tras el prompt de acceso ya incluye Resend) y por qué **no** se amplía con las variables de Stripe |
| `apps/web/src/routes/login/+page.server.ts` y `apps/web/src/service-worker.ts` | Entrada por enlace o código (tras el prompt de acceso); la vuelta a `/` y el destino `/` de las notificaciones |
| `docs/adr/0003-*.md` y `docs/despliegue/opciones-de-acceso.md` | Por qué no hay alta pública ni correo, y qué de eso se conserva |
| `packages/db/migrations/0001_identity_and_context.sql`, `0005_rls.sql`, `0029_*.sql`, `0030_personal_y_altas.sql`, `0038_*.sql` y `packages/db/scripts/sql/bootstrap.sql` | Hogares (sin política de INSERT), perfiles, membresías, la restrictiva de la 0038, retirada del correo, roles `NOBYPASSRLS` |
| `packages/server/src/mail-retirement.integration.test.ts`, `packages/db/tests/140_retired_weekly_report_and_mail.sql` | Las dos reglas del correo que siguen vigentes tras el prompt de acceso (payload referencial; ninguna definer lee correos) y que las plantillas nuevas respetan |
| `apps/web/tests/auth.integration.test.ts` | Afirma que el alta pública de Better Auth está cerrada: **sigue siendo cierto** (el webhook crea cuentas por la API de servidor) y la prueba se conserva |
| `apps/web/scripts/seed-household-accounts.mjs` y `docs/despliegue/alta-de-hogar.md` | Lo único que hoy crea hogares, con el rol propietario (`SEED_DATABASE_URL`): el webhook tiene que hacer lo mismo por un camino acotado (§3.3.3). `packages/db/scripts/bootstrap.mjs` es el bootstrap de roles y esquema, una vez por base: no crea hogares |
| `apps/web/src/lib/server/job-runner.server.ts`, `apps/worker/` y `docs/runbooks/planificador-cola.md` | La cola por la que irá el correo |
| `apps/web/svelte.config.js`, `infra/quality/lighthouserc.json`, `lighthouse-budget.json`, `apps/web/scripts/verify-today-bundle.mjs` | Prerender en Vercel, presupuestos y módulos desterrados |
| `docs/ux/sistema-movil.md` y `docs/ux/revision-ux-v3-intuitividad.md` | La voz y el sistema de la aplicación con los que la portada tiene que ser coherente |
| `docs/manual/index.html` y `scripts/construir-manual-publicable.mjs` | El manual que se publica en `/manual` y las capturas sintéticas |
| `.github/workflows/ci.yml` (job `lighthouse`) y `security.yml` | Dónde entra la portada en las medidas y qué pasa gitleaks |

Documentación externa a leer **en su versión vigente** con `dependency-expert`
y citar en el spec: Stripe (Checkout en modo suscripción con prueba, Stripe
Tax con impuesto incluido, portal de cliente, webhooks y firma, idempotencia,
CLI `stripe listen`/`stripe trigger` para pruebas locales, el SDK de Node y su
compatibilidad con Node 24); SvelteKit (prerender parcial con rutas dinámicas,
`adapter-vercel` con `split: false`); Resend (plantillas y límites, ya
integrado por el prompt de acceso); Better Auth (creación de usuarios desde
servidor sin contraseña, vinculación de una cuenta existente a un hogar
nuevo).

## 7. Diseño de referencia (esbozo; el spec manda)

- **Migración `00NN_billing_y_plazas.sql`**: `app.household_subscriptions`
  (hogar, `stripe_customer_id`, `stripe_subscription_id`, `status`,
  `trial_end`, `current_period_end`, `billing_exempt boolean`, marcas),
  `app_private.household_signups`, `app_private.stripe_events` (idempotencia),
  función y disparador de plazas, estado `suspended` consultable por una
  función `app.household_is_writable(household_id)` que los handlers de
  comandos comprueban al principio (un solo sitio: `processSyncBatch` o
  `withAuthorizedTransaction`), **el camino acotado de alta de hogar**
  (§3.3.3: rol de login nuevo con sus políticas, o función definer), el filtro
  de hogares archivados en lo que resuelve sesión y membresía, RLS de las
  tablas nuevas (la suscripción la lee `family_admin` del hogar; las de
  `app_private` no tienen GRANT para la app salvo lo que el alta y el webhook
  necesiten con su rol), el GRANT para que el worker lea el correo del
  destinatario, auditoría, `DO $check$`. Suite SQL propia en `test:rls` con
  el **siguiente número libre** (hoy `220`; `230` si Garantías ya ocupó la
  `220`).
- **Contratos**: `HOUSEHOLD_SEATS = { family: 5, staff: 3 }` en
  `@housekeeper/contracts`; código de rechazo `household_seats_full` y
  `household_suspended` con sus textos; estado de suscripción en
  `AppContextV1` para que la interfaz sepa pintar el aviso sin otra consulta.
- **Servidor**: `billing.server.ts` (crear Checkout, portal, leer estado),
  `billing-webhook.server.ts` (verificar firma, idempotencia, despacho por
  tipo de evento, transacción de alta de hogar reutilizando lo que haga
  `seed-household-accounts.mjs` extraído a una función compartida),
  `mail.server.ts` (plantillas en castellano, envío por la cola), tareas del
  worker para correo y para archivar hogares suspendidos a los 30 días.
- **Interfaz pública**: `src/lib/marketing/` con componentes propios; páginas
  prerrenderizadas; formulario `/alta` con validación y mensajes en castellano
  llano; `/alta/gracias` honesto; página de error pública con voz propia.
- **Interfaz privada**: Ajustes → tarjeta «Suscripción» (estado, próxima
  factura en palabras, «Gestionar en Stripe»); plazas en Ajustes y Personal;
  aviso de impago/suspensión en Hoy y en el shell; «Tu acceso» → nombre de
  usuario editable (en el alta pública se deriva del correo).
- **Variables nuevas** (`.env.example`, destino `[vercel]`, grupo
  indivisible **blando**): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_ID`, `SIGNUP_DATABASE_URL` si el spec elige el rol dedicado,
  `PUBLIC_SITE_URL=https://www.homekeeping.app`. Las de Resend
  (`RESEND_API_KEY`, `MAIL_FROM`) ya existen desde el prompt de acceso.
  Ninguna clave publicable de Stripe en el cliente si Checkout es alojado.
- **Dependencias nuevas**: el SDK de Stripe para Node (versión fijada) y, si
  procede, el del proveedor de correo o `fetch` directo. Justificadas en el
  spec; `pnpm-lock.yaml` en commit propio.

## 8. Workflow específico

Sigue las siete fases del workflow común con estas adiciones:

### Fase 1 · Diseño

1. Brainstorming con las seis preguntas de §4 en una sola tanda.
2. Investigación (`dependency-expert`): Stripe, correo, prerender en Vercel.
3. **Dirección visual antes del spec**: dos o tres direcciones de portada
   (mood, tipografía, paleta, tipo de movimiento) presentadas al propietario
   como maquetas estáticas rápidas con datos sintéticos (`frontend-design`;
   la skill de brainstorming permite abrir el visual companion). Se elige
   una. Sin esta elección, el diseño «creativo» acaba siendo genérico.
4. Spec `docs/superpowers/specs/YYYY-MM-DD-web-publica-homekeeping-design.md`
   con: mapa de rutas, arquitectura de contenidos (qué dice cada página y a
   quién), flujo de alta con diagrama de secuencia y **tabla de estados** de
   la suscripción, modelo de datos, plazas, correo, legal (índice de cada
   documento), SEO/GEO (inventario de metadatos y datos estructurados),
   rendimiento y accesibilidad, seguridad, pruebas, entrega. ADR de §3.7.
5. Revisión adversarial: `critic`, `security-reviewer` (webhook, tokens de
   correo, enumeración de correos en `/alta`, abuso del formulario, RLS de las
   tablas nuevas, suspensión que no se pueda saltar) y `architect` (prerender
   frente a `guardForPath`, una sola función, presupuesto de Hoy).
6. Puerta: aprobación del propietario.

### Fase 2 · Plan por fases

1. **Nombre e identidad**: `app-title.ts`, manifiesto, textos; README y
   skill actualizados. Es una fase pequeña y aparte porque toca a la familia
   actual (cambia el nombre bajo el icono): se avisa antes.
2. **Plazas**: migración, contrato, disparador, mensajes, Ajustes y Personal,
   suites. Comprobación del hogar real.
3. **Cobro**: tablas, Stripe Checkout, webhook idempotente, estados,
   suspensión en solo lectura, hogares archivados inaccesibles, portal,
   pruebas con `stripe trigger` y eventos firmados sintéticos.
4. **Correo**: plantillas nuevas sobre el adaptador de Resend que ya existe
   (bienvenida del alta en línea; impago y suspensión por la cola con payload
   referencial; acuse de `/contacto`), pruebas con el adaptador falso.
5. **Alta de hogar**: el camino acotado en la base (rol o función) con su
   suite, el servicio de alta en dos pasos idempotentes compartido con el
   guion `seed-household-accounts.mjs` (que pasa a usarlo), webhook → hogar
   listo, `/alta`, `/alta/gracias`, dbe2e del recorrido completo con Stripe
   simulado y el correo de bienvenida leído del adaptador falso.
6. **Web pública**: portada, páginas, legal, SEO/GEO, animación, a11y,
   Lighthouse, `llms.txt`, sitemap, robots; demo pública si se aprobó.
7. **Endurecimiento y entrega**: revisión de seguridad ejecutada
   (`docs/security/revision-homekeeping-alta-y-cobro.md`), documentación,
   runbook (dominio, variables, webhook de Stripe apuntando a producción,
   despliegue de la demo), producción.

### Fase 3 · Ejecución

TDD. El webhook se prueba con eventos firmados generados en test y con el CLI
de Stripe en local; el proveedor de correo tiene un adaptador falso en test y
nunca se llama a la API real desde una suite. Ningún dato de tarjeta toca el
servidor. Las páginas legales se renderizan desde `docs/legal/*.md` (una sola
fuente) y un test comprueba que no queda ningún `[[MARCADOR]]` sin rellenar
**en producción** (en el repositorio sí quedan, a propósito).

### Fase 4 · Verificación

Lo del workflow común y, además: `pnpm test:lighthouse` con la portada y
`/precios` añadidas; la build prerrenderiza las rutas públicas y la función
sigue siendo una; `verify:bundle` en verde con los destierros nuevos; dbe2e
de «contratar → correo de bienvenida → entrar con el enlace → Hoy → plazas»; la
suite SQL demuestra que la membresía 6 y la 4 se rechazan y que un hogar
suspendido no acepta comandos; `security.yml` sin secretos (las claves de
Stripe de prueba también son secretos: no entran en el árbol).

### Fase 5 · Documentación

Manual (capítulo «Tu suscripción» para la administración; nombre nuevo en
todo el manual; capítulo de instalación con el nombre); skill (secciones
«Suscripción y plazas», «Alta de un hogar por la web», y actualización de
«no hay pantalla que cree hogares», que deja de ser cierto); runbook (§1
dominio e identidad, §5 variables del grupo nuevo, webhook de Stripe,
despliegue de la demo, §7 humo con una contratación de prueba con tarjeta
`4242…` y su cancelación desde el portal); `.env.example`; README (el aviso
del nombre, mapa, suites, documentación); `docs/legal/` con los borradores y
su estado; ADR nuevo; `security-baseline.md` (frontera nueva: Stripe y
correo); `CONTRIBUTING.md` si cambia alguna regla.

### Fase 6 · Producción

Orden propio, además del común: (1) revisión legal cerrada y marcadores
rellenados por el propietario; (2) dominio y `www` en Vercel, certificados,
redirección del dominio viejo si lo hay, `BETTER_AUTH_URL` y
`PUBLIC_SITE_URL` nuevos **en la misma operación** que el corte; (3) cuenta de
Stripe en modo prueba con el producto y el precio creados, webhook de
producción registrado con su secreto, Stripe Tax activado; (4) proveedor de
correo con dominio verificado; (5) variables del grupo indivisible en Vercel;
(6) migraciones por conexión directa, tras comprobar las plazas del hogar
real; (7) merge; (8) humo: portada desde un móvil, Lighthouse en producción,
contratación de prueba completa con tarjeta de prueba, correo recibido,
entrar, plazas, portal, cancelar; la familia entra con normalidad y ve el
nombre nuevo; `/api/health` y la cola; (9) demo pública si procede; (10)
sitemap enviado a Search Console; (11) copia posterior.

## 9. Riesgos conocidos

- **El corte de dominio** puede dejar a la familia fuera unas horas si se
  hace mal: se hace con el propietario delante, con la reposición de
  contraseñas cara a cara como red, y con el runbook actualizado antes.
- **El webhook es la puerta de alta**: firma verificada, idempotencia, alta
  en dos pasos con compensación, y una cola de reintentos de Stripe que no
  debe crear dos casas ni dos cuentas. Pruebas específicas de duplicado, de
  evento fuera de orden y de reanudación a medias.
- **Abrir la creación de hogares a un rol sometido a RLS** es el cambio de
  seguridad más serio del prompt: la 0038 cerró a propósito que la app cree
  `family_admin`. El camino nuevo tiene que ser el mínimo (un hogar sin
  membresías, una sola primera administradora), con su suite negativa, y la
  revisión de seguridad lo ejecuta con el rol real.
- **Enumeración de correos** en `/alta` y en «He olvidado mi contraseña»:
  respuestas idénticas exista o no la cuenta; límites de tasa en la base.
- **El nombre cambia bajo el icono** de tres personas reales: se avisa, se
  documenta y se hace en una fase propia.
- **Un prerender que arrastre la base**: ninguna página pública importa nada
  de `$lib/server` que abra conexión; el test espejo del grafo lo vigila.
- **Vender antes de la revisión legal**: la fase 6 lo bloquea de forma
  explícita; el alta se puede desplegar apagada (grupo de variables ausente,
  portada honesta) mientras lo legal se cierra.

## 10. Criterio de hecho

`https://www.homekeeping.app/` sirve una portada vistosa, accesible al 100 %
y dentro de los presupuestos, con páginas de funciones, precios, asistentes,
manual y legal; una contratación de prueba completa crea una casa nueva en
menos de dos minutos con su correo de bienvenida y su primera administradora;
la casa tiene 5 plazas de familia y 3 de personal y la sexta y la cuarta se
rechazan con un mensaje claro; impago → aviso → solo lectura → archivado,
todo probado; el hogar actual sigue igual, exento y con el nombre nuevo;
borradores legales publicados tras revisión profesional con los datos del
titular; ADR aceptado; revisión de seguridad ejecutada; manual, skill,
runbook, `.env.example`, README y memoria del agente al día; copias anterior
y posterior.
