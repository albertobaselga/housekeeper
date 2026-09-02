# ADR 0002: vacaciones, derecho anual y días disfrutados

## Estado

Aceptado el 8 de agosto de 2026.

## Contexto

El tipo `app.compensation_balance_type` incluía `'vacation'` desde la migración
0003 y la interfaz tenía su etiqueta, pero nadie los usaba: el acuerdo no
guardaba días de vacaciones y no existía ni saldo ni registro. El propietario va
a producción con una empleada real cuyo contrato son **30 días naturales al
año**, y fijó el alcance: derecho anual en el acuerdo y saldo visible, con los
días disfrutados apuntados a mano por la familia. No hay flujo de solicitud ni
de aprobación por parte de la empleada.

## Decisión

### Dónde vive el derecho

En `app.agreement_versions.annual_vacation_days`, no en el acuerdo. Cambiar los
días es cambiar lo pactado, así que exige una versión nueva igual que el
salario; el disparador `agreement_versions_append_only` de la migración 0002 ya
rechaza cualquier `UPDATE`. El comando `agreement / set_vacation_entitlement`
apila una versión que copia el resto de los términos y solo cambia los días,
nunca hacia atrás.

Defecto 30 (mínimo legal del empleo del hogar en España). Las filas existentes
lo heredan porque es lo que de hecho se les aplicaba.

### Cómo se registran los días

Tabla nueva `app.vacation_periods`, **append-only con corrección por
anulación**, calcando `app.payments`: una fila mal apuntada no se borra ni se
reescribe; se anula con autoría, instante y motivo, se queda en el expediente y
deja de contar. El disparador rechaza el borrado, la reescritura encubierta bajo
una anulación, la «desanulación» y los periodos solapados. Anular libera el
hueco, que es justamente para lo que sirve.

RLS: escribe solo `family_admin`; leen quien administra, la familia y la propia
empleada (es su expediente). Apoyo y visor, nada.

### Por qué NO se usa el libro de compensación

`app.compensation_ledger_entries` mide minutos de tiempo compensable sin
caducidad, ligados a una jornada extra resuelta. Las vacaciones son días
naturales de un derecho que se reinicia cada 1 de enero. Meterlas ahí obligaría
a inventar una conversión día→minutos que no significa nada y a filtrar el
saldo por año sobre una vista que no lo hace. El saldo se calcula en lectura
desde el derecho vigente y los periodos apuntados.

### El exceso se permite y se enseña

Si lo disfrutado supera el derecho, el saldo queda **negativo y visible**
(«42 de 30 días disfrutados · 12 días de más»), con una nota que dice que **la
aplicación** no lo corrige sola —así, sin marca: el nombre del proyecto no se
muestra nunca a quien usa la casa—. No se rechaza el alta.

La alternativa —rechazar el periodo que no cabe— tiene un coste peor: empuja a
no apuntar los días, y un expediente que solo admite lo que cuadra deja de ser
un expediente. El número en rojo es la conversación que hay que tener entre las
partes, no un fallo del programa.

### El primer año se prorratea

El derecho del año se prorratea por los días naturales que el acuerdo cubre
dentro de ese año, tanto al empezar como al terminar. Enseñar «30 días» a quien
empezó en noviembre sería mentir con un número redondo, y esa es exactamente la
mentira que había que evitar. El redondeo es hacia arriba, a favor de quien
trabaja; con el año entero el cociente es exacto, así que el caso normal no se
infla.

El prorrateo se explica con sus números en la propia tarjeta («El acuerdo cubre
332 días de 2026, así que de los 30 días del año le tocan 28»), porque un «28»
a secas parecería un error de la aplicación.

### Un periodo a caballo del fin de año

Gasta el derecho de cada año por separado: del 24 de diciembre al 5 de enero son
ocho días de un año y cinco del siguiente, no trece del que empieza.

## Consecuencias

- El derecho solo se cambia apilando versiones, así que el historial de
  «Versiones y cambios» explica también por qué cambiaron los días.
