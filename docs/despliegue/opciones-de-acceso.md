# Opciones de acceso para el despliegue real (Vercel + Supabase)

Investigación para el despliegue de Casa Clara con **tres personas reales**: Alberto y Ana
(familia) y Nuria (interna). Hoy la entrada de producción es **enlace mágico por correo** y
la de demostración es un **selector de cuentas** protegido por `ENABLE_DEMO_PASSWORD_AUTH`.
El propietario descarta depender del correo.

Este documento **no implementa nada**: compara opciones, recomienda una y detalla el plan.
Precios y límites verificados en agosto de 2026 (fuentes al final).

> **Estado (agosto de 2026): la opción A está implementada.** Lo que hay montado y cómo se
> opera se cuenta en [acceso-produccion.md](acceso-produccion.md). Las referencias a líneas
> concretas de este documento describen el código **anterior** al cambio; sirven para entender
> por qué se decidió lo que se decidió, no para leer el código de hoy. Sigue pendiente el
> paso 8 (passkeys) y, fuera del acceso, el cambio a `@sveltejs/adapter-vercel` del paso 7.

---

## 1. Qué hay hoy en el repositorio

### 1.1 Better Auth ya está montado y ya sabe de contraseñas

`apps/web/src/lib/server/auth-core.ts` construye la instancia. El bloque relevante:

- Líneas 29-31 y 66-68: `emailAndPassword: { enabled: options.demoPasswordEnabled ?? false }`.
  **El proveedor de contraseña ya existe**; solo está apagado salvo en demo.
- Líneas 33-39 y 70-74: el plugin `magicLink({ expiresIn: 600, disableSignUp: true })`.
- Líneas 55-79: `createAuthCore()` duplica literalmente la configuración para poder inyectar
  `extraPlugins`. Cualquier cambio de configuración hay que hacerlo **dos veces** o refactorizar
  antes; es la primera deuda a saldar.

`apps/web/src/lib/server/auth.server.ts`:

- Líneas 14-38: `deliverMagicLink()`. Con `SMTP_HOST` envía por nodemailer; en `dev` sin SMTP
  imprime el enlace por consola; **fuera de dev y sin SMTP lanza excepción** (línea 37). Es decir,
  hoy el despliegue en Vercel sin SMTP deja la única puerta de producción inservible.
- Líneas 45-60: `getAuth()` devuelve `null` si faltan `DATABASE_AUTH_URL` o `BETTER_AUTH_SECRET`.
  Con `null` no se monta ninguna ruta `/api/auth` y la app cae al selector de fixtures.

`apps/web/src/routes/login/+page.server.ts`:

- Línea 11: los tres modos, `'fixture-selector' | 'password-selector' | 'magic-link'`.
- Líneas 25-28: `resolveMode()`. Sin `auth` → fixtures; con `auth` y flag demo → selector con
  contraseña; con `auth` y sin flag → enlace mágico.
- Líneas 31-41: `demoCredentialFor()`. **No hay formulario de contraseña**: el usuario pulsa una
  tarjeta y el servidor recupera correo y contraseña de variables de entorno
  (`DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD`, etc.). Es un atajo de demostración, no un login.
- Líneas 65 y 73-81: doble reja — fuera de `localhost` exige `ALLOW_SYNTHETIC_DATA_ONLY=true`
  (control 9 del baseline, `docs/security/security-baseline.md:21`).
- Líneas 104-122: la acción `magiclink`, con respuesta idéntica exista o no la cuenta.

`apps/web/src/routes/login/+page.svelte`: bloque de enlace mágico en 25-36, rejilla de cuentas
demo en 38-60, y el aviso «Demo sin contraseña» en la línea 62.

### 1.2 No existe cliente de auth en el navegador

`grep -rn "createAuthClient" apps/web/src` no devuelve nada. Toda la autenticación pasa por
**form actions** de SvelteKit con mejora progresiva. Esto importa mucho para passkeys, que
obligan a JavaScript en el cliente y a un `authClient`. La CSP declarada en
`apps/web/svelte.config.js:14-30` (`script-src: ['self']`) no lo impide, porque el cliente
viajaría en el bundle propio.

