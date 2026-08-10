# Alta de un hogar de verdad, de punta a punta

Cómo se pone en pie un hogar real: base de datos vacía → tres personas entrando
con su contraseña, el acuerdo laboral dado de alta, el manual de convivencia
volcado y el calendario enlazado.

El procedimiento está **ensayado entero en local** contra una base de datos que
representa producción, y es el mismo contra Supabase: solo cambian las cadenas
de conexión. Los pasos van en este orden porque cada uno depende del anterior.

> **Los datos del hogar no entran nunca en el repositorio.** Nombres, importes,
> horarios y la URL del calendario viven en un JSON fuera de Git (y fuera del
> entorno del servidor). Todos los ejemplos de este documento son **inventados**.

---

## 0. Qué necesitas antes de empezar

| Cosa | Para qué |
|---|---|
| Una base de datos vacía y su conexión **directa** | `bootstrap` y `migrate` toman cerrojos de sesión; el *pooler* de Supabase no vale |
| El JSON del hogar, fuera del repositorio, en modo `600` | Lo leen los dos guiones de alta |
| `APP_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `AUTH_DB_PASSWORD` | Contraseñas de los roles de ejecución que crea el bootstrap |
| `BETTER_AUTH_SECRET` | Firma de sesiones. Un secreto largo y aleatorio, distinto por entorno |
| Un sitio donde apuntar las contraseñas generadas | Fuera del repositorio, también en `600` |

### El fichero de configuración (ejemplo inventado)

Un solo fichero alimenta el alta de cuentas **y** la del acuerdo:

```json
{
  "household": { "slug": "casa-ejemplo", "displayName": "Casa Ejemplo" },

  "people": [
    { "username": "rosa",  "name": "Rosa",  "email": "rosa@ejemplo.test",  "role": "family_admin" },
    { "username": "nuria", "name": "Nuria", "email": "nuria@ejemplo.test", "role": "family_admin" },
    { "username": "lucia", "name": "Lucía", "email": "lucia@casa.local",   "role": "employee_live_in" }
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
      "from": "08:00",
      "to": "19:00",
      "longBreakMinutes": 120,
      "effectiveHoursPerDay": 8,
      "weekly": "Cinco jornadas de lunes a viernes. Fin de semana libre."
    },
    "extraWorkTypes": [
      { "code": "jornada_extra", "name": "Jornada extra", "unit": "per_shift",
        "rateCents": 5000, "referenceMinutes": 480, "active": true },
      { "code": "media_jornada_extra", "name": "Media jornada extra", "unit": "per_shift",
        "rateCents": 2500, "referenceMinutes": 240, "active": true }
    ],
    "supplements": [
      { "code": "antiguedad", "name": "Complemento de antigüedad",
        "amountCents": 3000, "addsToPay": true }
    ]
  }
}
```

El detalle de cada campo de `people` está en
[acceso-produccion.md §2](acceso-produccion.md). Lo de `agreement`, en el paso 3.

**Dos personas con `family_admin`, siempre.** Es la red de recuperación de
contraseñas: si solo hay una y la pierde, no queda quien se la reponga.

---

## 1. Roles y esquema

```bash
export DATABASE_URL='postgresql://…'          # conexión DIRECTA, rol propietario
export APP_DB_PASSWORD='…'
export WORKER_DB_PASSWORD='…'
export AUTH_DB_PASSWORD='…'

pnpm --filter @casa-clara/db bootstrap        # roles casa_clara_*, esquema casa_auth
pnpm --filter @casa-clara/db migrate          # todas las migraciones, en orden
```

**El bootstrap va antes que las migraciones**, sin excepción: la 0001 ya concede
sobre `casa_clara_app` y `casa_clara_worker`, así que esos roles tienen que
existir. Los roles son **del clúster, no de la base**: si ya existían de otra
instalación, el bootstrap solo les repone la contraseña.

**Qué se verifica.** El bootstrap imprime cuántos roles `casa_clara_*` hay y si
el esquema `casa_auth` está. `migrate` imprime cada fichero aplicado y termina
diciendo cuántos. Volver a ejecutarlo dice `Database is up to date`.

**Ninguna fixture, nunca.** `packages/db/fixtures/` y `seed-demo-users.mjs` son
para entornos sintéticos. Una base de producción no los ve jamás.

---

## 2. Las personas

```bash
export DATABASE_AUTH_URL='postgresql://casa_clara_auth_login:…@…/…'
export SEED_DATABASE_URL="$DATABASE_URL"      # el propietario de las migraciones
export BETTER_AUTH_SECRET='…'