- El saldo es derivado, no almacenado: no hay que reconciliar nada al anular ni
  al cambiar el derecho, y el 1 de enero se reinicia solo.
- Si el derecho cambia a mitad de año se aplica el de la última versión ya en
  vigor. Hay otra respuesta defendible (prorratear por tramos); se eligió la
  simple y se dejó el cambio a la vista en el historial.
- Sigue sin existir una interfaz de alta o edición completa del acuerdo: el
  único término editable desde la aplicación es el derecho de vacaciones.

---

## Enmienda (11 de agosto de 2026): que se entere, y que quede el historial

La decisión original resolvió **dónde se guardan** las vacaciones y **quién las
escribe**. Al usarlo con el hogar real aparecieron los dos huecos que quedaban,
y el propietario los cerró con una frase literal: «las vacaciones las marca el
admin hablando con la empleada, no implementes flujo de aprobación, pero sí que
la empleada tiene que poder ver que se le han aplicado vacaciones (notificación)
y poder verlas en su sección. También tiene que poder ver el histórico el admin,
para cada empleado».

### 1 · Que se entere: una marca de agua, no una tabla de avisos

Migración **0028**: `app.vacation_notice_marks`, una fila por persona con un
único dato, `seen_through` — «he visto todo lo que se había apuntado hasta este
instante». «Lo nuevo» se responde comparando ese instante con `recorded_at` y
`voided_at`, columnas que la 0020 ya guardaba.

La alternativa era una tabla de avisos con una fila por notificación. Se
descarta por tres razones acumuladas: (a) obliga a decidir qué significa que un
periodo se apunte, se anule y se vuelva a apuntar —¿tres avisos, o uno que
cambia de sentido?—; (b) crea un hecho nuevo que hay que mantener sincronizado
con el expediente, y el día que se desincronice la aplicación mentirá sobre él;
(c) la notificación al móvil que vendrá después necesita exactamente la misma
pregunta, y con la marca de agua la responde leyendo el mismo hecho.

La regla de qué es nuevo vive en el dominio (`vacationNewsSince`), no en la
pantalla, para que el aviso de dentro de la aplicación y el push de mañana no
acaben con dos definiciones distintas de «nuevo».

Tres cosas que la marca **no** es, y que su forma impide que llegue a ser:

- **No es una conformidad.** Que ella haya visto los días no significa que esté
  de acuerdo con ellos. Ninguna pantalla puede insinuarlo, y por eso no hay
  botón de «Entendido» ni nada que descartar a mano.
- **No es un registro de actividad.** Guarda un instante, el último, y se pisa a
  sí misma. No lleva disparador de auditoría —que copiaría cada actualización,
  con actor y hora, a una tabla append-only— por la misma razón que el progreso
  de lectura de la Guía (ADR de la 0026).
- **No la ve nadie más.** Tampoco quien administra. Si la empleada ha abierto o
  no la aplicación no es asunto de la casa.

Se marca al MIRAR la sección, no al pulsar nada, y con el instante que la
pantalla llegó a enseñar en vez de `now()`: unas vacaciones apuntadas mientras
la página estaba abierta siguen siendo novedad la próxima vez. La base acota esa
marca por arriba (nunca el futuro) y por abajo (nunca hacia atrás).

### 2 · Dónde vive el aviso

En **Hoy**, que es la primera pantalla, como una línea más del bloque
«Pendientes de ti» que ya existía. No es un cartel permanente ni algo que haya
que descartar en cada pantalla: se apaga solo cuando ella mira.

El bloque ya no contiene solo decisiones, así que su título dejó de ser un
literal de la plantilla y lo escribe el servidor (`decisionsTitleFor`). Titular
«Necesita tu decisión» encima de «te han apuntado vacaciones» le pediría una
aprobación que este hogar decidió no pedirle. Con novedades solas dice
«Novedades para ti»; mezcladas, «Novedades y decisiones».