### 1.3 La autorización no la hace el proveedor de identidad

Este es el punto que decide toda la comparativa. Better Auth **solo emite identidad**; el permiso
vive en la base de datos:

- `packages/db/migrations/0001_identity_and_context.sql:41-49` — comentario explícito:
  *«Better Auth owns authentication. This table stores only the stable external id and a minimal
  application profile; no password or authentication secret belongs here.»*
  `app.user_profiles.user_id` es `text`, no un UUID de ningún proveedor concreto.
- Líneas 51-67 de la misma migración: `app.household_memberships` con `starts_at`, `expires_at`
  y `revoked_at`.
- `packages/db/migrations/0005_rls.sql:70-77` — la política `memberships_discover_own` excluye
  membresías futuras, caducadas o revocadas.
- `apps/web/src/lib/server/app-user.server.ts:31` — `set_config('app.user_id', $1, true)` y lectura
  de membresías bajo RLS en **cada petición** (`hooks.server.ts:24-43`).
- `packages/server/src/database.ts:29-44` — `withAuthorizedTransaction` vuelve a comprobar
  `revoked_at is null and (expires_at is null or expires_at > now())` en cada escritura.
- `apps/web/src/lib/server/access.server.ts:36-79` y
  `apps/web/src/routes/h/[householdId]/settings/+page.svelte:89-120` — el `family_admin` ya ve y
  gobierna los accesos; `apps/web/src/lib/access/commands.ts:33-64` encola `set_expiry` y `revoke`
  (contratos en `packages/contracts/src/schemas.ts:267,581`).

**Consecuencia:** la revocación instantánea del control 3 del baseline
(`docs/security/security-baseline.md:15`) **no depende del mecanismo de login**. Revocar una
membresía corta el acceso en la petición siguiente aunque la cookie de sesión siga viva.
Cualquiera de las opciones de este documento la conserva, *siempre que el identificador estable
que se guarda en `app.user_profiles.user_id` no cambie*. Ese es el único invariante que hay que
proteger en una migración de proveedor.

### 1.4 Cómo se crean las cuentas hoy

`apps/web/scripts/seed-demo-users.mjs` es el patrón exacto que reutilizaremos:
`auth.api.signUpEmail()` para la identidad, y luego `insert` idempotente en `app.user_profiles` y
`app.household_memberships` con `row_security = off` desde el rol propietario de migraciones.
Está deliberadamente bloqueado para producción: exige `ENABLE_DEMO_PASSWORD_AUTH=true`
**y** `ALLOW_SYNTHETIC_DATA_ONLY=true` (líneas 33-45). Para el despliegue real hace falta un
script hermano sin esas rejas y con otro nombre.

`app.user_profiles.email` existe desde `packages/db/migrations/0006_reminders_and_autoconfirm.sql:6-7`,
con un `CHECK` que exige forma de correo (`algo@algo.algo`). No exige que sea entregable.

### 1.5 Dos defectos que hay que corregir antes de producción

1. **El alta pública queda abierta al activar contraseña.** Hoy `auth-core.ts:29-31` pone
   `emailAndPassword.enabled` sin `disableSignUp`. El tipo lo soporta
   (`@better-auth/core/dist/types/init-options.d.mts:588`). Como `/api/auth` se monta en
   `hooks.server.ts:19-22` en cuanto existe `auth`, con la contraseña activada
   `POST /api/auth/sign-up/email` es alcanzable desde internet. El daño hoy es limitado —el usuario
   creado no tendría membresía, `resolveAppUser` devolvería `null` y el guard lo mandaría a
   `/login`— pero permite llenar la tabla `auth.user` de basura. **En producción, `disableSignUp: true`
   es obligatorio.**
2. **El adaptador es `@sveltejs/adapter-node`** (`apps/web/svelte.config.js:1`). Vercel necesita
   `@sveltejs/adapter-vercel`, o bien un servidor Node en otro sitio. No es un asunto de auth, pero
   condiciona el punto siguiente.
3. **El limitador de Better Auth usa memoria por defecto**, inservible en funciones sin estado.
   En Vercel hay que declarar `rateLimit: { storage: 'database' }`.

