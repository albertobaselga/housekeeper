# Contrato, segunda vuelta — plan de implementación

Diseño que manda: [docs/ux/contrato-feedback-v2.md](../../ux/contrato-feedback-v2.md).
Investigación de partida: `/tmp/claude-1000/propuestas/inv-0.md` … `inv-5.md`.

**Goal:** llevar a producción los ocho puntos del feedback de uso del expediente
de empleo, incluido el cambio del año de vacaciones al año de contrato con
arrastre y compensación económica.

**Arquitectura:** cinco tareas repartidas en tres tandas. El reparto NO es por
temas sino por **ficheros que se tocan**, porque `apps/web/src/lib/employment/model.ts`
y `apps/web/src/lib/server/employment.server.ts` los necesitan casi todas y dos
agentes editándolos a la vez se pisan. Dentro de una tanda no hay dos tareas que
escriban el mismo fichero.

## Restricciones globales (valen para las cinco tareas)

- Node >= 24: anteponer `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`.
- **El dinero es BigInt de céntimos de extremo a extremo.** `parseCents` /
  `formatCents` de `packages/domain/src/money.ts`. Nunca `Number`, nunca coma
  flotante, ni siquiera para un intermedio.
- **CSS sólo con tokens.** `apps/web/scripts/lint-css-tokens.mjs` rechaza
  longitudes, colores y `font-weight` a pelo, también dentro del `<style>` de un
  `.svelte`. Ninguna frase por debajo de 14 px.
- **Nada de `$app/state` ni `$app/stores` en las páginas.** Lo que viene de la
  URL lo pasa el `load`.
- **Sin `<svelte:head><title>`**: el título lo pone `app-title.ts`.
- Toda ruta anidada nueva se declara en `NESTED_ROUTE_CAPABILITY`
  (`apps/web/src/lib/auth/routing.ts`) o falla cerrada.
- Castellano en textos, comentarios y mensajes de commit.
- **El presupuesto de bytes del arranque de Hoy son 120.000** y quedan ~1.500 de
  margen: `pnpm --filter @casa-clara/web verify:bundle` tiene que seguir pasando.
- Antes de dar una tarea por terminada: `pnpm typecheck`, `pnpm lint` y los tests
  del paquete tocado, ejecutados de verdad, con la salida leída.
- Commits pequeños en castellano, uno por pieza con sentido propio.

---

## Tanda 1 — tres tareas en paralelo

### Tarea A — Conceptos limpios y Resumen sin ruido

Cubre los puntos 1, 2 y 3 del feedback. Fuente: `inv-0.md` y `inv-4.md`.

**Ficheros suyos** (ningún otro agente los toca en esta tanda):
- `apps/web/src/lib/server/employment.server.ts`
- `apps/web/src/lib/employment/model.ts`
- `apps/web/src/lib/components/employment/ManualAdjustmentsCard.svelte`
- `apps/web/src/routes/h/[householdId]/employment/conceptos/+page.svelte`
- `apps/web/src/routes/h/[householdId]/employment/+page.svelte`
- `apps/web/tests/manual-adjustments-settled.integration.test.ts`
- `docs/manual/index.html` (sólo la sección de confirmación independiente)

**Qué hace:**
1. El filtro de los ajustes ya aplicados y de los anulados sube al servidor: no
   llegan a la página. La subconsulta `settledPeriod` que ya existe dice cuáles
   son. Al hacerlo, `ManualAdjustmentsCard` se queda sin necesidad de partir la
   lista en pendientes y aplicados: se retira el `<details class="settled-trail">`.
2. La ventana de historial baja de 12 meses a 3.
3. Conceptos queda con exactamente tres bloques: pendientes de acordar o
   compensar, gastos pendientes, e importes sueltos del mes.
4. En el Resumen se retiran las **dos** apariciones del rótulo «Confirmación
   independiente»; lo que explicaba pasa a una frase junto al formulario de
   Pagos y se reescribe en el manual.
5. «Última cuenta» salta las anuladas, y no se pinta cuando la última es una
   cuenta abierta sin importe.
6. El enlace del Resumen al origen de un importe aplicado apunta al mes de
   Pagos, no a Conceptos.
7. La construcción de `?empleada=<id>`, hoy repetida a mano en cuatro sitios, se
   unifica en un único constructor junto a `sourceAnchor`.