El presupuesto de bytes de Hoy no sufre: el contenido del aviso es dato del
servidor, y el cambio de título **ahorra** cinco bytes (119.916 → 119.911).

### 3 · La sección y el historial son la misma pantalla

`/h/<hogar>/employment/vacaciones`, ruta propia con su propio trozo de
JavaScript. No son dos pantallas porque no son dos verdades: los periodos y los
días de cada año son los mismos mire quien mire. Lo único que cambia es cuántas
personas devuelve la RLS —a la empleada la suya, a quien administra todas— y la
voz de las frases («te quedan» / «le quedan»).

Enseña **todos los años** que cubre el contrato, incluidos los que no tienen
nada apuntado, porque un año en blanco es información y saltárselo dejaría
agujeros que parecen datos perdidos. Lo anulado sigue en la lista, marcado como
anulado, sin sumar y con su motivo.

Sin porcentajes, sin barras y sin una sola palabra que puntúe a nadie por
descansar más o menos: es historia, no evaluación.

### 4 · Lo que la familia no administradora ve, y lo que no

La RLS le devuelve los periodos (`vacation_periods_read` incluye a
`family_member`) pero **no** las versiones del contrato
(`agreement_versions_read` no la incluye). Así que ve los días apuntados y no el
derecho anual. La pantalla lo dice —«En 2026 constan 15 días»— en vez de
calcular un derecho de cero, que no sería un vacío sino una cifra inventada.

### 5 · Varias empleadas

El historial las enseña **todas**, una tarjeta por contrato visible. Es la
diferencia con la tarjeta del año en curso dentro de Contrato, que enseña una y
se cambia con el selector.

---

## Segunda enmienda (1 de septiembre de 2026): el salto de año

La decisión original resolvió **dónde se guardan** las vacaciones y **quién las
escribe**; la primera enmienda, **que se entere y que quede el historial**. Al
usarlo un año entero apareció el hueco que quedaba, y el propietario lo cerró
con dos frases literales: «hasta que se cumplan los 12 meses del inicio del
contrato, ese es el periodo en el que se calculan los días de vacaciones» y «al
saltar de año, los días no consumidos se pueden mover al año siguiente hasta una
fecha determinada; pasada esa fecha salta un aviso de compensación económica que
se puede rechazar (se pierden) o aceptar (se incorporan como días a pagar)».

### 1 · El año de vacaciones es el del contrato, no el del calendario

`vacationYearBalance` recibía un año natural y recortaba por 1-ene/31-dic. Pasa a
recibir un **año de contrato**: doce meses contados desde `agreementStartsOn`. Un
contrato que empezó el 5 de marzo de 2025 tiene su primer año del 5-mar-2025 al
4-mar-2026, y el aniversario ABRE el año nuevo.

Tres consecuencias, todas buenas:

- **Desaparece el prorrateo del primer año.** El año empieza el día del contrato,
  así que se devenga el derecho completo. El prorrateo sobrevive sólo para el
  **último** año, cuando el contrato termina a media anualidad. La decisión
  original —«el primer año se prorratea»— queda derogada por ésta; el porqué de
  aquélla (no enseñar «30 días» a quien empezó en noviembre) sigue valiendo, pero
  ahora lo resuelve el corte y no la regla de tres.
- **La pantalla cambia de voz.** Deja de decir «Vacaciones 2026» y dice el año de
  contrato con sus fechas: «Segundo año · 5 mar 2026 – 4 mar 2027». Sin las
  fechas, el ordinal no le dice nada a quien lo lee.
- **Un aniversario clavado.** Doce meses después de un 29 de febrero es el 28 de
  febrero, y los años se cuentan siempre desde la fecha ORIGINAL del contrato,
  nunca encadenando uno sobre el anterior: si no, el aniversario de un contrato
  firmado un 29 de febrero se iría desplazando y no volvería nunca a su día.