---

## 2. Opción A — Better Auth con contraseña de verdad

Activar `emailAndPassword` en producción, escribir un formulario real de usuario y contraseña,
y no configurar `sendResetPassword`.

**Qué falta respecto a hoy**

| Pieza | Estado | Trabajo |
|---|---|---|
| Proveedor de contraseña | Ya existe, apagado (`auth-core.ts:29-31`) | Encenderlo con `disableSignUp: true` |
| Hashing | Ya resuelto: Better Auth usa **scrypt** por defecto | Ninguno |
| Formulario de login | **No existe** (hoy es un selector de tarjetas) | Nueva acción `password` en `login/+page.server.ts` |
| Alta de las 3 cuentas | Script demo bloqueado para producción | Script nuevo, sin las rejas de las líneas 33-45 |
| Cambio de contraseña | `auth.api.changePassword` existe | Pantalla en Ajustes |
| Bloqueo por intentos | Better Auth limita por defecto en producción (60 s / 100 req) | Regla estricta para `/sign-in/email` + `storage: 'database'` |
| Sesiones y cierre | Ya funciona (`routes/logout/+server.ts`) | Ninguno |
| Revocación instantánea | Ya funciona por RLS | Ninguno |
| Restablecer sin correo | No existe | Plugin `admin` + acción en Ajustes |

**Sobre el restablecimiento.** Verificado en el código instalado
(`better-auth/dist/api/routes/password.mjs:51-57`): si no se define `sendResetPassword`, el endpoint
`request-password-reset` responde `400 RESET_PASSWORD_DISABLED`. Es decir, **no configurarlo no
deja un flujo a medias: lo desactiva limpiamente**, y de paso elimina esa superficie de ataque.
La reposición se hace entonces por otra vía (§6).

**Se puede prescindir del correo por completo.** Better Auth exige un campo `email` único en su
tabla de usuarios, pero nada obliga a que sea entregable. Dos caminos:

- Correos reales de los tres (lo natural: Alberto y Ana los tienen). Se usan como identificador,
  nunca se les escribe.
- Plugin `username` (incluido en el paquete, `better-auth/plugins/username`, endpoint
  `signInUsername`): Nuria entra con `nuria` en lugar de un correo. El campo `email` se rellena
  con algo sintético tipo `nuria@casa.local`, que satisface el `CHECK` de
  `0006_reminders_and_autoconfirm.sql:7`. **Recomendado**: para alguien sin costumbre de gestionar
  contraseñas, teclear `nuria` es notablemente más fácil que teclear un correo sin erratas en un
  móvil.

**Pros:** cero dependencias nuevas, cero servicios de terceros, cero coste, el modelo de
autorización no se toca, funciona sin JavaScript.
**Contras:** hay que gestionar contraseñas humanas; sin correo, la recuperación es un proceso
manual del administrador.
**Coste:** 0 €. **Esfuerzo:** 1-1,5 días.

---

## 3. Opción B — Passkeys (WebAuthn) con contraseña de respaldo

Better Auth tiene el plugin en `@better-auth/passkey`, versión **1.6.26**, exactamente alineada con
la `better-auth` 1.6.26 que declara `apps/web/package.json:27`. Usa SimpleWebAuthn por debajo y
añade una tabla `passkey`.

**Cómo sería para la familia.** Cada persona registra el móvil una vez desde Ajustes, ya con sesión
iniciada. A partir de ahí entra con huella o cara. Es la opción más cómoda y la más segura: no hay
secreto que teclear, adivinar ni reutilizar, y es inmune al phishing porque la credencial está atada
al dominio.

**Soporte.** Sólido en iOS/Safari, Android/Chrome, Windows Hello, macOS. Las passkeys se sincronizan
dentro del ecosistema: iCloud Keychain entre dispositivos Apple, Google Password Manager entre
dispositivos Google. **No sincronizan entre Apple y Android** sin un gestor de terceros (1Password,
Bitwarden); la migración nativa Apple↔Google se espera para finales de 2026.

