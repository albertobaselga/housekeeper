# Informe UX · La interna (Ana, `employee_live_in`)

Auditoría de la experiencia real de Ana —la usuaria más sensible al tiempo y la de menor
afinidad tecnológica del hogar— con revisión breve de Lucía (`helper`) y Diego (`viewer`).
Criterios: velocidad, simplicidad, mínimos taps, cero tiempo perdido.

## 1 · Método

- **Entorno**: build de producción (`adapter-node`) contra Postgres 18 real bajo RLS
  (base exclusiva `casaclara_wt_x`), siembra de la batería e2e-db
  (`e2e/db-global-setup.ts`: acuerdo vigente, dos jornadas extra pendientes, un gasto
  pendiente, rutinas por audiencia, catálogo de comida). Login por selector demo.
- **Instrumentación**: sondas Playwright ad-hoc (`*.uxprobe.ts`, eliminadas tras la
  auditoría). Toda la sesión de Ana en **viewport móvil 390×844** (emulación táctil).
  Lucía y Diego en escritorio 1280×800 más una pasada móvil.
- **Latencia percibida**: cronometraje `Date.now()` desde el tap hasta que el DOM
  refleja el resultado, interceptando la red para contar peticiones y bytes. El patrón
  de escritura es siempre `POST /api/v1/sync` + `invalidateAll()` (que re-descarga el
  `__data.json` **completo** de la página); ambos quedan cuantificados.
- **Aviso**: todas las cifras son sobre loopback (RTT ≈ 0). Son el **suelo** de la
  latencia; en 4G real cada acción suma 2 viajes de red (sync + refetch), es decir
  +200–600 ms sobre lo medido.
- Capturas en scratchpad (`ux-interna/ana-01…17.png`, `lucia-*.png`, `diego-*.png`),
  fuera del repositorio.

## 2 · Resumen ejecutivo

El backend es rápido y honesto: ninguna acción de Ana tardó más de ~1 s ni perdió datos,
y el importe con coma, los defaults del parte semanal y la descarga del expediente
funcionan a la primera. Pero la capa que Ana ve tiene cuatro grietas serias: su pantalla
de inicio («Hoy») es **decorado de demostración** que además siembra un conflicto de
sincronización irresoluble; **Emergencias offline solo funciona si hubo antes una carga
completa de esa URL** (si no, aterriza en una página genérica sin el 112); tras
reconectar, la app **nunca confirma** que lo guardado llegó al servidor; y en móvil
**la mitad de la aplicación (Rutinas incluida) no tiene navegación**.

## 3 · Tabla por tarea (Ana, móvil 390×844)

Taps contados desde «Hoy» ya autenticada. «Latencia» = tap final → resultado visible
(loopback). Fricción: 1 = fluido, 5 = bloqueante.

| Tarea | Taps desde Hoy | Campos y defaults | Latencia medida | Red generada | Fricción |
|---|---|---|---|---|---|
| Registrar jornada extra | 2 taps (Pagos → botón) + **scroll de 2,2 pantallas** (formulario a y=1874 px) + teclear minutos | Tipo (def. «Horas extraordinarias» ✓), fecha (def. hoy ✓), minutos (def. 60; `type=number` sin `inputmode`), nota opcional | **994 ms** | POST sync + `__data.json` de 11,5 KB | 3 |
| Marcar jornada como realizada | 2 taps (Pagos → «Marcar realizada») + scroll hasta la fila | ninguno | **172 ms** | POST sync + refetch 11,5 KB | 2 |
| Parte semanal de 5 días | **6 taps** (Pagos → 4×«Añadir día» → «Enviar») | Defaults excelentes: cada fila nueva propone el siguiente día libre de la semana y 480 min; 0 teclas si la jornada es de 8 h | **106 ms** el envío; rellenar las 5 filas con defaults ≈ 4 s | POST sync + refetch 11,8 KB | 2 |
| Registrar gasto («12,50») | 2 taps + 2 campos (fecha def. hoy ✓; importe `inputmode=decimal` ✓ acepta coma; descripción) | — | **177 ms**; fila «pendiente de aprobación» aparece al instante | POST sync + refetch 12 KB | 2 (4 con el hueco de la foto, ver I-08) |
| Consultar cuánto cobrará (AC-05) | **1 tap** (Pagos): «Transferencia proyectada 1.400,00 €» a y=490 px, dentro de la primera pantalla ✓ | — | 112–139 ms de navegación | `__data.json` 57–69 KB | 2–3 (ver I-09) |
| Confirmar un cobro | 2 taps + scroll; **ninguna pista en «Hoy»** de que hay algo que confirmar | nota opcional | **90 ms** | POST sync + refetch 12,8 KB | 3 |
| Descargar su expediente | 2 taps (Pagos → enlace, tras scroll) | — | **179 ms**, `mi-expediente.zip` | descarga directa | 1 |
| Completar su rutina real | **Imposible por navegación**: Rutinas no está en la barra inferior; solo por URL directa o búsqueda. Una vez allí, 1 tap | — | **135 ms**, pero **sin feedback** (ver I-06) | POST sync + refetch 4 KB | 5 |
| Añadir algo a la compra | 3 taps (Menú → pestaña «Lista de la compra» → botón) + nombre libre | 5 campos (catálogo, nombre, cantidad, unidad, sección); solo el nombre es necesario | **138 ms**; marcar comprada: 140 ms | POST sync + refetch 5,6 KB | 2–3 |
| Consultar el menú de hoy | 1 tap… y **abre en lunes** siendo viernes: +1 tap y desconcierto. La tarjeta «Hoy comemos» del inicio muestra platos **de demostración** | — | 109–122 ms | `__data.json` 29–46 KB | 4 |
| Abrir Emergencias | **1 tap**, «Ayuda» siempre visible en la barra inferior ✓ | — | ver §4 | — | 1 online / 5 offline sin cache |

