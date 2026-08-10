# Personal y contratos: varias empleadas de verdad

Qué hace falta para que en Casa Clara pueda trabajar más de una persona, para que
la administración vea de un vistazo **quién trabaja hoy en la casa y quién
trabajó antes** con sus contratos, y para que **el alta de una cuenta se haga
desde la aplicación** en lugar de un guion que lee un JSON de fuera del
repositorio.

Decisión del propietario, literal:

> «Prepara un plan para implementarlo bien y que el admin pueda ver todos los
> empleados activos y anteriores y los contratos asociados además de poder darles
> acceso a la app creando sus cuentas (asociadas a ese contrato).»

Documentos hermanos: [acceso-produccion.md](despliegue/acceso-produccion.md)
(cómo se entra hoy), [opciones-de-acceso.md](despliegue/opciones-de-acceso.md)
(por qué sin correo) y [alta-de-hogar.md](despliegue/alta-de-hogar.md).

---

## 0. Lo que ya estaba roto y va primero

El modelo de datos **siempre** admitió varias empleadas: `employment_agreements`
tiene un índice único `(household_id, employee_membership_id) WHERE status =
'active'`, es decir, **un acuerdo activo por persona**, no por hogar. Lo que no
lo admitía era la sesión.

`resolveAppUser` leía el rol y el identificador de membresía de
`memberships.rows[0]` —la primera membresía por antigüedad— y los pegaba a la
identidad. A partir de ahí todo el servidor operaba con ese papel único: las
capacidades del AppShell, el 403 de las rutas por capacidad, el traspaso
operativo, el expediente laboral y el identificador con el que se firma el
snapshot crítico.

Con un hogar y una empleada no se notaba. Con dos hogares es una escalada de
privilegios en un sentido y una denegación en el otro; y el identificador de
membresía tenía el mismo defecto por otro lado, porque el expediente compara
`agreement.employeeMembershipId` con el de quien mira para decidir si un acuerdo
es «suyo».

**Hecho.** `DemoUser` perdió `role`, `membershipId` y `householdIds`, y ganó
`memberships`: una entrada por hogar vivo. El rol se pide para un hogar concreto
con `membershipIn(user, householdId)` (`src/lib/auth/membership.ts`) y el hogar
es un argumento obligatorio. Revertirlo no compila. Rejas:
`apps/web/tests/membership.test.ts` y `apps/web/tests/app-user.integration.test.ts`
(contra Postgres real bajo RLS, en los dos órdenes de antigüedad).

---

## 1. Qué hay ya y qué falta

### Ya está

| Pieza | Dónde |
|---|---|
| Varias membresías por hogar, con `starts_at`, `expires_at` y `revoked_at` | `app.household_memberships` (0001) |
| Revocación instantánea por RLS (cada petición reevalúa la membresía) | `memberships_discover_own`, `withAuthorizedTransaction` |
| Un acuerdo activo **por persona** y su historial versionado append-only | `app.employment_agreements`, `app.agreement_versions` (0002) |
| Alta y apilado de versiones desde la interfaz | `/h/{id}/employment/acuerdo` |
| Candidatas sin acuerdo activo, ya en plural | `loadAgreementAdmin` |
| Caducar y revocar accesos, reponer contraseñas | `/h/{id}/settings` |

### Falta

1. **Una pantalla de personal.** Hoy la administración ve *accesos* (una lista
   plana de membresías en Ajustes) y *acuerdos* (una lista de contratos en la
   pantalla del acuerdo). No ve **personas con su historia**: quién está, quién
   estuvo, desde cuándo, con qué contrato y con cuál antes.
2. **`loadEmploymentOverview` mira un solo acuerdo.** La consulta hace
   `order by (status = 'active') desc, starts_on desc limit 1`: con dos empleadas
   la pantalla de Pagos enseña el expediente de una sola, y a la familia le
   enseña el de la que salga primero. Para la empleada es correcto (la RLS solo
   le deja ver el suyo); para la administración, no.
3. **El alta solo existe fuera de la aplicación.** `seed-household-accounts.mjs`
   necesita consola, tres variables de entorno y un JSON fuera del repositorio.
   No sirve para el día a día.
4. **La RLS no deja crear el perfil de otra persona.** `user_profiles` solo tiene
   `user_profiles_self_insert` (`user_id = app.current_user_id()`): una
   administradora **no puede** insertar la fila de perfil de quien va a entrar.
   Es el hueco de esquema que obliga a la migración.