# Ensayo: dice qué haría y no escribe nada
pnpm --filter @casa-clara/web seed:accounts --config /ruta/fuera/del/repo/hogar.json --dry-run

# De verdad. La salida trae las contraseñas: guárdala donde toque, no en pantalla
pnpm --filter @casa-clara/web seed:accounts --config /ruta/fuera/del/repo/hogar.json \
  > /ruta/fuera/del/repo/credenciales.txt
chmod 600 /ruta/fuera/del/repo/credenciales.txt
```

**Qué se verifica.** El guion imprime el identificador del hogar —**apúntalo,
hace falta en el paso 4**— y una línea por persona diciendo si se creó. Las
contraseñas generadas se muestran **una sola vez**: van en cuatro grupos de cinco
caracteres sin letras que se confundan al dictar.

Repetirlo es inofensivo: sin banderas no toca ninguna contraseña en marcha.

---

## 3. El acuerdo laboral

> **Lee esto antes de escribir nada.** El acuerdo se da de alta con DOS partes,
> y ninguna de las dos se corrige después: la versión 1 —salario, jornada,
> vacaciones— y su **catálogo de conceptos**, que dice qué trabajo extra existe
> y a cuánto se paga (`app.extra_work_types`, migración 0021). **Sin catálogo,
> el acuerdo es mudo**: quien trabaja no ve ningún concepto, la tarjeta de
> trabajo extra dice «Sin trabajo extra disponible» y no puede registrar ni una
> jornada.
>
> Y no se arregla hacia atrás. La versión y su catálogo son inmutables
> (disparadores `agreement_versions_append_only` de 0002 y
> `extra_work_types_frozen` de 0021), una versión nueva solo puede entrar en
> vigor **después** de la anterior, y para valorar un día trabajado la base
> exige el concepto de la versión vigente **ese día**
> (`extra_work_events_type_freeze`). Los días entre el inicio del acuerdo y la
> corrección se quedan sin nada **para siempre**.

Hay dos vías, y escriben exactamente lo mismo. Elige según lo que te dé más
tranquilidad:

| Vía | Cuándo | Qué te da | Qué no |
|---|---|---|---|
| **La pantalla** — Pagos → «Administrar el acuerdo» (`/h/<hogar>/employment/acuerdo`) | Lo normal. Una familia sin terminal puede hacerlo sola | Autoría real, RLS, el historial delante y el formulario avisando si el catálogo queda vacío | No tiene ensayo ni es idempotente: enviar dos veces **crea dos cosas** |
| **El guion** `agreement:seed` | Cuando quieres ensayar el alta antes de hacerla | `--dry-run` de verdad (dice qué haría y hace rollback) e idempotencia por contenido | Se ejecuta por fuera de la RLS, con el rol propietario |

### 3.a Desde la pantalla

1. Entra como `family_admin` → **Pagos → «Administrar el acuerdo»**.
2. **Nuevo acuerdo → «Dar de alta un acuerdo»**. Si el botón no aparece, es que
   no hay ninguna empleada interna sin acuerdo activo: da de alta su acceso
   antes (paso 2).
3. Empleada, `El acuerdo empieza el`, `La primera versión rige desde` (lo normal
   es el mismo día), salario mensual, minutos semanales, **días de vacaciones**
   y motivo.
4. **Trabajo extra.** Un bloque por concepto: código en minúsculas
   (`jornada_extra`), nombre, cómo se paga, tarifa, y —en las jornadas— **los
   minutos de referencia, que son obligatorios**. «Se lo permito» marcado.
5. **Complementos**, si los hay. «Quién lo cobra» decide si el importe **suma a
   su transferencia** o **lo paga la casa aparte**; lo segundo consta en sus
   condiciones y no toca el total del mes.
6. **Dar de alta el acuerdo.**

**Repasa el formulario antes de enviarlo.** No hay ensayo, no hay deshacer y la
versión es inmutable. Si envías dos veces, el segundo intento falla con «Esa
persona ya tiene un acuerdo activo en este hogar» — eso no es un error, es el
índice único `one_active_agreement_per_employee_idx` haciendo de red.

### 3.b Desde el guion

```bash
pnpm --filter @casa-clara/db agreement:seed --config /ruta/fuera/del/repo/hogar.json --dry-run
pnpm --filter @casa-clara/db agreement:seed --config /ruta/fuera/del/repo/hogar.json
```

Escribe acuerdo, versión 1 y catálogo en una transacción. Los campos de
`agreement`:

| Campo | Qué es |
|---|---|
| `employeeUsername` | Quién trabaja. **Que sea `employee_live_in`** — ver el §8 sobre `helper` |
| `createdByUsername` | Quién firma por la casa. Opcional: por defecto, la primera `family_admin` |
| `startsOn` | Primer día del acuerdo, `AAAA-MM-DD`. La versión 1 rige desde ese mismo día |
| `monthlySalaryCents` | Salario mensual en céntimos (`123400` = 1.234,00 €) |
| `contractedWeeklyMinutes` | Minutos semanales contratados (`2400` = 40 h) |
| `annualVacationDays` | Días naturales de vacaciones al año (mínimo legal español: 30) |
| `schedule` | Las condiciones de horario. Texto, o campos que el guion redacta |
| `extraWorkTypes` | **Obligatorio.** El catálogo. Lista, posiblemente vacía |
| `supplements` | Opcional. Complementos periódicos |

Cada concepto de `extraWorkTypes`:

| Campo | Qué es |
|---|---|
| `code` | Identidad estable entre versiones: minúsculas, dígitos y `_`, de 3 a 40 caracteres |
| `name` | Cómo se llama en pantalla |
| `unit` | `per_shift` (por jornada), `per_hour` (por hora trabajada) o `fixed_amount` (importe fijo por supuesto) |
| `rateCents` | Tarifa en céntimos. **Obligatorio**, y `null` es un valor legítimo: «pactado sin precio todavía», y entonces ella no lo ve |
| `referenceMinutes` | De cuántos minutos es la jornada. **Obligatorio si `per_shift`**, prohibido si `per_hour` |
| `active` | Opcional, por defecto `true`. Es el permiso: en `false` ella no lo ve por ninguna vía |

Cada complemento de `supplements`: `code`, `name`, `amountCents` (o `null`),
`addsToPay` (**obligatorio**: `true` suma a la transferencia, `false` lo paga la
casa aparte), y opcionalmente `startsOn`, `endsOn` y `active`.

### Sin catálogo, el guion se niega

Si el JSON no trae `extraWorkTypes`, **aborta sin escribir nada** y explica por
qué. No lo rellena por su cuenta ni deja el acuerdo a medias: el fallo que esto
sustituye era silencioso —terminaba con éxito y dejaba el destrozo hecho—, y un
acuerdo mudo no se puede deshacer.

Si de verdad no se pacta ningún trabajo extra, dilo escribiéndolo:

```json
"extraWorkTypes": []
```

El guion lo acepta y avisa en la salida de lo que significa.

### Desactivar las horas sueltas es no escribirlas

Para que no haya horas extraordinarias, **no crees ningún concepto `per_hour`**.
No hay bandera para esto y no hace falta: la política
`extra_work_types_employee_read` solo le enseña conceptos activos y con tarifa,
así que una fila que no existe y una fila desactivada son indistinguibles para
ella — y no crearla es más limpio, porque entonces no queda **ninguna** tarifa
horaria escrita en ningún sitio. Las columnas reliquia de 0002
(`overtime_hourly_rate_cents`, `worked_rest_day_rate_cents`) se derivan del
catálogo y quedan en cero.

`overtimeHourlyRateCents`, `workedRestDayRateCents`,
`workedRestDayCreditMinutes`, `allowsHourlyOvertime` y `allowsExtraShifts` **ya
no se pactan en el JSON**: las dos primeras eran las tarifas que ahora son
conceptos, la tercera es el `referenceMinutes` de la jornada, y las dos banderas
decían ser un permiso sin serlo. Si el fichero las trae, el guion aborta
diciendo adónde se fueron.

### Vacaciones: ninguna fila más

Los 30 días **son** `annualVacationDays` de la versión. No hay tabla de saldo;
`app.vacation_periods` solo se llena cuando se disfrutan días.

### Cambiar lo pactado no se hace con este guion

Repetirlo con los mismos datos —incluido el mismo catálogo— no escribe nada.
Repetirlo con datos **distintos** aborta, y distingue si cambiaron las
condiciones de la versión o una tarifa del catálogo. Una subida de salario, una
tarifa nueva o un concepto retirado son una **versión nueva**, y se apila desde
la aplicación, con autoría y motivo.

**Qué se verifica**, entrando como la empleada:

- **Mis condiciones**: salario, jornada, «30 días naturales al año» y **solo**
  los conceptos pactados con su tarifa. **Ninguna tarifa por hora**.
- **Pagos**: la tarjeta de trabajo extra ofrece el formulario con los conceptos
  en el desplegable, **no** el mensaje «Sin trabajo extra disponible». Registra
  una jornada de prueba y resuélvela para comprobar el circuito entero.

Y como `family_admin`, en **Administrar el acuerdo**: `v1 · desde el <fecha>`
con el salario, los conceptos con su tarifa y los días de vacaciones.

---

## 4. El manual de convivencia

Vuelca la guía, las rutinas, el contacto del 112 y la plantilla de semana.

```bash
HOUSEHOLD=$(psql "$DATABASE_URL" -Atc "select id from app.households where slug = 'casa-ejemplo'")

