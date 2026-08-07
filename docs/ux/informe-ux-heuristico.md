# Informe UX heurístico transversal — Casa Clara (web)

- **Fecha:** 2026-08-07 · **Rama:** `codex/brief-completion`
- **Método:** lectura de código (citas `ruta:línea`) + medición real contra build de producción (`adapter-node`) con Postgres sembrado (migraciones + fixtures + siembra e2e), sesión `family_admin`.
- **Instrumentos:** Lighthouse 13.4.1 (preset **mobile**, 7 rutas, servidor con `DATABASE_URL`), Playwright (latencia de acciones y navegación, red sin limitar y emulación 4G con RTT 150 ms vía CDP), inspección de IndexedDB.
- **Principios evaluados (brief):** VELOCIDAD y SIMPLICIDAD, mínimos clicks, intuitiva sin manual. Presupuestos: LCP ≤ 2 s, TBT ≤ 200 ms, script ≤ 120 KB (`infra/quality/lighthouserc.json:22-25`).

**Veredicto en una línea:** el rendimiento de carga es excelente (7/7 rutas con score 100 y LCP ≤ 1,72 s en móvil), pero la experiencia incumple el principio de simplicidad donde más duele: **Hoy es una maqueta que no refleja el hogar real (y marca tareas que el servidor rechaza), medio producto es inalcanzable desde un móvil, y el sistema de guardado dice cosas falsas al usuario**.

---

## 1. Los cinco hallazgos más graves

| ID | Sev. | Titular |
|----|------|---------|
| H-01 | P1 | «Hoy» es una fixture estática con datos reales detrás; marcar una tarea genera un comando que el servidor **rechaza** y deja un banner rojo permanente e irresoluble |
| H-02 | P1 | En móvil (≤ 52 rem) desaparecen de la navegación **5 de 11 módulos** (wiki, rutinas, calendario, contactos, ajustes) y también la píldora de sincronización |
| H-03 | P1 | Los conflictos/rechazos de sync solo tienen triaje en Empleo: en wiki, menú, recetas, rutinas y ajustes el banner «Revisión necesaria» no tiene ninguna salida |
| H-04 | P1 | El feedback de guardado miente: un comando **rechazado** se anuncia como «se sincronizará al recuperar la conexión», y el mismo estado se pinta verde en 6 sitios y ámbar en 4 |
| H-05 | P1 | Lo urgente no aflora en Hoy: jornadas y gastos pendientes, pagos vencidos y huecos de menú sin confirmar existen en la base de datos pero hay que ir a pescarlos módulo a módulo |

---

## 2. Hallazgos detallados

### H-01 · P1 — Hoy no es el hogar: es una maqueta, y encima rompe el sync

**Evidencia (código):**
- `apps/web/src/routes/h/[householdId]/today/+page.server.ts:4` — `load` devuelve `getTodayFixture()` **incondicionalmente**, aun con `DATABASE_URL` y RLS operativos. Las «tareas de hoy», el menú y la agenda son literales de `apps/web/src/lib/server/fixtures.server.ts:171-193`, incluida la fecha `dateLabel: 'Viernes, 7 de agosto'` (hardcodeada).
- `apps/web/src/routes/h/[householdId]/today/+page.svelte:23` — el toggle encola `aggregateType: 'routine_occurrence'`, agregado que el servidor **no maneja** (`packages/server/src/commands/rhythm.ts:431-434` registra `routine` e `ics_feed`). El propio código lo sabe: `apps/web/src/lib/food/commands.ts:407-409` — «`routine_occurrence` provocaba rejected/unsupported_aggregate (bug cazado por la batería e2e)» — pero solo se corrigió en Rutinas (modo live), no en Hoy.
- Además el toggle de Hoy hace `queueOutbox()` + `refreshSyncStatus()` **sin `flushOutbox()`** (`today/+page.svelte:21-27`): el cambio ni siquiera intenta llegar al servidor en el acto.

**Evidencia (medición, sesión real contra Postgres):**
1. Píldora inicial: «Todo guardado». Tap en una tarea → «1 cambio pendiente».
2. Al recargar (el monitor hace flush): outbox en IndexedDB = `{status: 'rejected', aggregate: 'routine_occurrence'}`, píldora «Revisión necesaria» y **banner rojo fijo**: «Revisión necesaria — Hay un cambio que no se puede combinar automáticamente». No existe UI para descartarlo (ver H-03): el banner es permanente en todos los dispositivos del usuario hasta vaciar IndexedDB a mano.

