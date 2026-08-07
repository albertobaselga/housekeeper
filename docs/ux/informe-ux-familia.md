# Informe UX — Experiencia de la familia (Alberto y Marta)

**Fecha:** 7 de agosto de 2026 · **Rama auditada:** `codex/brief-completion`
**Auditor:** UX familia (conducción real en navegador, sin cambios de código)

---

## 1. Método

- **Entorno:** build de producción (`adapter-node`) contra Postgres real con RLS (`casaclara_wt_w`), sembrada con la batería e2e (`e2e/db-global-setup.ts`): jornada extra solicitada, festivo sin resolver, gasto pendiente, recetas con y sin alérgenos, comensal con alergia alta (Leo, lácteos), rutinas y página wiki «Lavadora · programa corto».
- **Conducción:** scripts ad-hoc de Playwright (Chromium) que ejecutan cada tarea **partiendo de Hoy**, contando cada click/tap, cada campo tecleado, y midiendo con `Date.now()` cuánto tarda cada acción en **reflejarse en pantalla** (el patrón `queueCommand → invalidateAll()` recarga los datos: ese coste está incluido). Tiempos de documento con `performance.getEntriesByType('navigation')`.
- **Vistas:** escritorio 1280×720 y móvil 390×844 (3 tareas clave repetidas).
- **Advertencia sobre latencias:** servidor y base de datos son locales (TTFB 1–3 ms). Los tiempos medidos son el **suelo** del coste; en producción se les suma la red. Lo relevante es la proporción: qué acciones recargan todo y cuáles no.
- Las capturas citadas (`a0-…`, `m2-…`, `s1-…`, `v1-…`) quedan en el directorio de trabajo de la auditoría, fuera del repositorio.

---

## 2. Tabla por tarea

Fricción: 1 = fluido, 5 = hace perder tiempo real. Clicks contados **desde Hoy**, incluida la navegación.

### Alberto (family_admin)

| # | Tarea | Clicks | Campos (obligatorios / con default sensato) | Latencia percibida | Fricción |
|---|-------|--------|---------------------------------------------|--------------------|----------|
| A1 | Aceptar jornada extra solicitada | 2 | 0 | 123 ms | **2** — la tarjeta «Jornadas extra» empieza a 804 px: bajo el pliegue |
| A1b | Resolver festivo trabajado | 4 | 2 (motivo obligatorio sin default; compensación default «dinero») | 115 ms | **2** |
| A2 | Aprobar gasto de Ana | 3 | 1 (motivo **obligatorio** incluso para aprobar) | 130 ms | **3** |
| A3 | Abrir + cerrar liquidación del mes | 3 | 1/1 (vencimiento prellenado con fin de mes ✓) | 152 + 139 ms | **1** — el mejor flujo de la app |
| A4 | Registrar pago | 2 | 1/3 (importe **hay que teclearlo** aunque la app lo conoce; método y fecha con default ✓) | 156 ms | **2** |
| A5 | Fijar caducidad a un acceso | 2 | 1 (datetime-local vacío, sin atajos) | 137 ms | **3** |
| A6 | Revocar acceso | 3 | 1 (escribir REVOCAR) | 89 ms | **2** — fricción intencional proporcionada a lo irreversible |
| A7 | Descargar traspaso operativo | 2 | 0 | descarga 33 ms | **1** |
| A8 | Crear una rutina | 2 | 2/6 visibles (título y **próxima fecha sin default**; audiencia, frecuencia e intervalo con default ✓) | 138 ms | **2** |

### Marta (family_member)

| # | Tarea | Clicks | Campos | Latencia percibida | Fricción |
|---|-------|--------|--------|--------------------|----------|
| M1 | Menú de hoy (sin choque) | 4 | 1 (receta; raciones autocalculadas ✓) | 129 ms | **2** — 1 click evitable: abre en **lunes**, no en hoy |
| M2 | Menú con choque de alérgenos | 5 | 1 + checkbox de reconocimiento | 129 ms | **2** — bloqueo claro con comensal afectado; fricción justificada |
| M3 | Confirmar un hueco | 3 | 0 | 128 ms | **1** |
| M4 | Duplicar la semana | 1 (+2 de verificación) | 0 | **sin señal de término** | **4** — cero feedback: hay que navegar a la semana siguiente para saber si funcionó |
| M5 | Añadir a la compra | 3 (+1 marcar comprado) | 1–4 (cantidad/unidad/sección sin defaults y con el mismo peso visual que el nombre) | 139 ms | **3** |
| M6 | Editar wiki con editor visual | 5 | 2 (contenido + resumen opcional) | editor listo en 85 ms; guardar 126 ms | **2** |
| M7 | Encontrar «cómo va la lavadora» | 2 | 1 | resultados ~40 ms | **1** — la frase natural funciona (stopwords del español bien tratadas) |

