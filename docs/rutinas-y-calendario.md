# Rutinas con ritmo propio y calendario unificado

> Especificación ejecutable. Lo que aquí se decide es lo que hay que construir; donde
> dos investigaciones proponían cosas distintas, esta nota elige una y dice por qué.
> Toda referencia `fichero:línea` está verificada contra el árbol en `main` (28c732f).

---

## 1 · Qué falta hoy

Casa Clara sabe repetir una tarea `daily | weekly | monthly | quarterly` con un
intervalo de 1 a 12 y una única fecha, `next_due_on`
(`packages/db/migrations/0008_food_and_rhythm.sql:196-214`). Con eso no se puede
decir «la cocina a fondo los lunes **y** los jueves»: el modelo no tiene conjunto
de días de la semana, así que harían falta dos rutinas que se completan y avanzan
por separado. Tampoco se puede decir «cambio de ropa de temporada»: aritméticamente
`quarterly × 2` da un ritmo semestral, pero el vocabulario de la interfaz solo
ofrece día, semana, mes y trimestre (`apps/web/src/lib/food/cadence.ts:10-15`), de
modo que la familia leería «cada 2 trimestres», y no hay ancla de estación ni fecha
fija. Peor: el avance parte de la ocurrencia completada
(`0009_ics_and_routine_functions.sql:105-110`, `packages/server/src/commands/rhythm.ts:47`,
`apps/web/src/lib/food/dates.ts:41` — la misma aritmética **triplicada**), así que
una rutina mensual anclada el 31 se degrada para siempre: 31/01 → 28/02 → 28/03 →
28/04. Y una rutina diaria olvidada una semana exige siete pulsaciones de «Marcar
hecha» y muestra siete líneas «Vencía el…», porque `today.server.ts:376` lista con
`next_due_on <= hoy` y cada marcado avanza exactamente un intervalo.

Pero el problema mayor no es la expresividad de la recurrencia: **es que el manual
del hogar llegó sin cadencias y la app no tiene dónde aparcarlas**. El Word v0.1
traía los encabezados de los tres planes y las columnas de sus tablas, vacíos:
`la-casa-y-sus-zonas/080-planes-semanal-quincenal-y-periodico.md:12` dice «No se
asigna aquí una frecuencia de limpieza profunda. La familia completará tareas,
días, alcance y prioridades», y los tres planes son citas «Pendiente de completar
por la familia» con la cabecera de columnas y ninguna fila. La tabla de once zonas
de `limpieza/050-particularidades-por-zona.md` nombra dormitorios, despacho, baños,
salón, cocina, rellanos y escalera, habitación de juegos, porche, lavandería,
garaje y zonas privadas — con su alcance y sus límites, sin una sola frecuencia.
Ninguna de esas once generó rutina, no por descuido del volcado sino porque
`frequency` y `next_due_on` son `NOT NULL`: **no existe el estado «esto se hace,
falta decidir cuándo»**, que es el estado real de unas 21 de las ~32 tareas
identificables del manual. De las 5 rutinas sembradas
(`packages/db/scripts/seed-manual.mjs:56-108`), 2 son recordatorios a la familia de
rellenar el manual y solo 2 son trabajo real de la empleada. Los tres bloques más
accionables y más diarios que el documento sí fecha —inicio de jornada (7
comprobaciones), cierre de jornada (7) y cierre de cocina (6)— viven en la wiki y
**no aparecen en Hoy**.

Recuento honesto del corpus, para que nadie invente al implementar: tareas con
cadencia de calendario declarada, **11** (10 diarias, de las cuales 5 son momentos
de una misma rutina, más **1 quincenal**: la compra personal, `cocina/110`). Tareas
con día concreto de la semana, **0**. Semanales sin día fijo, **0**. Mensuales, **0**.
Trimestrales, **0**. Estacionales, **0**. «Los lunes y los jueves» y «el cambio de
armarios de temporada» **no están en el documento**: son decisiones que el
propietario tiene en la cabeza. Esta ola no las recupera del manual —no hay de
dónde—: construye el sitio donde escribirlas.

---

## 2 · Modelo de recurrencia elegido

### 2.1 Decisión: campos propios cerrados, RRULE solo como formato de salida

Se descarta almacenar RRULE. El argumento decisivo no es la expresividad sino que
**el subconjunto de RRULE que este repo ya parsea no cubre lo que hace falta**:
`apps/worker/src/ics.ts:426` limita las partes a `FREQ|INTERVAL|COUNT|UNTIL|BYDAY`,
`ics.ts:443` solo acepta `DAILY|WEEKLY|MONTHLY` (rechaza `YEARLY`, que es
justamente lo estacional) e `ics.ts:463` prohíbe `BYDAY` fuera de `WEEKLY`. Adoptar
RRULE obligaría a extender el parser justo por donde se cerró, a escribir un segundo
parser en plpgsql para la función definer, y a parsear la cadena de vuelta a campos
para poder pintar el formulario de la familia. Se pagaría el coste de un formato
general para expresar cuatro cosas. Con campos propios, la CHECK valida en base, el
formulario **es** el esquema, y no queda lógica de recurrencia en SQL. RRULE se
emite al generar el feed ICS (§5.4), que es la dirección fácil.

Renuncias explícitas y aceptadas: «el segundo martes de cada mes», «el último
viernes», series con número de repeticiones, y «1.ª/2.ª quincena del mes» (la
columna «Quincena» del plan quincenal del Word). Ninguna aparece en el manual, y el
único quincenal real —la compra personal— es literalmente «cada dos semanas»
(`cocina/110`), que sí se expresa. Un quinto valor del enum las añade después **sin
tocar filas existentes**.

### 2.2 Tipos y columnas

```sql
CREATE TYPE app.routine_pattern AS ENUM (
  'every_n_days',    -- «todos los días», «cada 3 días», «cada 15 días»
  'days_of_week',    -- «los lunes y los jueves», «cada 2 semanas los martes»
  'day_of_month',    -- «el día 1 de cada mes», «cada 3 meses»
  'months_of_year'   -- «en junio y en diciembre» → las temporadas
);

CREATE TYPE app.routine_overdue_policy AS ENUM ('carry', 'skip');
```

```sql
ALTER TABLE app.routines
  ADD COLUMN pattern        app.routine_pattern,   -- NULL = «sin cadencia confirmada»
  ADD COLUMN anchor_on      date,                  -- desde cuándo rige; da la FASE
  ADD COLUMN repeat_every   integer,               -- días | semanas | meses según pattern
  ADD COLUMN weekdays       smallint[],            -- ISO 1=lunes … 7=domingo
  ADD COLUMN month_day      smallint,              -- 1..31, o -1 = «último día del mes»
  ADD COLUMN months         smallint[],            -- 1..12
  ADD COLUMN overdue_policy app.routine_overdue_policy NOT NULL DEFAULT 'carry',
  ADD COLUMN ends_on        date;
ALTER TABLE app.routines ALTER COLUMN next_due_on DROP NOT NULL;
```

Convención de día de semana **ISO 1..7**, que coincide con `extract(isodow …)` y con
«lunes primero»; la conversión a la convención 0..6 de `ics.ts:425` se hace **solo**
en la frontera del ICS.

### 2.3 Resolución: `pattern` es NULLABLE — el estado «sin cadencia confirmada»

Aquí las investigaciones se contradicen. El estudio de modelo propone
`pattern SET NOT NULL`; el estudio del corpus señala que **el desbloqueo más
importante de toda la ola** es poder dar de alta una tarea acordada cuya frecuencia
aún no se ha decidido. Gana el corpus, y no por poco: sin ese estado, las 21 tareas
de zona y colada que el propietario sí tiene en la cabeza no pueden entrar en el
sistema para que él les ponga día después, y los tres planes del manual seguirán
vacíos porque no hay nada que editar.

`pattern IS NULL` significa **«se hace, falta decidir cuándo»**. Implica
`anchor_on`, `repeat_every`, `weekdays`, `month_day`, `months` y `next_due_on`
todos `NULL`. Consecuencias, todas deseables y ninguna gratuita:

- La rutina **aparece en la página de Rutinas**, en un grupo propio, y **jamás en
  Hoy ni en el calendario ni en el ICS ni en los avisos**: los prefiltros
  `next_due_on <= $2` (`today.server.ts:376`, `snapshot.server.ts:118`) excluyen
  `NULL` sin tocar una línea.
- No se puede completar: `routine.complete` la rechaza con `routine_has_no_schedule`.
- La migración deja `pattern` no nulo en **todas** las filas existentes; la
  nulabilidad solo abre la puerta a filas nuevas.

### 2.4 Restricciones de forma

```sql
CREATE FUNCTION app.is_normalized_smallints(vals smallint[], lo smallint, hi smallint)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT vals IS NOT NULL
     AND cardinality(vals) BETWEEN 1 AND (hi - lo + 1)
     AND vals = (SELECT array_agg(v ORDER BY v) FROM (SELECT DISTINCT unnest(vals) AS v) d)
     AND (SELECT bool_and(v BETWEEN lo AND hi) FROM unnest(vals) v)
$$;
```