**Impacto:** la pantalla de aterrizaje —el «hub» del brief— muestra tareas, menú y agenda que no son los del hogar, y su única acción interactiva deja la app en estado de error visible para siempre. Un usuario no técnico no puede ni entender ni salir de ahí.

**Recomendación:** (a) cablear el load de Hoy a Postgres (rutinas de hoy vía `loadRoutines`, menú del día vía `loadMenuWeek`, agenda del calendario) con la fixture solo como fallback sin DB, como ya hacen los demás módulos; (b) reutilizar `completeRoutine()` de `food/commands.ts:400` (agregado `routine`) para el toggle y hacer flush inmediato; (c) test e2e-db que marque una tarea desde Hoy y afirme ACK `accepted`.

---

### H-02 · P1 — En móvil, medio producto no existe

**Evidencia:**
- `apps/web/src/app.css:627` — a ≤ 52 rem: `.sidebar { display: none; }`.
- `apps/web/src/lib/components/AppShell.svelte:114` — la bottom-nav renderiza `visibleNavigation.slice(0, 4)` + Emergencias. Para todos los roles eso es: Hoy, Acuerdos y pagos, Menú, Recetas, Ayuda. **Wiki, Rutinas, Calendario, Contactos y Ajustes quedan sin ninguna entrada de navegación** (solo se llega por búsqueda o enlaces incidentales). Para la empleada interna, Rutinas —su módulo de trabajo diario— es inaccesible; para el administrador, Ajustes (accesos, traspaso) es inaccesible.
- `apps/web/src/app.css:634` — a ≤ 52 rem también `.sync-pill { display: none; }`, y `:625` oculta el `detail` del banner. Consecuencia: en móvil los estados `pending`/`syncing` **no tienen ninguna representación visual** — justo en el dispositivo donde el offline-first es la promesa central.

**Impacto:** el dispositivo primario del hogar (móvil en la cocina, empleada con su teléfono) no puede llegar a la wiki («manual de la casa») ni a las rutinas, y no puede saber si sus cambios están confirmados.

**Recomendación:** bottom-nav de 5 posiciones: Hoy · Menú · [+ según rol: Pagos/Rutinas] · Buscar · «Más» (sheet con el resto y Ajustes). Emergencias puede vivir en «Más» + acceso desde Hoy (es `emergency.read` para todos, pero no necesita uno de los 5 huecos permanentes). Mantener visible en móvil una versión mínima de la píldora (punto de color + contador) y mover el `detail` del tooltip `title=` a un popover tocable.

---

### H-03 · P1 — «Revisión necesaria» sin salida fuera de Empleo

**Evidencia:**
- `apps/web/src/lib/offline/sync.ts:31` — cualquier registro con `status !== 'pending'` (sea `conflict` o `rejected`, de cualquier agregado) enciende la fase `conflict` global.
- El único triaje es `apps/web/src/lib/components/employment/OutboxTriageCard.svelte`, montado solo en `employment/+page.svelte:132` y filtrado a agregados laborales (`apps/web/src/lib/employment/outbox.ts:12-27`: `time_entry, extra_work, settlement, payment, expense`).
- Un conflicto de wiki/menú/receta/rutina/acceso enciende el banner rojo (`AppShell.svelte:47-52`) y **ninguna pantalla lo lista ni permite Reintentar/Descartar**. El editor de wiki incluso avisa «el servidor pedirá resolverlo a mano» (`apps/web/src/lib/components/wiki/WikiEditor.svelte:148`) — pero la mano no tiene dónde.
- Detalle agravante: `rejected` (rechazo definitivo, p. ej. permisos) se presenta con el copy de conflicto de fusión «no se puede combinar automáticamente» (`apps/web/src/lib/offline/sync-state.ts:27-29`) — descripción falsa.

**Recomendación:** promover el triaje a global: una vista «Cambios pendientes» (accesible desde la píldora/banner) que liste todo el outbox con descripción humana por agregado, distinga *pendiente / conflicto / rechazado* y ofrezca Reintentar/Descartar. `OutboxTriageCard` ya tiene el 80 % del patrón; falta generalizar el descriptor de comandos.

---

### H-04 · P1 — El sistema de guardado dice cosas falsas o contradictorias