### Móvil 390×844 (repetición de 3 tareas clave)

| # | Tarea | Resultado |
|---|-------|-----------|
| V2 | Menú de hoy (Marta) | 4 clicks, sin overflow horizontal (0 px), pestañas de día caben; la fila «Comida» exige un scroll razonable. Guardar: 236 ms. **OK** |
| V3 | Resolver jornada extra (Alberto) | 4 clicks; funciona, pero la tarjeta de pendientes está a **1088 px** (más de un viewport entero de scroll). Sin overflow. |
| V4 | Añadir a la compra (Marta) | 3 clicks con solo el nombre; el formulario mide 406 px de alto para un caso que casi siempre es «nombre + añadir». |
| V1 | Navegación | **Wiki, Rutinas, Calendario, Contactos y Ajustes no existen en móvil** (ver F-03). |

---

## 3. Hallazgos

### F-01 · P1 — «Hoy» es un decorado: no muestra ni un solo dato real

`today/+page.server.ts` devuelve **siempre** `getTodayFixture()`: la fecha («Viernes, 7 de agosto»), la rutina, el menú («Lentejas con verduras») y la agenda son texto fijo, aunque el hogar tenga Postgres con datos reales. Verificado en vivo: con una jornada extra («Plancha del sábado»), un gasto («Farmacia») pendientes y el menú real de la semana cargado, **nada de eso aparece en Hoy** (captura `a0-hoy-admin`). Hoy no es un hub: es la pantalla más vista y la única que no dice nada accionable; toda tarea real empieza con un click de huida hacia otro módulo.

**Recomendación:** cargar Hoy desde las mismas consultas que ya existen: huecos del menú de hoy (`loadMenuWeek`), rutinas que vencen hoy (`live.routines` con `nextDueOn`), y contadores accionables «2 jornadas por resolver · 1 gasto por revisar» enlazando a las anclas que la página de empleo ya genera (`#extra-…`, `#gasto-…`). Con eso, resolver una jornada pasaría de 4 clicks a 2.

### F-02 · P1 — Marcar una tarea en Hoy acaba en un banner rojo permanente e irresoluble

El toggle de Hoy (y el de Rutinas en modo fixture) encola un comando `routine_occurrence` que **ningún handler del servidor implementa** (`api/v1/sync/+server.ts` registra rhythm/food/wiki/access/employment; `routine_occurrence` solo existe en el schema de contratos). Secuencia observada: click → píldora «1 cambio pendiente» → al recargar, el flush recibe `rejected: unsupported_aggregate` → **banner rojo «Revisión necesaria · Hay un cambio que no se puede combinar automáticamente» en todas las páginas, para siempre** (captura `s1-sync-tras-flush`). El único triaje de outbox vive en «Acuerdos y pagos» y filtra solo agregados laborales, así que este rechazo no se puede descartar desde ninguna pantalla. Además la tarea vuelve a aparecer sin marcar (es fixture): el usuario pierde su acción y gana una alarma que no entiende.

**Recomendación:** (a) eliminar el toggle sobre datos fixture o mapearlo al comando real de rutinas; (b) el banner debe decir **qué** cambio falló y **dónde** resolverlo (enlace al triaje), y el triaje debe aceptar cualquier agregado; (c) autodescartar los `unsupported_aggregate` en vez de dejarlos como conflicto eterno.

### F-03 · P1 — En el móvil desaparecen cinco módulos, incluidos Wiki y Ajustes

Bajo 52 rem el sidebar se oculta y la bottom-nav muestra `visibleNavigation.slice(0, 4)` + Ayuda: **Hoy, Pagos, Menú, Recetas, Ayuda**. Wiki de la casa, Rutinas, Calendario, Contactos y Ajustes del hogar **no tienen ningún punto de entrada** en móvil (verificado: 0 enlaces visibles; captura `v1-movil-hoy`). Marta no puede abrir la wiki desde el teléfono —el caso de uso «cómo va la lavadora» es de pie delante de la lavadora— salvo dando el rodeo por el icono de búsqueda; Alberto no puede revocar un acceso desde el móvil de ninguna manera.