## 4 · Emergencias: medición con números

| Escenario | Tiempo hasta ver «Llamar al 112» | Resultado |
|---|---|---|
| Frío (primera visita de la sesión, online) | **82–93 ms** | ✓ |
| Caliente (segunda visita, online) | **85–86 ms** | ✓ |
| Carga completa (F5) | **56–59 ms** | ✓ |
| **Offline, con carga completa previa de la URL** | **99–102 ms** | ✓ cumple el AC de ≤ 500 ms |
| **Offline, sin carga completa previa (solo navegación SPA)** | **98 ms… hasta la página equivocada** | ✗ aterriza en el fallback `/offline` genérico: sin 112, sin contactos, y además **sin estilos** (captura `ana-14`) |

El service worker solo cachea páginas en navegaciones completas (`request.mode ===
'navigate'`); moverse por la app es navegación cliente, así que el escenario realista
—Ana usa la app un rato y pierde la señal sin haber hecho nunca F5 en Emergencias—
acaba en «Casa Clara sigue guardando lo esencial» con un botón «Volver». El
`CriticalSnapshot` firmado se guarda en IndexedDB pero **solo lo lee la búsqueda**;
nadie lo usa para pintar Emergencias offline.

## 5 · Flujo offline completo (gasto en modo avión)

1. **Acción offline**: el gasto se encola en ~1,3 s; banner superior «**Sin conexión ·
   1 pendiente**» (claro y visible ✓) y nota en la tarjeta «Guardado en este
   dispositivo; se sincronizará al recuperar la conexión» (✓). Pero la fila del gasto
   **no aparece en la lista** de pendientes: la tarjeta muestra «2 por revisar» sin el
   suyo (captura `ana-15`), lo que contradice al banner.
2. **Reconexión**: el flush ocurre y el banner desaparece, pero (a) la fila **sigue sin
   aparecer** (no hay `invalidateAll` en el flush de reconexión), (b) la nota «Guardado
   en este dispositivo…» **permanece** aunque ya está sincronizado, y (c) la píldora
   «Todo guardado» está **oculta en móvil** (`.sync-pill { display: none }`). Medido:
   `rowAfterFlush=false`, nota aún visible; solo tras recargar a mano aparece el gasto.
3. **Veredicto**: Ana no puede distinguir «guardado en mi móvil» de «recibido por la
   familia» sin recargar. La confianza depende de un F5 que nadie le ha enseñado.

## 6 · Hallazgos

### P1 — corregir antes de que Ana lo toque

- **I-01 · «Hoy» es un decorado.** `today/+page.server.ts` sirve `getTodayFixture()`
  siempre: las 5 tareas («Recoger a Leo», «Poner lavadora clara»…), el menú («Lentejas
  con verduras») y la agenda **no son datos del hogar** ni cambian con Postgres
  conectado. Las rutinas reales de Ana viven en otra página (inaccesible en móvil,
  I-05) y el menú real en otra. Su pantalla principal miente.
  *Recomendación*: alimentar «Hoy» con las rutinas de su audiencia, el menú del día
  real y las acciones laborales que la esperan; hasta entonces, retirar la tarjeta.
- **I-02 · El toggle de «Hoy» fabrica un conflicto irresoluble.** Marcar una tarea
  encola `routine_occurrence {taskId, done}`; el servidor no tiene handler y responde
  `rejected · unsupported_aggregate` en el siguiente flush. Resultado medido: banner
  rojo permanente «**Revisión necesaria · Hay un cambio que no se puede combinar
  automáticamente**» (en móvil solo «Revisión necesaria», dos palabras sin explicación)
  y el triaje de «Cambios sin sincronizar» **no lo lista** (filtra solo agregados
  laborales), así que no existe botón para descartarlo (captura `ana-17`).
  *Recomendación*: eliminar el comando fixture y añadir al triaje un cajón «otros
  cambios rechazados» para que ningún registro quede sin salida.