5. **No hay obligación de cambiar la contraseña inicial.** Se entrega en persona
   y se confía en que se cambie; nada lo comprueba.

---

## 2. Esquema: migración 0030

Una sola migración, y pequeña. Todo lo demás ya existe.

```
0030_personal_y_altas.sql
```

1. **`app.user_profiles.must_change_password boolean NOT NULL DEFAULT false`.**
   La contraseña inicial la teclea la administración y viaja de boca a boca: la
   persona tiene que cambiarla en su primera entrada. La marca vive en el
   esquema `app` (no en el de identidad) porque es una regla de la casa, no de
   Better Auth, y porque así viaja en la misma consulta que ya lee el perfil:
   cero peticiones extra.

2. **Política `user_profiles_admin_insert`.** `family_admin` con contexto
   completo puede insertar filas de perfil. No puede exigirse en el `WITH CHECK`
   que exista ya una membresía en su hogar, porque en el alta el perfil se
   escribe **antes** que la membresía. La fila suelta es inerte: sin membresía no
   abre ninguna puerta, y la membresía sigue exigiendo
   `tenant_context_matches(household_id)`.

3. **Política `user_profiles_admin_update`.** Para renombrar y para poner la
   marca de cambio de contraseña al reponerla. A diferencia de la anterior, esta
   sí exige que la persona tenga membresía en el hogar en contexto (es la misma
   condición que ya usa `user_profiles_admin_read`).

4. **Disparador `user_profiles_password_flag_guard`.** La marca solo puede
   **encenderse** bajo un contexto `family_admin`, y solo puede **apagarla** la
   propia persona. Sin él, la RLS de `user_profiles_self_update` —que existe
   desde 0005 y da permiso sobre la fila entera— dejaría que quien tiene que
   cambiar la contraseña se quitase la obligación de encima. Es defensa en
   profundidad: hoy el único código que apaga la marca es el que acaba de
   cambiar la contraseña de verdad.

**No hace falta nada más.** Ni tabla de «empleadas», ni columna de estado: el
personal son las membresías cuyo papel es `employee_live_in` o `helper`, y su
historia son sus acuerdos. Inventar una tabla paralela sería duplicar la verdad.

---

## 3. Servidor

### 3.1 `src/lib/server/staff.server.ts` (nuevo)

`loadStaffOverview(user, householdId)` — una transacción autorizada, gate
explícito de `family_admin` (redundante con la RLS a propósito: esta vista o es
completa o no es, como `loadAccessOverview`), tres consultas:

- **Personas**: membresías con papel `employee_live_in` o `helper`, con nombre
  de perfil, `starts_at`, `expires_at`, `revoked_at` y si tiene la contraseña
  pendiente de cambio.
- **Acuerdos** de esas membresías: estado, `starts_on`, `ends_on`.
- **Versiones** de esos acuerdos: número, fecha de efecto, salario, jornada,
  vacaciones y motivo.

Y una función pura que reparte versiones en acuerdos y acuerdos en personas, y
que decide el estado de cada quien:

| Estado | Cuándo | Qué se lee en pantalla |
|---|---|---|
| `trabajando` | membresía viva y acuerdo activo | «Trabaja en la casa» |
| `sin_contrato` | membresía viva y ningún acuerdo activo | «Tiene acceso, sin contrato en vigor» |
| `caduca` | membresía viva con `expires_at` futuro | «Hasta el …» |
| `anterior` | membresía revocada o caducada, o acuerdo terminado | «Trabajó aquí» |

El estado se calcula con el reloj de la base (`statement_timestamp()`), el mismo
contra el que la RLS decide, no con el del proceso Node.

### 3.2 `loadEmploymentOverview`: de un acuerdo a la persona que se mira

Cambio mínimo y honesto, en dos pasos:

1. La consulta acepta un `employeeMembershipId` opcional. Sin él conserva el
   comportamiento de hoy (el acuerdo más relevante), que es exactamente lo que
   la empleada necesita: la RLS solo le enseña el suyo.
2. La pantalla de Pagos, para quien administra, recibe ese identificador por
   query string (`?de=<membershipId>`) desde Personal, y un selector de persona
   cuando hay más de un acuerdo activo.

Queda **fuera de esta entrega** (ver §6): es un cambio en una pantalla grande y
con dinero dentro, y merece su propio trabajo con sus propias pruebas.

### 3.3 `src/lib/server/staff-hire.server.ts` (nuevo): el alta