**Prueba que lo demuestra:** ampliar la de integración que ya existe para que
compruebe que un ajuste con nómina cerrada detrás **no llega** al modelo (hoy
comprueba que llega marcado), y que uno anulado tampoco.

### Tarea B — Pagos como tabla plegable por meses

Cubre los puntos 5 y 6. Fuente: `inv-2.md`.

**Ficheros suyos:**
- `apps/web/src/routes/h/[householdId]/employment/pagos/+page.svelte`
- `apps/web/src/routes/h/[householdId]/employment/pagos/+page.server.ts`
- `apps/web/src/lib/employment/pagos.ts` **(nuevo)** — aquí va toda la lógica de
  agrupar por meses y dar forma a las filas.
- `apps/web/tests/` — prueba nueva del módulo anterior.

**Límite duro:** esta tarea **no toca `model.ts` ni `employment.server.ts`**. Lo
que necesite derivar lo deriva en `pagos.ts` a partir de lo que el `load` ya
recibe.

**Qué hace:**
1. Un `<details>` por mes, plegado, **sin `name`** (plegado libre, no acordeón
   exclusivo). Fila cerrada: mes, estado, importe y descarga.
2. El botón de descarga vive en la fila cerrada, con «PDF» visible y el nombre
   completo en `aria-label`. Tiene que caber a 320 px.
3. La frase del botón de abrir la cuenta se reescribe: hoy dice que «se cierra a
   revisión y deja de sumar solo», que es falso. Debe decir que se crea el
   borrador del mes, que la fecha de vencimiento **no se podrá cambiar después**,
   y que lo que se apunte más tarde sigue entrando hasta que se cierre.

### Tarea C — El año de vacaciones pasa a ser el año de contrato

Primera mitad del punto 4. Fuente: `inv-1.md`, apartado 4.1 del diseño.

**Ficheros suyos:**
- `packages/domain/src/vacations.ts`
- `packages/domain/src/vacations.test.ts`
- `apps/web/src/lib/employment/vacation-history.ts`
- `apps/web/tests/vacation-history.test.ts`

**Límite duro:** dominio y frases. **No** toca migraciones, ni comandos, ni
`model.ts`, ni las páginas. La tarea E se apoyará en lo que ésta deje.

**Qué hace:**
1. `vacationYearBalance` deja de recibir un año natural y pasa a recibir un
   **año de contrato**: periodos de doce meses desde `agreementStartsOn`. Hace
   falta un ayudante que, dada la fecha de inicio del acuerdo y un índice (1, 2,
   3…), devuelva `{ index, startsOn, endsOn }`, y otro que diga en qué año de
   contrato cae una fecha.
2. Desaparece el prorrateo del primer año (por construcción empieza el día del
   contrato). Sobrevive el del último año cuando el contrato termina a media
   anualidad.
3. `vacationDaysInYear(period, year)` se generaliza a una ventana `[from,
   through]`, porque el corte ya no es 1-ene/31-dic.
4. Las frases del historial dicen el año de contrato **con sus fechas**:
   «Segundo año · 5 mar 2026 – 4 mar 2027». Sin fechas el ordinal no significa
   nada.
5. La compensación, que **no calcula ningún precio**: el importe por día de
   vacaciones no disfrutado se pacta en el contrato (apartado 4.4 del diseño,
   corregido por el propietario). La función recibe la tarifa **como parámetro**
   y hace `compensación = tarifa pactada × días no disfrutados`, en BigInt de
   céntimos. **Sin tarifa pactada devuelve la ausencia, nunca un importe
   estimado ni un cero.** La frase congelada dice de dónde sale el precio, no
   cómo se calculó: «18 días sin disfrutar × 46,15 € por día, pactados en las
   condiciones vigentes desde el 5 de marzo de 2026 = 830,70 €».

7. **Los días devengados a día de hoy** (apartado 4.1 bis del diseño), pedido en
   la segunda ronda: `accruedDays` proporcional dentro del año de contrato con la
   fecha **inyectada**, y `availableNowDays = accruedDays − takenDays`, que
   **puede ser negativo** cuando se han disfrutado días por adelantado, y no por
   eso es un error. No confundirlo con `remainingDays`, que es lo que quedará al
   terminar el año: son dos cifras distintas y las dos son ciertas. La frase lleva
   siempre la fecha; sin ella el número no significa nada.