- **I-03 · Emergencias offline depende de un F5 previo** (§4). *Recomendación*:
  precachear `/h/<id>/emergency` en el `install` del SW (la URL se conoce tras el
  login) o renderizar el fallback `/offline` desde el `CriticalSnapshot`; y dar estilos
  al fallback.
- **I-04 · La reconexión es muda** (§5). *Recomendación*: al completar el flush por
  evento `online`, ejecutar `invalidateAll()`, cambiar la nota a «Enviado ✓ HH:MM» y
  mostrar la píldora de sync también en móvil (aunque sea solo el punto de color).
- **I-05 · Media aplicación no existe en el móvil de Ana.** La barra inferior solo
  lleva Hoy, Pagos, Menú, Recetas y Ayuda; la lateral está oculta (`display:none`).
  Sin ruta táctil a **Rutinas** (su trabajo diario), Wiki, Calendario, Contactos ni
  **Salir** (el logout solo vive en la sidebar). A Lucía le pasa igual con Rutinas.
  *Recomendación*: quinto elemento «Más» (o menú del avatar) con el resto de secciones
  y el cierre de sesión; Rutinas nunca a más de 2 taps.

### P2 — fricción que cuesta minutos cada semana

- **I-06 · «Marcar hecha» no confirma nada.** Tras el tap (135 ms) no hay chip
  «Hecha», el botón sigue idéntico y lo único que cambia es «próxima: vie, 7 ago» →
  «vie, 14 ago» en letra pequeña. Un segundo tap de duda **completa la semana
  siguiente**. *Recomendación*: chip «Hecha hoy ✓» + botón deshabilitado hasta el
  refresco, y deshacer.
- **I-07 · El menú abre en lunes.** `selectedDay = 0` fijo: un viernes, Ana tiene que
  encontrar y tocar la pestaña «vie» cada vez. *Recomendación*: seleccionar el día
  actual por defecto.
- **I-08 · El gasto no lleva foto y nadie lo dice.** Cero `input[type=file]`, cero
  menciones a ticket/justificante en la página (medido). La tubería offline de blobs
  existe (`flushBlobs`, subida de adjuntos con ACK) pero **ninguna UI la usa**; el
  propio código lo anota como hueco. Ana registrará «Farmacia 12,50 €» y tirará el
  ticket, y la familia aprobará a ciegas. *Recomendación*: botón de cámara en el
  formulario conectado al store de blobs; mientras no exista, un aviso «guarda el
  ticket en papel».
- **I-09 · AC-05 se cumple a medias.** Lo bueno: 1 tap, total en la primera pantalla y
  cada línea con enlace a su origen («Salario acordado 2026-08 → v1», «Anticipo ·
  cuota mensual → saldo»). Lo malo: (a) el resumen dice «1.400,00 €» y las líneas
  «1.500,00 − 100,00» sin una fila de total intermedia hasta 1,3 pantallas más abajo;
  (b) las jornadas extra y gastos **pendientes no aparecen en la proyección** y nada
  explica que entrarán al aprobarse — para Ana «mis horas del sábado no están»;
  (c) la cabecera se llama «Devengo en curso». *Recomendación*: bloque «Pendiente de
  aprobación (no incluido): +X €» bajo la proyección y lenguaje llano («Este mes
  cobrarás»).
- **I-10 · Confirmar el cobro es un secreto.** Con la liquidación pagada por la
  familia, «Hoy» no muestra ninguna señal (medido: 0 menciones); el formulario está en
  Pagos tras scroll. La confirmación independiente —pieza central del producto— depende
  de que Ana pasee por la app. *Recomendación*: aviso accionable en «Hoy» («La familia
  registró tu pago de julio: confirma que lo recibiste»).
- **I-11 · Jornada extra: formulario enterrado y en minutos.** 2,2 pantallas de scroll
  (queda debajo del parte semanal y de las jornadas pendientes) y el campo pide
  «Minutos» (1–1440): una jornada de 3 h son «180», con default 60 que casi nunca
  valdrá. *Recomendación*: botón «+ Añadir» fijo en la cabecera de Pagos y selector
  horas + minutos.
- **I-12 · Emergencias también es fixture.** Contactos, pasos y «actualizado hace 2
  días» son de demostración idénticos para cualquier hogar, y no hay UI para editarlos.
  Para la página cuyo lema es la confianza offline, es el dato menos fiable de la app.

### P3 — pulido