**Evidencia:**
1. **Promesa falsa:** las cuatro copias de `queue*Command` (`employment/commands.ts:296`, `wiki/commands.ts:224`, `food/commands.ts:428`, `access/commands.ts:75`) devuelven `'queued'` si el comando sigue en el outbox, **sin distinguir `pending` de `rejected`**. Un comando que el servidor acaba de rechazar muestra «Guardado en este dispositivo; se sincronizará al recuperar la conexión» (`ExtraWorkPendingCard.svelte:191` y 3 más) — no va a ocurrir jamás.
2. **Mismo estado, dos copys y dos colores:** «Cambio guardado en la outbox local, pendiente de sincronizar.» en **verde** `success-message` (menu:217, recipes:199, routines:130, settings:79, wiki:159, wiki/[slug]:93) vs «Guardado en este dispositivo; se sincronizará…» en **ámbar** `queued-note` (4 tarjetas de empleo). «Outbox» además es jerga técnica.
3. **Chips con semántica invertida:** `WeeklyReportCard.svelte:70` pone `sent = true` *siempre* (sincronice o no), mientras `SettlementActions.svelte:56-59` pone `sent` *solo si quedó en cola*. «Semana enviada» y «Cierre enviado» significan cosas opuestas.
4. **Avisos pegajosos:** en menu/recipes/routines/settings/wiki, `queued` (y `saved` en wiki/[slug]) nunca vuelven a `false`: el aviso queda pegado el resto de la sesión aunque el cambio ya sincronizara.
5. **Éxito silencioso:** en el camino feliz online, menu/recipes/routines/settings/wiki no muestran nada tras guardar (solo la píldora global — que en móvil no existe, H-02).
6. La frase clave que distingue local de confirmado («falta confirmación del servidor», `sync-state.ts:46`) solo existe como `title=` tooltip (`AppShell.svelte:101`): invisible en táctil.

**Recomendación:** un único componente `ActionStatus` con tres estados y copy fijo («Guardando…» / «Guardado ✓» / «Guardado en este dispositivo — pendiente de enviar» / «No se pudo guardar — revisar»), alimentado por un `queueCommand` único (hoy hay 4 copias byte a byte) que devuelva `synced | queued | rejected`. Verde solo para confirmado por el servidor.

---

### H-05 · P1 — Lo urgente no aflora: Hoy no agrega nada

**Evidencia:** con la base sembrada, el hogar tiene una jornada extra `requested` esperando aceptación, un festivo trabajado por resolver, un gasto pendiente (`apps/web/e2e/db-global-setup.ts:150-190`) y huecos de menú sin confirmar. Nada de esto aparece en Hoy (`today/+page.server.ts` no lee de Postgres). Clicks medidos desde Hoy para los 5 eventos más frecuentes del hogar (sesión real; «click» = tap/click, sin contar tecleo):

| Evento frecuente | Camino hoy | Clicks | ¿Aflora en Hoy? | Ideal |
|---|---|---:|---|---:|
| Marcar tarea del día (empleada) | Hoy → tap tarea | 1 (**roto**, H-01) · vía Rutinas: sidebar → «Marcar hecha» | 2 | Fixture, no la real | 1 |
| Cambiar/asignar la comida de hoy | Menú → pestaña del día (abre en **lunes**, H-08) → «Asignar/Cambiar» → elegir receta → «Guardar hueco» | 5 | Solo lectura del menú fixture | 2–3 |
| Confirmar el hueco de hoy («hueco sin confirmar») | Menú → pestaña del día → «Confirmar» | 3 | No | 1 |
| Aceptar jornada extra / gasto pendiente (familia) | Acuerdos y pagos → «Aceptar»/«Aprobar» | 2 | **No hay ninguna señal de que exista** | 1 |
| Marcar ítem de la lista de la compra | Menú → pestaña «Lista de la compra» → checkbox | 3 (las pestañas se resetean en cada visita) | No | 2 |

**Recomendación:** convertir Hoy en agregador: bloque «Necesita tu decisión» (jornadas/gastos pendientes con Aceptar inline, pagos vencidos `dueOn < hoy`, huecos de hoy sin confirmar con Confirmar inline) + rutinas reales de hoy + menú real del día. El coste de servidor ya está pagado: `loadEmploymentOverview` y `loadMenuWeek` ya computan todo; Hoy solo necesita una proyección ligera.

---

### H-06 · P2 — Latencia estructural: `invalidateAll()` como único mecanismo de refresco

