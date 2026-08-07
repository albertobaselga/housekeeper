# Revisión UX v2 — re-auditoría posterior a la ola front-end

Fecha: 2026-08-07 · Rama: `codex/brief-completion` (tras los merges de la ola front-end: hub Hoy real, cola de comandos unificada, navegación móvil completa, defaults, emergencias offline-first).

**Método** (idéntico al de [revision-ux-v1.md](revision-ux-v1.md) y sus tres informes): build de producción (`adapter-node`) contra Postgres 18 real bajo RLS (base exclusiva `casaclara_mx_u`, login sin BYPASSRLS), siembra de la batería e2e-db (`apps/web/e2e/db-global-setup.ts`), sondas Playwright temporales `*.uxprobe.ts` (eliminadas antes del commit; cada bloque de medición corre sobre base re-sembrada), cronometraje `Date.now()` del click al reflejo en DOM, 4G emulada por CDP (RTT 150 ms, 1,6 Mbps — mismos parámetros que H-06) y Lighthouse **13.4.1** preset móvil con sesión admin real. Latencias locales = suelo sobre loopback, como en v1. Capturas en el scratchpad (`ux-v2/*.png`), fuera del repositorio.

## Veredicto de los 5 P1

| P1 | Antes (v1) | Después (v2, medido) | Veredicto |
|---|---|---|---|
| **UX-P1-1** Hoy fixture, lo urgente a 2–5 clicks | Fecha hardcodeada; jornada a 2–4 clicks con la tarjeta a 804–1088 px; gasto 3 clicks + motivo obligatorio tecleado; hueco 3 clicks sin señal; cobro de Ana sin ninguna pista (I-10) | Hoy carga de Postgres (eyebrow «Viernes, 7 de agosto» real) con bloque **«Necesita tu decisión»** (4 asuntos con la base sembrada). Desde Hoy: **jornada 2 clicks · 159 ms** (ancla aterriza en viewport); **gasto 3 clicks · 0 tecleos · 106 ms** (motivo prellenado «Aprobado»); **hueco de hoy 2 clicks · 143 ms** (la decisión aparece al existir hueco sin confirmar); a Ana le aparece «Cobro de agosto 2026 por confirmar · 1.500,00 € pagados» con CTA. Menú y rutinas reales del día en Hoy | **Cerrado** (el gasto queda en 3 clicks —uno abre el formulario— pero sin tecleo; jornada y hueco en 1–2) |
| **UX-P1-2** Toggle de Hoy → banner rojo eterno | `routine_occurrence` sin handler → `rejected: unsupported_aggregate`, «Revisión necesaria» permanente e irresoluble | El toggle usa el agregado real (`routine.complete`) con guard anti doble-tap: **106–129 ms**, ACK accepted, **0 banners**, píldora «Todo guardado», outbox vacío (verificado en IndexedDB) y persiste tras recargar. En modo fixture el toggle es solo memoria local (no encola nada) | **Cerrado** |
| **UX-P1-3** Móvil pierde 5 módulos y la píldora | Bottom-nav de 4 + Ayuda; Wiki/Rutinas/Calendario/Contactos/Ajustes/Salir sin entrada; `.sync-pill { display:none }` | 390×844: bottom-nav 4 + **«Más»** (hoja modal accesible). Ana: **Rutinas 1 tap** (pestaña propia), **Wiki 2 taps**; admin: **Ajustes 2 taps**; Contactos/Calendario/Emergencias en «Más»; **Salir presente** en la hoja. **Píldora visible** (punto 24×44 px con `title`), overflow-x 0 px | **Cerrado** (matiz: Emergencias pasa de 1 tap a 2 — ver P3 nuevos) |
| **UX-P1-4** Triaje solo laboral y feedback que miente | `queueCommand` ×4 anunciaba «se sincronizará» ante un `rejected`; conflicto fuera de Empleo sin salida; reconexión muda | Rechazo forzado real fuera de Empleo (menú: cambio offline + confirmación con hash caduco → `menu_content_changed` al reconectar): offline la nota es ámbar y veraz; al volver la red el flush corre solo y el banner dice **«Necesita tu decisión · 1 — Hay 1 cambio rechazado o en conflicto que no se aplicará solo»** (sin prometer reenvío, sin jerga de fusión). En **Hoy** aparece el triaje global con descripción humana («Confirmación de un hueco del menú · Conflicto con el servidor · El contenido del hueco cambió desde tu confirmación») y Reintentar/Descartar: **descartar = 1 click · 63 ms** → banner fuera, «Todo guardado». Reconexión con `invalidateAll` automático (los datos frescos llegan solos) | **Cerrado** (resto menor: nota verde «outbox local» pegajosa en 4 páginas, ver P3) |
| **UX-P1-5** Emergencias offline solo con F5 previo | SPA-first offline → fallback `/offline` genérico sin 112, sin contactos, sin CSS | El layout calienta la caché del SW (`x-casa-clara-warm-page`) en el primer login: **offline sin haber visitado nunca Emergencias → página real con estilos y «Llamar al 112» en 66 ms**; con carga completa previa 70 ms (antes 99–102). El fallback `/offline` para rutas no cacheadas ahora pinta **112 + contactos del CriticalSnapshot con estilos en 57 ms** | **Cerrado** |