**Si se pierde el móvil.** Si la passkey estaba sincronizada, aparece sola en el móvil nuevo al
iniciar sesión con el Apple ID o la cuenta de Google. Si el dispositivo era el único y no había
sincronización, la credencial se pierde y hace falta el proceso de recuperación de la aplicación.
Por eso **passkeys en solitario no son una opción responsable aquí**: hay que combinarlas con
contraseña.

**Coste añadido sobre la opción A.** Una dependencia nueva, un `createAuthClient` en el navegador
—que hoy no existe— y la ruptura del principio de «todo funciona sin JavaScript» en la pantalla de
entrada. También hay que fijar `rpID` al dominio de producción, lo que complica probarlo en local
(`localhost` funciona, pero una passkey de `localhost` no sirve en el dominio real).

**Pros:** entrar es un gesto; nada que recordar; resistente a phishing; sin correo.
**Contras:** exige JavaScript; una capa nueva en el cliente; recuperación dependiente del ecosistema
del móvil; hay que mantener igualmente el camino de contraseña.
**Coste:** 0 €. **Esfuerzo:** +1 día sobre la opción A.

---

## 4. Opción C — Supabase Auth (GoTrue)

### 4.1 Sustituir Better Auth

**Plan gratuito.** 50.000 usuarios activos mensuales —tres personas ni lo rozan—, 500 MB de base de
datos, 1 GB de almacenamiento, 5 GB de egress, 2 proyectos activos. **Los proyectos gratuitos se
pausan tras una semana de inactividad**; para una app de uso familiar diario no debería activarse,
pero conviene saberlo antes de unas vacaciones largas.

**El SMTP integrado es solo para desarrollo.** Confirmado: **2 correos por hora**, en modo
«best effort», con aviso explícito de que no sirve para producción. La sospecha del propietario es
correcta. Con **email + contraseña y la confirmación de correo desactivada** (Authentication →
Settings → *Enable email confirmations*, off) **se puede operar sin enviar un solo correo**: el alta
la hace el administrador desde el panel y el usuario entra directamente. Ojo al detalle documentado:
aunque se desactive la confirmación, **los flujos de recuperación de contraseña siguen existiendo** y
sí intentarían enviar correo; hay que no exponerlos en la interfaz.

**Coste de integración: alto y sin contrapartida.** La autorización de esta app es propia
(§1.3): RLS con `set_config('app.user_id')` sobre un `user_id` de tipo `text`, `app.set_household_context()`,
y membresías con rol, caducidad y revocación. Supabase Auth no aporta nada de eso; su modelo de RLS
habitual (`auth.uid()` y políticas por `auth.users`) es *otra* forma de hacer lo mismo que aquí ya
está hecho, probada además con una matriz negativa (`packages/db/tests/020_rls_matrix.sql`).
Sustituir Better Auth obliga a:

- reescribir `auth-core.ts`, `auth.server.ts` y `hooks.server.ts:24-43` para validar un JWT de GoTrue
  en lugar de leer una sesión;
- **remapear todos los `user_id` existentes** de `app.user_profiles` y `app.household_memberships`,
  con el riesgo de romper la trazabilidad de `app.audit_events`;
- rehacer las pruebas de integración de auth y el script de semillas.

**Veredicto: cirugía innecesaria.** Se cambiaría un proveedor que ya funciona, ya está migrado y ya
está probado, por otro que resuelve exactamente el mismo problema —emitir identidad— y que además
tiene un límite de correo aún peor que no tener correo.

### 4.2 Supabase Auth solo como emisor de identidad

**Sí es técnicamente posible y limpio.** El modelo de membresías es agnóstico por diseño:
`app.user_profiles.user_id` es `text` (`0001_identity_and_context.sql:44`) y el comentario de la
línea 41 dice explícitamente que ahí no vive ningún secreto. Bastaría con que
`hooks.server.ts:24-43` verificase el JWT de Supabase y pasara `sub` a `resolveAppUser()` en lugar
del `authSession.user.id` actual. Todo lo demás —RLS, roles, revocación, `withAuthorizedTransaction`—
seguiría intacto.

