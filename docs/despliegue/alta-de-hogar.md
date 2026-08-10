# Alta de un hogar de verdad, de punta a punta

Cómo se pone en pie un hogar real: base de datos vacía → tres personas entrando
con su contraseña, el contrato laboral dado de alta, el manual de convivencia
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

Un solo fichero alimenta el alta de cuentas **y** la del contrato:

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
    "overtimeHourlyRateCents": 1000,
    "workedRestDayRateCents": 5000,
    "annualVacationDays": 30,
    "allowsHourlyOvertime": false,
    "allowsExtraShifts": true,
    "schedule": {
      "from": "08:00",
      "to": "19:00",
      "longBreakMinutes": 120,
      "effectiveHoursPerDay": 8,
      "weekly": "Cinco jornadas de lunes a viernes. Fin de semana libre.",
      "restDays": ["sabado", "domingo"],
      "days": { "viernes": { "to": "15:00" } }
    }
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

## 3. El contrato laboral

```bash
pnpm --filter @casa-clara/db agreement:seed --config /ruta/fuera/del/repo/hogar.json --dry-run
pnpm --filter @casa-clara/db agreement:seed --config /ruta/fuera/del/repo/hogar.json
```

Crea el contrato y su **versión 1**, que entra en vigor el mismo día en que
empieza el contrato. Los campos de `agreement`:

| Campo | Qué es |
|---|---|
| `employeeUsername` | Quién trabaja. Su rol tiene que ser `employee_live_in` o `helper` |
| `createdByUsername` | Quién firma por la casa. Opcional: por defecto, la primera `family_admin` |
| `startsOn` | Primer día del contrato, `AAAA-MM-DD` |
| `monthlySalaryCents` | Salario mensual en céntimos (`123400` = 1.234,00 €) |
| `contractedWeeklyMinutes` | Minutos semanales contratados (`2400` = 40 h) |
| `overtimeHourlyRateCents` | Tarifa de hora extraordinaria. **Obligatoria** — ver abajo |
| `workedRestDayRateCents` | Lo que se paga un día de descanso trabajado |
| `annualVacationDays` | Días naturales de vacaciones al año (mínimo legal español: 30) |
| `schedule` | El horario. Ver «El horario va a dos sitios», abajo |
| `allowsHourlyOvertime`, `allowsExtraShifts` | Opcionales. Qué trabajo de más admite el contrato |

### El horario va a dos sitios

Desde la migración 0025 el horario deja de ser solo una frase. El mismo bloque
`schedule` del JSON alimenta las dos cosas:

- **La frase** de siempre, en `terms.schedule` del contrato. No se retira: es lo
  que se pactó por escrito con los hogares ya dados de alta.
- **El dato consultable**, en `app.agreement_schedules` y sus días, que es lo que
  la aplicación enseña y compara con la jornada semanal contratada.

`from`, `to` y `longBreakMinutes` ya existían y ahora construyen además la
**jornada tipo**. Lo nuevo es opcional:

| Clave | Qué es |
|---|---|
| `restDays` | Días que **no** se trabaja. Nombres castellanos (con o sin tilde) o números ISO (1 lunes … 7 domingo) |
| `days` | Los días que se salen de la jornada tipo. Cada uno admite `from`, `to`, `longBreakMinutes` y `note` |

Un día solo declara **lo que cambia**: terminar antes los viernes es
`"days": { "viernes": { "to": "15:00" } }`, sin repetir la hora de entrada ni el
descanso. Los días que no aparecen trabajan la jornada tipo.

Si `schedule` es una **cadena** en vez de un objeto, sigue valiendo y sigue
yendo solo a la frase: de una frase no se deduce un horario sin inventar, y el
guion no inventa condiciones. En ese caso el contrato queda **sin horario
consultable** y a la empleada no se le enseña ninguna sección de horario.

**Si el horario no cuadra con `contractedWeeklyMinutes`, el guion lo dice y
guarda igual.** Imprime un `AVISO` con las dos cifras y la diferencia. No aborta
a propósito: no le toca decidir cuál de las dos condiciones está mal, pero sí
que nadie se entere seis meses después. Ese mismo aviso aparece luego en la
pantalla de administración y en la de la empleada.

Añadir un horario a un contrato ya dado de alta **no se hace reenviando el
guion**: aborta igual que con cualquier otra condición. Es una versión nueva,
desde Contrato → Administrar el contrato.

### La tarifa de hora extraordinaria no se inventa

Si falta, **el guion aborta** y explica que hay que pactarla. No la deduce del
salario ni la deja en cero: es una condición del contrato y ponerle un número
sería hablar por dos personas que no lo han acordado. Cuando esté pactada, va en
el JSON, o por argumento si aún se está negociando:

```bash
pnpm --filter @casa-clara/db agreement:seed --config /ruta/hogar.json \
  --overtime-hourly-rate-cents 1000
```

### Cambiar lo pactado no se hace con este guion

Repetirlo con los mismos datos no escribe nada. Repetirlo con datos **distintos**
aborta: las versiones del contrato son inmutables (el disparador
`agreement_versions_append_only` rechaza cualquier reescritura). Una subida de
salario o un cambio de vacaciones es una **versión nueva**, y se añade desde la
aplicación, con autoría y motivo. El guion solo da el alta.

**Qué se verifica.** En Contrato: la tarjeta «Versiones y cambios de salario» con
`v1 · desde el <fecha>`, el salario, las tarifas y los días de vacaciones; y la
tarjeta de vacaciones con el saldo del año en curso, **prorrateado** si el
contrato empezó a mitad de año (la pantalla lo explica en una línea). Y, si el
JSON declaró horario, «Mis condiciones» de la empleada enseña la tarjeta **Tu
jornada** con la frase del horario; si no lo declaró, esa tarjeta no existe.

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
| El contrato | Contrato | Versión 1 con el salario, el horario, las tarifas y los días de vacaciones |
| Las vacaciones | Contrato | El saldo del año, prorrateado si el contrato empezó a mitad de año |
| Quien trabaja ve lo suyo | Contrato, como la empleada | Su contrato, su horario, su saldo y su expediente descargable; **ningún** formulario de apuntar o anular vacaciones |
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

- **Los interruptores de compensación no se obedecen.** `allowsHourlyOvertime` y
  `allowsExtraShifts` quedan escritos en `terms.compensation` del contrato, pero
  hoy la sección Contrato enseña la tarifa horaria y el tipo «Horas
  extraordinarias» a quien trabaja aunque el contrato diga que no hay horas
  sueltas. Si el hogar lo pactó
  así, hay que llevarlo a la interfaz antes de dar el alta por buena.
- **No hay pantalla para dar de alta un contrato.** Solo el guion del paso 3. Una
  familia sin terminal no puede hacerlo sola.
- **Cambiar lo pactado exige la aplicación** (versión nueva). Correcto de diseño,
  pero conviene tenerlo probado antes de necesitarlo.
- **El grupo de comensales se crea a mano y se puede duplicar.**
- **La primera lectura del calendario depende del trabajador de fondo.** Sin él
  el calendario queda enlazado y vacío.