**Pruebas:** las 290 líneas de `vacations.test.ts` se adaptan, no se tiran.
Casos nuevos obligatorios: contrato empezado un 29 de febrero; periodo a caballo
de dos años de contrato; último año prorrateado; el devengo a una fecha dada,
incluida una anterior al inicio y otra posterior al fin; un saldo disponible
negativo por días disfrutados por adelantado; la compensación con tarifa pactada;
**la compensación sin tarifa pactada, que no devuelve importe**; y que ningún
camino del dinero pase por `Number`.

---

## Tanda 2 — una sola tarea (toca los mismos ficheros que la A)

### Tarea D — La portada manda, el alta sale de ella, Contrato se airea

Cubre los puntos 7 y 8. Fuente: `inv-3.md` e `inv-5.md`.

**Ficheros suyos:**
- `apps/web/src/routes/h/[householdId]/employment/+page.server.ts` y `+page.svelte`
- `apps/web/src/routes/h/[householdId]/employment/acuerdo/+page.svelte`
- `apps/web/src/routes/h/[householdId]/employment/alta/` **(nueva ruta)**
- `apps/web/src/lib/components/employment/StaffHireForm.svelte`
- `apps/web/src/lib/server/staff-hire.server.ts`
- `apps/web/src/lib/auth/routing.ts`
- `apps/web/src/routes/h/[householdId]/personal/+page.svelte`
- `apps/web/src/lib/employment/model.ts` (`buildPortadaView`)
- `apps/web/src/lib/server/employment.server.ts` (`loadEmploymentPortada`)

**Qué hace:**
1. La portada aparece **siempre** para quien administra, también con cero o una
   empleada. Hoy sólo con más de un acuerdo, y por eso el alta no se alcanza.
2. Pendiente = cuentas **cerradas** con importe sin pagar, y nada más. Sin deuda
   el encabezado dice «Al día», no «0,00 €».
3. La familia no administradora ve la lista y el camino a cada expediente, sin
   una cifra y sin el alta.
4. La persona cuyo contrato terminó se distingue de la que acaba de llegar.
5. Alta en `/employment/alta`, en dos etapas —la persona, luego el contrato—,
   con llave `access.manage` **declarada en `routing.ts`**. Al terminar se entra
   al expediente recién creado. Se ofrecen las dos clases de persona diciendo que
   el apoyo del hogar no genera contrato.
6. El formulario de alta desaparece de la pestaña Contrato y de Personal;
   Personal enlaza al único que queda.
7. La pestaña Contrato se queda con las condiciones vigentes aireadas, un único
   camino llamado **«Cambiar las condiciones»** que explica que se apilan con
   fecha de aplicación, y el historial de versiones plegado. El `h1` sigue siendo
   «Condiciones del contrato» (lo esperan `app-title.ts` y dos pruebas).
8. **Las dos condiciones nuevas del contrato, con su migración `0034`**, que se
   mueven aquí desde la tarea E: son condiciones pactadas, y quien rediseña la
   pantalla del contrato es quien tiene que poder pactarlas.
   - `app.agreement_versions.unused_vacation_day_rate_cents` — el importe por
     día de vacaciones no disfrutado (apartado 4.4 del diseño). `bigint`,
     `CHECK (>= 0)`, **NULLABLE**: vacía significa «no se pactó», que es la
     verdad de los contratos ya firmados, y un cero por omisión dejaría escrito
     en una tabla inmutable que se acordó pagar cero euros por día. El trigger
     `enforce_agreement_version_append_only` no enumera columnas —sólo prohíbe
     todo lo que no sea INSERT—, así que añadirla no obliga a reescribirlo.
   - La **política de caducidad** de los días arrastrados en
     `agreement_versions.terms` (apartado 4.2): seis meses por omisión, otro
     número de meses, o «nunca expiran». Ausente = seis meses, así que ningún
     contrato existente se toca.
   Las dos son **obligatorias en «Cambiar las condiciones» y opcionales en el
   alta**, como ya lo son el catálogo de trabajo extra y los complementos.
   Cuando la tarifa no está pactada se dice que no está: nunca un cero.

---

## Tanda 3 — una sola tarea (se apoya en C y toca model.ts)