pnpm --filter @casa-clara/db manual:import --household "$HOUSEHOLD" --dry-run
pnpm --filter @casa-clara/db manual:import --household "$HOUSEHOLD"
```

**Qué se verifica.** El guion resume lo que hizo: apartados y notas de la guía,
rutinas, contactos y plantilla. Es idempotente por contenido: repetirlo dice
`0 notas nuevas, 0 actualizadas, N sin cambios`.

> **La plantilla de semana necesita un grupo de comensales.** Si el hogar
> todavía no tiene ninguno, el guion avisa
> (`sin grupo de comensales vivo: la plantilla … se omite`) y sigue. Crea el
> grupo en el paso 5 y **vuelve a pasar este guion**: entonces sí la crea.

---

## 5. Lo que solo se hace desde la aplicación

Estos pasos no tienen guion a propósito: son decisiones del hogar y quedan con
autoría.

### 5.1 El grupo de comensales

1. **Menú → Recetas y comensales**: apunta a quien come en casa.
2. **Menú → Nuevo grupo de comensales**: nómbralo (p. ej. «Casa») y marca a esas
   personas. **Crear grupo**.
3. Vuelve a pasar `manual:import` (paso 4) para que nazca la plantilla de semana.

Ojo: crear el grupo **no es idempotente**. Repetir el formulario crea otro grupo
con el mismo nombre; comprueba antes si ya está.

### 5.2 El calendario ICS

**La URL del calendario no pasa por el repositorio, ni por una variable de
entorno, ni por un guion.** Se teclea en la pantalla y viaja a la base de datos:

1. Entra como `family_admin` → **Calendario**.
2. **Enlazar un calendario**.
3. **¿De quién es este calendario?** → una etiqueta que se entienda («Cole de los
   niños»). Es lo único que verá el resto de la casa.
4. **Enlace del calendario** → la dirección iCal privada. Tiene que empezar por
   `https://` (lo exigen el formulario y la base de datos).