**Pero no aporta nada en este escenario.** Se ganaría un panel de administración de usuarios (útil
para reponer contraseñas sin escribir código) a cambio de: verificación de JWT en el servidor,
gestión de refresh tokens en el cliente, un segundo sistema de sesiones conviviendo con las cookies
actuales, y la pérdida del plugin de passkeys de Better Auth. Para tres usuarios no compensa.
Merecería la pena solo si en el futuro se quisieran inicios de sesión con Google/Apple sin
implementarlos a mano.

**Coste:** 0 €. **Esfuerzo:** 2-3 días (sustitución) o 1-1,5 días (solo emisor). **No recomendado.**

---

## 5. Opción D — Correo gratuito, por si algún día

Aunque el propietario lo descarte, este es el precio de volver a los enlaces mágicos. Nada de esto
hay que hacerlo ahora; `deliverMagicLink()` (`auth.server.ts:14-38`) ya habla SMTP genérico, así que
basta con rellenar `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM`.

| Proveedor | Plan gratuito | Requisitos | Notas |
|---|---|---|---|
| **Resend** | 3.000 correos/mes, tope de 100/día, 1 dominio, 30 días de logs | Dominio propio verificado (DNS: SPF/DKIM) | La opción más limpia si ya hay dominio |
| **Brevo** | 300 correos/día (~9.000/mes) | Cuenta y verificación de remitente | Más generoso en volumen; interfaz más pesada |
| **Gmail con contraseña de aplicación** | Límite de envío de la cuenta (orden de cientos/día) | 2FA activo en la cuenta Google | Cero configuración de DNS, pero mezcla la cuenta personal con la app y Google restringe periódicamente esta vía. Solo como tapón temporal |
| **SMTP propio en Supabase** | **Sí, permitido en el plan gratuito** | Cualquiera de los anteriores | Sube el límite de 2/hora a 30/hora, ajustable en Rate Limits |

Para tres personas, cualquiera de los tres primeros sobra con holgura: el gasto real serían tres o
cuatro correos al mes. **El coste no es el dinero, es la fragilidad**: un enlace mágico añade una
dependencia externa entre la persona y su propia casa, y añade el correo como punto único de fallo
para el acceso.

---

## 6. Recuperar el acceso sin correo

Es la pregunta difícil y merece una respuesta explícita, en tres niveles.

**Nivel 1 — Ana y Nuria olvidan su contraseña: Alberto se la repone.**
El plugin `admin` viene en el paquete instalado (verificado en
`node_modules/better-auth/dist/plugins/admin/`: expone `createUser`, `listUsers`, `setUserPassword`
y `revokeUserSessions`). Se añade una acción en la sección «Accesos del hogar» de Ajustes
—que ya existe y ya es exclusiva de `family_admin`, `access.server.ts:44`— con un botón
«Poner una contraseña nueva». El administrador teclea una contraseña provisional, se la dice en
voz alta, y la app obliga a cambiarla en el primer acceso. Sin correo, sin esperas, cara a cara,
que es como funciona una casa.

**Nivel 2 — Alberto, el administrador, pierde su acceso.**
Aquí no puede haber autoservicio; hay tres redes de seguridad, y conviene tener al menos dos:

1. **Ana también es `family_admin`.** Es lo más barato y lo más robusto: dos administradores se
   reponen mutuamente. El modelo de roles ya lo permite (`app.household_role` en
   `0001_identity_and_context.sql:20-26`).
2. **Códigos de recuperación de un solo uso, impresos.** Se generan cinco al crear cada cuenta,
   se guardan como hash junto al usuario y se imprimen en un papel dentro de un sobre en casa. Es
   trabajo adicional (tabla, generación, canje, invalidación) y para tres personas probablemente
   sea sobreingeniería si ya hay dos administradores.
3. **El panel de Supabase.** Alberto es el dueño del proyecto: entrando en Supabase puede ejecutar
   un `update` sobre la tabla de credenciales de Better Auth. Es la vía de último recurso y
   conviene **documentarla en un runbook**, no descubrirla en una urgencia. Cualquiera con acceso
   al panel de Supabase puede, de hecho, entrar en la aplicación; **esa cuenta debe tener 2FA**.