### Tarea E — Arrastre de vacaciones y compensación económica

Segunda mitad del punto 4. Fuente: `inv-1.md`, apartados 4.2 a 4.4 del diseño.

**Ficheros suyos:**
- `packages/db/migrations/0034_vacation_carryover.sql` (nueva)
- `packages/contracts/src/schemas.ts` (política en `agreementTermsInputSchema`,
  y las acciones nuevas del comando)
- `packages/server/src/commands/vacation.ts`
- `apps/web/src/lib/server/vacations.server.ts`
- `apps/web/src/lib/server/today.server.ts`
- `apps/web/src/lib/employment/model.ts` (`buildVacationView`)
- `apps/web/src/lib/employment/commands.ts`
- `apps/web/src/routes/h/[householdId]/employment/vacaciones/`
- Las pruebas de integración de vacaciones y de conceptos.

**Qué hace:**
1. Migración 0034 con `app.vacation_carryovers`: estados `proposed` → `carried`
   | `compensated` | `rejected`, y `carried` → `compensated` | `expired`.
   Append-only con el mismo patrón que 0020 y 0022: trigger que prohíbe el
   DELETE, enumera columna a columna lo que no puede cambiar, toma cerrojo
   consultivo en el **espacio de nombres 6** (verificado libre) y escribe
   auditoría. Lectura para administración y para la propia empleada
   (`employee_row_visible(..., false)`: la fila lleva importe y los importes no
   llegan a la familia no administradora). Escritura sólo `family_admin`.
   `GRANT SELECT, INSERT, UPDATE`, sin DELETE.
2. En la misma migración, `app.manual_adjustments` gana `vacation_carryover_id`
   con su clave ajena — y hay que **reescribir `app.enforce_manual_adjustment_append`**
   para incluirla, o la anulación podría colar un cambio en ella.
   **Trampa conocida de esta casa:** `FORCE ROW LEVEL SECURITY` va al final del
   fichero, después de cualquier función `SECURITY DEFINER` que nombre la tabla,
   o la migración es imposible de aplicar en Supabase.
3. La política de caducidad entra en `agreement_versions.terms`: seis meses por
   omisión, otro número de meses, o «nunca expiran». Ausente = seis meses, así
   que ningún contrato existente se toca.
3 bis. **La tarifa del día de vacaciones no disfrutado** (apartado 4.4 del
   diseño): columna nueva en `app.agreement_versions`, hermana de
   `overtime_hourly_rate_cents` y `worked_rest_day_rate_cents`, `bigint` con
   `CHECK (>= 0)` y **NULLABLE**. Vacía significa «no se pactó», que es la
   verdad de los contratos ya firmados; un cero por omisión dejaría escrito en
   una tabla inmutable que se acordó pagar cero euros por día. El trigger
   `enforce_agreement_version_append_only` **no enumera columnas** (sólo prohíbe
   todo lo que no sea INSERT), así que añadirla no obliga a reescribirlo —al
   revés que en `manual_adjustments`. Sin tarifa pactada, la pantalla ofrece
   arrastrar o rechazar, y para compensar dice lo que falta y lleva a pactarlo;
   nunca estima un importe. Pásale el nombre exacto de la columna a la tarea D,
   que la pide en el formulario.
4. Tres acciones nuevas del comando de vacaciones: arrastrar, compensar y
   rechazar con motivo obligatorio. Compensar crea el concepto a mano **en la
   misma transacción**, con el importe y la frase congelados, y enlaza las dos
   direcciones. Si el mes ya está cerrado, se aplaza al primer mes abierto con su
   nota, como cualquier concepto. Guarda de rol `family_admin`.
5. La propuesta se **calcula al leer** y sólo se escribe la fila al decidir.
6. Tarjeta en la pestaña Vacaciones con las tres salidas, y una línea de decisión
   en Hoy para quien administra: **un elemento más de la lista, con el texto
   escrito por el servidor**, sin ninguna rama nueva en la plantilla, porque el
   presupuesto de bytes no lo aguanta.
7. Los días arrastrados se enseñan como línea aparte, no sumados al derecho.
   En la misma pantalla va **el devengo a día de hoy** que deja calculado la
   tarea C (`accruedDays` / `availableNowDays`): «Devengados a 1 de septiembre:
   15 de 30 días», con la fecha siempre dicha, y la nota de días disfrutados por
   adelantado **sólo cuando los haya**. Es un dato pedido expresamente por el
   propietario; que no se quede en el dominio sin llegar a la pantalla.