- **I-13 · Lenguaje de contable/desarrollador** (citas textuales visibles):
  «Devengo en curso», «Transferencia proyectada», «El servidor materializa las líneas
  desde los hechos y congela los totales», «La tarifa se congela en el servidor con la
  versión vigente del acuerdo», «Cambio guardado en la **outbox** local, pendiente de
  sincronizar» (menú y rutinas), «Apertura pendiente de sincronizar», «Confirmación
  caducada: el contenido cambió», «Auto-confirmado», «Realizada sin aceptación previa».
  En positivo: «Todo guardado», «Sin conexión · 1 pendiente», «Guardado en este
  dispositivo…», «¿A quién llamar?» son exactamente el tono correcto.
- **I-14 · Objetivos táctiles < 44 px** (medidos en Hoy y Pagos): enlaces de origen del
  ledger e historial **72–79 × 14 px** (lo más tocado por Ana para «ver de dónde
  sale»); «Ver semana →» 97×19; botones `small-button` («Añadir día», «Enviar parte
  semanal», «Registrar jornada extra», «Añadir gasto», «Marcar hecha»…) 36 px de alto;
  select de tipo 37 px; lupa de búsqueda 40×40; marca «Casa Clara» 137×33. La barra
  inferior (≈68 px) y las filas de tarea del Hoy sí cumplen.
- **I-15 · Teclados móviles**: importes y cantidades con `inputmode=decimal` ✓; los
  campos de minutos («Minutos», «Minutos trabajados», raciones, intervalo) son
  `type=number` **sin** `inputmode=numeric`, con teclado subóptimo en iOS.
- **I-16 · Lista de la compra**: 5 campos para apuntar «lejía» (catálogo, nombre,
  cantidad, unidad, sección a mano); solo los ítems manuales se pueden marcar como
  comprados — los derivados del menú («· del menú») no tienen checkbox, así que en el
  supermercado la lista no se puede ir tachando entera.

## 7 · Lucía (helper) y Diego (viewer) — 10 minutos cada uno

**Lucía** ve exactamente su mundo en escritorio: Hoy, Menú, Recetas, Wiki, Rutinas,
Contactos (+ Emergencias). Nada de Pagos ni Calendario. Las rutas ajenas
(`/employment`, `/calendar`, `/settings`) devuelven un 403 **amable y correcto**:
«Tu rol no permite abrir esta sección» con botón «Volver a Casa Clara» — ninguna traza
fea (guard central en `hooks.server.ts`). Dos peros: en móvil su barra inferior es Hoy,
Menú, Recetas, Wiki + Ayuda, con lo que **Rutinas —su herramienta de trabajo— queda sin
navegación** (I-05); y el «Hoy» fixture le deja marcar tareas de demostración, armando
la misma bomba de conflicto que a Ana (I-02).

**Diego** ve Hoy, Calendario y Contactos; todas las demás rutas (menú, wiki, recetas,
rutinas, búsqueda, ajustes, expediente) devuelven el mismo 403 amable ✓. La nota bajo
las tareas («Tu acceso permite consultar el día, pero no marcar rutinas») es un buen
ejemplo de negación en tono de casa. Único exceso: la tarjeta «Hoy comemos» del inicio
le enseña un menú (fixture) **sin tener `menu.read`** — inofensivo hoy porque es falso,
pero el día que «Hoy» sea real será una fuga de visibilidad.

## 8 · Top 5 cambios que más tiempo ahorrarían a Ana

1. **«Hoy» de verdad**: sus rutinas reales marcables, el menú del día real y un aviso
   accionable cuando Pagos la espera (confirmar cobro, parte sin enviar). Mata I-01,
   I-02, I-06 (parcial), I-07 e I-10 de una vez: es su pantalla de arranque y hoy no
   sirve para nada.
2. **Emergencias offline garantizada**: precachear la URL de Emergencias en el install
   del service worker o pintar el fallback desde el `CriticalSnapshot`. Es la
   diferencia entre 99 ms y una página en blanco en el peor momento posible.
3. **Cerrar el ciclo de confianza offline**: al reconectar, refrescar datos y cambiar
   la nota a «Enviado ✓»; píldora de estado visible en móvil. Ahorra el F5 ritual y las
   dudas de «¿le llegó a la familia?».
4. **Navegación móvil completa**: «Más» en la barra inferior con Rutinas, Wiki,
   Calendario, Contactos y Salir. Sin esto, Rutinas simplemente no existe en su
   teléfono.
5. **Acciones frecuentes a mano**: botón «+ Añadir» (jornada/gasto) fijo arriba en
   Pagos con horas+minutos en vez de minutos, y menú abriendo en el día actual. Son los
   dos formularios que Ana usará varias veces por semana; hoy cuestan 2 pantallas de
   scroll y una conversión mental.

---

*Auditoría realizada el 7 de agosto de 2026 sobre la rama `codex/brief-completion`
(build de producción, Postgres real, RLS activo). Las latencias son de loopback: en el
móvil real de Ana cada acción añade el RTT de su red dos veces (sync + refetch).*