```sql
ALTER TABLE app.routines ADD CONSTRAINT routines_pattern_shape CHECK (
  CASE
    WHEN pattern IS NULL THEN
      anchor_on IS NULL AND repeat_every IS NULL AND weekdays IS NULL
      AND month_day IS NULL AND months IS NULL AND next_due_on IS NULL
      AND ends_on IS NULL
    ELSE
      anchor_on IS NOT NULL AND
      CASE pattern
        WHEN 'every_n_days' THEN
          repeat_every BETWEEN 1 AND 366
          AND weekdays IS NULL AND month_day IS NULL AND months IS NULL
        WHEN 'days_of_week' THEN
          repeat_every BETWEEN 1 AND 12
          AND app.is_normalized_smallints(weekdays, 1::smallint, 7::smallint)
          AND month_day IS NULL AND months IS NULL
        WHEN 'day_of_month' THEN
          repeat_every BETWEEN 1 AND 36
          AND (month_day = -1 OR month_day BETWEEN 1 AND 31)
          AND weekdays IS NULL AND months IS NULL
        WHEN 'months_of_year' THEN
          repeat_every IS NULL
          AND (month_day = -1 OR month_day BETWEEN 1 AND 31)
          AND app.is_normalized_smallints(months, 1::smallint, 12::smallint)
          AND weekdays IS NULL
      END
  END
);
ALTER TABLE app.routines ADD CONSTRAINT routines_ends_after_anchor
  CHECK (ends_on IS NULL OR anchor_on IS NULL OR ends_on >= anchor_on);
```

El `36` de `day_of_month` no es capricho: `interval_count` admite hasta 12
(`0008:206`) y una rutina `quarterly` con intervalo 12 son **36 meses**. Una CHECK de
24 haría fallar la migración sobre datos reales.

### 2.5 Resolución: la política de atraso se **deriva del patrón**, no se pregunta

Segunda contradicción. El estudio de modelo quiere una columna
`overdue_policy` que el usuario elige; el estudio de pantallas quiere una regla fija
—las ocurrencias diarias y de días fijos **caducan al acabar su día**, el atraso solo
existe de semanal para arriba— y no preguntar nada.

Se adopta **lo mejor de ambas y se argumenta**: la columna existe (es el único modo
de expresar que «el cambio de ropa de temporada» debe arrastrarse aunque se olvide
una semana, mientras que «hacer las camas» no debe acumular catorce pendientes), pero
**en la fase 1 no hay control en la interfaz**: el valor se deriva del patrón al
guardar, en un único sitio del servidor.

| Patrón | Regla de derivación | Política |
|---|---|---|
| `every_n_days` con `repeat_every ≤ 6` | ritmo sub-semanal | `skip` |
| `days_of_week` | ritmo sub-semanal | `skip` |
| `every_n_days` con `repeat_every ≥ 7` | de semanal para arriba | `carry` |
| `day_of_month`, `months_of_year` | de mensual para arriba | `carry` |

Por qué así: la regla del estudio de pantallas es correcta en el 100 % de los casos
del manual y ahorra una pregunta que nadie sabría contestar; la columna deja la
puerta abierta a la excepción sin otra migración. Si algún día aparece la excepción,
se añade un control y nada más cambia.

Semántica: `carry` = se arrastra hasta que alguien la marque, y **se muestra una sola
línea, la más antigua pendiente** (nunca una lista de noventa). `skip` = si no se
hizo, se pasa por alto; la ocurrencia de hoy sustituye a la de ayer. Esto es lo que
impide que diez rutinas diarias por siete días de vacaciones se conviertan en setenta
filas y setenta toques.

### 2.6 Lo que NO cambia

- **`app.routine_completions` intacta.** Su clave primaria ya es
  `(household_id, routine_id, due_on)` (`0008:222`): las finalizaciones **ya están
  indexadas por ocurrencia**. Es el activo que hace viable todo esto; con «lunes y
  jueves» hay dos filas por semana y la tabla lo soporta sin tocar nada.
- Las políticas RLS de rutinas y finalizaciones (`0008:370-398`). El modelo de
  audiencia no se toca y AC-25 sigue vigente palabra por palabra.
- AC-26: ni porcentajes, ni rachas, ni histórico de cumplimiento (`0008:191-193`).

### 2.7 `next_due_on` deja de ser estado y pasa a ser caché

```sql
COMMENT ON COLUMN app.routines.next_due_on IS
  'Caché: cota INFERIOR de la próxima ocurrencia pendiente, o NULL si la rutina no
   tiene cadencia confirmada. Invariante: nunca es posterior a la ocurrencia real,
   para que el prefiltro «next_due_on <= hoy» jamás oculte una rutina. La verdad
   está en las columnas de patrón.';
```

Esa invariante es lo que hace segura la caché: si se queda anticuada solo puede
quedarse **atrás**, el prefiltro SQL selecciona de más y el generador en TypeScript
descarta. Nunca puede ocultar nada.

### 2.8 Algoritmo de próxima ocurrencia

**Un único módulo puro, `packages/domain/src/recurrence.ts`.** Hoy la misma
aritmética está triplicada (`0009:105-110`, `rhythm.ts:47`, `dates.ts:41`, cuyo
comentario dice literalmente «réplica exacta») y las tres copias tienen que coincidir
a mano. Las tres desaparecen. `@casa-clara/domain` ya es dependencia de `apps/web`
(`apps/web/package.json:24`) y de `packages/server` (`packages/server/package.json:20`).

```ts
export type RoutineRule =
  | { pattern: 'every_n_days';   anchorOn: string; repeatEvery: number; endsOn?: string | null }
  | { pattern: 'days_of_week';   anchorOn: string; repeatEvery: number; weekdays: number[]; endsOn?: string | null }
  | { pattern: 'day_of_month';   anchorOn: string; repeatEvery: number; monthDay: number; endsOn?: string | null }
  | { pattern: 'months_of_year'; anchorOn: string; months: number[]; monthDay: number; endsOn?: string | null };

/** Ocurrencias en [fromISO, toISO], ambas inclusive, en orden ascendente. */
export function occurrencesBetween(rule: RoutineRule, fromISO: string, toISO: string): string[];
```

Aritmética sobre cadenas ISO en UTC (como ya hace `dates.ts`), **nunca** con `Date`
en hora local ni con `Intl` dentro del generador.

- **`every_n_days`** — `d0 = anchor + ceil(max(0, from − anchor) / n) · n`; luego `+n`
  hasta `to`. Nunca antes de `anchor`.
- **`days_of_week`** — la semana es activa si y solo si
  `((mondayOf(d) − mondayOf(anchor)) / 7) mod repeatEvery == 0`; dentro de ella, los
  días con `isodow(d) ∈ weekdays`; se descartan los anteriores a `anchor` (misma regla
  que `ics.ts:505`, WKST=MO). `mondayOf` ya existe en `dates.ts:57`.
- **`day_of_month`** — el mes es activo si y solo si
  `(monthIndex(d) − monthIndex(anchor)) mod repeatEvery == 0`. Día del mes =
  `monthDay == -1 ? último : min(monthDay, último)` → **RECORTE**.
- **`months_of_year`** — todos los años desde `anchor`, meses `∈ months`, mismo
  cálculo de día. `repeatEvery` no interviene.
- En todos: `d ≤ endsOn` si existe, y `d ≥ anchorOn`.

**Recorte y no salto, decidido a conciencia.** La RFC 5545 salta los meses sin ese día
y así lo hace el parser de entrada (`ics.ts:508`). Para tareas de casa, saltar
significa *que en febrero no se hace la limpieza a fondo*, lo cual es incorrecto. Se
mantiene el recorte, que además es lo que producción ya hace (`make_interval` en
`0009`, `addMonthsClamped` en `dates.ts:23`).

**Esto arregla un fallo real.** Generando desde el ancla y no desde la ocurrencia
completada, una rutina mensual anclada el 31 hace 31/01 → 28/02 → **31/03**, en vez
de degradarse a 28 para siempre.

### 2.9 De ocurrencias a «lo que sale en Hoy»

```ts
export function pendingFor(
  rule: RoutineRule,
  policy: 'carry' | 'skip',
  completedDueOns: ReadonlySet<string>,
  todayISO: string
): { due: string[]; overdue: string | null; upcoming: string[] };
```

- Ventana de generación: `[max(anchorOn, hoy − 400 días), hoy + horizonte]`, con tope
  duro de **1000 fechas por rutina y llamada**.
- `due` = ocurrencias de hoy sin fila en `routine_completions`.
- `overdue`: con `skip`, siempre `null`; con `carry`, **la más antigua pendiente y
  solo esa**, mostrada una vez con «Tocaba el jueves».
