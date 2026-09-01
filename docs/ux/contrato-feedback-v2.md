# Contrato — segunda vuelta: decisiones sobre el feedback de uso

Fecha: 1 de septiembre de 2026.
Antecedente: [rediseno-contrato-en-pestanas.md](rediseno-contrato-en-pestanas.md), ya en producción.

Quien administra la casa usó las cinco pestañas durante unos días y señaló ocho cosas.
Este documento las convierte en decisiones. No es una lista de ideas: cada apartado
dice qué se hace, qué NO se hace y por qué, para que quien lo implemente no tenga
que adivinar.

El criterio que atraviesa las ocho: **una pantalla enseña lo que todavía hay que
decidir; lo ya decidido se consulta en su sitio, no estorba en el camino.** Casi
todos los defectos señalados son incumplimientos de esa frase.

---

## 1. Conceptos: lo aplicado no llega a la página

**Lo señalado:** «si ya se aplicó en agosto, pues desaparece de esta página».
Plegarlos en un `<details>` no basta: siguen estando.

**Decisión.** El filtro sube al servidor. `loadEmploymentOverview` deja de traer
los ajustes que ya tienen una nómina cerrada detrás (la subconsulta `settledPeriod`
que se añadió para el arreglo anterior ya sabe cuáles son) y deja de traer los
anulados. Con eso, `ManualAdjustmentsCard` no necesita partir nada: lo que le
llega es, por construcción, lo que queda por resolver.

La página queda con exactamente tres bloques, en este orden:

1. **Pendientes de acordar o compensar** — jornada extra y días de descanso
   trabajados que aún no se han pactado.
2. **Gastos pendientes** — los adelantados por la empleada que la casa no ha
   devuelto.
3. **Importes sueltos del mes** — los conceptos a mano imputados al mes en curso
   que todavía no se han cerrado.

**Ventana de historial: de 12 meses a 3.** Los 12 meses existían para enseñar
historial. El historial se mudó a la pestaña Pagos en el rediseño anterior, así
que aquí sólo sirven para arrastrar cosas viejas. Lo único que puede quedar
antiguo tras el filtro es un pendiente que nunca se cerró, y tres meses lo
alcanzan de sobra.

**El enlace huérfano del Resumen.** Hoy el Resumen enlaza el origen de cada
importe a Conceptos con un ancla. Si el concepto ya no está en Conceptos, el
enlace lleva a una página que no lo tiene. Se corrige a la vez: cuando el ajuste
está aplicado, el Resumen enlaza al mes correspondiente de **Pagos**, que es
donde ha pasado a vivir.

**Lo que NO se hace:** no se toca la vista de la empleada más allá del mismo
filtro (ve lo mismo que la administración, sin los botones), y no se inventa un
archivo de conceptos: el archivo es Pagos.

---

## 2. Resumen: se retira la tarjeta huérfana y se arregla «Última cuenta»

**Lo señalado:** «Confirmación independiente» no aporta nada, y no está claro qué
sale en «última cuenta pagada / cobro sin confirmar» ni si los enlaces están bien.

**Decisión.**

**«Confirmación independiente» se retira.** No es una tarjeta a medio hacer: es el
rótulo que quedó huérfano cuando se borró su botón el 7 de agosto (3a3b0a1), y
está duplicado en dos sitios de la misma plantilla. Ninguna prueba lo cubre. Lo
que explicaba —que quien cobra confirma por su cuenta, y que pagar y confirmar
son dos hechos distintos— es cierto e importante, así que no se pierde: pasa a
ser una frase junto al formulario de Pagos, que es donde se actúa. En el manual
se reescribe en el mismo sentido, dejando de anunciar una tarjeta que ya no
existe.

**«Última cuenta» se blinda y se calla cuando no tiene nada que decir.**
Hoy toma `settlements[0]` sin mirar el estado, con dos consecuencias: si algún
día existe la anulación de una cuenta, enseñará la anulada como si fuera la
última real; y cuando la cuenta del mes en curso está recién abierta, repite lo
que ya dice el devengo («Sin cerrar» junto a «Periodo abierto») sin ningún
importe, que es exactamente el ruido señalado. Se arregla:

- Se salta las anuladas al elegir cuál es la última.
- Si la última es una cuenta **abierta y sin importe**, la tarjeta no se pinta:
  el devengo del mes ya lo cuenta mejor.