El alta toca **dos bases de datos** que no comparten transacción: la de
identidad (Better Auth) y la de la aplicación. El orden y la compensación son la
parte delicada:

1. Comprobar en la base de la aplicación, bajo RLS y dentro de una transacción
   autorizada, que quien pide es `family_admin` de **este** hogar. Si no, se
   acaba aquí y no se ha creado nada en ningún sitio.
2. Crear la identidad con `auth.api.createUser` (plugin `admin`), pasando la
   cabecera de la sesión: Better Auth vuelve a comprobar por su cuenta que quien
   llama es administrador. El alta por HTTP (`sign-up`) sigue cerrada en todos
   los entornos; esto no la reabre.
3. En **una sola transacción** de la base de la aplicación: `user_profiles`
   (con `must_change_password = true`), `household_memberships` y —si se está
   dando de alta a una empleada con contrato— `employment_agreements` con su
   `agreement_versions` versión 1, reutilizando `createAgreement`.
4. Si el paso 3 falla, **borrar la identidad recién creada**. Una cuenta que
   puede entrar y no tiene membresía no entra a ningún sitio (la RLS la deja
   fuera y `resolveAppUser` devuelve null), pero deja un nombre de usuario
   ocupado y una fila huérfana; se limpia.

La contraseña inicial la genera el servidor con el mismo alfabeto dictable del
guion (cuatro grupos de cinco, sin caracteres que se confundan al dictar) y se
enseña **una sola vez** en la respuesta de la acción, para leerla en voz alta.
No se guarda en ningún sitio, no viaja por correo —no hay correo— y no se puede
volver a ver: si se pierde, se repone desde Ajustes, que es el camino que ya
existe.

El alta **no puede crear una administradora**, y es deliberado: los papeles que
ofrece son `employee_live_in` y `helper`, y el papel de Better Auth que escribe
es siempre el de miembro. Quien administra la casa —y puede reponer contraseñas
ajenas— se sigue dando de alta con el guion, con las manos en la consola.

### 3.4 Obligación de cambiarla

- `resolveAppUser` lee `must_change_password` en la consulta que ya hace y lo
  pone en la identidad.
- El hook del servidor, después de resolver la identidad: si la marca está
  encendida y la ruta pedida es de hogar y no es «Tu acceso», redirige a «Tu
  acceso». No se bloquea `/api/auth` (haría falta para salir) ni la propia
  pantalla de la contraseña.
- La acción `changePassword` de `/h/{id}/account`, tras cambiarla de verdad,
  apaga la marca. Es el **único** sitio que la apaga.
- Reponer la contraseña de alguien desde Ajustes vuelve a encenderla: la que
  entrega la administración es tan provisional como la del alta.

### 3.5 Revocación: lo que NO puede cambiar

La revocación instantánea funciona hoy porque **cada petición** vuelve a
resolver la membresía bajo RLS: `memberships_discover_own` excluye revocadas y
caducadas, y `withAuthorizedTransaction` repite la comprobación con el reloj de
la base. No hay caché de sesión con el rol dentro, y no la va a haber.

El alta no introduce ningún atajo: la cuenta nueva no queda «autorizada» en
ninguna parte más que en su fila de membresía. La prueba de integración del
punto 0 ya fija esto (`una membresía revocada deja de existir en la identidad`)
y la del alta lo repite de extremo a extremo: dar de alta, entrar, revocar,
dejar de entrar.

---

## 4. Interfaz

### 4.1 `/h/{id}/personal` (nueva ruta, capacidad `access.manage`)

Una lista de personas, no de filas de base de datos. Cada una:

- Nombre, papel en la casa y estado en lenguaje llano.
- Desde cuándo está (y hasta cuándo, si hay fecha).
- Sus contratos, el vigente arriba y los anteriores debajo, cada uno con su
  periodo y sus versiones (fecha de efecto, salario, jornada, vacaciones y el
  motivo que se escribió al pactarla).
- Aviso si tiene la contraseña inicial sin cambiar.

Separadas en dos grupos con encabezado propio: **quien trabaja hoy en la casa** y
**quien trabajó antes**. Sin cifras agregadas de ningún tipo: no hay un «total de
nóminas» ni un «coste del mes», porque esta pantalla no es de contabilidad y un
número así, mal entendido, es peor que ninguno.

**No entra en la barra de navegación.** El grafo inicial de Hoy tiene 34 bytes
de margen sobre 120.000 y una entrada más en `AppShell.svelte` no cabe: el
AppShell está dentro de ese grafo. Personal se alcanza desde **Ajustes del
hogar** —donde ya se gestionan los accesos— y desde la pantalla del acuerdo.
Cuando se libere presupuesto (tarea «Liberar bytes del arranque de Hoy») entra en
la hoja de «Más», junto a Ajustes.