**Nivel 3 — lo que nunca hay que hacer.** No dejar una «contraseña maestra» en variables de
entorno, y no reciclar el atajo demo de `demoCredentialFor()` (`login/+page.server.ts:31-41`) como
puerta trasera de producción. Ese código debe desaparecer del camino real, no quedarse dormido.

---

## 7. Tabla comparativa

| Opción | Coste | Esfuerzo | ¿Sin correo? | Facilidad para Nuria | Riesgo principal |
|---|---|---|---|---|---|
| **A. Better Auth + contraseña** (con `username`) | 0 € | 1-1,5 días | Sí, total | Alta: `nuria` + contraseña corta y memorable | Contraseña débil o compartida; reposición manual |
| **B. A + passkeys** | 0 € | +1 día | Sí, total | Muy alta: huella | Exige JS; pérdida del móvil sin sincronización |
| **C. Supabase Auth sustituyendo** | 0 € | 2-3 días | Sí, con confirmación desactivada | Media | Remapeo de `user_id`, ruptura de auditoría, RLS duplicada |
| **C'. Supabase solo como identidad** | 0 € | 1-1,5 días | Sí | Media | Dos sistemas de sesión conviviendo; sin passkeys |
| **D. Enlace mágico + Resend/Brevo** | 0 € | 0,5 días | **No** | Baja: depende del correo en el móvil | Dependencia externa; correo como punto único de fallo |

---

## 8. Veredicto y plan de implementación

**Recomendación: opción A ahora, opción B como capa opcional después.**
Contraseña real de Better Auth con el plugin `username`, sin correo en ningún punto del recorrido,
y reposición de contraseñas por el administrador desde Ajustes. Cuando esté en marcha y las tres
personas estén dentro, añadir passkeys como *atajo* voluntario para quien quiera entrar con la
huella, manteniendo siempre la contraseña como respaldo.

### Paso 1 — Refactorizar `auth-core.ts` antes de tocar nada

`apps/web/src/lib/server/auth-core.ts` duplica la configuración entre las líneas 25-41 y 62-77.
Unificar en un único objeto de opciones al que se le concatenan `extraPlugins`. Sin esto, cada
cambio posterior hay que escribirlo dos veces y es cuestión de tiempo que diverjan.

### Paso 2 — Encender la contraseña de producción

En el objeto unificado:

- `emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 }`.
  **`disableSignUp` no es opcional** (§1.5).
- **No definir `sendResetPassword`**: eso deja `request-password-reset` devolviendo
  `400 RESET_PASSWORD_DISABLED` (`better-auth/dist/api/routes/password.mjs:51-57`), que es
  justo lo que queremos.
- Añadir `username()` de `better-auth/plugins/username`.
- Añadir `admin()` de `better-auth/plugins/admin`, con Alberto como único `admin`.
- Añadir `rateLimit: { storage: 'database', customRules: { '/sign-in/email': { window: 60, max: 5 }, '/sign-in/username': { window: 60, max: 5 } } }`.
- Sustituir `demoPasswordEnabled` por una opción explícita de producción; el flag demo deja de
  gobernar el proveedor de contraseña.
- Decidir sobre `magicLink`: **quitarlo**. Mientras siga registrado, `/api/auth/sign-in/magic-link`
  existe y `deliverMagicLink()` lanzará la excepción de `auth.server.ts:37` en cada intento.
  Una puerta que solo sabe fallar es peor que ninguna puerta.

Ejecutar después las migraciones de Better Auth (`runAuthMigrations`, `auth-core.ts:81-84`) para
crear las columnas de `username` y las tablas de `admin` y `rateLimit`.

### Paso 3 — Simplificar `auth.server.ts`

Eliminar `deliverMagicLink()` (líneas 14-38) y la dependencia de `nodemailer` del camino de
autenticación. Si en el futuro se quisiera correo, se recupera de git.

### Paso 4 — Escribir el formulario de entrada de verdad

En `apps/web/src/routes/login/+page.server.ts`:

- Nueva acción `password` que lea `username` y `password` del formulario y llame a
  `auth.api.signInUsername({ body, headers })`. Mensaje de error único e idéntico para usuario
  inexistente y contraseña incorrecta.
