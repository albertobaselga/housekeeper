# Rediseño: Contrato en una sola pantalla con pestañas

Fecha: 2026-08-31 · Estado: aprobado para implementación

## Qué se pide

La sección Contrato tiene que sentirse como **una sola pantalla** organizada en
pestañas, en vez de una lista larga de tarjetas con funciones mezcladas:

- **Vista principal**: el mes en curso y cómo va la cuenta.
- **Conceptos**: añadir extras, adelantos, ausencias y gastos.
- **Vacaciones**: saldo, apuntar días e historial.
- **Contrato**: condiciones, versionado y «aplicar a partir de una fecha».
- **Pagos**: histórico de cuentas de cada mes, con el documento de pago en PDF
  (todos los conceptos) descargable.

Todo por empleada (selector), con posibilidad de dar de alta personas nuevas y
de modificar el contrato de cada una versionándolo.

## Decisión de arquitectura: pestañas = rutas

Las pestañas **no** son estado de cliente dentro de una página única: son las
rutas de siempre más dos nuevas, unidas por una barra de pestañas común. La
navegación de SvelteKit entre rutas hermanas es de cliente, así que al usar la
barra **se siente una sola pantalla**, y a cambio se conserva lo que ya está
decidido y probado:

- Cada ruta mantiene su propio grafo de JavaScript (el editor de condiciones no
  engorda el arranque de Hoy; la decisión está comentada en el propio código).
- Cada ruta conserva su capacidad en `NESTED_ROUTE_CAPABILITY` y sigue fallando
  cerrada.
- Las URL siguen siendo compartibles, incluida la empleada elegida
  (`?empleada=`).

### El mapa

| Pestaña | Ruta | Capacidad | Contenido |
|---|---|---|---|
| Resumen | `employment/` | `settlement.read` (existente) | Mes en curso y cuenta |
| Conceptos | `employment/conceptos` (nueva) | `settlement.read` | Añadir y decidir extras, gastos, adelantos y ausencias |
| Vacaciones | `employment/vacaciones` | `agreement.read` (existente) | Saldo, apuntar días, historial |
| Pagos | `employment/pagos` (nueva) | `settlement.read` | Cuentas de cada mes + PDF |
| Contrato | `employment/acuerdo` | `agreement.write` (existente) | Versionado y altas |
| Condiciones | `employment/condiciones` | `agreement.read` (existente) | Lo pactado, en voz de tú |

La quinta pestaña es **una sola plaza con dos caras**: quien tiene
`agreement.write` ve «Contrato» (acuerdo); quien solo tiene `agreement.read` ve
«Condiciones». Nadie ve las dos.

### `EmploymentTabs.svelte` (nuevo, en `lib/components/employment/`)

`<nav>` con enlaces y `aria-current="page"` (son rutas, no un `tablist` de
widget). Estilo sobre la base de `.day-tabs`/`.chip` que ya existe en el CSS.
Recibe las capacidades ya resueltas del contexto y pinta solo las pestañas que
aplican; propaga `?empleada=` en cada href para que cambiar de pestaña no
pierda a la persona elegida. En móvil, la barra va en scroller con máscara,
como la tira de chips actual.

## Qué queda en cada pestaña

### Resumen (`employment/`) — adelgaza

Se queda con lo que responde «¿cómo va el mes?»: tira de cifras, selector de
empleada, triaje del outbox, la cuenta del mes línea a línea, los saldos
(compensación y anticipos), la apertura de la cuenta y, para la empleada, la
descarga de su expediente. Gana una tarjeta pequeña de **pendientes** («2
jornadas por confirmar · 1 gasto por decidir») que enlaza a Conceptos, y un
chip con el estado de la última cuenta que enlaza a Pagos.

Se van de aquí: las tarjetas de registro/decisión de extras y gastos (a
Conceptos), los conceptos a mano (a Conceptos), la tarjeta de vacaciones (a
Vacaciones), la tarjeta de versiones (a Contrato/Condiciones) y el historial de
liquidaciones (a Pagos).

### Conceptos (`employment/conceptos`) — nueva

Reutiliza los componentes existentes tal cual: `ExtraWorkPendingCard`,
`ExpensesPendingCard` y `ManualAdjustmentsCard`. La familia no administradora
entra y ve lo pendiente en solo lectura, como hoy en la principal.

`ManualAdjustmentsCard` gana **dos atajos de precarga**, sin ruta de escritura
nueva: «Adelanto» y «Ausencia» rellenan el mismo formulario de concepto a mano
(importe en negativo, etiqueta y motivo precargados y editables) y acaban en el
mismo comando `recordManualAdjustment`. **Hueco documentado**: los anticipos
con cuota (`app.advances`) siguen siendo de solo lectura — crearlos exigiría
comando, contrato y servidor nuevos y queda fuera de este rediseño; la ausencia
sin sueldo del dominio (`unpaid_absence`) tampoco se alimenta todavía, y el
atajo de ausencia usa el concepto a mano, que llega a la cuenta por el camino
ya probado.

