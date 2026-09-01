# Operaciones de administración

Para cada operación: **(a) por dónde se hace**, **(b) qué rol hace falta**,
**(c) qué NO hay que hacer**. El apartado (c) es el que importa.

Las rutas son literales. `<hogar>` es el UUID del hogar, que va siempre en la
URL. Los ejemplos son inventados.

> **Antes de nada**: lee [las cuatro reglas](SKILL.md#las-cuatro-reglas-que-no-se-rompen).
> La pantalla antes que el SQL, siempre.

---

## Hogares

**(a) Por dónde.** No hay pantalla. Un hogar nace **sólo** con
`apps/web/scripts/seed-household-accounts.mjs`, que lo crea a partir del bloque
`household` del JSON externo (`slug` + `displayName`) junto con las primeras
personas. Procedimiento completo en
[referencia-instalacion.md](referencia-instalacion.md#alta-de-un-hogar-nuevo).

**(b) Rol.** Ninguno de la aplicación: se ejecuta con el rol **propietario** de
la base, por fuera de la RLS.

**(c) Qué NO hacer.**

- **No crees hogares con `INSERT`.** El guion crea a la vez el hogar, los
  perfiles y las membresías, y las tres cosas tienen que existir para que nadie
  quede con identidad sin membresía (una cuenta así no entra a ningún sitio pero
  ocupa el nombre de usuario).
- **No supongas que hay una pantalla para cambiar de hogar.** El hogar activo se
  deduce de la URL; tras entrar, `/` sólo redirige de cortesía al primero de la
  lista de membresías.
- **Da de alta siempre dos `family_admin`.** Es la red de recuperación de
  contraseñas: si sólo hay una y la pierde, no queda quien se la reponga.

---

## Personas, cuentas, roles y caducidad

### Dar de alta a alguien que va a trabajar en la casa

**(a) Por dónde.** `/h/<hogar>/personal` → formulario de alta (acción `hire`).
Crea **identidad, membresía y —si se pactan en el mismo acto— contrato con su
primera versión**. Devuelve una contraseña generada que se enseña **una sola
vez**, para leerla en voz alta.

**(b) Rol.** `family_admin` (capacidad `access.manage`).

**(c) Qué NO hacer.**

- **Esta pantalla NO da de alta administradoras.** Sólo puede dar
  `employee_live_in` y `helper` (`HIREABLE_ROLES` en
  `apps/web/src/lib/server/staff-hire.server.ts`). Quien administra se sigue
  dando de alta con el guion, deliberadamente.
- **No cierres la pantalla sin apuntar la contraseña.** No se guarda en ninguna
  parte y no hay forma de volver a verla; habría que reponerla.
- **No des de alta a alguien dos veces.** El alta toca dos bases que no comparten
  transacción (identidad y aplicación); si el paso de la aplicación falla, el
  guion borra la identidad recién creada, pero **el nombre de usuario queda
  ocupado**.

### Dar de alta administración (o el alta inicial del hogar)

**(a) Por dónde.** `apps/web/scripts/seed-household-accounts.mjs --config <json>`.
Admite `--dry-run` (no escribe nada) y `--reset-passwords` (repone también las
contraseñas de quien ya existe). Sin banderas **nunca toca una contraseña en
marcha**: repetirlo es inofensivo.

**(b) Rol.** Propietario de la base. Necesita `DATABASE_AUTH_URL`,
`SEED_DATABASE_URL` y `BETTER_AUTH_SECRET`.

**(c) Qué NO hacer.**

- **`DATABASE_AUTH_URL` tiene que ser el rol `casa_clara_auth_login`** (nombre
  legado del proyecto anterior; ver
  [docs/despliegue/identificadores-legado.md](../../../docs/despliegue/identificadores-legado.md)),
  cuyo `search_path` es `casa_auth`. Con el rol propietario, Better Auth crea sus
  tablas en `public`: **el guion dice que ha ido bien e imprime las contraseñas,
  y luego nadie puede entrar** (401 para todos). Comprobado. Se detecta así:

  ```sql
  select table_schema, table_name from information_schema.tables
   where table_name in ('user','session','account');
  -- tienen que estar en casa_auth, no en public
  ```

- **No dejes la salida en pantalla.** Trae las contraseñas. Redirígela a un
  fichero fuera del repositorio en modo `600`.
- **No metas el JSON del hogar en Git.** Nombres, importes y horarios viven
  fuera.

### Reponer la contraseña de otra persona

**(a) Por dónde.** `/h/<hogar>/settings` → acción `resetMemberPassword`. Pide
escribir una palabra de confirmación. Al reponerla, **revoca todas las sesiones**
de esa persona.

**(b) Rol.** `family_admin`.

**(c) Qué NO hacer.** No toques la tabla `casa_auth.account` a mano: la
contraseña va cifrada con el formato de Better Auth y un hash escrito a mano deja
a la persona fuera. Si quien administra pierde **su propia** contraseña, el
procedimiento está en
[docs/despliegue/acceso-produccion.md](../../../docs/despliegue/acceso-produccion.md)
— y por eso hacen falta dos administradoras.

### Cambiar la propia contraseña y los avisos

**(a) Por dónde.** `/h/<hogar>/account` («Tu contraseña y tus avisos»).

**(b) Rol.** Cualquiera, incluido `viewer`. Es deliberado: tu contraseña es tuya
sea cual sea tu papel, y nadie de la casa puede ver si tienes los avisos
encendidos.

### Caducidad y retirada de accesos

**(a) Por dónde.** `POST /api/v1/sync`, agregado `membership`, acciones
`set_expiry` (con `expiresAt`, o `null` para quitar la caducidad) y `revoke`.
Los controles viven en `/h/<hogar>/settings`.

**(b) Rol.** `family_admin` (`access.manage`).

**(c) Qué NO hacer.** No borres la fila de `app.household_memberships`. Retirar
un acceso es `revoke`, que deja constancia; un `DELETE` se lleva por delante la
autoría de todo lo que esa persona escribió.

---

## Contratos

Lee **entero** [docs/despliegue/alta-de-hogar.md §3](../../../docs/despliegue/alta-de-hogar.md)
antes de dar de alta un contrato. Es la operación con menos marcha atrás del
sistema.

### Alta de un contrato

**(a) Por dónde.** Dos vías que escriben exactamente lo mismo:

| Vía | Cuándo | Qué te da | Qué no |
|---|---|---|---|
| **Pantalla** `/h/<hogar>/employment/acuerdo` → «Dar de alta un acuerdo» | Lo normal | Autoría real, RLS, el historial delante | **Ni ensayo ni deshacer** |
| **Guion** `packages/db/scripts/seed-employment-agreement.mjs --config <json>` | Cuando quieres ensayar antes | `--dry-run` de verdad (hace `ROLLBACK`) e idempotencia por contenido | Corre por fuera de la RLS, con el rol propietario |

También se pactan en el mismo acto al contratar desde `/h/<hogar>/personal`.

**(b) Rol.** `family_admin` (`agreement.write`). El guion, propietario de la base.

**(c) Qué NO hacer.** Esto es lo caro:

- **Nunca des de alta un contrato sin catálogo de trabajo extra.** Una versión
  sin conceptos es un **acuerdo mudo**: quien trabaja ve «Sin trabajo extra
  disponible» y no puede registrar ni una jornada. Y **no se arregla hacia
  atrás** — las versiones y su catálogo son inmutables, y una versión nueva sólo
  rige **desde su fecha**: los días intermedios se quedan sin nada para siempre.

  El guion **se niega a escribir sin `extraWorkTypes`** y sale con código 1.
  Verificado. Si de verdad no se pacta ninguno, escríbelo:
  `"extraWorkTypes": []`.

  > **Nota histórica.** Este guion **sí** creó una vez un acuerdo mudo, en
  > silencio y con éxito aparente. Ese fallo está corregido: hoy la ausencia de
  > catálogo aborta antes de tocar la base. Si encuentras una nota que diga «no
  > uses nunca `seed-employment-agreement.mjs`», está desfasada — pero la
  > pantalla sigue siendo la vía normal.

- **No envíes el formulario sin repasarlo.** No hay ensayo ni deshacer. Enviarlo
  dos veces falla con «Esa persona ya tiene un acuerdo activo en este hogar»: no
  es un error, es el índice `one_active_agreement_per_employee_idx` haciendo de red.
- **No firmes el contrato con rol `helper`.** El esquema lo admite, pero la
  política `extra_work_types_employee_read` (0021) sólo enseña el catálogo a
  `employee_live_in`: **un contrato con `helper` nace mudo**.
- **No hay ninguna ruta para cerrar o anular un contrato.** No existe en el
  código. La única salida a un alta equivocada es apilar una versión nueva, que
  no repara los días anteriores.

### Versión nueva (subida de salario, tarifa nueva, horario distinto)

**(a) Por dónde.** `/h/<hogar>/employment/acuerdo` → apilar versión, con autoría
y motivo.

**(b) Rol.** `family_admin`.

**(c) Qué NO hacer.**

- **No lo intentes con el guion.** Repetirlo con datos distintos **aborta** a
  propósito, y distingue si cambiaron las condiciones o una tarifa del catálogo.
  El guion sólo da el alta.
- **No reescribas `app.agreement_versions`.** El disparador
  `agreement_versions_append_only` lo rechaza, y con razón.
- **Una versión nueva sólo puede entrar en vigor DESPUÉS de la anterior.** No se
  arreglan días pasados.

### Horario

Desde la 0025 el horario va a **dos sitios**: la frase de siempre
(`terms.schedule`) y el dato consultable (`app.agreement_schedules` y sus días).

**(c) Qué NO hacer.**

- **No añadas un horario a un contrato ya dado de alta reenviando el guion**:
  aborta. Es una versión nueva, desde la pantalla.
- **Si el horario no cuadra con la jornada semanal contratada, se avisa pero se
  guarda.** Ni el guion ni la pantalla deciden cuál de las dos condiciones está
  mal. El aviso queda a la vista de la casa y de quien trabaja — no lo ignores.
- **Si `schedule` es una cadena en vez de un objeto**, el contrato queda **sin
  horario consultable** y a la empleada no se le enseña ninguna sección de
  horario. De una frase no se deduce un horario sin inventar.

### Trabajo extra

**(a) Por dónde.** `POST /api/v1/sync`, agregado `extra_work`. Quien trabaja lo
registra desde la pestaña **Conceptos** de su Contrato
(`/h/<hogar>/employment/conceptos`, `work.register.self`); la administración lo
acepta ahí mismo, lo marca como hecho, lo resuelve (`money` o `time_off`), lo
rechaza o lo cancela — cada transición con motivo. Los gastos con justificante y
los conceptos apuntados a mano viven en esa misma pestaña.

**(b) Rol.** `employee_live_in` para registrar lo suyo; `family_admin` para
`work.confirm` y resolver. La administración puede además registrar y resolver en
el mismo acto (`resolveNow`).

**(c) Qué NO hacer.**

- **No inventes la tarifa en el comando.** La congela el concepto del catálogo de
  la versión vigente **el día trabajado** (`extra_work_events_type_freeze`), nunca
  el payload.
- **No te saltes la máquina de estados con `UPDATE`.** Ni siquiera `resolveNow` lo
  hace: encadena las transiciones que hagan falta, cada una firmada.
- **Desactivar las horas sueltas es no escribirlas.** No hay bandera: si no creas
  ningún concepto `per_hour`, no existe ninguna tarifa horaria en ninguna parte.
  Es más limpio que dejarla escrita y desactivada.

### Complementos

Conceptos periódicos del acuerdo (`app.recurring_supplements`). El campo
`addsToPay` decide si **suma a la transferencia** (`true`) o si **lo paga la casa
aparte** (`false`); lo segundo consta en las condiciones y **no toca el total del
mes**.

**(c) Qué NO hacer.** No uses un complemento para un apunte de un solo mes: para
eso están los conceptos apuntados a mano (abajo).

### Conceptos apuntados a mano

**(a) Por dónde.** `POST /api/v1/sync`, agregado `manual_adjustment`, acciones
`record` y `void` (migración 0022). `period` es un mes natural (`AAAA-MM`).

**(b) Rol.** `family_admin`.

**(c) Qué NO hacer.** No apuntes importe cero: se rechaza a propósito, porque una
línea muda en la cuenta del mes no ayuda a nadie. Y **no borres un apunte**:
existe `void`, con motivo.

---

## Vacaciones

**(a) Por dónde.** `/h/<hogar>/employment/vacaciones`. Por debajo, `POST
/api/v1/sync`, agregado `leave_request`, acciones `record` (con `startsOn`,
`endsOn` y nota) y `void` (con motivo).

**(b) Rol.** `family_admin` para apuntar y anular. Quien trabaja **ve** su saldo y
su historial pero **no tiene ningún formulario** de apuntar ni de anular.

**(c) Qué NO hacer.**

- **No busques una tabla de saldo: no existe.** Los días **son**
  `annualVacationDays` de la versión vigente. `app.vacation_periods` sólo se
  llena cuando se disfrutan días.
- **El derecho anual no se cambia apuntando días.** Se cambia apilando una
  versión nueva del acuerdo (`set_vacation_entitlement`).
- **Los días son NATURALES**, que es la unidad del contrato. Si el contrato empezó
  a mitad de año, el saldo del primer año sale **prorrateado**, y la pantalla lo
  explica en una línea.

Decisión de fondo: [ADR 0002](../../../docs/adr/0002-vacaciones.md).

---

## Rutinas

**El modelo de cadencia actual** (migraciones 0023 y 0033). La forma anterior
—`frequency` + `intervalCount` + `nextDueOn`— **está retirada y ya no se
traduce**.

**(a) Por dónde.** `/h/<hogar>/routines`. Por debajo, `POST /api/v1/sync`,
agregado `routine`, acciones `upsert`, `complete` y `uncomplete`.

**(b) Rol.** `routine.read` y `routine.toggle` los tienen `family_admin`,
`family_member`, `employee_live_in` y `helper`. **No `viewer`.**

**La cadencia.** `pattern` discrimina la forma, y cada patrón declara exactamente
sus campos y ninguno más:

| `pattern` | Campos | Ejemplo |
|---|---|---|
| `null` | ninguno más | «esto se hace, falta decidir cuándo» |
| `every_n_days` | `anchorOn`, `repeatEvery` (1–366) | cada 15 días |
| `days_of_week` | `anchorOn`, `repeatEvery` (1–12), `weekdays` (ISO 1=lunes…7=domingo) | los lunes y los jueves |
| `day_of_month` | `anchorOn`, `repeatEvery` (1–36), `monthDay` | el día 1 de cada mes |
| `months_of_year` | `anchorOn`, `months` (1–12), `monthDay` | en junio y en diciembre |

Todos admiten `endsOn` opcional, que no puede ser anterior a `anchorOn`.

**(c) Qué NO hacer.**

- **No mandes `frequency` ni `intervalCount` ni `nextDueOn`.** El comando se
  rechaza con `errorCode: routine_cadence_format_retired` — un rechazo honesto, no
  una traducción a ciegas. Verificado. La tabla de traducción vieja no sabía
  expresar «cada 15 días» ni «en junio y en diciembre», así que aplicarla
  escribiría una cadencia que nadie pidió.
- **No escribas `next_due_hint`.** Es **caché derivada** de la regla —una cota
  inferior de la próxima ocurrencia— y la calcula el servidor. Antes se llamaba
  `next_due_on` y el nombre mentía: invitaba a decidir con ella.
- **No escribas `overdue_policy`.** Se **deriva** del patrón en un único sitio.
- **`pattern: null` es un valor de primera clase, no un hueco.** Esa rutina se
  guarda, aparece en Rutinas y **jamás** en Hoy, en el calendario, en el ICS ni en
  los avisos. Verificado: creada una rutina con `pattern: null`, aparece en
  `/routines` y no en `/today`.

Modelo y razones: [docs/rutinas-y-calendario.md](../../../docs/rutinas-y-calendario.md).

---

## Guía de la casa

**(a) Por dónde.** `/h/<hogar>/wiki` (portada), `/h/<hogar>/wiki/<slug>` (una
nota), `/h/<hogar>/wiki/libro` y `/h/<hogar>/wiki/libro/<slug>` (lectura
secuencial), `/h/<hogar>/wiki/progreso` (progreso de lectura).

Por debajo, `POST /api/v1/sync`:

| Agregado | Acción | Para qué |
|---|---|---|
| `wiki_page` | `create` | Nota nueva. Con `spaceSlug` crea el apartado si no existe |
| `wiki_page` | `edit` | Editar (con `summary`, que es el motivo del cambio) |
| `wiki_page` | `set_state` | `status` (`draft` / `published`) y `pinned` |
| `wiki_space` | `create` | Apartado nuevo |
| `wiki_space` | `set_template` / `clone_template` | Plantillas de apartado |

**(b) Rol.** Leer: `content.read` (todos menos `viewer`). **Escribir: `guide.write`,
que sólo tiene `family_admin`.** Es deliberado — la Guía es a la vez el manual de
acogida de quien trabaja aquí. Sin esa capacidad la interfaz no dibuja ningún
control de escritura, y la RLS de `wiki_*` lo impone igualmente (0026).

**«Añade una hoja nueva a la guía»** es un comando `wiki_page` / `create` con
`spaceSlug`, `title`, `bodyMarkdown` y `publish`. Verificado.

**(c) Qué NO hacer.**

- **No publiques un borrador sin querer.** `publish: false` (o `status: draft`) lo
  deja fuera de la lectura del resto de la casa. Un borrador es un borrador.
- **No metas notas por `INSERT`.** Cada edición genera una **revisión** con
  autoría; un `INSERT` a pelo deja la nota sin historial y sin `import_hash`, y
  entonces el importador del manual la ve como ajena y puede duplicarla.
- **No cambies el slug a mano.** Los slugs históricos viven en
  `app.wiki_page_slugs` y sostienen el redirigido 308; reescribirlo rompe los
  enlaces que ya circulan por la casa.
- **Para volcar el manual entero usa el importador**, no la pantalla nota a nota:
  `packages/db/scripts/import-manual.mjs`. Es idempotente por hash de contenido.
  Runbook: [docs/runbooks/importar-manual.md](../../../docs/runbooks/importar-manual.md).

---

## Contactos y emergencias

**(a) Por dónde.** `/h/<hogar>/contacts` y `/h/<hogar>/emergency`. Por debajo,
`POST /api/v1/sync`, agregado `contact`, acciones `upsert` y `archive`.

Campos: `name`, `roleLabel`, `phone`, `kind` (`emergency`, `health`, `home`,
`service`, `school`, `otros`), `featured` y `notes`.

**(b) Rol.** Leer: **todos los cinco roles**, incluido `viewer`. Escribir:
`contact.write` — `family_admin` y `family_member`.

**(c) Qué NO hacer.**

- **No borres contactos: archívalos.** Existe `archive` por eso.
- **No dejes Emergencias sin el 112.** Lo siembra el importador del manual
  (`packages/db/scripts/seed-manual.mjs`); del Anexo G **sólo el 112 trae datos
  reales**, el resto son plantillas que no se siembran a propósito.
- **Emergencias es la única pantalla que nunca da error**: si la base falla se
  pinta igual y dice «no se pudo leer» en vez de servir una maqueta. No cambies
  eso: alguien puede estar mirándola con prisa.

---

## Menú, recetas, alérgenos, comensales y compra

**(a) Por dónde.** `/h/<hogar>/menu` (menú semanal y lista de la compra) y
`/h/<hogar>/recipes` (recetario). Por debajo, `POST /api/v1/sync`, agregados
`menu_slot`, `menu_group`, `menu_template`, `recipe`, `food`, `diner` y
`shopping_item`.

**(b) Rol.** Leer el menú: `menu.read` (todos menos `viewer`). Escribir:
`menu.write` — `family_admin` y `family_member`. El recetario va por
`content.read` / `content.write`.

**(c) Qué NO hacer.**

- **Crear un grupo de comensales NO es idempotente.** Repetir el formulario crea
  otro grupo con el mismo nombre. Comprueba antes si ya está.
- **La plantilla de semana del manual necesita un grupo de comensales vivo.** Si
  el hogar no tiene ninguno, `import-manual.mjs` avisa
  (`sin grupo de comensales vivo: la plantilla … se omite`) y sigue. Crea el grupo
  y **vuelve a pasar el importador**. Verificado.
- **Los alérgenos son los de la UE** (`app.eu_allergens`): no inventes filas
  nuevas, enlaza las que hay.

---

## Calendario y calendarios enlazados

**(a) Por dónde.** `/h/<hogar>/calendar`. Enlazar un calendario externo: botón
«Enlazar un calendario» → etiqueta y URL iCal. La URL **tiene que empezar por
`https://`** (lo exigen el formulario y la base).

Hay además un feed ICS de salida, `/api/v1/ics/<token>`, para suscribir las
rutinas en un calendario externo.

**(b) Rol.** Ver el calendario: `calendar.read` — `family_admin`,
`family_member`, `employee_live_in` y `viewer`. **`helper` no.** Escribir eventos:
`calendar.write` — `family_admin` y `family_member`. **Enlazar calendarios es
sólo de administración**: la política RLS de `app.ics_sources` no lo enseña a
nadie más.

**(c) Qué NO hacer.**

- **La URL del calendario no pasa por el repositorio, ni por una variable de
  entorno, ni por un guion.** Se teclea en la pantalla y viaja a la base. Es una
  dirección privada: quien la tenga ve el calendario entero.
- **No esperes eventos inmediatos.** Queda como `Pendiente de la primera lectura`
  hasta que el trabajo de fondo lo lea. **Sin planificador de cola desplegado, un
  calendario enlazado se queda vacío para siempre** — ver
  [referencia-mantenimiento.md](referencia-mantenimiento.md#el-planificador-de-la-cola).
- **El token del feed ICS es la autorización.** Esa ruta **no pide sesión**. Si se
  filtra, se revoca; no lo pegues en ningún sitio compartido.

---

## Adjuntos y justificantes

**(a) Por dónde.** `POST /api/v1/households/<hogar>/attachments` (subida, desde el
formulario de gastos) y `GET /api/v1/households/<hogar>/receipts/<expenseId>`
(servir el justificante). Los gastos se apuntan con `POST /api/v1/sync`,
`expense.create.self`, y la administración los resuelve (`approved` / `rejected`)
con motivo.

**(b) Rol.** Subir el gasto propio: `employee_live_in` (`expense.create.self`).
Resolver: `family_admin`. Ver un justificante: cualquier miembro, y la RLS filtra
cuál.

**(c) Qué NO hacer.**

- **El depósito es privado SIEMPRE.** Ningún objeto se expone en público, ni por
  URL firmada ni por política de bucket: la aplicación los sirve proxeándolos por
  una ruta autenticada. No lo abras «para depurar».
- **Sin almacén configurado, adjuntar responde 503** con un mensaje veraz —
  verificado. No es un error transitorio: falta configuración. Ver
  [referencia-instalacion.md](referencia-instalacion.md#lo-que-degrada-en-silencio).
- **En producción no hay antivirus.** Vercel + Supabase no tiene dónde correr el
  demonio. Riesgo asumido y cómo reactivarlo:
  [docs/security/adjuntos-sin-antivirus.md](../../../docs/security/adjuntos-sin-antivirus.md).

---

## Avisos push

**Sólo hay tres avisos, y ninguno más**: el recibo del mes a quien trabaja en la
casa, la cuenta del mes por pagar a quien administra, y —desde la migración
0034— «el mes está a punto de acabar», también a quien administra (el
penúltimo día del mes, por la mañana, y solo si queda algún acuerdo activo sin
liquidación cerrada del mes). Recordatorios de tareas, de rutinas, recuentos de
lo hecho o lo pendiente, y avisos por ausencia de acción **están prohibidos**,
y no es una opción apagada: es código que no existe, con pruebas que lo
sostienen. El porqué está en
[docs/notificaciones.md §6](../../../docs/notificaciones.md) (y su enmienda,
§0ter, para el tercero).

**(a) Por dónde.** Cada quien enciende los suyos en `/h/<hogar>/account`. Alta y
baja del dispositivo: `POST` / `DELETE /api/v1/push/subscription`. Además, al
entrar al hogar la aplicación comprueba sola el estado del permiso en ese
dispositivo: si está sin decidir, ofrece un banner propio y descartable
(«Activa los avisos…» + **Activar**); el diálogo del sistema solo aparece tras
tocar ese botón, nunca antes.

**(b) Rol.** Cualquiera, sobre su propio teléfono. **Nadie de la casa puede ver si
otra persona los tiene encendidos**, ni siquiera quien administra.

**(c) Qué NO hacer.**

- **`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT`: las tres o
  ninguna.** Con la pública puesta y la privada a medias, el navegador se
  suscribiría a un servidor que jamás podrá escribirle, y el silencio se leería
  como «está roto» en vez de como «no está configurado».
- **`VAPID_SUBJECT` tiene que ir limpio** (`mailto:` o `https:`, sin espacios ni
  corchetes angulares). Apple contesta 403 `BadJwtToken` a un `sub` sucio, **y
  sólo Apple**: un espacio de más rompe los avisos únicamente en los iPhone de la
  casa.
- **No rotes las claves VAPID por higiene.** Rotarlas invalida **todas** las
  suscripciones a la vez y obliga a volver a suscribir a cada persona con su
  teléfono delante.
- Sin claves, la aplicación funciona **entera** y «Tu cuenta» dice
  «Esta instalación no manda avisos al móvil» en vez de dibujar un interruptor que
  no puede funcionar. Verificado. **Nada vive sólo detrás del push.**

Puesta en marcha: [docs/runbooks/notificaciones-push.md](../../../docs/runbooks/notificaciones-push.md).

---

## Liquidaciones, pagos y el PDF

**(a) Por dónde.** `/h/<hogar>/employment/pagos` — la pestaña **Pagos** del
Contrato, no su portada: ahí viven las cuentas de cada mes, el botón de cerrar,
el de registrar un pago, el de confirmar el cobro y los dos PDF. La portada
(`/h/<hogar>/employment`) resume el mes en curso y enlaza aquí. Por debajo,
`POST /api/v1/sync`:

| Agregado | Acción | Capacidad |
|---|---|---|
| `settlement` | `open` (periodo y vencimiento) | `settlement.close` (`family_admin`) |
| `settlement` | `close` | `settlement.close` (`family_admin`) |
| `settlement` | `confirm_receipt` | `payment.confirm.self` (`employee_live_in`) |
| `payment` | registrar un pago | `payment.register` (`family_admin`) |

Cerrar la cuenta del mes **encola** el trabajo `document.render_receipt`, que
genera el PDF determinista del recibo y lo deja en el depósito privado. Desde
la migración 0035 ese recibo queda además **registrado**
(`app.settlement_receipts`) y **descargable**.

**En Pagos hay dos PDF, y no son el mismo. Conviene saber cuál se está
mirando**, porque si algún día no coincidieran, esa diferencia es la noticia:

| Enlace | Ruta | Cuándo aparece | Qué es |
|---|---|---|---|
| «Descargar el documento de pago (PDF)» | `GET …/settlements/<liquidación>/documento` | Cualquier cuenta que ya no esté abierta | Se **dibuja al momento** a partir de la cuenta viva |
| «Recibo archivado (PDF)» | `GET …/settlements/<liquidación>/receipt` | Cuenta cerrada **y** con su recibo ya registrado | El fichero que **archivó la cola** al cerrar: el mismo que anunció el aviso al móvil, byte a byte |

Los dos los ve quien administra y la persona de ese contrato, y en los dos
**decide la RLS**: quien no debe verlos recibe 404, no un enlace roto.

Cuando no hay recibo archivado, la pantalla dice «Sin recibo archivado: este mes
se cerró antes de que se archivaran los recibos, o acaba de cerrarse y aún está
en la cola», y remite al documento de pago. **No promete una espera a
propósito**: para los meses cerrados antes de la 0035 esa espera no termina
nunca sin el backfill de
[docs/runbooks/planificador-cola.md](../../../docs/runbooks/planificador-cola.md)
§7 — y ese backfill **vuelve a avisar al móvil de cada mes que rehace**, así que
se lee entero antes de lanzarlo. Para un mes recién cerrado, en cambio, el peor
caso son cinco minutos: una vuelta de la cola.

Quien trabaja se descarga **su propio** expediente (PDF + CSV) en
`GET /api/v1/households/<hogar>/employment-export`. Esa ruta es **sólo para
`employee_live_in`**: incluso `family_admin` recibe 403, a propósito. Es
distinta del recibo por liquidación de arriba: aquel es un PDF por mes y por
empleada; este es todo el histórico en un solo export.

**(b) Rol.** Ver: `settlement.read` — `family_admin`, `family_member` y
`employee_live_in`. Cerrar y registrar pagos: sólo `family_admin`. Confirmar que
se ha recibido: sólo quien cobra.

**(c) Qué NO hacer.**

- **Los importes son céntimos en `bigint`.** Nunca decimales, nunca coma
  flotante. `123400` son 1.234,00 €.
- **No toques los libros contables a mano.** `app.*_ledger_entries` son de
  **solo-añadir**: un saldo corregido con `UPDATE` deja de cuadrar con su
  historial y ya nadie sabe cuál de los dos es el bueno. Para corregir un mes
  existen los conceptos apuntados a mano y el `void` con motivo.
- **Si el PDF no aparece, no lo generes a mano.** Es la cola: mira si drena
  ([referencia-mantenimiento.md](referencia-mantenimiento.md#el-planificador-de-la-cola)).
  Con el planificador puesto, el peor caso son cinco minutos.
- **No cierres un mes para «probar».** Cerrar dispara el recibo y el aviso a quien
  cobra.