8. Segunda enmienda del ADR `docs/adr/0002-vacaciones.md` explicando el año de
   contrato, por qué tabla nueva, por qué los días van congelados, por qué no se
   reutiliza la marca de agua de 0028, y qué política eligió el propietario.

**Pruebas obligatorias:** la fila no se mueve si se anula un periodo del año
origen después de decidir; dos decisiones simultáneas no generan dos pagos; la
empleada y la familia no administradora no escriben; el concepto creado por un
arrastre; y el salto de año con `now` inyectado (`loadVacationOverview` ya lo
acepta).

---

## Un hueco del reparto, y cómo se tapó

El reparto por ficheros tenía un agujero que sólo se vio al ejecutarlo: la tarea C
cambia la firma de `vacationYearBalance`, sus **llamadas** viven en `model.ts` y
en `employment.server.ts`, y esos dos ficheros estaban asignados a la tarea A en
la tanda 1 pero el arreglo estaba escrito en la tarea E, de la tanda 3. Con ese
reparto, **la tanda 1 no podía cerrar en verde por construcción**: seis errores de
tipos y cinco pruebas rojas se quedaban esperando dos tandas.

Se tapó dándole a la tarea A la adaptación mínima —la firma nueva y las frases
con `contractYearLabel`—, y dejándole a E lo que de verdad es suyo: pintar el
devengo, la nota de anticipo y la tarjeta del arrastre.

La lección para el próximo reparto: cuando una tarea cambia una **firma**, el
reparto tiene que seguir a sus llamantes, no sólo a su fichero. Repartir por
ficheros no basta si la unidad que se rompe es un contrato entre módulos.

## Cabos sueltos anotados durante la ejecución

- **La densidad de Pagos aguanta con dos cuentas, no con tres.** La batería A6
  exige `min(3, total)` filas visibles en la primera pantalla. A 320×568 quedan
  277 px de lista y una tercera fila pediría 291. No es maquillable: la fila mide
  97 px porque a ese ancho el distintivo de estado no cabe en la misma línea que
  el importe, y por encima hay 105 px de barra de persona más pestañas. **Si
  alguien siembra una tercera liquidación en las fixtures, esta ruta empieza a
  fallar.** La salida honesta entonces es paginar el historial —que este diseño
  dejó fuera a propósito— o aligerar el cromo de las pestañas; **no** rebajar A6.
- **Cobertura de densidad y desbordamiento para Pagos.** *(Hecho: la ruta entró en
  las dos baterías, y la primera ejecución encontró un defecto real que habíamos
  metido nosotros — un pie de tarjeta de 96 px que empujaba la tabla fuera de la
  primera pantalla, justo el defecto que la tabla venía a arreglar.)* `apps/web/e2e/mobile-densidad.dbe2e.ts`
  y `mobile-overflow.dbe2e.ts` recorren una lista de rutas y hoy no incluyen
  `employment/pagos`. La tabla plegada ya trae `data-lista="principal"` y `.cifra`,
  o sea que esas baterías la medirían solas con sólo añadir la ruta. Se midió a
  mano a 320 px y no desborda, pero sin la ruta en la lista nada lo guarda de una
  regresión futura. Va en el cierre.
- **Las capturas del manual**: `apps/web/scripts/manual-shots.mjs` buscaba
  rótulos que el rediseño en pestañas ya había mudado de ruta, así que el manual
  publicado llevaba desde entonces ilustrado con capturas de pantallas que ya no
  existían. Asignado a la tarea A, que es quien reescribe los pies.
- **`app.css`**: el bloque de la fila de mes vive en el `<style>` del `.svelte`.
  Pasa el mismo linter de tokens. Si se quiere consolidar en `app.css`, se mueve
  tal cual.

## Cierre

Con las tres tandas dentro: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm --filter @casa-clara/web verify:bundle` y la batería de base de datos.
Después, merge a `main`, despliegue y **aplicar la migración 0034 en Supabase por
conexión directa al 5432** (el pooler del 6543 no conserva los cerrojos de
sesión que necesita el runner).