- Cuando está pagada y el cobro confirmado, la tarjeta se queda, en verde, como
  acuse de recibo. Cuesta una línea y cierra el círculo.

**Los enlaces.** La cadena `?empleada=<id>` se construye hoy en cuatro sitios
distintos a mano. Se unifica en el ayudante que ya existe para las anclas
(`sourceAnchor`), del que sale un único constructor de destinos. Es barato y
quita la clase entera de fallo.

---

## 3. Pagos: una tabla operativa, no una lista infinita

**Lo señalado:** debería estar colapsado por meses, con el detalle al expandir y
la descarga del documento por cada mes. Y «Empezar la cuenta de septiembre 2026»
no se entiende.

**Decisión.**

**Cada mes es una fila plegada.** Fila cerrada: mes, estado, importe y el botón
de descarga. Al desplegar aparece el detalle que hoy ocupa la pantalla entera:
líneas, pagos, fechas y motivos. El plegado es **libre, no exclusivo** —se pueden
tener dos meses abiertos para compararlos—, porque comparar dos meses es una cosa
que quien administra hace de verdad al revisar una discrepancia.

**La descarga no exige desplegar.** El botón vive en la fila cerrada, con el
texto visible «PDF» y el nombre completo en `aria-label` («Descargar el documento
de pago de agosto de 2026»). Es lo único que cabe en la fila a 320 px sin robarle
ancho al importe.

**El botón de abrir la cuenta dice lo que hace.** «Empezar la cuenta de
septiembre 2026» pasa a explicar en una frase debajo qué significa: que se crea
el borrador del mes con lo que lleva devengado, que se le pone fecha de
vencimiento —**y que esa fecha luego no se puede cambiar**, porque hoy no existe
ningún comando para corregirla—, y que abrirla **no congela nada**: lo que se
apunte después sigue entrando. La frase actual dice lo contrario («se cierra a
revisión y deja de sumar solo») y es sencillamente falsa; corregir el texto es
todo lo que hace falta, porque el congelado de verdad ocurre al cerrar.

**Lo que NO se hace:** no se pagina el historial. El servidor sigue trayendo
todos los meses; plegados caben de sobra. Queda anotado que el día que una casa
pase de unos cinco años habrá que traer sólo las cabeceras y pedir el detalle al
desplegar.

---

## 4. Vacaciones: el año es el del contrato, y los días no se pierden en silencio

**Lo señalado:** al saltar de año, los días no consumidos se pueden mover al año
siguiente hasta una fecha determinada; pasada esa fecha salta un aviso de
compensación económica que se puede rechazar (se pierden) o aceptar (se
incorporan como días a pagar en el mes que toque).

Es el cambio grande de esta vuelta, y trae una decisión de fondo que reordena el
módulo entero.

### 4.1 El año de vacaciones deja de ser el año natural

**Decisión del propietario, literal:** «hasta que se cumplan los 12 meses del
inicio del contrato, ese es el periodo en el que se calculan los días de
vacaciones».

Hoy el dominio calcula por **año natural** (`vacationYearBalance` recibe un
`year` y recorta por 1-ene/31-dic, prorrateando el primer y el último año). Pasa
a calcular por **año de contrato**: periodos de doce meses contados desde
`agreementStartsOn`. Un contrato que empezó el 5 de marzo de 2025 tiene su
primer año del 5-mar-2025 al 4-mar-2026, el segundo del 5-mar-2026 al
4-mar-2027, y así.

Consecuencias, todas buenas:

- **Desaparece el prorrateo del primer año.** Por construcción el año de
  contrato empieza el día del contrato: se devenga el derecho completo. El
  prorrateo sobrevive sólo para el **último** año, cuando el contrato termina a
  media anualidad.
- **La pantalla cambia de voz.** Deja de decir «Vacaciones 2026» y pasa a decir
  el año de contrato con sus fechas: «Segundo año · 5 mar 2026 – 4 mar 2027».
  Sin las fechas el número no significa nada para quien lo lee.
- **Un periodo disfrutado a caballo de dos años de contrato se reparte** entre
  ellos exactamente como hoy se reparte entre dos años naturales. La regla no
  cambia, sólo dónde está el corte.

### 4.1 bis — Los días devengados a día de hoy

Pedido en la segunda ronda: «tiene que salir el dato de vacaciones devengadas
hasta la fecha para saber cuántas ha devengado a día de hoy».