### 4.2 Alta desde `/h/{id}/personal`

Un formulario liso, no un asistente de varios pasos ni una sección que se abre
y se cierra:

- Nombre visible, nombre de usuario, correo (identificador, nunca buzón) y papel.
- Una casilla, marcada por defecto, para registrar el contrato en el mismo acto:
  fecha de inicio, salario mensual, jornada semanal, vacaciones anuales y
  motivo. Sin marcar, se crea solo el acceso y las condiciones se pactan cuando
  toque (queda en estado «tiene acceso, sin contrato en vigor», que la pantalla
  dice tal cual). La primera versión entra en vigor el día que empieza el
  contrato: en un alta no hay historia previa que respetar, y pedir dos fechas
  para decir lo mismo solo invita a teclear una mal.
- El trabajo extra y los complementos **no** se pactan aquí: se apilan luego
  como versión desde El acuerdo, porque lo pactado no se reescribe.
- **Sin JavaScript**: `form action`, envío normal y recarga de la página, que
  además deja el listado de arriba ya con la persona nueva. Dar de alta es un
  acto deliberado que se hace contra el servidor o no se hace; no pasa por la
  cola offline, igual que el cambio de contraseña o el pacto de condiciones.

Al terminar, la pantalla enseña usuario y contraseña en grande y monoespaciado,
con la advertencia de que no vuelve a mostrarse y de que se entrega en persona.

Un detalle que parece un descuido y no lo es: el desplegable del papel es el
único campo que **no** recuerda lo tecleado cuando el alta se rechaza. Marcar la
opción elegida obliga a Svelte a traer una primitiva que ninguna otra pantalla
usa, y esa primitiva vive en el trozo compartido que Hoy carga al arrancar:
costaba 110 bytes de los 34 que quedan de presupuesto. Volver a elegir entre dos
opciones sale más barato.

---

## 5. Orden de ejecución

| # | Paso | Estado |
|---|---|---|
| 1 | Rol y capacidades del hogar de la URL, con sus pruebas | **hecho** |
| 2 | Migración 0030 (marca de contraseña, políticas de perfil, disparador) | **hecho** |
| 3 | `loadStaffOverview` + pruebas de integración bajo RLS | **hecho** |
| 4 | Pantalla `/h/{id}/personal` (lectura) y enlaces desde Ajustes y Acuerdo | **hecho** |
| 5 | Alta desde la aplicación + contraseña obligatoria + pruebas | **hecho** |
| 6 | Pagos por persona (`?de=`) y selector cuando hay más de un acuerdo | pendiente |
| 7 | Manual de usuario y capturas | pendiente |

El orden no es negociable en los tres primeros: sin el paso 1, cualquier pantalla
nueva se construye sobre un rol que puede no ser el de quien mira; sin el 2, el
alta no puede escribir el perfil de nadie.

---

## 6. Lo que queda fuera, y por qué

- **Pagos por persona.** `loadEmploymentOverview` sigue enseñando un solo
  acuerdo. Para la empleada es correcto hoy y siempre (la RLS solo le da el
  suyo). Para la administración con dos empleadas, la pantalla de Pagos enseña
  el expediente de una sola: **es el hueco conocido que queda abierto**. El
  arreglo es el §3.2 y es un trabajo propio, porque toca la pantalla con más
  dinero dentro de la aplicación.
- **Entrada en la barra de navegación.** Bloqueada por el presupuesto de Hoy
  (§4.1).
- **Empleada sin cuenta.** Hoy toda membresía cuelga de una identidad de Better
  Auth: no se puede registrar el contrato de alguien que no va a usar la
  aplicación. No ha hecho falta todavía; si hiciera falta, el sitio es una
  identidad de perfil sin cuenta de credenciales, no una tabla nueva.
- **Segunda administradora obligatoria.** El guion avisa cuando solo hay una; la
  pantalla de alta ni siquiera puede crear administradoras (§3.3). Dar de alta a
  la segunda sigue siendo cosa del guion y del runbook.
- **La puerta de la contraseña provisional no cubre `/api`.** El hook bloquea
  las pantallas del hogar, no las rutas de datos: no enseñan nada que esa
  persona no pueda ver de todos modos, y bloquearlas rompería la propia pantalla
  a la que se la está mandando.
