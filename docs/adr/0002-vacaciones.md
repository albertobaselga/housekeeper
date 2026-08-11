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
(«42 de 30 días disfrutados · 12 días de más»), con una nota que dice que Casa
Clara no lo corrige sola. No se rechaza el alta.

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