Hoy la pantalla sólo sabe decir el derecho del año entero, que responde «cuántos
le tocan este año» y no «cuántos se ha ganado ya» — que es justo lo que se
pregunta quien está a mitad de año decidiendo si puede dar unos días.

Se añade el devengo proporcional dentro del año de contrato en curso:

```
devengado = ceil(derecho del año × días transcurridos ÷ días que el acuerdo cubre de ese año)
```

contando los días naturales desde el inicio del año de contrato hasta la fecha,
ambos incluidos, y sobre el derecho **ya prorrateado** si es el último año de un
contrato que termina. El redondeo va hacia arriba, a favor de quien trabaja, que
es la regla que el módulo ya declara para el prorrateo.

**Se divide por los días que el acuerdo cubre, no por los del año entero**, y la
diferencia sólo aparece en el último año de un contrato que termina a media
anualidad —pero ahí es grande—. El derecho de ese año ya viene prorrateado por
el final del contrato; dividir además por el año completo lo descontaría **dos
veces**, y quien trabajó hasta su último día no llegaría nunca a devengar el
derecho que se le reconoce. Con un contrato que acaba el 30 de junio y diez días
de derecho, al 1 de mayo el reparto correcto son cinco días y la división por el
año entero daría dos.

*(Esta línea se corrigió el 1 de septiembre de 2026: el documento decía «días del
año de contrato» y el código, con razón, divide por los días cubiertos. Queda
anotado porque es una cifra que acaba en dinero y alguien la comprobará dentro de
dos años.)*

**Dos cifras que no se pueden confundir**, y de las que sale el único error
serio posible aquí:

- *Lo que quedará al terminar el año* = derecho del año − disfrutados. Ya existe.
- *Lo disponible ahora mismo* = devengado − disfrutados. Es lo nuevo.

Quien en marzo ha disfrutado 20 de sus 30 días tiene diez por delante y, a la
vez, ha gastado más de lo devengado. Las dos cosas son ciertas y dicen cosas
distintas; mezclarlas hace que la pantalla mienta.

**Lo disponible ahora puede salir negativo, y no es un error:** son vacaciones
disfrutadas por adelantado, algo normal y legítimo (se dan en agosto aunque el
año de contrato acabe en marzo). Se enseña como lo que es —un anticipo—, no como
una alarma, y sólo cuando ocurre. La línea del devengo lleva siempre la fecha:
«Devengados a 1 de septiembre: 15 de 30 días». Sin la fecha, el número no
significa nada.

La fecha de referencia se inyecta, nunca se lee del reloj dentro del dominio,
como ya hace el resto del repo.

### 4.2 El margen: seis meses, configurable, o nunca

**Decisión del propietario:** «posterior a esa fecha se dan 6 meses más de margen
para gastarlos, pagarlos o perderlos. En el contrato puede haber una opción que
sea que nunca expiren esos días o hacer overwrite a esos 6 meses de margen».

En las condiciones del contrato (`agreement_versions.terms`, que ya existe y ya
tiene esquema) aparece la política de caducidad:

- **por omisión, 6 meses** desde el fin del año de contrato;
- **un número distinto de meses**, si se pacta otro margen;
- **o «nunca expiran»**, y entonces no hay fecha límite ni aviso de caducidad.

Va en `terms` y no en columnas nuevas porque es política pactada, cambia al
apilar una versión del contrato como todo lo demás, y `terms` es exactamente
para eso. El esquema de zod lo valida; ausente significa seis meses, así que
ningún contrato existente necesita tocarse.

### 4.3 Qué se guarda y cómo se decide

Tabla nueva `app.vacation_carryovers` (migración 0034). No columnas en las que ya
hay: un arrastre no es un periodo disfrutado (`vacation_periods`) ni es lo pactado
(`agreement_versions`, que además es inmutable). Es un hecho con decisión,
autoría, motivo y consecuencia económica, y se construye con el mismo patrón
append-only que los conceptos y los propios periodos: trigger que prohíbe el
DELETE y sólo admite las transiciones de estado legales, auditoría, cerrojo
consultivo para que dos administradores a la vez no generen dos pagos por los
mismos días.

Estados: `proposed` → `carried` | `compensated` | `rejected`, y `carried` →
`compensated` | `expired`.

**Lo que se congela al proponer** —días con derecho, disfrutados, no
disfrutados, versión del acuerdo, importe y la frase que explica el importe— no
se recalcula nunca al leer. Si en marzo se anula un periodo del año anterior, la
propuesta que alguien vio y decidió no puede cambiar debajo. Es el mismo criterio
que ya siguen las tarifas congeladas de la jornada extra y la nota de
aplazamiento de los conceptos.