- `upcoming` = las 2–3 próximas ocurrencias `> hoy`, para el chip optimista.
- La caché `next_due_on` = `min(overdue ?? ∞, primera ocurrencia ≥ hoy no completada)`.

**Completar tarde.** Se inserta la finalización con el `due_on` de la ocurrencia
perdida y **el calendario no se mueve**. Hoy sí se mueve (`0009:105`,
`completed_due + interval`), lo que produce la cinta de correr: una rutina diaria con
5 días perdidos avanza 1 día por marcado y sigue vencida indefinidamente. Con
generación desde la regla eso desaparece por construcción.

**Validación de `dueOn` al completar: deliberadamente permisiva.** `completeRoutine`
**no** exige que `dueOn` sea una ocurrencia vigente. Una finalización es un hecho
(«esto se hizo tal día») y las reglas cambian; rechazarla rompería el outbox offline
de una empleada que quedó con la regla anterior. Se acepta e ingresa; si ya no es
ocurrencia, simplemente no se pinta. Único rechazo nuevo: `pattern IS NULL`.

### 2.10 Renuncias registradas

| Se renuncia a | Por qué | Cómo se añadiría |
|---|---|---|
| «El segundo martes de cada mes» | no está en el manual ni en la petición | quinto valor del enum |
| «1.ª / 2.ª quincena del mes» | el único quincenal real es «cada dos semanas» (`cocina/110`) | `month_days smallint[]` |
| Momento del día (Inicio, Cierre, antes de comer) | fase 2, §6 | columna enum opcional |
| Sub-ítems de checklist | fase 2, §6 | tabla hija |
| Hora del reloj en las rutinas | `060-rutina-diaria-de-referencia.md` dice «La secuencia se adapta … No obliga a interrumpir el descanso»; poner hora convierte una guía en un fichaje | — |
| Control de `ends_on` en la interfaz | «repetir hasta» es jerga de calendario de oficina; la columna existe para el ICS y el archivado | control nuevo, sin migración |

---

## 3 · Migración de lo existente

Producción está viva. **Expandir y contraer, en dos migraciones separadas por un
despliegue.** Los ficheros son `0023_routine_recurrence.sql` y
`0024_routine_recurrence_contract.sql` (0019 no existe; la numeración salta de 0018 a
0020 y eso no importa: el runner ordena por nombre de fichero).

### 3.1 Migración 0023 (expandir) — orden obligatorio

La lección de la 0021 está escrita en `packages/db/scripts/migrate.mjs:63-66` y en
`0021_agreement_terms_catalogue.sql:516-523`: **un `UPDATE` deja comprobaciones
diferidas en cola y el `ALTER TABLE` siguiente falla con «cannot ALTER TABLE … because
it has pending trigger events»**, cosa que con las tablas vacías no se ve. Por tanto,
en este orden exacto:

1. `CREATE TYPE` (los dos enums) y `CREATE FUNCTION app.is_normalized_smallints`.
2. **Todos** los `ALTER TABLE … ADD COLUMN`, sin `NOT NULL` y sin CHECK, más el
   `ALTER COLUMN next_due_on DROP NOT NULL`.
3. `UPDATE app.routines` con el relleno de §3.2.
4. **`SET CONSTRAINTS ALL IMMEDIATE;`** ← la línea que faltó en 0021.
5. Aserción de coherencia en un bloque `DO` (§3.3). Si falla, la migración entera se
   deshace.
6. `ADD CONSTRAINT routines_pattern_shape`, `ADD CONSTRAINT routines_ends_after_anchor`
   y los `COMMENT ON COLUMN`. **`pattern` y `anchor_on` quedan NULLABLES** a propósito
   (§2.3); la aserción del paso 5 es la que garantiza que ninguna fila *existente* se
   quedó sin patrón.
7. `DROP FUNCTION app_private.ics_feed_events(text)` + `CREATE` con la nueva firma de
   salida (`CREATE OR REPLACE` **no puede** cambiar el tipo de retorno) + **reemitir
   `REVOKE ALL … FROM PUBLIC` y `GRANT EXECUTE … TO casa_clara_app`**. La migración
   0011 existe precisamente porque un grant de este feed se perdió una vez.
8. `CREATE FUNCTION app.set_routine_due_hint(uuid, date)` (§5.1) y
   `CREATE FUNCTION app_private.routine_digest_inputs(date)` con
   `GRANT EXECUTE … TO casa_clara_worker`.
9. **No** se toca `app.advance_routine_after_completion`, ni `frequency`, ni
   `interval_count`: el código antiguo que siga sirviendo durante el despliegue
   funciona igual.

El fichero va en un único `BEGIN;…COMMIT;` (lo exige `migrate.mjs`,
`stripOuterTransaction`).

### 3.2 Relleno desde lo existente

| Heredado | `pattern` | `repeat_every` | resto |
|---|---|---|---|
| `daily`, k | `every_n_days` | k | — |
| `weekly`, k | `days_of_week` | k | `weekdays = ARRAY[isodow(next_due_on)]` |
| `monthly`, k | `day_of_month` | k | `month_day = day(next_due_on)` |
| `quarterly`, k | `day_of_month` | **3·k** | `month_day = day(next_due_on)` |

En todas: `anchor_on = next_due_on`, `ends_on = NULL`, y `overdue_policy` **derivada
según la tabla de §2.5** (no `carry` para todo).

Con `anchor_on = next_due_on` **ninguna rutina pierde su próxima fecha**: el ancla es,
por construcción, una ocurrencia de la nueva regla, y es exactamente la que estaba
pendiente. Ésa es la garantía que pide el encargo, y la aserción de §3.3 la comprueba.

Cambio de semántica que se acepta a conciencia: las dos rutinas diarias sembradas
(`Rutina diaria de referencia`, `Ventilación de la mañana`) pasan de `carry` implícito
a `skip`. Es el arreglo que se busca, no un efecto colateral: hoy una semana de
vacaciones les deja siete líneas «Vencía el…».

Límite conocido e irrecuperable: si una rutina mensual venía del 31 y ya estaba
recortada a `2026-02-28`, `month_day` queda en 28 y se pierde la intención original.
No hay forma de recuperarla desde el estado actual (la primera finalización tiene el
mismo recorte). Mitigación: `RAISE NOTICE` con las rutinas donde
`extract(day from next_due_on) >= 28` para que una persona las revise. En producción
son 5 rutinas sembradas del manual: inspección de un minuto.

### 3.3 Aserción que impide una migración silenciosamente rota

```sql
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM app.routines WHERE pattern IS NULL OR anchor_on IS NULL) THEN
    RAISE EXCEPTION 'quedan rutinas sin patrón tras el relleno';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.routines
     WHERE (pattern = 'days_of_week'
            AND NOT (extract(isodow FROM next_due_on)::smallint = ANY (weekdays)))
        OR (pattern = 'day_of_month'
            AND month_day <> extract(day FROM next_due_on)::smallint)
        OR (pattern = 'every_n_days' AND anchor_on <> next_due_on)
        OR anchor_on <> next_due_on
  ) THEN
    RAISE EXCEPTION 'la regla derivada no reproduce next_due_on';
  END IF;
END
$check$;
```

### 3.4 Contrato de comandos: el outbox offline ya tiene envelopes de la forma antigua

`routineUpsertPayloadSchema` (`packages/contracts/src/schemas.ts:749-758`) exige
`frequency`/`intervalCount`/`nextDueOn`. Puede haber envelopes encolados en IndexedDB
**antes** del despliegue. El servidor debe aceptar **las dos formas** durante al menos
un ciclo: `z.union([legacyRoutineUpsertPayloadSchema, routineUpsertV2PayloadSchema])`,
traduciendo la vieja con la misma tabla de §3.2. **No es opcional**: sin ello, una
rutina creada offline se rechaza al reconectar.

### 3.5 Migración 0024 (contraer), tras el despliegue

`DROP FUNCTION app.advance_routine_after_completion(uuid, date)`;
`ALTER TABLE app.routines DROP COLUMN frequency, DROP COLUMN interval_count`;
`DROP TYPE app.routine_frequency`; `ALTER TABLE app.routines RENAME COLUMN next_due_on
TO next_due_hint` (para que el nombre deje de mentir). Retirar la rama legacy del
esquema Zod. **Ojo al territorio**: `packages/db/tests/020_rls_matrix.sql:143` inserta
rutinas con `frequency, interval_count, next_due_on` explícitos y hay que actualizarlo
en la misma tarea que la 0024, no antes.

### 3.6 Prueba de la migración

Extender `packages/db/scripts/migrate-with-history.test.mjs` (existe justo para esto):
`STOP_AT = '0022_manual_adjustments.sql'`, sembrar cinco rutinas —una por frecuencia,
una `quarterly` con `interval_count = 12`, una mensual con `next_due_on = 2026-02-28`,
una `weekly` con finalización ya registrada— y seguir migrando hasta la cabeza.