**Evidencia (código):** 13 llamadas a `invalidateAll()` y **cero** a `invalidate(dep)` selectivo ni a `depends()` en todo `apps/web/src` (menu:49, recipes:33, routines:46, settings:34, wiki:33, wiki/[slug]:42+55, employment:82, y 5 componentes de empleo). Ninguna actualización optimista fuera del modo fixture.

**Evidencia (medición, servidor con Postgres):**

| Sonda (family_admin) | Red local | Detalle de red observado |
|---|---:|---|
| Acción «Guardar hueco» de menú | 114 ms hasta última respuesta | `POST /api/v1/sync` (81 ms) **y después, en serie**, `menu/__data.json?x-sveltekit-invalidated=111` (6,0 KB) |
| Acción «Confirmar» hueco | 107 ms | mismas 2 peticiones seriales (6,1 KB de datos) |
| Acción «Marcar hecha» (rutinas) | 76 ms | sync + `routines/__data.json?x-sveltekit-invalidated=111` (4,3 KB) |
| **Misma acción con 4G emulada (RTT 150 ms)** | **832 ms** de click a UI actualizada | 2 viajes seriales: no hay estado intermedio, la fila no cambia hasta que vuelve el segundo |
| Navegación entre módulos (client-side, caliente) | 34–118 ms · 4G: 173–710 ms | 1 × `__data.json` (0,7–7,6 KB) + chunks JS del nodo la primera vez (7–40 KB) |

Claves del patrón:
- El sufijo `x-sveltekit-invalidated=111` confirma que **cada acción re-ejecuta también el load del layout**, que reconstruye y **firma Ed25519 el snapshot crítico en cada pasada** (`apps/web/src/routes/h/[householdId]/+layout.server.ts:27` → `buildCriticalSnapshot`, `apps/web/src/lib/server/snapshot.server.ts:12-32`). En navegación normal el layout se cachea (`=001`); el coste extra es un peaje exclusivo de las acciones.
- Cada tap en un checkbox de la compra (`menu/+page.svelte:390`) paga los 2 viajes seriales **y bloquea todos los botones de la página** (`disabled={busy}` global, `menu/+page.svelte:41`): marcar 10 ítems en el súper con 4G ≈ 8 s de espera acumulada y sin poder encadenar taps.
- La navegación SSR por módulo está bien resuelta (loads server-side de 4–25 ms de TTFB, payloads pequeños); el problema es exclusivamente el ciclo de acción.

**Recomendación:** (a) para toggles idempotentes (compra, rutinas, confirmar hueco): actualización optimista local + reconciliación con el ACK, sin re-load; (b) para el resto: `depends('app:menu')` en cada `+page.server.ts` e `invalidate('app:menu')` tras la acción — evita re-ejecutar el layout (y la firma del snapshot); (c) quitar el lock `busy` de página entera y dejarlo por control (el patrón por tarjeta de Empleo ya existe).

---

### H-07 · P2 — Cero feedback de navegación y carga

**Evidencia:** `$navigating` no se usa en ningún sitio; no existen skeletons ni spinners (grep de `navigating|skeleton|aria-busy|spinner|Cargando` sobre `src/`: 0 resultados fuera de la píldora de sync). Los loads son bloqueantes (sin streaming): al navegar, la página anterior queda congelada sin indicador hasta que llega la nueva. En local es invisible (34–118 ms); con 4G la primera visita a un módulo son 710 ms de nada.

**Recomendación:** barra de progreso fina global ligada a `navigating` en `+layout.svelte` (≈15 líneas). Suficiente; con estos payloads no hacen falta skeletons por módulo.

---

### H-08 · P2 — El menú abre en lunes, no en hoy

**Evidencia:** `apps/web/src/routes/h/[householdId]/menu/+page.svelte:43` — `let selectedDay = $state(0)` (lunes) en modo real. Irónicamente el modo fixture abre en viernes (`:198`, `let selected = $state(4)`). El caso de uso nº 1 («¿qué toca hoy y qué le falta?») paga un click extra siempre, y «hoy» es la pestaña menos visible un domingo.

**Recomendación:** inicializar `selectedDay` al índice de la fecha actual (`Europe/Madrid`) dentro de la semana cargada; conservar 0 solo para semanas que no incluyen hoy.

---

### H-09 · P2 — Estados vacíos que no orientan y ramas en blanco