**Quién decide: quien administra la casa** (`family_admin`), como todo lo demás
del contrato. La empleada lo ve, no lo decide. Esto es coherente con la decisión
ya tomada en el ADR de vacaciones de que no hay flujo de aprobación por la
empleada.

**Cuándo aparece la propuesta.** Se calcula al leer, y sólo se escribe la fila
cuando alguien decide. No hace falta un trabajo periódico nuevo ni un disparador
por calendario, que hoy no existen; el cálculo es reproducible desde los periodos,
que sí son append-only. El aviso aparece **en cuanto termina el año de contrato**
con días sin disfrutar, no en la fecha límite: avisar cuando ya no se pueden
disfrutar sería avisar tarde. Durante el margen la decisión sigue abierta y los
días se pueden seguir cogiendo.

**Dónde aparece:** una tarjeta arriba de la pestaña Vacaciones con las tres
salidas (arrastrar, compensar, rechazar con motivo obligatorio), y una línea de
decisión en Hoy para quien administra. En Hoy tiene que ser **un elemento más de
la lista de decisiones, con el texto escrito por el servidor**: el presupuesto de
bytes del arranque de Hoy tiene unos 1.500 de margen y una rama nueva en la
plantilla se lo come.

### 4.4 El precio del día se pacta, no se calcula

**Decisión del propietario, corrigiendo la primera respuesta:** «el precio del
día de vacaciones no disfrutado tiene otro valor que se cierra en el contrato, no
se auto calcula».

Así que no hay fórmula. El importe por día de vacaciones no disfrutado es **una
tarifa más de las condiciones pactadas**, hermana de las dos que ya existen —el
precio de la hora extra y el del día de descanso trabajado— y se guarda donde
están ellas: una columna nueva en las versiones del acuerdo.

```
compensación = tarifa pactada × días no disfrutados
```

**La columna es opcional, y esa es una decisión deliberada.** Los contratos ya
firmados no pactaron esta tarifa; ponerles un cero significaría dejar escrito en
un expediente inmutable que se acordó pagar cero euros por día, que es falso y
que además nunca se podría corregir, sólo tapar apilando otra versión. Vacía dice
la verdad: no se pactó.

**Sin tarifa pactada no hay compensación.** No se estima, no se deduce del
salario, no se pone cero. La pantalla de Vacaciones ofrece arrastrar o rechazar
los días, y para compensarlos dice lo que falta y lleva a pactarlo. Es más
trabajo para quien administra que inventar un número, y es lo único honesto:
esta aplicación existe para que cada cifra diga de dónde sale.

**Dónde se pacta.** En «Cambiar las condiciones» está siempre. En el alta de una
persona es opcional, como ya lo son el catálogo de trabajo extra y los
complementos: al dar de alta no se sabe todo, y obligar a rellenarlo entonces
sólo conseguiría que alguien escribiera cualquier cosa.

**Qué versión fija el precio: la vigente cuando se decide pagar**, no la del año
que se cierra. El dinero es del mes en que se paga; si la tarifa subió, se paga
con la nueva, y la frase congelada deja constancia de cuál se usó y desde cuándo
regía: «18 días sin disfrutar × 46,15 € por día, pactados en las condiciones
vigentes desde el 5 de marzo de 2026 = 830,70 €». Esa fecha es lo que hace la
frase verificable dentro de dos años.

**Cómo llega a la nómina.** Aceptar la compensación crea, **en la misma
transacción**, un concepto a mano («Vacaciones del segundo año no disfrutadas»)
con el importe y la frase como motivo, y lo enlaza con el arrastre en las dos
direcciones. Así ningún concepto de vacaciones queda huérfano y ningún arrastre
se puede pagar dos veces. Si el mes que toca ya está cerrado, se aplaza al primer
mes abierto con su nota, que es lo que ya hace cualquier concepto.

**Los días arrastrados NO suman al derecho del año siguiente como un número
mayor.** Se enseñan como una línea aparte («18 días arrastrados del segundo año,
hasta el 4 de septiembre de 2027»). Sumarlos convertiría el derecho en un «48»
que se lee como un error de la aplicación.

---

## 5. Contrato: una persona, sus condiciones y cómo se cambian

**Lo señalado:** «no se ve bien, todo pegado»; «dar de alta» y «nuevo contrato»
no se entienden.