---

## 4 · Las tres pantallas

### 4.1 Rutinas — la cadencia como una frase, no como un formulario

Hoy hay cinco campos siempre visibles (`routines/+page.svelte:196-242`). Se mantiene
la frase de vuelta y se añade **una sola pregunta por encima**, con revelado
progresivo: en cualquier momento hay exactamente **un** subcontrol visible. El
formulario no crece.

```
¿Quién la hace?   [ Toda la casa ▾ ]          ← sin cambios

¿Cuándo toca?
  ( ) Todos los días
  ( ) Días fijos de la semana
  ( ) Cada cierto tiempo
  ( ) Por temporada
  ( ) Todavía no lo sabemos
```

| Opción | Escribe | Subcontrol | Texto de ayuda |
|---|---|---|---|
| Todos los días | `every_n_days`, `repeat_every = 1`, `anchor_on = hoy` | — | — |
| Días fijos de la semana | `days_of_week`, `repeat_every = 1` | siete botones `L M X J V S D`, multiselección, `aria-pressed`, `aria-label` completo («lunes») | «Marca los días que toca.» |
| Cada cierto tiempo | `every_n_days` (días/semanas) o `day_of_month` (meses) | `cada [2] [semanas ▾]` + «¿Cuándo toca la próxima vez?» | — |
| Por temporada | `months_of_year`, `month_day = 1` | cuatro botones `Primavera · Verano · Otoño · Invierno` | «Te avisará el primer día de cada temporada que marques.» |
| Todavía no lo sabemos | `pattern = NULL` | — | «Quedará apuntada en esta página. No aparecerá en Hoy hasta que le pongáis día.» |

**Temporadas = meses meteorológicos.** Primavera → 3, Verano → 6, Otoño → 9, Invierno
→ 12, siempre con `month_day = 1`. Se elige el criterio meteorológico y no el
astronómico porque las fechas astronómicas se mueven de año en año y el modelo no
tiene «21 de junio ± un día»; el manual no exige esa precisión, y «al empezar el
verano (1 de junio)» se lee bien. «Cambio de ropa de temporada de los armarios» sale
entonces como `months = [6,12]` (o `[3,6,9,12]` si la familia marca las cuatro).

Debajo, **siempre visible, `aria-live="polite"`, la frase de vuelta** — el antídoto
contra la jerga: nadie tiene que descifrar los controles, lee la frase.

- «Toca todos los días.»
- «Toca los lunes y los jueves.»
- «Toca cada 2 semanas. La próxima, el lunes 17 de agosto.»
- «Toca al empezar el verano (1 de junio) y al empezar el invierno (1 de diciembre).»
- «Sin día todavía. No aparecerá en Hoy.»

**Tres cambios de literal que van con esto.** (1) «Próxima fecha» → **«¿Cuándo toca la
próxima vez?»**, y **solo aparece en «Cada cierto tiempo»**; escribe `anchor_on`. En
las otras ramas la fecha es derivada y pedirla es pedir al usuario que resuelva a mano
lo que la app ya sabe. (2) **Fuera «trimestre» del desplegable**
(`cadence.ts:12-17`): «cada 3 meses» dice lo mismo en lengua de casa. Unidades del
selector: **día(s) · semana(s) · mes(es)**. (3) **«Detalles» pasa a
`<textarea rows="2">`**: hoy es un `<input type="text" maxlength="1000">`
(`routines/+page.svelte:200-202`), un campo de una línea para mil caracteres.

**La lista.** Hoy es plana, ordenada por `next_due_on` (`food.server.ts:795`). Con
veinte rutinas es sopa. Se agrupa **por tipo de ritmo**, con los mismos cinco títulos
del formulario:

```
Todos los días · 6
Días fijos de la semana · 4
Cada cierto tiempo · 7
Por temporada · 2
Todavía no lo sabemos · 21
```

En Rutinas se *gestiona* (el eje útil es «qué clase de ritmo tiene esto»); en Hoy se
*hace* (el eje útil es «qué me queda»). Dos páginas, dos ordenaciones, a propósito.

Segunda línea de cada fila: «Empleada · todos los días» (sin «próxima»: es hoy,
siempre) · «Empleada · los lunes y los jueves · la próxima, el jueves 13» · «Toda la
casa · cada 2 semanas · la próxima, el lunes 17 de agosto» · «Familia · en verano y en
invierno · la próxima, el 1 de diciembre» · «Empleada · sin día todavía».

En 390 px, «Marcar hecha» + «Editar» + chip no caben en `.wiki-node-row`
(`routines/+page.svelte:158-185`): **«Editar» pasa a enlace de texto al final de la
fila** y el botón de acción se queda solo. Una rutina sin cadencia no muestra «Marcar
hecha»; muestra el enlace «Ponerle día».

### 4.2 Hoy — qué aparece y, sobre todo, qué no

```
Rutinas                                          [ 5 por hacer ]
Lo que toca hoy                                        Todas →
```

«Vencen hoy» es lenguaje de factura; «Lo que toca hoy» es lenguaje de casa. El chip es
**cuenta, no nota**: «5 por hacer» / «Todo hecho ✓». Nunca porcentaje, nunca racha
(AC-26, `0008:191-193`; el anillo de progreso que se ve en `today/+page.svelte:298-299`
es de la maqueta).

Orden y corte: (1) **«Se quedó pendiente»**, solo `overdue_policy = 'carry'`, una línea
por rutina como mucho: «Cambio de sábanas» / «Tocaba el jueves». (2) **«Hoy»**,
encabezado solo si existe el bloque anterior. (3) `<details>` **«3 hechas hoy»**,
plegado, al fondo, atenuado (`.routine-done` ya existe en `app.css:389-390`). Corte a
**6 filas pendientes**; el resto tras `<details><summary>Ver las 4
restantes</summary>`. Seis porque a 390 px es una pantalla bajo la cabecera.
`<details>` nativo: **cero bytes de JavaScript**.

**Qué NO aparece.** Una rutina diaria no hecha ayer **no es una deuda**: con `skip`, la
ocurrencia caduca al acabar su día y la de hoy la sustituye. Un baño sin limpiar el
domingo no reaparece el lunes con «vencía ayer»; el lunes toca el baño del lunes. Nada
del futuro: ni «mañana toca…». Ni porcentaje, ni histórico, ni racha. Nunca más de 6
filas sin plegar. Y las rutinas sin cadencia confirmada **no salen aquí en absoluto**.

**«Necesita tu decisión» deja de listar rutinas una a una.** `today.server.ts:308-319`
empuja hoy una fila de decisión por cada rutina que vence; con diez rutinas diarias esa
sección se convierte en una copia de la tarjeta de rutinas que hay justo debajo. Se
sustituyen las N filas por **cero filas cuando todo está al día** y **una sola** cuando
hay atraso real: «Se quedaron 3 rutinas sin hacer» · «Ver» → `#rutinas-de-hoy`. Una
rutina de hoy no es una decisión: es el trabajo.

**Presupuesto.** El gate real es
`resource-summary:script:size ≤ 122880` (`infra/quality/lighthouserc.json:26`) más
`infra/quality/lighthouse-budget.json` con `"resourceType": "script"` en `/today`:
**HTML servido y CSS no cuentan**. Por tanto: agrupación, orden, cortes, encabezados,
contadores y todos los literales se calculan en `today.server.ts` (código de servidor,
0 bytes de bundle) y se sirven como marcado; los desplegables son `<details>` nativo.
**Devolución concreta de bytes**: `today/+page.svelte:17` importa `nextRoutineDue` de
`$lib/food/dates` y `today/+page.svelte:45` construye un `Intl.DateTimeFormat` solo
para predecir el chip optimista. Si `TodayRoutineView` (`today.server.ts:87-99`) trae
ya `nextDueChip: string` calculado en servidor, **ambos desaparecen** del bundle. El
saldo neto de esta ola en Hoy debe ser **negativo**, y hay que medirlo.

### 4.3 Calendario unificado — agenda con tira de semana

**Se descarta la rejilla de mes.** Cinco razones, en orden de peso: (1) a 390 px, siete
columnas dan celdas de ~50 px, donde solo caben un número y un punto, así que para
saber algo hay que tocar el día — la agenda da la información en cero toques; (2) las
rutinas son repetitivas por definición y una rejilla mensual con «baños» los 31 días es
ruido, porque la rejilla está diseñada para eventos escasos, no para ritmo; (3) obliga
a expandir el mes entero siempre; (4) una rejilla de fechas accesible necesita
`role="grid"`/`gridcell` con `tabindex` móvil y navegación por flechas, mientras que
una agenda es encabezados y listas, que es lo que la página ya hace y ya pasa axe
(`apps/web/e2e/critical.a11y.ts`); (5) la rejilla que existe
(`calendar/+page.svelte:223-240`, `.mini-calendar` en `app.css:772-776`) es **maqueta
sin datos**, así que no se pierde nada. Lo único que una rejilla aporta de verdad a una
casa —«¿cuándo cae la cosa grande?»— lo resuelve el bloque **«Más adelante»**.
`occurrencesBetween` deja la puerta abierta a una rejilla el día que se quiera.