- Reducir `LoginMode` (línea 11) a `'fixture-selector' | 'password'`.
- **Borrar `demoCredentialFor()` (líneas 31-41)** y el bloque de la acción `demo` que usa
  `auth.api.signInEmail` (líneas 71-96). El selector de fixtures sin base de datos (líneas 98-101)
  puede quedarse: solo vive cuando `getAuth()` es `null`, y es lo que sostiene la demo actual.
- Retirar las variables `DEMO_*_EMAIL` / `DEMO_*_PASSWORD` del entorno de producción.

En `apps/web/src/routes/login/+page.svelte`: sustituir el bloque de enlace mágico (25-36) y la
rejilla de cuentas (38-60) por un formulario de dos campos. Quitar el aviso «Demo sin contraseña»
(línea 62) y el rótulo «Entorno local de demostración» (línea 17). Etiquetas en el idioma de la
casa: «Tu nombre de usuario» y «Tu contraseña», `autocomplete="username"` y
`autocomplete="current-password"` para que los gestores del móvil hagan su trabajo.

### Paso 5 — Crear las tres cuentas

Script nuevo, `apps/web/scripts/seed-household-accounts.mjs`, calcado de
`seed-demo-users.mjs` pero **sin** las rejas de las líneas 33-45 y **sin** contraseñas en el
entorno: que las genere aleatorias y las imprima una sola vez por consola, para que Alberto las
reparta y cada uno la cambie al entrar.

| Persona | Usuario | Rol | Correo interno |
|---|---|---|---|
| Alberto | `alberto` | `family_admin` | su correo real (nunca se le escribe) |
| Ana | `ana` | `family_admin` | su correo real |
| Nuria | `nuria` | `employee_live_in` | `nuria@casa.local` |

Ana como segunda `family_admin` **es parte del diseño de recuperación**, no una comodidad.
El resto del script (`app.user_profiles` + `app.household_memberships` con `row_security = off`
desde el rol propietario) se reutiliza tal cual, líneas 78-104.

### Paso 6 — Cambiar y reponer contraseñas desde Ajustes

- **Cambio propio:** pantalla nueva con `auth.api.changePassword({ newPassword, currentPassword, revokeOtherSessions: true })`.
  `revokeOtherSessions: true` es importante: cerrar las demás sesiones al cambiar la contraseña.
- **Reposición por el administrador:** botón en la tarjeta de cada miembro de la sección
  «Accesos del hogar» (`settings/+page.svelte:89-120`), que llame a
  `auth.api.setUserPassword` del plugin `admin` seguido de `revokeUserSessions`. Reutilizar la
  confirmación por palabra que ya existe para revocar (`settings/+page.svelte:76`).

### Paso 7 — Ajustes de despliegue que afectan al acceso

- Cambiar `@sveltejs/adapter-node` por `@sveltejs/adapter-vercel` en `apps/web/svelte.config.js:1`.
- Conectar `DATABASE_URL` y `DATABASE_AUTH_URL` al **pooler de Supabase en modo transacción**
  (puerto 6543): las funciones sin estado abren y cierran conexiones sin parar. El código es
  compatible, porque `set_config(..., true)` y `set local` viven siempre dentro de un `begin`
  explícito (`app-user.server.ts:30-31`, `packages/server/src/database.ts:28-29`).
- `BETTER_AUTH_URL` y el `rpID` de una futura passkey deben apuntar al dominio definitivo, no a
  una URL de previsualización de Vercel.
- Mantener `ALLOW_SYNTHETIC_DATA_ONLY` **sin definir o a `false`** en producción, y comprobar que
  el banner de datos sintéticos (`hooks.server.ts:17`) no aparece.

### Paso 8 (opcional, después) — Passkeys

`pnpm add @better-auth/passkey@1.6.26` en `apps/web`, `passkey({ rpID, rpName: 'Casa Clara', origin })`
en la configuración, migración, un `createAuthClient` con `passkeyClient()` —el primero del
proyecto— y dos botones: «Entrar con huella» en la pantalla de acceso y «Añadir este dispositivo»
en Ajustes. La contraseña sigue siendo el camino principal; la passkey es un atajo.