5. **Enlazar el calendario**.

Queda listado en «Calendarios enlazados» como `Pendiente de la primera lectura`.
Los eventos aparecen cuando el trabajador de fondo lo lea por primera vez; si el
enlace no vale, la propia tarjeta lo dice (`No se pudo leer la última vez`).

Quien no administra **no ve** ni el botón ni la gestión: la política RLS de
`app.ics_sources` es solo de administración.

---

## 6. Comprobar que el hogar está de verdad en pie

Con la aplicación levantada contra esa base de datos (`DATABASE_URL` con el rol
de ejecución, `DATABASE_AUTH_URL` y `BETTER_AUTH_SECRET`):

| Comprobación | Dónde | Qué tiene que verse |
|---|---|---|
| La entrada es real | `/login` | Pide **usuario y contraseña**. Si muestra tarjetas de cuentas, falta la base de identidad y **no estás sirviendo datos reales** |
| Cada persona entra | `/login` | Las tres, con la contraseña que se les dictó, caen en «Hoy» de su hogar |
| La guía | Guía de la casa | Los apartados del manual, con sus notas y las fichas destacadas |
| Las rutinas | Rutinas | Las cinco del manual, con su cadencia y su próxima fecha |
| Emergencias | Emergencias | El 112 entre los contactos destacados, con su etiqueta |
| La plantilla | Menú → Semanas plantilla | «Semana tipo del manual (pendiente)» |
| El acuerdo | Pagos | Versión 1 con el salario, las tarifas y los días de vacaciones |
| **El catálogo llegó** | Pagos, como la empleada | La tarjeta de trabajo extra **ofrece el formulario** con los conceptos pactados. Si dice «Sin trabajo extra disponible», el acuerdo nació mudo: **para aquí y léete el §3** |
| **Y puede usarlo** | Pagos, como la empleada | Registrar una jornada extra de prueba con fecha de hoy. Tiene que aceptarse |
| **Y no ve lo que no le aplica** | Mis condiciones, como la empleada | Solo los conceptos pactados. Si no hay horas sueltas, **ninguna tarifa por hora** en ninguna parte |
| Las vacaciones | Pagos | El saldo del año, prorrateado si el acuerdo empezó a mitad de año |
| Quien trabaja ve lo suyo | Pagos, como la empleada | Su acuerdo, su saldo y su expediente descargable; **ningún** formulario de apuntar o anular vacaciones |
| Y no lo ajeno | Ajustes del hogar, como la empleada | Un 403 con «no está incluida en tu acceso» |
| Nada sintético | Cualquier pantalla | Ningún banner de entorno sintético; `ALLOW_SYNTHETIC_DATA_ONLY` sin definir o a `false` |