```
Calendario                                  Agosto de 2026
──────────────────────────────────────────────────────────
  ←   L    M    X    J    V    S    D   →      [ Hoy ]
     10   11   12  [13]  14   15   16
      ··   ·    ···  ··   ·         ·
──────────────────────────────────────────────────────────
  [ Todo ]  [ Rutinas ]  [ Eventos ]
──────────────────────────────────────────────────────────
Hoy, miércoles 13
  Rutinas
   [ ] Limpieza de baños          Todos los días · Empleada
   [ ] Cocina a fondo             Los lunes y los jueves · Empleada
  En el calendario
       16:45  Natación de Marta          Cole de los niños
──────────────────────────────────────────────────────────
jueves 14
  Rutinas
       Limpieza de baños          Todos los días · Empleada
  Nada más previsto.
──────────────────────────────────────────────────────────
Más adelante
   1 de septiembre   Cambio de armarios de temporada
  12 de octubre      Revisión de la caldera        Trabajo de…
```

Navegación: `← Semana anterior` / `Semana siguiente →` / `Hoy`. **Sin selector
semana/mes**: menos estados, y el alcance de 30 días que hoy da `CALENDAR_AGENDA_DAYS`
(`calendar.server.ts:22`) lo conserva «Más adelante».

**Rutina frente a evento se distingue por tres señales simultáneas, nunca por color**:
(1) bloque separado y etiquetado dentro de cada día, `Rutinas` y `En el calendario`,
cada uno un `<ul aria-label="Rutinas del miércoles 13">` — intercalar cosas sin hora
con cosas con hora siempre parece roto; (2) **la forma es la promesa**: la rutina lleva
una casilla (algo que puedes marcar), el evento lleva una hora («16:45» / «Todo el
día»); (3) la segunda línea: rutina → «Todos los días · Empleada», evento → «17:30 ·
Cole de los niños». El color puede acompañar, pero ninguna información depende de él.

**Marcar hecha desde el calendario: solo hoy y lo atrasado.** El futuro se pinta sin
control, con segunda línea «Toca este día». Marcar hecho algo futuro es una mentira o
una función que nadie ha pedido. El chip es **idéntico** al de Hoy («Hecha ✓ · próxima
el X»): la app habla una vez. En fase 1 el objetivo táctil es una casilla-botón de
44×44 a la izquierda y el texto **no** es objetivo; la fila entera como objetivo exige
`routine.uncomplete` (§6), porque sin deshacer los toques por error no tienen salida.

**Sin conexión.** Las rutinas se pueden calcular sin red; los eventos no. La página
cacheada por el service worker (`PAGE_CACHE`, `apps/web/src/service-worker.ts:8`) abre
con lo último descargado y **eso hay que decirlo**: banda «Sin conexión. Las rutinas se
calculan igual; los eventos son los de la última descarga (ayer, 21:04).» La expansión
de rutinas ocurre **en el navegador en esta página**, a partir de la lista de reglas
(pequeña), de modo que cualquier semana, adelante o atrás, se pinta sin red. El bloque
de eventos de una semana no descargada dice «Los eventos del calendario necesitan
conexión», nunca un hueco mudo. Marcar hecha sin red: la outbox ya lo cubre, pero el
chip **no puede** decir «próxima el X» —es falso hasta que sincronice—: «Guardada sin
conexión · se enviará al volver.»

Esto no contradice §4.2: el módulo de expansión es **uno solo y puro**
(`packages/domain/src/recurrence.ts`), importado **desde el servidor** en Hoy y en el
snapshot (0 bytes al presupuesto de `/today`) y **desde el cliente** solo en
`/calendar`, cuyo chunk de ruta no entra en el presupuesto medido. Hay que **verificar
con la build** que el generador no cae en el chunk compartido de arranque; si cayera,
la expansión de calendario pasa también a servidor y se pierde la navegación de semanas
offline (renuncia aceptable, decisión de quien mida).

**Rendimiento: al vuelo, sin materializar.** Un hogar tiene del orden de 10–40 rutinas;
un mes son 40 × 31 ≈ 1.240 evaluaciones de regla, cada una un test de día de la semana
o una comparación de fecha. Microsegundos. Materializar ocurrencias costaría una fila
por rutina y día (~12.000 filas/año/hogar), un trabajo de rellenado cada vez que cambia
una cadencia, una política de recogida de basura, RLS para una tabla nueva y una
familia entera de errores de desincronización — a cambio de nada, porque lo único que
la materialización aporta («quién hizo qué y cuándo») **ya está materializado** en
`app.routine_completions`. **Regla: las finalizaciones se guardan; las ocurrencias se
calculan.** Se revisaría si un hogar superase ~150 rutinas o si se añadiera asignación
por ocurrencia.

### 4.4 Accesibilidad y 390 px

- **Tira de semana**: 7 botones a 390 px ≈ 52 px cada uno; a 320 px ≈ 43 px, justo en
  el límite — la letra del día va **encima** del número, nunca al lado. `role="group"`
  con `aria-label="Semana del 10 al 16 de agosto"`; cada botón con `aria-pressed`;
  **nombre accesible con las cuentas exactas**: «miércoles 13, 2 rutinas y 1 evento».
  Los puntos de densidad son decoración (`aria-hidden`), jamás la única señal. La tira
  **no** debe ser un carrusel con elementos ocultos: los siete caben.
- **Casilla de completar**: `<button>` real de 44×44 con
  `aria-label="Marcar hecha: Limpieza de baños"`. Nada de `<div role="checkbox">`. El
  chip conserva el `role="status"` que ya usa Hoy (`today/+page.svelte:245`).
- **Chips de filtro**: botones con `aria-pressed`, no enlaces (los enlaces exigirían ida
  al servidor y offline caen al fallback).
- **Jerarquía**: `<h2>` la sección, `<h3>` por día, subbloques como `<ul aria-label=…>`.
- **Grupos de días y temporadas**: `<fieldset>` con `<legend>`; la frase de vuelta con
  `aria-live="polite"`.
- **`touch-action: manipulation`** en las casillas, para matar el retardo de doble toque.
- **Contraste**: «Tocaba el jueves» no puede ir en `--ink-faint`; usa el tono de aviso.
- `apps/web/e2e/mobile-overflow.dbe2e.ts:17` ya mide `/routines` y `/calendar` a 320 y
  390 px; la tira y los grupos de chips necesitan `min-width: 0` en cada celda.

### 4.5 Resumen de literales exactos

**Rutinas** — «¿Cuándo toca?» · «Todos los días» · «Días fijos de la semana» · «Cada
cierto tiempo» · «Por temporada» · «Todavía no lo sabemos» · «Marca los días que
toca.» · «Te avisará el primer día de cada temporada que marques.» · «Quedará apuntada
en esta página. No aparecerá en Hoy hasta que le pongáis día.» · «¿Cuándo toca la
próxima vez?» · «Toca todos los días.» · «Toca los lunes y los jueves.» · «Toca al
empezar el verano (1 de junio) y al empezar el invierno (1 de diciembre).» · «Sin día
todavía. No aparecerá en Hoy.» · «Ponerle día» · encabezados de grupo idénticos a las
cinco opciones.

**Hoy** — «Lo que toca hoy» · «5 por hacer» / «Todo hecho ✓» · «Se quedó pendiente» ·
«Tocaba el jueves» · «Ver las 4 restantes» · «3 hechas hoy» · «Ninguna rutina toca
hoy.» · decisión única: «Se quedaron 3 rutinas sin hacer» / «Ver».

**Calendario** — «Rutinas» / «En el calendario» · «Todo · Rutinas · Eventos» · «Hoy,
miércoles 13» / «mañana, jueves 14» / «viernes 15 de agosto» · «Nada previsto.» ·
«Nada más previsto.» · «Más adelante» · «Toca este día» · «Sin conexión. Las rutinas se
calculan igual; los eventos son los de la última descarga (ayer, 21:04).» · «Los
eventos del calendario necesitan conexión.» · «Guardada sin conexión · se enviará al
volver.»

### 4.6 Lo que se descarta y por qué