**Evidencia (inventario completo en §6):** ~20 estados vacíos son un `<p class="audit-note">` gris de 0,75 rem sin CTA («Todavía no hay grupos de comensales en este hogar.» `menu/+page.svelte:352`; «Todavía no hay recetas con datos estructurados.» `recipes/+page.svelte:217` — y la creación de recetas pasa por la wiki, cosa que no se explica). Los formularios de creación existen pero viven en otra tarjeta sin enlace desde el vacío. Casos peores:
- Ramas `{#if}` sin `{:else}` final: menu, recipes, routines, wiki, employment pueden renderizar **página en blanco** dentro del shell.
- Hoy sin tareas: «0 de 0 completadas» y anillo con `--progress: NaNdeg` (`today/+page.svelte:39`); rutinas fixture: `NaN%` (`routines/+page.svelte:204`).
- Vacíos ambiguos que mezclan «no hay» con «tu rol no ve»: `employment/+page.svelte:121-122`, `routines/+page.svelte:159`, `wiki/+page.svelte:201`.
- El único `+error.svelte` está en la raíz **fuera del AppShell**: un 404 de wiki (`wiki/[slug]/+page.server.ts:17`) pierde navegación, píldora y contexto, y su CTA («Volver a Casa Clara» → `/`) te saca del hogar.

**Recomendación:** patrón único de vacío (icono + una frase + botón de creación si `canWrite`, o explicación de permiso si no); `+error.svelte` bajo `h/[householdId]/` para conservar el shell; separar siempre el copy «no hay contenido» del copy «sin permiso».

---

### H-10 · P2 — Formularios: bien de defaults, mal de móvil y de fallo silencioso

**Evidencia (inventario completo: 24 formularios; los tres peores en §7):**
- `enterkeyhint`: **0** ocurrencias; `autocomplete`: 2 (email del login, `off` en REVOCAR); `inputmode`: 4 (todas `decimal`); `autocapitalize/pattern`: 0.
- `apps/web/src/app.css:302` fija los inputs de `.action-form` a `.82rem` (~13 px) → **zoom automático de iOS al enfocar** en casi todos los formularios de employment, menú, recetas, rutinas y ajustes.
- Fallo silencioso al enviar: menu (nuevo grupo `:152`, añadido a compra `:171`), recipes (ingredientes `:89-90`, alimento `:131`, comensal `:168`), routines (`:91`), wiki (nueva página `:58`): la guarda JS hace `return` sin ningún mensaje — «Guardar» no hace nada visible.
- Validación en vivo solo en 3 sitios (motivo de resolución, REVOCAR, editor wiki); el resto valida al enviar, con el `role="alert"` por encima del botón (tapado por el teclado en móvil: `WeeklyReportCard.svelte:114`).
- Áreas táctiles: `.button.small-button` ≈ 36 px (`app.css:278`), por debajo de los 44 px recomendados, y es el botón dominante en empleo/menú/wiki.
- Positivo: los defaults son en general sensatos (fecha=hoy, 480 min, fin de mes, `bank_transfer`, precarga de slots y revisiones).

**Recomendación:** subir inputs a 16 px (mata el zoom iOS de raíz); añadir `inputmode`/`enterkeyhint`/`autocomplete` donde toca; convertir toda guarda silenciosa en mensaje `role="alert"` junto al botón; `min-height: 44px` táctil.

---

### H-11 · P2 — Búsqueda como página en vez de overlay, y a medio cablear

**Evidencia:** el atajo ⌘K navega a la página `/search` (`AppShell.svelte:32-35`) — pierde el contexto donde estabas; en móvil queda un icono (`app.css:631`) que también navega. Las búsquedas sugeridas solo existen en modo fixture (`search/+page.svelte:147`); en modo real con query vacía no se renderiza nada bajo el buscador. El vacío «No aparece “X”» anota el hueco (`home.searchGaps`) pero no ofrece «crear página wiki» pese a que el dato existe. Los contactos del buscador real salen de la **fixture**, no de Postgres (`search/+page.server.ts:16-18`, comentario incluido).
Lo bueno: la búsqueda offline sobre snapshot con su copy («Sin conexión solo buscamos en el snapshot de este dispositivo») es el mejor estado de la app.

**Recomendación:** overlay/palette global (input + resultados en un dialog sobre la página actual) reutilizando el mismo endpoint; CTA «Documentarlo ahora» hacia nueva página wiki desde el vacío; sugerencias también en modo real. La página `/search` puede quedarse como fallback enlazable.

---

### H-12 · P2 — Arquitectura de navegación: 11 módulos para 5 intenciones