## Latencia de acción con 4G emulada (RTT 150 ms)

| Medición | Antes (v1) | Después (v2) | Veredicto |
|---|---:|---:|---|
| Guardar wiki (patrón optimista nuevo) | 832 ms click→UI (2 viajes seriales) | **231 ms** hasta ver el contenido nuevo · **238 ms** hasta «Cambio sincronizado.» (1 viaje + pintado desde el borrador; `invalidate('cc:wiki')` selectivo sin re-firmar el snapshot) | **Mejorado** (3,6×; el objetivo «<200 ms percibidos» se roza pero no se cumple estrictamente: el pintado espera al primer intento de flush, ver P2-1b) |
| Registrar pago (sin optimista, contraste) | 832 ms | **827 ms** (queue → ack → `invalidateAll` con re-firma del snapshot: los 2 viajes seriales siguen ahí) | **Sin cambio** (esperado: el patrón solo se aplicó a wiki) |
| Marcar rutina desde Hoy | 832 ms (equivalente) | **825 ms** | **Sin cambio** |

En local las acciones siguen en 46–170 ms (suelo), como en v1.

## Defaults (P2 de la ola)

| Medición | Antes | Después | Veredicto |
|---|---|---|---|
| Menú abre en el día actual | Abría en lunes; cambiar la comida de hoy = 5 interacciones (una correctiva) | Pestaña activa = **hoy** (verificado día 7); cambiar la comida de hoy desde Hoy = **4 interacciones · 152 ms**, sin click correctivo | **Cerrado** |
| Registrar pago | Importe placeholder a reteclear (formato es-ES estricto) | Importe **prellenado** con el pendiente (1.500,00), botón **«Pagar todo (1.500,00 €)»**, método = último usado, fecha = hoy → pago completo con **0 tecleos** (abrir 1 click · 140 ms; cerrar 1 click · 121 ms; pagar 1 click) | **Cerrado** |
| Motivo al aprobar gasto | Obligatorio, texto libre («ok», «correcto») | Prellenado **«Aprobado»** editable; «Rechazar» prellena «Rechazado» con foco+selección para matizar | **Cerrado** |
| Duplicar semana | Sin ninguna señal de término (fricción 4) | Mensaje en **158–170 ms**: «Semana del 3 ago – 9 ago copiada a la del 10 ago – 16 ago» + enlace «Ver la semana …→» | **Cerrado** |
| «Marcar hecha» en Rutinas | Solo cambiaba la fecha pequeña; el doble tap consumía la ocurrencia siguiente | Chip **«Hecha ✓ · próxima el vie, 14 ago» en 135 ms** y botón deshabilitado tras el tap (guard verificado) | **Cerrado** |

## Lighthouse móvil (Postgres real, sesión admin, LH 13.4.1)

Presupuestos: LCP ≤ 2000 ms · TBT ≤ 200 ms · JS ≤ 120 KB.

| Ruta | Antes (v1) | Después (v2) | Veredicto |
|---|---|---|---|
| Hoy | 100 · LCP 1716 ms · TBT 0 · JS 46 KB | **100 · LCP 1668 ms · TBT 0 · CLS 0 · 78 KB transfer · JS 55 KB** — ahora con datos reales y triaje lazy | **Cerrado/Sin regresión** |
| Menú | 100 · LCP 1669 ms · TBT 0 · JS 52 KB | **99 · LCP 1669–1698 ms · TBT 0 · CLS 0 · JS 55 KB** (2 pasadas; el punto perdido es FCP ~1370 ms, dentro de presupuesto) | **Sin cambio material** (−1 punto de score, presupuestos cumplidos) |