| Descartado | Motivo |
|---|---|
| Rejilla de mes | ilegible a 390 px, ruidosa con rutinas repetitivas, cara de expandir y de hacer accesible; «Más adelante» da lo único que aportaba |
| Distinguir rutina/evento por color | falla en daltonismo, alto contraste y lector de pantalla |
| Marcar hecha una rutina futura | es mentira, o es «adelantar», que nadie pidió |
| Hora del reloj en las rutinas | `060-rutina-diaria-de-referencia.md`: «No obliga a interrumpir el descanso» |
| Arrastrar y soltar para reprogramar | inaccesible con poco coste; en móvil compite con el scroll |
| Asignación por ocurrencia | duplica el modelo; la audiencia ya responde «¿quién?» |
| Porcentajes, rachas, histórico | AC-26 (`0008:191-193`) |
| «Cada 2 trimestres» para decir «verano e invierno» | el modelo actual lo expresa, la frase es inhumana |
| Editor de RRULE / «repetir hasta» | jerga de calendario de oficina |
| Agrupar Hoy por zona de la casa | con menos de 8 diarias sobra; los encabezados ocupan más que las filas que ordenan |
| Selector mes/semana/día en el calendario | tres estados donde uno basta |

---

## 5 · Impacto en definer, avisos, snapshot e ICS

### 5.1 La función definer pierde toda la recurrencia

`app.advance_routine_after_completion` (`0009:84`) existe por un motivo estrecho: la
RLS solo deja escribir `app.routines` a la familia, pero la empleada y el apoyo también
completan. Ese motivo sigue en pie **solo para refrescar la caché**:

```sql
CREATE FUNCTION app.set_routine_due_hint(target_routine uuid, hint date)
RETURNS date LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;
  -- Mismo guardián que la 0009: solo tras una finalización real de este hogar.
  IF NOT EXISTS (
    SELECT 1 FROM app.routine_completions
     WHERE household_id = app.current_household_id() AND routine_id = target_routine
  ) THEN
    RAISE EXCEPTION 'no existe finalización que justifique el refresco' USING ERRCODE = '42501';
  END IF;
  UPDATE app.routines SET next_due_on = hint
   WHERE household_id = app.current_household_id() AND id = target_routine
     AND anchor_on IS NOT NULL AND hint >= anchor_on;
  RETURN hint;
END $$;
```

De ~30 líneas con un `CASE frequency` a un `UPDATE` de una columna: la superficie de
seguridad se reduce y **desaparece la cuarta copia del algoritmo**.

### 5.2 Avisos: barrido diario en vez de un job por ocurrencia

El encolado actual tiene dos fallos que el nuevo modelo obliga a mirar de frente:
**editar una rutina no rearma nada** (`upsertRoutine`, `rhythm.ts:145`, sale por la
rama de `UPDATE` sin llamar a `enqueueRoutineDue`, así que el job antiguo sigue
apuntando a la fecha vieja) y **una rutina que nadie completa nunca vuelve a avisar**
(el único reencolado está en `rhythm.ts:269`, dentro del camino de finalización). Con
«lunes y jueves» son además dos avisos por semana y el esquema actual encola uno por
ocurrencia.

Se sustituye por **un barrido diario** `notification.routines_due_digest` sobre las
07:00 de Madrid, que lee `app_private.routine_digest_inputs(for_date)` (nueva definer
para `casa_clara_worker`, siguiendo el patrón de `record_ics_sync` y
`list_ics_sources_for_sync`), genera las ocurrencias del día en el worker con el mismo
módulo de `packages/domain`, y envía **un correo por audiencia con las rutinas de ese
día**, o ninguno si no hay nada. Un job al día en vez de uno por ocurrencia; nada que
cancelar al editar la regla; y desaparece la lista de destinatarios parcial que hoy
documenta `resolveAudienceRecipients` (`rhythm.ts:63-77`), porque se resuelve dentro de
la definer con la lista completa en vez de bajo la RLS de quien encoló. **AC-25 se
conserva palabra por palabra y debe seguir aserto sobre el digest**: audiencia `family`
jamás incluye a la empleada, y el apoyo no recibe aviso aunque vea la rutina.

Coste conocido: `packages/server/src/routine-quarterly.integration.test.ts` afirma hoy
que el alta encola un job con `run_at` = la fecha de vencimiento; esa prueba se
reescribe contra el digest.

### 5.3 Snapshot offline

**El snapshot sigue llevando ocurrencias ya resueltas, no reglas.** `snapshot.server.ts:98-128`
genera en servidor; `SnapshotRoutine` (`fixtures.server.ts:169-177`) solo añade
`dueOn: string` (hoy únicamente hay `dueLabel`), que hace falta para poder encolar la
finalización correcta desde la página offline. El filtro `next_due_on <= $2` sigue
valiendo como **prefiltro** gracias a la invariante de cota inferior; el generador
decide después.

### 5.4 Feed ICS

`app_private.ics_feed_events` (`0009:8`) deja de devolver `frequency`/`interval_count` y
devuelve las columnas de patrón (y omite las filas con `pattern IS NULL`). El generador
sigue en TypeScript, en `apps/web/src/routes/api/v1/ics/[token]/+server.ts`. Mejora
gratis: en vez de proyectar 8 ocurrencias sueltas (`PROJECTED_OCCURRENCES = 8`, línea
11), emitir **una `RRULE` real** con `ical-generator` — `FREQ=WEEKLY;BYDAY=MO,TH`,
`FREQ=MONTHLY;BYMONTHDAY=1`, `FREQ=YEARLY;BYMONTH=6,12;BYMONTHDAY=1` — para que el
calendario del suscriptor no se quede seco. Con una salvedad medible: **`BYMONTHDAY`
con día ≥ 29 no es fiel** (la RFC salta, nosotros recortamos); en ese caso, y solo en
ese, se siguen emitiendo ocurrencias explícitas. `month_day = -1` sí es fiel
(`BYMONTHDAY=-1`).

---

## 6 · Reimportación del manual

### 6.1 Principio: el volcado no inventa cadencias

Lo que el documento no dice, el volcado no lo escribe. «Los lunes y los jueves» y «el
cambio de armarios» **no se siembran**: son decisiones nuevas del propietario que la
app debe capturar, y luego devolverse al plan semanal y al plan periódico de
`080-planes-semanal-quincenal-y-periodico.md`, que sigue en `status: draft` esperando
exactamente eso.

### 6.2 Qué debe crear el volcado cuando el modelo sepa expresarlo

**A · Las 5 existentes, corregidas en su sitio** (mismas claves, mismos ids
deterministas, ninguna fila nueva):

| Clave | Cambio |
|---|---|
| `routine:rutina-diaria-de-referencia` | `every_n_days × 1`; sin cambio de sentido |
| `routine:ventilacion-de-la-manana` | `every_n_days × 1`; sin cambio de sentido |
| `routine:compra-personal-quincenal` | `days_of_week`, `repeat_every = 2`, `weekdays = [1]`; deja de ser `weekly×2` con la fecha escondida en SQL (`seed-manual.mjs:86,96`: `current_date + ((8 - extract(isodow from current_date))::int % 7)`) y pasa a decir «cada 2 semanas, los lunes» donde la familia lo puede leer y editar |
| `routine:plan-periodico` | **se archiva** (`archived_at`) |
| `routine:plan-semanal` | se conserva, **renombrada** a «Concretar los planes de la casa», `days_of_week`, `repeat_every = 1`, `weekdays = [1]`, audiencia `family` |

Dos meta-rutinas para el mismo recado eran una de más: se deja **una sola**.

**B · Tres rutinas diarias nuevas, que el documento sí fecha:**

| Clave nueva | Título | Patrón | Audiencia | Origen |
|---|---|---|---|---|
| `routine:inicio-de-jornada` | Inicio de jornada | `every_n_days × 1` | `employee` | `la-casa-y-sus-zonas/030` (7 comprobaciones, nota fijada) |
| `routine:cierre-de-jornada` | Cierre de jornada | `every_n_days × 1` | `employee` | `la-casa-y-sus-zonas/050` (7 comprobaciones, nota fijada) |
| `routine:cierre-de-cocina` | Cierre de cocina | `every_n_days × 1` | `employee` | `cocina/100` (6 pasos) |

`details` remite a la ficha: «Ver ficha: Guía rápida — cierre de jornada.» Es la
pérdida más grave del volcado actual —los bloques más diarios y accionables del manual
no aparecen en Hoy— y se corrige. Nota de coste, aceptada y reversible: Hoy pasa de 2 a
5 filas diarias de la empleada; con `overdue_policy = 'skip'` y el corte a 6 filas eso
cabe. **No** se despliega la rutina diaria de referencia en sus 5 momentos: eso necesita
la columna de momento y los sub-ítems de checklist (§7), y hasta entonces multiplicaría
Hoy sin dar accionabilidad nueva.

**C · Las ~21 tareas nombradas sin cadencia, como rutinas con `pattern = NULL`.** Es la
razón de ser de §2.3. Once de la tabla de zonas
(`limpieza/050-particularidades-por-zona.md`): dormitorios, despacho (con «confirmar
acceso» en los detalles), baños, salón, cocina, rellanos y escalera, habitación de
juegos, porche, lavandería, garaje. Tres fichas de superficie (mármol, tarima, terrazo:
`limpieza/020`, `030`, `040`), cuyo «cuándo» es un disparador por estado y cuyo
calendario el propio texto delega en «la planificación familiar confirmada». Colada
completa (`ropa-y-colada/010`), planchado (`050`), doblado y guardado (`060`), residuos
(`la-casa/070`), hacer las camas, revisión de consumibles y revisión de mantenimiento
(`mantenimiento/010`).