**Evidencia:** `apps/web/src/lib/auth/routing.ts:3-15` define 11 módulos; el sidebar muestra 8 + Emergencias + Ajustes (`AppShell.svelte:13-22`). Solapes de intención observados:
- **Recetas ⊂ Menú:** recetas son páginas wiki extendidas (`app.recipes` referencia `wiki_pages`) y su único uso operativo es asignarse a huecos del menú; el módulo Menú ya enlaza a recetas por hueco (`menu/+page.svelte:260`) y Recetas enlaza de vuelta. Dos entradas de nav para un mismo flujo comida.
- **Rutinas + Calendario:** ambas son «qué toca y cuándo»; Calendario es además fixture pura sin escritura (`calendar/+page.server.ts:4`) pese a que `calendar.write` existe como capacidad.
- **Contactos ⊂ Emergencias/Búsqueda:** contactos es una lista fixture de 6 entradas (`contacts/+page.server.ts:4`), sin alta real (el botón «Añadir contacto» no tiene handler, `contacts/+page.svelte:13`); los destacados ya viven en Emergencias y en el snapshot.
- **Búsqueda como página** (H-11).

**Mapa de navegación mínimo propuesto** (nav primaria fija + overlay; todo lo demás son sub-vistas, no entradas de nav):

| Rol | Nav primaria (orden) | Dentro de cada área | Fuera de la nav |
|---|---|---|---|
| family_admin | **Hoy · Comida · Casa · Pagos · Ajustes** | Comida = menú semanal + compra + recetas (pestañas ya existentes); Casa = wiki + rutinas + calendario/agenda; Pagos = expediente laboral | Buscar = overlay global (icono/⌘K); Emergencias = acceso fijo desde Hoy + «Más» |
| family_member | Hoy · Comida · Casa · Pagos(lectura) | ídem | ídem |
| employee_live_in | **Hoy · Mi trabajo · Comida · Casa** | Mi trabajo = jornadas/partes/gastos/mi expediente (lo suyo primero) | ídem |
| helper | Hoy · Comida · Casa | Casa sin edición | ídem |
| viewer | Hoy · Emergencias | agenda y contactos en Hoy | Buscar oculto (sin `search.use`) |

Con 4–5 entradas, la bottom-nav móvil deja de amputar módulos (H-02) sin necesidad de menú «Más» para lo cotidiano, y desktop y móvil quedan isomorfos. El coste es bajo: son agrupaciones de rutas existentes bajo layouts con pestañas, patrón que Menú ya usa (`menu/+page.svelte:224-227`).

---

### H-13 · P2 — Tres maneras de confirmar (o ninguna)

**Evidencia:** no hay `confirm()` ni undo en toda la app. Extremos:
- Revocar acceso: formulario con palabra tecleada `REVOCAR` (`settings/+page.svelte:139-153`) — el más ceremonioso.
- «Vaciar» un hueco de menú (`menu/+page.svelte:289`) y «Descartar» un cambio del outbox (`OutboxTriageCard.svelte:95`): destruyen al primer click sin confirmación ni deshacer.
- Asignar receta con alérgeno incompatible: checkbox de asunción «Sé que hay una incompatibilidad y asumo la decisión» (`menu/+page.svelte:326-338`) — patrón excelente, único.

**Recomendación:** escala única de fricción: irreversible-grave = palabra tecleada; destructivo-recuperable = confirmación de un paso o undo de 5 s; riesgo de seguridad = checkbox de asunción. «Vaciar» y «Descartar» necesitan al menos el segundo nivel.

---

### H-14 · P3 — Copys y patrones divergentes entre módulos (tabla)

| # | Intención | Patrón A | Patrón B |
|---|---|---|---|
| 1 | Guardar formulario | «Guardar hueco/receta/rutina/cambios» | «Enviar parte semanal», «Registrar pago/jornada», «Añadir gasto», «Fijar caducidad» |
| 2 | Aprobar | «Confirmar» (menú), «Confirmar cobro/resolución» | «Aceptar» (jornadas), «Aprobar» (gastos), «Marcar hecha» vs «Marcar realizada» |
| 3 | Feedback offline | verde «…outbox local…» (6 sitios) | ámbar «Guardado en este dispositivo…» (4 sitios) — ver H-04 |
| 4 | Botón en vuelo | solo WikiEditor cambia a «Guardando…» (`WikiEditor.svelte:154`) | el resto solo se atenúa |
| 5 | Lock de envío | `busy` de página entera (menu:41, settings:24, wiki:27…) | `busy` por tarjeta (5 componentes de empleo) |
| 6 | Fijar página | «Fijar/Desfijar» (`wiki/+page.svelte:141`) | «Fijar en portada/Desfijar» (`wiki/[slug]/+page.svelte:78`) — mismo comando |
| 7 | Infra | `queueEmploymentCommand`/`queueWikiCommand`/`queueFoodCommand`/`queueAccessCommand`: 4 copias idénticas + `dispatch()` reimplementado en 5 páginas | — |