**Recomendación:** quinta pestaña «Más» con el resto de módulos (y mover Ayuda/Emergencias dentro, o mantenerla como sexto icono compacto). Coste mínimo, desbloquea la mitad de la app en el dispositivo donde más se usa.

### F-04 · P2 — «Duplicar en la semana siguiente» no da ninguna señal de haber funcionado

Tras el click no hay mensaje, ni cambio visible, ni enlace: la píldora sigue en «Todo guardado» (el `success-message` solo existe en la rama offline). Comprobar que funcionó cuesta 2 clicks más (Semana siguiente → volver). Es la acción más «peligrosa» del menú (sobrescribe/rellena otra semana) y la única sin confirmación ni feedback (captura `m4-duplicar-sin-feedback`).

**Recomendación:** mensaje de éxito con enlace «Ver la semana del 10 ago →» (y, mejor, botón de deshacer). Una línea de Svelte; elimina la verificación manual.

### F-05 · P2 — El menú abre en lunes, no en hoy

`selectedDay = $state(0)`: en la práctica, de martes a domingo el primer gesto de Marta es siempre el mismo click correctivo a la pestaña del día actual (captura `m1-menu-dia-defecto`, lunes activo siendo viernes). Es un click evitable en la tarea más frecuente de la casa.

**Recomendación:** preseleccionar `week.days.indexOf(hoy)` cuando la semana visible contiene el día actual.

### F-06 · P2 — Lo accionable de «Acuerdos y pagos» está enterrado bajo lo informativo

Orden actual de la columna: parte semanal → devengo en curso (proyección) → jornadas extra pendientes → gastos pendientes. Las tarjetas que **piden decisión** a Alberto empiezan a 804 px en escritorio y a 1088 px en móvil (más de un viewport de scroll), mientras que arriba queda una proyección que no requiere acción. El chip «3 sin resolver» existe pero viaja con la tarjeta enterrada.

**Recomendación:** subir «Pendientes de acordar o resolver» y «Gastos pendientes» justo bajo el summary-strip cuando tengan elementos, o añadir al summary-strip un cuarto bloque «3 pendientes →» con anchor. La información de proyección puede esperar; las decisiones no.

### F-07 · P2 — Registrar un pago obliga a teclear un importe que la app ya sabe

El pendiente (1.521,75 €) se muestra solo como *placeholder* y como texto «Pendiente actual», pero el campo llega vacío y hay que copiar a mano un número con miles y decimales (formato es-ES estricto: un error de coma produce «Importe inválido»). El caso dominante es «pagar todo».

**Recomendación:** botón «Pagar todo el pendiente» que rellene el campo (manteniéndolo editable para pagos parciales). Método y fecha ya tienen buenos defaults; con esto el pago completo queda en 2 clicks y 0 tecleos.

### F-08 · P2 — Aprobar un gasto exige redactar un motivo obligatorio

El botón «Aprobar» está deshabilitado hasta escribir texto libre en «Motivo de la decisión». Tiene sentido al **rechazar**; al aprobar produce motivos-relleno («ok», «correcto») que no aportan trazabilidad y añaden un campo a la tarea de revisión más habitual.

**Recomendación:** motivo opcional al aprobar (default «Aprobado sin observaciones»), obligatorio solo al rechazar. Aprobar quedaría en 3 clicks y 0 campos.

### F-09 · P2 — Gestión de accesos: formularios siempre expandidos y caducidad sin atajos

Cada miembro de la lista muestra permanentemente su campo «Nueva caducidad» y su botón «Revocar acceso»: una lista de 5 personas son 5 formularios abiertos y 5 botones de revocar a la vista, con la página creciendo linealmente. El datetime-local vacío obliga a componer fecha y hora a mano incluso para los casos típicos («fin de mes», «+1 mes», «fin del verano»). La revocación en sí (REVOCAR + botón) está bien calibrada para lo irreversible que es.

**Recomendación:** colapsar las acciones tras un botón por miembro y ofrecer presets de caducidad (+1 semana / +1 mes / fecha concreta). Menos scroll, menos riesgo de interactuar con la fila equivocada.

### F-10 · P2 — Once destinos de navegación y cuatro son decorado: dispersa y confunde

Destinos: 8 en el nav + Emergencias + Ajustes + Buscador = 11. Con base de datos real, **Calendario y Contactos siguen siendo fixtures al 100 %** (agenda y teléfonos inventados sin ningún aviso más allá del sutil «datos fict…» del logo), igual que Hoy (F-01). Datos reales y datos de atrezzo conviven con el mismo aspecto: el usuario no puede saber qué es verdad. Además hay solape conceptual: Recetas son páginas wiki con extensión, y el menú ya enlaza a recetas.