También se añade lo que faltaba para responder la pregunta que de verdad se hace
quien administra a mitad de año: **los días devengados a día de hoy**,
proporcionales dentro del año de contrato, con la fecha **inyectada** y no leída
del reloj. Son dos cifras distintas y las dos son ciertas: *lo que quedará al
terminar el año* (derecho − disfrutados) y *lo disponible ahora mismo*
(devengado − disfrutados). Mezclarlas hace mentir a la pantalla. La segunda puede
salir **negativa**, y no es un error: son vacaciones disfrutadas por adelantado,
lo normal cuando se dan en agosto y el año de contrato acaba en marzo. Se enseña
como un anticipo, no como una alarma, y sólo cuando ocurre.

El devengo se divide por los días que el acuerdo **cubre** de ese año, no por los
del año entero. La diferencia sólo aparece en el último año de un contrato que
termina a media anualidad, pero ahí es grande: el derecho de ese año ya viene
prorrateado por el final del contrato, y dividir además por el año completo lo
descontaría **dos veces**.

### 2 · Tabla nueva, y por qué no columnas

Migración **0035**: `app.vacation_carryovers`. Un arrastre no cabe en nada de lo
que ya existía:

- `app.vacation_periods` guarda días **disfrutados**; un arrastre no es un
  periodo disfrutado.
- `app.agreement_versions` guarda lo **pactado**, y además es inmutable; un
  arrastre es un hecho de un año concreto, no un cambio de contrato.
- Un cálculo derivado tampoco vale, y ésta es la razón de fondo: **un derivado no
  puede recordar que alguien dijo que no**. Antes de la 0035 el derecho se
  reiniciaba por aritmética y la casa no podía distinguir «se decidió que se
  perdían» de «a nadie se le ocurrió mirarlo».

Es un hecho con decisión, autoría, motivo y consecuencia económica, así que se
construye con el mismo patrón append-only que los periodos (0020) y los conceptos
(0022): disparador que prohíbe el DELETE, transiciones tasadas, auditoría y
cerrojo consultivo por (acuerdo, año de contrato) en el **espacio de nombres 6**,
que estaba libre. Sin ese cerrojo, dos administradores aceptando a la vez
generarían dos conceptos por los mismos días.

`app.manual_adjustments` estrena `vacation_carryover_id` para cerrar la cadena de
procedencia por los dos extremos, y eso obligó a **reescribir**
`app.enforce_manual_adjustment_append`, que enumera columna a columna lo que la
anulación no puede tocar. Sin ese repaso, anular un concepto habría sido una
puerta para mover un pago de vacaciones de un año a otro sin dejar rastro.

### 3 · Por qué los días van congelados

Al decidir se guardan los días con derecho, los disfrutados, los no disfrutados,
el año de contrato con sus fechas, la versión del acuerdo, el importe y la frase
que lo explica. **Nada de eso se recalcula nunca al leer.**

Si en marzo se anula un periodo del año anterior, la propuesta que alguien vio y
decidió —y que quizá ya se pagó— no puede cambiar debajo. Es el mismo criterio
que ya siguen la nota de aplazamiento de los conceptos (0022) y las tarifas
congeladas de la jornada extra, y aquí importa más que en ninguno de los dos,
porque detrás hay una transferencia a una persona real.

Lo que **no** se congela es cuándo aparece la propuesta: **se calcula al leer** y
la fila sólo se escribe al decidir. No hace falta ni trabajo periódico ni
disparador por calendario —ninguno de los dos existe en esta casa—, y el cálculo
es reproducible desde los periodos, que sí son append-only. La propuesta aparece
**en cuanto termina el año de contrato**, no en la fecha límite: avisar cuando ya
no se pueden disfrutar sería avisar tarde.

### 4 · Por qué NO se reutiliza la marca de agua de 0028

`app.vacation_notice_marks` guarda un instante que se pisa a sí mismo, sin
auditoría, y esta misma ADR dice tres cosas que la marca **no** es —y la primera
es que **no es una conformidad**. Colar en ella una decisión sobre días y dinero
insinuaría exactamente la aprobación que el hogar decidió no pedirle a la
empleada, y rompería la razón de existir de la marca.