### Vacaciones (`employment/vacaciones`) — gana el formulario

Sube aquí la `VacationsCard` (saldo del año y apuntar/anular días, para quien
tiene `leave.approve`) de la empleada elegida, seguida del historial año a año
que ya existía. El aviso de novedades y su marca de visto no cambian.

### Pagos (`employment/pagos`) — nueva

El historial de cuentas de cada mes que hoy vive al fondo de la principal, con
sus `SettlementActions` (cerrar, apuntar pago, confirmar cobro) y, por cada
cuenta, **«Descargar el documento de pago (PDF)»**.

Endpoint nuevo: `GET /api/v1/households/[householdId]/settlements/[settlementId]/documento`.
Genera el PDF al momento con `pdf-lib` siguiendo los patrones de
`employment-export.server.ts` (WinAnsi saneado, A4, paginado, metadatos
estables): membrete del hogar, empleada, periodo, **todas** las líneas de la
cuenta, lo que consta sin transferirse debajo del total (complementos que paga
la casa, conceptos anotados), pagos con método y referencia, pagado/pendiente,
estado de la confirmación de cobro y la marca «Documento doméstico no
oficial». El acceso lo decide la RLS: se carga bajo la sesión de quien pide y
sin filas se responde 404 — la familia no administradora no llega a ver
importes, igual que en pantalla. El recibo que archiva el worker al cerrar
sigue siendo el documento canónico de archivo; este endpoint es la vista
imprimible de la misma cuenta, disponible también para cuentas abiertas.

### Contrato (`employment/acuerdo`) — gana el alta de personas

Se mantiene el versionado tal cual está (apilar versión con `effectiveFrom`,
alta de contrato sobre membresía existente): el motor y la inmutabilidad ya
estaban resueltos. Se añade el **alta de una persona nueva** reutilizando el
flujo de Personal sin duplicarlo: el formulario de contratación se extrae de
`personal/+page.svelte` a un componente compartido (`StaffHireForm.svelte`),
la acción `?/hire` de acuerdo llama al mismo `hireHouseholdMember()` (identidad
+ acceso + contrato en un acto, con contraseña provisional), y Personal sigue
funcionando igual con el componente extraído.

## Selector de empleada

Sigue siendo `?empleada=<agreementId>` en la URL, con la tira de chips actual,
pero ahora **encima de la barra de pestañas y presente en todas** las pestañas
por-persona (Resumen, Conceptos, Pagos; Vacaciones ordena a la elegida
primero; Contrato resalta su acuerdo). Con una sola empleada no se pinta,
como hoy.

## Errores y estados vacíos

Sin cambios de criterio: ausencia por permiso se dice («Importes reservados»),
no se pintan vacíos falsos; el modo maqueta (sin base de datos) sigue siendo de
solo lectura y muestra Resumen con la barra de pestañas deshabilitada donde no
haya datos que enseñar.

## Qué hay que tocar fuera de `employment/`

- `routing.ts`: dos entradas nuevas en `NESTED_ROUTE_CAPABILITY`
  (`employment/conceptos` y `employment/pagos`, ambas `settlement.read`) con su
  comentario de por qué.
- `$lib/app-title`: etiquetas de las dos rutas nuevas.
- Los `href` que el modelo genera hacia anclas de la principal
  (`#anticipo-…`, `#vacaciones-…`, enlaces desde Hoy) se revisan y apuntan a la
  pestaña donde ahora vive cada cosa.
- Pruebas: `routing.test.ts` (rutas anidadas nuevas), las e2e que navegan por
  la principal (`family-employment.dbe2e.ts`, `employee-flow.dbe2e.ts`,
  `mobile-densidad.dbe2e.ts`, a11y) se actualizan a la navegación por
  pestañas; prueba de integración nueva para el endpoint del PDF (empieza por
  `%PDF`, conceptos completos, 404 para quien la RLS no deja).

## Qué NO entra (y por qué)

- Crear anticipos con cuota (`app.advances`): exige contrato + comando +
  servidor nuevos; el atajo «Adelanto» sobre concepto a mano cubre el caso de
  uso inmediato sin abrir esa obra.
- Alimentar `unpaid_absence` del dominio: mismo motivo; el atajo «Ausencia»
  usa concepto a mano.
- PDF del contrato/condiciones: no se pidió; el documento pedido es el de pago.
- Tocar la cola offline o los form actions: los dos modelos de escritura se
  quedan como están, que es como están documentados.