## Lo que sigue sin cerrar (orden por impacto)

**P2 restantes**

1. **Latencia no optimista intacta fuera de la wiki**: menú, rutinas y empleo siguen con `queueCommand → invalidateAll` (2 viajes seriales + re-firma Ed25519 del layout) → **~825 ms por acción en 4G**, y el `busy` global del menú sigue bloqueando toda la página (marcar N ítems de la compra sigue sin permitir taps encadenados). El patrón de referencia está documentado en `wiki/[slug]/+page.svelte`; falta replicarlo (H-06, punto 9 de la ola).
   1b. Además, el pintado «optimista» de la wiki se hace **después** de `await queueCommand` (espera el intento de flush ≈1 RTT): con 4G son 231 ms; pintar antes del envío dejaría el gesto en <50 ms reales.
2. **Calendario y Contactos siguen siendo fixtures al 100 %** sin marca alguna, y los contactos/pasos de **Emergencias también son de demostración** (F-10 / H-12 / I-12): la página que promete confianza offline sirve datos que no son del hogar.
3. **Formularios móviles sin tocar** (H-10): 0 `enterkeyhint`, solo 4 `inputmode`, inputs a ~13 px (zoom iOS), minutos como `number` crudo, jornada extra sigue pidiendo minutos (I-11).
4. **Cero feedback de navegación** (H-07): `$navigating` sigue sin usarse; la primera visita a un módulo en 4G sigue siendo ~700 ms de pantalla congelada.
5. **Copy de guardado aún bifurcado** (resto de H-04): la nota verde «Cambio guardado en la outbox local, pendiente de sincronizar.» persiste en menú/rutinas/recetas/ajustes (5 sitios), con jerga y sin volver a `false` (pegajosa el resto de la sesión). Wiki y empleo ya son veraces.

**P3 nuevos (aparecidos con la ola)**

- **Emergencias pasó de 1 tap a 2 en móvil**: «Ayuda» era el 5.º icono fijo; ahora vive dentro de «Más». Para el AC de emergencias conviene reconsiderar un acceso fijo (p. ej. desde Hoy).
- **En Hoy, marcar una rutina la hace desaparecer sin chip**: el feedback es la desaparición de la fila de «Vencen hoy» (en Rutinas sí hay «Hecha ✓ …»). Un usuario que dude puede no saber si su tap contó.
- El detalle de la píldora móvil sigue solo en `title=` (invisible en táctil); el punto de color sí se ve.
- Nota de método: el rechazo «duplicar semana solapada» (`week_overlap`) ya existe en el servidor pero la UI nunca puede producirlo (siempre duplica a +7 días); el rechazo forzado de esta auditoría usó el conflicto real de confirmación con hash caduco.

## Top de lo siguiente (tiempo ahorrado ÷ esfuerzo)

1. **(M) Replicar el patrón wiki en compra/rutinas/confirmar-hueco/empleo** y pintar el optimista antes del flush: es la única P2 que sigue costando ~800 ms por gesto en el camino dominante.
2. **(S) Unificar la última nota de guardado** (retirar «outbox local» y hacerla efímera) — cierra H-04 del todo con el `queueCommand` único ya existente.
3. **(S) Datos reales o banda «demo» en Calendario/Contactos/Emergencias** — el único sitio donde la app aún «miente» tras la ola.
4. **(XS) Barra de progreso con `$navigating`** y **(S) pasada móvil de formularios** (16 px, `inputmode`/`enterkeyhint`).
5. **(XS) Acceso fijo a Emergencias desde Hoy** para recuperar el tap perdido.

---

*Todas las cifras de este documento salen de sondas reproducibles: mismas siembras, mismos umbrales y misma instrumentación que la v1. Los cinco P1 se re-midieron sobre base re-sembrada por medición; las capturas (`a1-hoy-admin`, `c1-movil-ana-hoy`, `d2-triaje-hoy`, `e1-emergencia-offline-spa`, …) quedan en el scratchpad de la auditoría, fuera del repositorio.*