Por lo mismo, el arrastre no entra en `vacationNewsSince`: el aviso de la empleada
sigue contando lo que le han apuntado o anulado, y nada más.

### 5 · Qué eligió el propietario en cada punto

- **Margen de caducidad:** seis meses desde el fin del año de contrato por
  omisión, otro número de meses si se pacta, o «nunca expiran». Va en
  `agreement_versions.terms` y no en una columna porque es política pactada con
  forma propia. **Ausente = seis meses**, así que ningún contrato ya firmado hubo
  que tocarlo.
- **Precio del día:** *«el precio del día de vacaciones no disfrutado tiene otro
  valor que se cierra en el contrato, no se auto calcula»*. Es una tarifa más de
  las condiciones (`unused_vacation_day_rate_cents`, migración 0034), hermana del
  precio de la hora extra y del día de descanso trabajado. **La columna es
  NULLABLE a propósito:** vacía dice «no se pactó», que es la verdad de los
  contratos anteriores; un cero por omisión dejaría escrito en una tabla inmutable
  que se acordó pagar cero euros por día. **Sin tarifa pactada no hay
  compensación**: la pantalla ofrece arrastrar o rechazar, y para compensar dice
  lo que falta y lleva a pactarlo. No se estima, no se deduce del salario, no se
  pone cero.
- **Qué versión fija cada cosa:** el **derecho** del año que se cierra lo fija la
  versión vigente al terminar aquel año —subir hoy los días pactados no reescribe
  un año ya vivido—, y con él viaja la política de caducidad, porque el margen es
  de esos días. El **precio** lo fija la versión vigente **al decidir pagar**,
  porque el dinero es del mes en que se paga; la frase congelada deja constancia
  de desde cuándo regía esa tarifa, y eso es lo que la hace comprobable dentro de
  dos años.
- **Quién decide:** quien administra la casa (`family_admin`), como todo lo demás
  del contrato. La empleada lo ve, no lo decide. Es coherente con la decisión ya
  tomada aquí de que no hay flujo de aprobación por su parte.
- **Quién lo lee:** administración y la propia empleada
  (`employee_row_visible(..., false)`, como los conceptos de 0022 y **no** como
  los periodos de 0020). La fila lleva importe, y los importes de esta casa no
  llegan a la familia no administradora.
- **Cómo llega a la nómina:** aceptar la compensación crea, **en la misma
  transacción**, un concepto a mano («Vacaciones del segundo año no disfrutadas»)
  con el importe y la frase como motivo, enlazado con el arrastre en las dos
  direcciones. Si el mes que toca ya está cerrado se aplaza al primer mes abierto
  con su nota, como cualquier concepto.
- **Cómo se enseñan los días arrastrados:** como **línea aparte**, nunca sumados
  al derecho del año siguiente. Un «48» se lee como un error de la aplicación.
- **Dónde aparece la decisión:** una tarjeta en la pestaña Vacaciones y **un
  elemento más** de la lista de decisiones de Hoy, con el texto escrito por el
  servidor. En Hoy no cabe una rama nueva de plantilla: el presupuesto de bytes
  del arranque está medido y se comprueba en cada rama.

### 6 · Lo que queda fuera, a propósito

- **Avisar a la empleada por el móvil.** El canal existe pero su catálogo de temas
  es cerrado, y mezclar el arrastre con la marca de agua rompería lo dicho en el
  punto 4.
- **Vencer solo los días arrastrados.** El estado `expired` y el paso
  `carried → expired` están definidos y guardados por el disparador, pero hoy
  nadie los escribe: haría falta un trabajo por calendario que esta casa no tiene.
  Mientras tanto, un arrastre pasada su fecha límite se sigue viendo con la fecha
  que tenía, que es la verdad.
- **Partir la decisión** («arrastro diez y me pagas ocho»). Obligaría a dos
  contadores donde hoy hay uno; no se ha pedido.