**Recomendación:** glosario de verbos (Guardar/Confirmar/Aceptar con significado fijo), un `queueCommand` compartido y el `ActionStatus` de H-04.

---

### H-15 · P3 — El presupuesto Lighthouse de CI no vigila lo que importa

**Evidencia:** `infra/quality/lighthouserc.json:8-11,14` solo audita `/login` y `/offline` con preset **desktop**, mientras el brief exige experiencia móvil; ninguna ruta autenticada (Hoy, menú, expediente, wiki) está cubierta. Hoy pasa (ver §3), pero nada impide una regresión. Nota positiva: `apps/web/scripts/verify-today-bundle.mjs` ya vigila el peso JS de Hoy.

**Recomendación:** añadir las rutas de §3 al LHCI con preset móvil y sesión sembrada (la infra e2e-db ya arranca servidor + Postgres; reutilizarla como `startServerCommand`).

---

## 3. Tabla Lighthouse (preset MOBILE, build producción + Postgres real, sesión family_admin)

Presupuestos del brief: **LCP ≤ 2000 ms · TBT ≤ 200 ms** (`infra/quality/lighthouserc.json`).

| Ruta | Score | LCP | TBT | FCP | CLS | Transfer | JS | ¿Cumple? |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `/login` | 100 | 1666 ms | 0 ms | 1310 ms | 0 | 54 KB | 38 KB | ✅ |
| Hoy `/h/…/today` | 100 | 1716 ms | 0 ms | 1306 ms | 0 | 69 KB | 46 KB | ✅ |
| Expediente `/h/…/employment` | 100 | 1702 ms | 0 ms | 1305 ms | 0 | 89 KB | 54 KB | ✅ |
| Menú `/h/…/menu` | 100 | 1669 ms | 0 ms | 1286 ms | 0 | 78 KB | 52 KB | ✅ |
| Wiki portada `/h/…/wiki` | 100 | 1663 ms | 0 ms | 1281 ms | 0 | 76 KB | 49 KB | ✅ |
| Página wiki `/h/…/wiki/lavadora` | 100 | 1547 ms | 0 ms | 1160 ms | 0 | 70 KB | 48 KB | ✅ |
| Búsqueda `/h/…/search?q=lavadora` | 100 | 1506 ms | 0 ms | 1131 ms | 0 | 68 KB | 48 KB | ✅ |

**Ninguna ruta incumple los presupuestos**; hay ~300 ms de margen en LCP en la peor ruta (Hoy). TTFB servidor: 2–25 ms (queries RLS incluidas). El SSR + hidratación mínima de SvelteKit está funcionando: este NO es el frente a atacar en la ola front-end — el coste está en el ciclo de acción (H-06) y en la arquitectura (H-01/02/05).

---

## 4. Latencia estructural — resumen de mediciones

Ver H-06 para el detalle. Cifras clave: acción = **2 viajes de red seriales** (`POST /api/v1/sync` → `__data.json?x-sveltekit-invalidated=111` con layout incluido y re-firma Ed25519 del snapshot); 76–114 ms en red local, **832 ms** con RTT 150 ms; navegación entre módulos 34–118 ms local (0,7–7,6 KB de datos por módulo; employment es el load más pesado con 7,6 KB), 173–710 ms en 4G la primera vez por los chunks del nodo (7–40 KB).

## 5. Estados y vacíos — resumen

Ver H-03/H-04/H-07/H-09. Fases de sync definidas en `sync-state.ts` (6: saved/pending/syncing/offline/conflict/error) con copys correctos pero mal entregados: el matiz local-vs-confirmado vive en un tooltip, la píldora es binaria verde/ámbar, en móvil desaparece, `rejected` se disfraza de conflicto y no hay vista de cola pendiente. Un usuario no técnico **no** puede distinguir de forma fiable «guardado en este dispositivo» de «confirmado».