**Recomendación:** (a) marcar de forma inequívoca (banda «demo») todo módulo que sirva fixtures, u ocultarlo cuando haya DB real; (b) fusionar: **Recetas dentro de Menú** (pestaña tercera junto a Menú semanal / Lista de la compra) y **Contactos dentro de Emergencias** (o del buscador, que ya los indexa). Resultado: 7–8 destinos, todos verdaderos.

### F-11 · P3 — Alta en la lista de la compra: 4 campos con el mismo peso para un caso de 1

Cantidad, unidad y sección son opcionales pero se presentan idénticos al nombre, sin defaults ni indicación de opcionalidad; el formulario además vive debajo de la lista completa. En la práctica «Servilletas» basta (verificado: se añade solo con nombre).

**Recomendación:** una línea rápida «+ Añadir» (nombre + botón) encima de la lista, con «más detalles» plegado para cantidad/unidad/sección.

### F-12 · P3 — Nueva rutina: «Próxima fecha» vacía y etiqueta «Cada cuántas (1–12)»

Dos de los seis campos frenan: la fecha obligatoria llega vacía (default natural: hoy o mañana) y «Cada cuántas (1–12)» solo se entiende releyendo Frecuencia. El resto de defaults (Toda la casa / Semanal / 1) son correctos. El formulario está tras la lista completa de rutinas (y en móvil, inaccesible — F-03).

**Recomendación:** default de fecha = hoy; fusionar frecuencia+intervalo en una sola frase («Repetir cada [1] [semana ▾]»).

### F-13 · P3 — El editor de wiki muestra 5 campos para retocar una línea

Título, Contenido, Resumen, Etiquetas y Alias aparecen siempre; para el retoque típico solo cuentan contenido y (opcionalmente) resumen. Es tolerable —todo llega prellenado— pero Etiquetas/Alias podrían plegarse bajo «Opciones de búsqueda». Lo demás del flujo es ejemplar: editor visual lazy (85 ms), pestañas Visual/Markdown coherentes, guardado con mensaje «sincronizado» explícito.

### Lo que está bien (y conviene no romper)

- **Latencia:** el patrón `command → invalidateAll` se refleja en 90–240 ms en local; ninguna acción exige doble confirmación ni recarga manual.
- **Liquidación (A3):** vencimiento prellenado con fin de mes, abrir/cerrar en 1 click cada uno, estados legibles («Pendiente de pago», «Pagada · cobro sin confirmar»).
- **Bloqueo de alérgenos (M2):** aparece al elegir la receta, nombra al comensal afectado («Leche y derivados — afecta a Leo»), deshabilita Guardar y exige asunción explícita: fricción exactamente donde debe haberla.
- **Buscador (M7):** «cómo va la lavadora» → 3 resultados con la página correcta la primera; disponible con ⌘K y desde el topbar.
- **Píldora de sync en estados simples:** «Todo guardado» / «1 cambio pendiente» / «Sin conexión · N pendientes» se entienden sin manual. El estado que no se entiende es el conflicto (F-02): no dice qué ni dónde.

---

## 4. Top 5 cambios que más tiempo ahorrarían a la familia

1. **Hoy con datos reales y pendientes accionables (F-01):** convierte la pantalla de entrada en el punto de partida de todas las demás tareas; ahorra 1–2 clicks y una decisión de navegación en cada tarea diaria.
2. **Menú «Más» en la bottom-nav móvil (F-03):** desbloquea wiki, rutinas y ajustes en el dispositivo principal de la casa; hoy esas tareas son sencillamente imposibles en el móvil.
3. **Arreglar el toggle de Hoy y el aviso de conflicto (F-02):** evita el peor escenario de la auditoría: una acción trivial que deja la app en alarma roja permanente y mina la confianza en todos los demás avisos de sync.
4. **Defaults que ya conoce la app (F-05, F-07, F-12):** menú abierto en el día actual, botón «pagar todo el pendiente», fecha de rutina prellenada. Tres cambios pequeños que eliminan el tecleo y el click correctivo más frecuentes.
5. **Pendientes laborales arriba + aprobar sin motivo obligatorio (F-06, F-08):** la revisión semanal de Alberto (jornadas + gastos) pasaría de «scroll + formulario» a dos decisiones visibles al abrir la página.