**Decisión.** La pestaña se queda con una sola cosa: **esta persona y su contrato
vigente**. Arriba, las condiciones que están en vigor desde cuándo, con aire entre
ellas. Debajo, un único camino de cambio, llamado por lo que hace: **«Cambiar las
condiciones»**, que explica en una frase que las condiciones no se corrigen sino
que se apilan, con fecha desde la que se aplican, y que lo anterior queda como
histórico consultable. Al final, el historial de versiones plegado.

**El formulario de alta se va de aquí.** Estaba en esta pestaña y en Personal, y
en las dos prometía lo mismo. Dar de alta a una persona no es una operación
dentro del expediente de otra persona: es una operación de la casa. Se muda a la
portada (apartado 6). Personal deja de tener su propio formulario y enlaza al
único que queda.

**El título de la pestaña sigue siendo «Condiciones del contrato»** —lo esperan el
título de la aplicación y dos pruebas— y el nombre de la persona lo pone la barra
de contexto que ya está encima.

---

## 6. La portada: la casa primero, la persona después

**Lo señalado:** el alta debe salir de la portada. Menú lateral → Contrato →
lista de personas con la cuenta pendiente de cada una, el resumen de la casa, y
«añadir nueva persona»; el alta pide los datos de la persona y los del contrato,
y genera una línea nueva en la lista.

**Decisión.**

**La portada es siempre la entrada de Contrato para quien administra**, también
cuando hay una sola persona o ninguna. Hoy sólo aparece con más de un acuerdo, y
por eso el alta no tiene desde dónde alcanzarse. Cuesta un toque de más en la
casa de una empleada; a cambio, hay un sitio y sólo uno donde está la casa entera.

**Qué cuenta como pendiente:** las cuentas **cerradas** con importe sin pagar.
Nada más. Fuera queda el devengo del mes en curso (es previsión, no deuda), la
cuenta abierta todavía sin cerrar, y el cobro pagado pendiente de confirmar por
la empleada (que no es dinero que la casa deba, sino un acuse que le toca a ella).
Cuando no se debe nada, el encabezado dice **«Al día»**, no «0,00 €».

**No se duplica el aviso de cuentas vencidas.** Ese aviso ya vive en Hoy;
en la portada basta el distintivo por persona.

**La familia no administradora ve la portada**: la lista de personas y el camino
a cada expediente, sin una sola cifra —la autorización de la base de datos ya se
lo impide— y sin el formulario de alta.

**El alta, en dos etapas, en `/employment/alta`:**

1. **La persona** — nombre, cómo entra en la casa y qué papel tiene.
2. **El contrato** — inicio, salario, jornada y días de vacaciones al año.

Al terminar, la lista de la portada tiene una línea más y se entra directamente
al expediente recién creado. La llave de la ruta es **`access.manage`**: lo que
se crea es un acceso a la casa, y así lo dice la tabla de rutas. Como toda ruta
anidada, hay que declararla o falla cerrada.

El alta sigue dejando vacíos el catálogo de trabajo extra y los complementos: se
pactan después apilando una versión. El aviso de que hasta entonces la empleada
no puede registrar jornada extra se dice al terminar el alta y en la pestaña
Contrato, que es donde se resuelve.

**Las dos clases de persona** —empleada con contrato y apoyo del hogar— se
ofrecen en el mismo formulario, diciendo que el apoyo del hogar no genera
contrato ni línea en esta lista. Es una frase; tener dos formularios en dos sitios
por esa distinción es peor.

**La persona cuyo contrato terminó** vuelve a la lista como candidata a un
contrato nuevo, y se distingue: no es lo mismo alguien que vuelve a la casa que
alguien que acaba de llegar.

---

## Lo que queda fuera, a propósito

- **Paginar el historial de Pagos.** No hace falta todavía.
- **Corregir la fecha de vencimiento de una cuenta abierta.** Exigiría un comando
  nuevo, contratos y auditoría. De momento se explica que no se puede cambiar.
- **Anular una cuenta.** No existe el comando; el Resumen se blinda igualmente
  para cuando exista.
- **Que abrir la cuenta congele el mes.** Es un cambio de dominio, no de
  presentación; hoy el cerrojo se toma al cerrar y así se explica.
- **Avisar a la empleada por el móvil del arrastre.** La marca de agua del aviso
  de vacaciones existe para otra cosa y mezclarlas rompería su razón de ser.
