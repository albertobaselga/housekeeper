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