**D · Lo que el volcado NO debe crear, nunca:**

- **Zonas privadas y patio inglés.** `convivencia/060:10` («La organización cotidiana …
  corresponde a quien las usa») y `:14` («**No hay inspecciones rutinarias**»). El valor
  `employee` de `audience` **sigue siendo legible por la familia**: una rutina aquí
  sería una inspección encubierta. Fuera hasta que exista un valor «privado de la
  empleada», que no está en esta ola.
- **Baño de la persona interna** y **baño de la planta calle**: uso y responsabilidad
  explícitamente pendientes (`limpieza/060:10,12`). Ninguna rutina.
- Nada estacional, nada con día de la semana concreto salvo los dos lunes justificados
  arriba, y nada que el manual marque «Pendiente de completar».

### 6.3 Cómo se hace sin duplicar lo que ya está en producción

El mecanismo ya existe y es correcto: `seed-manual.mjs` usa
`deterministicUuid(householdId, key)` y hace `insert … on conflict (id) do update`
(`seed-manual.mjs:174-200`), con la regla de oro **`next_due_on` solo al crear**
(«repetir la siembra no reinicia la recurrencia avanzada por finalizaciones»,
`seed-manual.mjs:172-173`). Se extiende con estas cuatro reglas, y ninguna se salta:

1. **Las claves de las 5 existentes no se tocan.** Cambiar `key` crearía duplicados con
   id nuevo. Las tres altas nuevas y las ~21 sin cadencia usan claves nuevas.
2. **`anchor_on` entra en el `INSERT` pero NO en el `DO UPDATE`**, igual que
   `next_due_on` hoy: reejecutar la siembra no debe mover la fase de una rutina que la
   familia ya ajustó.
3. **Las columnas de forma (`pattern`, `repeat_every`, `weekdays`, `month_day`,
   `months`) sí entran en el `DO UPDATE`, pero solo si la fila sigue en su estado
   sembrado.** Criterio operativo y barato: se actualizan si `pattern` coincide con el
   valor sembrado la vez anterior; si la familia lo cambió, la siembra respeta su
   decisión y lo anota en el informe como «respetada: X». Sin esto, la primera
   reejecución tras el despliegue destruiría el trabajo del propietario, que es
   exactamente lo que esta ola pretende capturar.
4. **`routine:plan-periodico` se archiva, no se borra** (`archived_at = now()` en el
   `DO UPDATE`, y una excepción explícita al `archived_at = null` que hoy fuerza la
   siembra en la línea 186). Borrar arrastraría sus `routine_completions` por
   `ON DELETE CASCADE` (`0008:225`).

Prueba de no duplicación (obligatoria): sembrar dos veces seguidas sobre la misma base
y comprobar que `select count(*) from app.routines` no cambia entre la primera y la
segunda pasada, y que `anchor_on` no se movió.

---

## 7 · Fase 2, con su coste declarado

- **Momento del día.** El manual ya tiene el vocabulario exacto y es de la casa, no
  inventado: *Inicio · Después de cada uso · Antes de una comida · Después de una comida
  · Cierre* (`060-rutina-diaria-de-referencia.md`). Coste: una columna enum opcional en
  `app.routines` y un desplegable más («¿En qué momento del día?», por defecto «Cuando
  se pueda»). **Merece la pena a partir de ~8 rutinas diarias**, no antes. Desbloquea el
  despliegue de la rutina diaria de referencia en sus 5 momentos.
- **Sub-ítems de checklist.** Las tres guías rápidas son 22 comprobaciones; hoy solo
  caben como texto en `details` (máx. 1000 caracteres, `schemas.ts:753`). Tabla hija.
- **«Esta semana no toca» (equivalente de `EXDATE`).** Aditivo, sin tabla nueva:
  `ALTER TABLE app.routine_completions ADD COLUMN outcome text NOT NULL DEFAULT 'done'
  CHECK (outcome IN ('done','skipped'))`. No toca la PK ni las políticas.
- **Vacaciones.** `app.vacation_periods` existe (`0020_vacations.sql:45`) pero **no está
  conectada a rutinas**: una rutina diaria vence igual en vacaciones. Una rutina de
  audiencia `employee` que cae dentro de un periodo `recorded` no debería insistir en
  Hoy, y en el calendario de la familia debería leerse «Durante las vacaciones de X».
  Poco código, y evita el único escenario en que la app queda como pesada. Relacionado:
  `convivencia/070:18` deja pendiente el **descanso semanal**, sin el cual una rutina
  diaria dispara en el día libre.
- **`routine.uncomplete`.** Habilita el objetivo táctil de fila entera y el «Deshacer».
  Pequeño en el servidor, grande en móvil.

---

## 8 · Plan de trabajo troceado

Diez tareas. Cada una lista **su territorio de ficheros**; dos tareas sin ficheros en
común pueden repartirse sin coordinación. Las dependencias son de contenido, no de
cortesía.

### T1 · Generador de recurrencia (sin dependencias) — **empieza aquí**
**Territorio (crea):** `packages/domain/src/recurrence.ts`,
`packages/domain/src/recurrence.test.ts`; **toca:** `packages/domain/src/index.ts` (una
línea de export).
**Entrega:** los tipos `RoutineRule` y `RoutineOverduePolicy`, `occurrencesBetween`,
`pendingFor` y `cadencePhrase` (la frase en castellano de §4.1), todo puro y sobre
cadenas ISO en UTC. Cubre los casos 1–13 de §9. No toca base ni interfaz. Es la
dependencia de casi todo lo demás; sale primero y se congela su firma.

### T2 · Migración 0023 (depende de: nada; conviene tras acordar T1)
**Territorio (crea):** `packages/db/migrations/0023_routine_recurrence.sql`; **toca:**
`packages/db/scripts/migrate-with-history.test.mjs`, `packages/db/tests/010_schema_and_constraints.sql`.
**Entrega:** §2.2–2.4 y §3.1–3.3 al pie de la letra, incluida la línea
`SET CONSTRAINTS ALL IMMEDIATE;` entre el `UPDATE` y los `ALTER`, la aserción del bloque
`DO`, el `DROP`+`CREATE` de `ics_feed_events` con **reemisión de `REVOKE`/`GRANT`**, y
las dos definer nuevas. `pattern` y `anchor_on` quedan **nullables**. No toca ningún
`.ts`.

### T3 · Contrato y comandos (depende de: T1, T2)
**Territorio:** `packages/contracts/src/schemas.ts` (749-764),
`packages/server/src/commands/rhythm.ts`, `packages/server/src/rhythm.integration.test.ts`.
**Entrega:** `routineUpsertV2PayloadSchema` + `z.union` con el esquema legacy y su
traducción (§3.4); derivación de `overdue_policy` desde el patrón (§2.5), en **un solo
sitio**; `upsertRoutine` escribe las columnas nuevas y acepta `pattern: null`;
`completeRoutine` deja de llamar a `advance_routine_after_completion`, calcula el nuevo
`hint` con `pendingFor` y llama a `app.set_routine_due_hint`; rechazo
`routine_has_no_schedule`. Borra `advanceDueDate` (`rhythm.ts:47`).

### T4 · Digest de avisos (depende de: T2, T3)
**Territorio:** `apps/worker/src/` (job nuevo `routines-digest.ts` y su registro),
`packages/server/src/routine-quarterly.integration.test.ts` (reescritura),
`packages/server/src/reminders.integration.test.ts` si toca el catálogo de jobs.
**Entrega:** §5.2. **AC-25 debe seguir aserto** sobre el digest: `family` jamás incluye
a la empleada, el apoyo no recibe aviso. Digest sin nada pendiente: **no se envía
correo**. Ojo: comparte `rhythm.ts` con T3 solo en la constante `ROUTINE_DUE_JOB` —
acordadla en T3 y no la toquéis después.

### T5 · Pantalla de Rutinas (depende de: T1, T3)
**Territorio:** `apps/web/src/routes/h/[householdId]/routines/+page.svelte`,
`apps/web/src/lib/food/cadence.ts` (reescritura completa),
`apps/web/src/lib/server/food.server.ts` (solo el bloque 780-805).
**Entrega:** §4.1 completo: las cinco opciones de «¿Cuándo toca?» con revelado
progresivo, la frase `aria-live`, el agrupado de la lista, «Editar» como enlace,
`<textarea>` en Detalles, fuera «trimestre». La frase la produce `cadencePhrase` de T1;
`cadence.ts` queda como capa fina de presentación.