Las comprobaciones de que el alta pública y el restablecimiento por correo
siguen cerrados están en [acceso-produccion.md §7](acceso-produccion.md).

---

## 7. Contra Supabase: qué cambia

Nada del procedimiento. Solo:

- `DATABASE_URL` de `bootstrap` y `migrate` tiene que ser la **conexión directa**
  (5432) con el rol `postgres`, no el *pooler*: ambos toman cerrojos de sesión.
- Ese rol no puede saltarse RLS, así que `migrate` intercala
  `0018_rls_force_compat.sql` entre migraciones. Lo dice por pantalla; es normal.
- `DATABASE_URL` de la **aplicación** es el del *pooler*, con
  `casa_clara_app_login`. La aplicación no migra ni siembra nunca.
- El esquema de Better Auth se llama `casa_auth`, no `auth`: en Supabase `auth`
  es de GoTrue.

Los detalles de red, regiones y variables de Vercel están en
[plan-vercel-supabase.md](plan-vercel-supabase.md).

---

## 8. Lo que este procedimiento todavía no resuelve

- **El alta del acuerdo no tiene deshacer, y la pantalla tampoco tiene ensayo.**
  No existe ninguna ruta en el código para cerrar o anular un acuerdo. Si el
  formulario se envía mal, la única salida es apilar una versión nueva, que rige
  **desde su fecha** y no repara los días anteriores. Por eso el guion del §3.b
  conserva su `--dry-run`: es el único ensayo que hay.
- **Un acuerdo con `helper` nace mudo.** El guion admite ese rol y el esquema
  también, pero la política `extra_work_types_employee_read` de 0021 solo enseña
  el catálogo a `employee_live_in`, y la pantalla solo ofrece como candidatas a
  quienes tienen ese rol. Hasta que se decida qué debe ver un `helper`, el
  acuerdo se firma con `employee_live_in`.
- **La primera versión rige desde el inicio del acuerdo, y no es configurable
  en el guion.** Es deliberado —una v1 posterior dejaría días trabajados sin
  condiciones—, pero significa que el acuerdo no se puede dar de alta con
  efectos retroactivos parciales. La pantalla sí deja separar ambas fechas,
  exigiendo que la versión no empiece antes que el acuerdo.
- **El grupo de comensales se crea a mano y se puede duplicar.**
- **La primera lectura del calendario depende del trabajador de fondo.** Sin él
  el calendario queda enlazado y vacío.