---

## 9. Riesgos de seguridad por camino

**Comunes a todos.** La revocación instantánea del control 3
(`docs/security/security-baseline.md:15`) **se conserva en todas las opciones**, porque no vive en
el proveedor de identidad sino en la RLS (`0005_rls.sql:70-77`) y en la recomprobación de cada
transacción (`packages/server/src/database.ts:36-44`). El único modo de perderla sería que un
cambio de proveedor alterase el `user_id` guardado en `app.user_profiles` sin remapear las
membresías: entonces la revocación miraría filas que ya no corresponden a nadie. **Cualquier
migración de proveedor debe llevar una prueba que verifique que revocar la membresía de un usuario
lo deja fuera en la petición siguiente.**

**Opción A (contraseña).** Contraseñas débiles o compartidas entre los tres; contraseña provisional
dictada en voz alta y nunca cambiada (mitigable forzando el cambio en el primer acceso); ausencia
de segundo factor. Riesgo asumible para tres personas de una casa, pero exige el limitador con
almacenamiento en base de datos: sin él, en Vercel cada función arranca con el contador a cero y
el límite es decorativo. Además, `disableSignUp: true` es obligatorio (§1.5).

**Opción B (passkeys).** Riesgo residual muy bajo en el acceso. El riesgo se desplaza a la cuenta
de Apple o de Google que sincroniza las passkeys: quien controle esa cuenta controla el acceso a
Casa Clara. Y si alguien tiene solo una passkey sin sincronizar y pierde el móvil, queda fuera
hasta que un administrador le reponga la contraseña — otra razón para no quitar nunca ese camino.

**Opción C (Supabase Auth).** El riesgo real es el de la migración: remapear identificadores sobre
`app.household_memberships` y `app.audit_events` es exactamente el tipo de operación que rompe
trazabilidad en silencio. Añade además una segunda superficie de sesión (JWT + refresh token en el
cliente) sobre la cookie actual, y hay que recordar que **los endpoints de recuperación de
contraseña de GoTrue siguen activos aunque se desactive la confirmación de correo**: si quedan
expuestos, son una vía de envío de correo que creíamos cerrada.

**Opción D (enlace mágico).** El correo se convierte en la llave maestra: quien entre en la bandeja
de entrada entra en la casa. Añade un tercero al camino crítico del acceso y hace que un fallo de
DNS o de reputación de dominio deje a la familia fuera de su propia aplicación.

---

## Fuentes

- [Send emails with custom SMTP — Supabase Docs](https://supabase.com/docs/guides/auth/auth-smtp)
- [General configuration — Supabase Docs](https://supabase.com/docs/guides/auth/general-configuration)
- [Password-based Auth — Supabase Docs](https://supabase.com/docs/guides/auth/passwords)
- [Pricing & Fees — Supabase](https://supabase.com/pricing)
- [Supabase Free Tier Limits 2026 — Automation Atlas](https://automationatlas.io/answers/supabase-free-tier-limits-2026/)
- [Passkey plugin — Better Auth](https://better-auth.com/docs/plugins/passkey)
- [Admin plugin — Better Auth](https://better-auth.com/docs/plugins/admin)
- [Username plugin — Better Auth](https://better-auth.com/docs/plugins/username)
- [Rate limiting — Better Auth](https://www.better-auth.com/docs/concepts/rate-limit)
- [Email & Password — Better Auth](https://www.better-auth.com/docs/authentication/email-password)
- [New Free Tier — Resend](https://resend.com/blog/new-free-tier)
- [Resend Free Tier Explained (2026) — Automation Atlas](https://automationatlas.io/answers/resend-free-tier-explained-2026/)
- [Brevo Free Plan: Complete Guide (2026) — Tajo](https://www.tajo.io/blog/brevo-free-plan-guide/)
- [Cross Device Passkey Sync Explained — MojoAuth](https://mojoauth.com/blog/cross-device-passkey-sync-icloud-google-1password)
- [What happens when your passkey device is lost? — Authsignal](https://www.authsignal.com/blog/articles/what-happens-when-your-passkey-device-is-lost-understanding-recovery-and-device-sync)