### T6 · Hoy (depende de: T1, T3)
**Territorio:** `apps/web/src/lib/server/today.server.ts`,
`apps/web/src/routes/h/[householdId]/today/+page.svelte`,
`apps/web/src/lib/server/snapshot.server.ts`, `apps/web/src/lib/server/fixtures.server.ts`
(solo `SnapshotRoutine`), `apps/web/e2e/today.dbe2e.ts`.
**Entrega:** §4.2 y §5.3. Incluye la **devolución de bytes**: `nextDueChip` calculado en
servidor, y borrado de `nextRoutineDue` y del `Intl.DateTimeFormat` de
`today/+page.svelte:17,45`. Añade `dueOn` a `SnapshotRoutine`. Sustituye las N filas de
decisión de `today.server.ts:308-319` por una sola. **Debe medirse el presupuesto antes
y después**; el saldo tiene que ser negativo.

### T7 · Calendario unificado (depende de: T1, T3; **no depende de T6**)
**Territorio:** `apps/web/src/routes/h/[householdId]/calendar/+page.svelte`,
`apps/web/src/lib/server/calendar.server.ts`, `apps/web/e2e/calendar.dbe2e.ts`,
`apps/web/e2e/calendar.e2e.ts`, la sección `.mini-calendar` de `apps/web/src/app.css`.
**Entrega:** §4.3 y §4.4: tira de semana, agenda por día con los dos bloques etiquetados,
chips de filtro, «Más adelante», bandas de sin conexión, casilla-botón 44×44 solo para
hoy y lo atrasado. Borra la maqueta de rejilla (`+page.svelte:223-240`). **Verifica con
la build** que el generador de T1 no cae en el chunk compartido de arranque.

### T8 · Feed ICS con RRULE (depende de: T2)
**Territorio:** `apps/web/src/routes/api/v1/ics/[token]/+server.ts`,
`packages/server/src/ics-grant.integration.test.ts`.
**Entrega:** §5.4. RRULE real cuando es fiel; ocurrencias explícitas cuando
`month_day ≥ 29`. Prueba de regresión del `GRANT` de la 0011.

### T9 · Reimportación del manual (depende de: T2, T3)
**Territorio:** `packages/db/scripts/seed-manual.mjs`,
`packages/db/content/manual/la-casa-y-sus-zonas/080-planes-semanal-quincenal-y-periodico.md`
(solo si se decide anotar el nuevo flujo), `docs/plan-import-manual-convivencia.md`.
**Entrega:** §6 completo, con las cuatro reglas de no duplicación y la prueba de doble
siembra. **No inventa cadencias.** Es la última tarea funcional y la que se puede
ejecutar contra producción con menos riesgo, porque es idempotente por construcción.

### T10 · Migración 0024 (contraer) — **después del despliegue de T1-T9**
**Territorio:** `packages/db/migrations/0024_routine_recurrence_contract.sql`,
`packages/db/tests/020_rls_matrix.sql` (línea 143: el `INSERT` con `frequency`),
`packages/contracts/src/schemas.ts` (retirar la rama legacy),
`packages/server/src/commands/rhythm.ts` (retirar la traducción).
**Entrega:** §3.5. **No se mezcla con ninguna otra tarea ni se adelanta**: separarla del
despliegue anterior es la única garantía de que un envelope offline antiguo no se pierde.

**Grafo de dependencias**

```
T1 ──┬──> T3 ──┬──> T4
     │         ├──> T5
T2 ──┘         ├──> T6
     ├──> T8   ├──> T7
     └──> T9 <─┘
                     todo ──> T10 (tras desplegar)
```

Paralelizable sin roces: `T1 ∥ T2` al principio; después `T4 ∥ T5 ∥ T6 ∥ T7 ∥ T8 ∥ T9`
—seis territorios de ficheros disjuntos— con la única precaución de acordar en T3 la
firma de `routineUpsertV2PayloadSchema` y el nombre del job antes de repartir.

---

## 9 · Casos límite y pruebas

**Generación (T1, `packages/domain/src/recurrence.test.ts`)**

1. `weekdays = [1,4]`: completar el lunes deja el jueves pendiente **en la misma
   semana**; el chip optimista dice jueves, no el lunes siguiente.
2. `days_of_week` con `repeat_every = 2` y ancla en **domingo**: la semana del ancla es
   la que empieza el lunes anterior (WKST=MO, mismo criterio que `ics.ts:501`).
3. `days_of_week` con ancla a mitad de semana: los días de esa semana anteriores al
   ancla **no** se emiten.
4. `day_of_month = 31`: enero 31 → febrero 28 (29 en bisiesto) → **marzo 31**.
   Contraprueba explícita: con `advanceDueDate` actual da 28 de marzo. Ésa es la deriva
   permanente que se arregla y la prueba debe dejarlo escrito.
5. `day_of_month = -1`: 31 ene, 28/29 feb, 31 mar.
6. `months_of_year = [6,12]` con `month_day = 1` en 2026, 2027 y un bisiesto; y el caso
   `months = [2]`, `month_day = 29`.
7. `every_n_days` con n=1 sobre el cambio de hora (25/10 y 29/03): ninguna ocurrencia
   perdida ni duplicada. Todo es `date`; ninguna función puede usar la zona del proceso.
8. `anchor_on` en el futuro: no aparece en Hoy hasta ese día.
9. `ends_on` pasado: no genera nada, no aparece, no avisa.
10. Ancla muy antigua (2019): la ventana de 400 días y el tope de 1000 fechas cortan, y
    la llamada sigue siendo barata.

**Finalización (T3)**

11. `carry`, 10 días sin hacer: Hoy muestra **una** vencida más la de hoy, no diez.
12. `skip`, 10 días sin hacer: Hoy **no** muestra vencidas.
13. Completar tarde: la ocurrencia perdida queda marcada y **la siguiente no se
    desplaza**.
14. Doble marcado de la misma ocurrencia: sigue dando `already_completed` (la PK de
    `0008:222` no cambia).
15. Editar la regla con finalizaciones ya registradas: no reviven ni se borran; las
    huérfanas dejan de pintarse.
16. Comando `complete` con un `dueOn` que ya no es ocurrencia (cliente offline con la
    regla anterior): **se acepta**.
17. Comando `complete` sobre una rutina con `pattern IS NULL`: se rechaza con
    `routine_has_no_schedule`.

**Migración y contrato (T2, T10)**

18. `migrate-with-history` con `STOP_AT = '0022_manual_adjustments.sql'`: las cuatro
    frecuencias, `quarterly × 12` (→ `repeat_every = 36`), una mensual recortada a 28 y
    una con finalización previa. Verifica el `SET CONSTRAINTS ALL IMMEDIATE`.
19. **Ninguna rutina cambia de próxima fecha por migrar**: `next_due_on` antes = después
    para las cuatro, y la primera ocurrencia generada desde `anchor_on` coincide.
20. Que la aserción de §3.3 **falle de verdad** si se corrompe el relleno a propósito.
21. Envelope antiguo (`frequency`/`intervalCount`) llegando después del despliegue:
    aceptado y traducido.
22. Reejecutar el runner sobre una base ya migrada: sin cambios (`migrate.mjs` verifica
    el sha-256).
23. Rutina con `pattern = NULL`: se guarda, aparece en `/routines`, **no** aparece en
    Hoy, ni en el snapshot, ni en el calendario, ni en el ICS, ni en el digest.

**Seguridad e integración**

24. `packages/db/tests/020_rls_matrix.sql` intacta hasta T10: la empleada no ve rutinas
    `family` (línea 340), el apoyo solo `all` (línea 395), el visor ninguna. Las
    columnas nuevas no abren nada.
25. `app_private.ics_feed_events` tras el `DROP`+`CREATE`: token válido devuelve filas,
    token revocado 404, y el `GRANT` a `casa_clara_app` sigue puesto (regresión de 0011).
26. RRULE emitida ≡ generación propia para `month_day ≤ 28` y para `-1`; ocurrencias
    explícitas para `≥ 29`.
27. AC-25 sobre el digest: audiencia `family` **jamás** incluye a la empleada; el apoyo
    no recibe aviso aunque vea la rutina.
28. Digest sin nada pendiente: **no se envía correo**.

**Interfaz y presupuesto**

29. Presupuesto de script por debajo de 122880
    (`infra/quality/lighthouserc.json:26`) con el generador **fuera** del chunk de
    arranque, y saldo **negativo** respecto de la medición previa a la ola.
30. `apps/web/e2e/mobile-overflow.dbe2e.ts` a 320 y 390 px sobre `/routines` y
    `/calendar`: sin desbordamiento horizontal con la tira de semana y los grupos de
    chips.
31. `apps/web/e2e/critical.a11y.ts`: axe sin violaciones en el calendario nuevo; la tira
    de semana anuncia «miércoles 13, 2 rutinas y 1 evento».
32. Doble siembra de `seed-manual.mjs`: `count(*)` estable y `anchor_on` sin mover.
33. Marcar hecha sin conexión: el chip dice «Guardada sin conexión · se enviará al
    volver», nunca «próxima el X».