## 6. Formularios — resumen del inventario

24 formularios (14 ficheros). Los que más duelen en móvil: **(1) Parte semanal** (`WeeklyReportCard.svelte:91-125`: filas repetidas, 13 px → zoom iOS por campo, minutos como number crudo, validación entera al enviar y el alert queda tras el teclado), **(2) Editor de ingredientes** (`recipes/+page.svelte:260-303`: 5 controles por fila apilados, select sin buscador, guardado que filtra filas en silencio), **(3) Añadido a la compra** (`menu/+page.svelte:412-436`: 5 campos sin `required`, fallo silencioso, sin confirmación de éxito — el caso de uso «de pie en el súper»). Detalle completo de campos/defaults/validación en el análisis de H-10.

---

## 7. Propuesta de ola front-end (ordenada por tiempo ahorrado al usuario ÷ esfuerzo)

| # | Cambio | Hallazgos | Impacto (tiempo/confianza de usuario) | Esfuerzo | Ratio |
|---|---|---|---|---|---|
| 1 | Menú abre en el día actual | H-08 | 1 click × cada visita al módulo más usado | XS (1 línea + test) | ★★★★★ |
| 2 | Arreglar el toggle de Hoy (agregado `routine` + flush) y cablear Hoy a datos reales con bloque «Necesita tu decisión» | H-01, H-05 | Convierte la pantalla de aterrizaje en el hub del brief; elimina un estado de error permanente; 1-2 clicks × cada evento diario | M | ★★★★★ |
| 3 | `queueCommand` único que devuelva `synced/queued/rejected` + componente `ActionStatus` con copy unificado | H-04, H-14 | Elimina mensajes falsos y 4 copias de código; base para todo lo demás | S | ★★★★★ |
| 4 | Bottom-nav de 5 posiciones con «Más» + píldora de sync visible en móvil | H-02 | Restaura el acceso a 5 módulos y la señal de guardado en el dispositivo principal | S | ★★★★★ |
| 5 | Actualización optimista en toggles (compra, rutinas, confirmar hueco) + `invalidate('app:X')` selectivo + lock por control | H-06 | ~800 ms → percepción instantánea por tap en 4G; desbloquea taps encadenados | M | ★★★★ |
| 6 | Triaje de outbox global (generalizar `OutboxTriageCard` + vista «Cambios pendientes» desde la píldora) | H-03 | Todo banner rojo pasa a tener salida; imprescindible antes de más escritura offline | M | ★★★★ |
| 7 | Vacíos con CTA + `+error.svelte` bajo el shell + eliminar ramas en blanco | H-09 | Primeros usos y errores dejan de ser callejones | S–M | ★★★ |
| 8 | Móvil en formularios: 16 px, `inputmode`/`enterkeyhint`/`autocomplete`, alertas junto al botón, 44 px táctiles | H-10 | Menos fricción en los formularios de la empleada (los más usados) | S–M | ★★★ |
| 9 | Barra de progreso global con `$navigating` | H-07 | Feedback en navegaciones 4G (200–700 ms) | XS | ★★★ |
| 10 | Búsqueda como overlay global + CTA «documentar hueco» | H-11, H-12 | Búsqueda sin perder contexto; alimenta la wiki | M | ★★ |
| 11 | Consolidación de navegación por intención (Comida/Casa/Pagos) según mapa de H-12 | H-12 | Menos carga cognitiva; requiere decisión de producto | L | ★★ |
| 12 | Confirmación destructiva coherente (undo 5 s en Vaciar/Descartar) | H-13 | Previene pérdidas silenciosas | S | ★★ |
| 13 | LHCI móvil sobre rutas autenticadas con e2e-db | H-15 | Protege el presupuesto que hoy se cumple | S | ★★ |

Los puntos 1–5 caben en una ola corta y tocan cada uno de los principios de la casa: velocidad percibida (1, 5), mínimos clicks (1, 2), intuitiva sin manual (3, 4).

---

*Método reproducible: servidor `node build` con `DATABASE_URL` (rol sin BYPASSRLS) sobre la base sembrada por `apps/web/e2e/db-global-setup.ts`; Lighthouse 13.4.1 `--form-factor=mobile --screenEmulation.mobile --only-categories=performance` con cookie de sesión demo; sondas Playwright con recolección de `response` y emulación `Network.emulateNetworkConditions` (RTT 150 ms, 1,6 Mbps). Las sondas fueron temporales y no forman parte del repositorio.*
