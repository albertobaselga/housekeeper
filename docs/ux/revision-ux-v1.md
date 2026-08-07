# Revisión UX v1 — síntesis y propuesta de ola front-end

Fecha: 2026-08-07. Síntesis del integrador sobre tres auditorías independientes conducidas con navegador real y Postgres sembrado: [familia](informe-ux-familia.md), [interna](informe-ux-interna.md) y [heurística transversal](informe-ux-heuristico.md). Principios evaluados: **velocidad y simplicidad** — nadie pierde tiempo, intuitiva, mínimos clicks.

## Lo que ya cumple (no tocar)

- **Rendimiento de carga impecable**: Lighthouse móvil 100/100 en las 7 rutas auditadas con datos reales; LCP 1,51–1,72 s (presupuesto ≤2 s), TBT 0 ms, JS 38–54 KB por ruta.
- Acciones a 90–240 ms en local; liquidación del mes en 2 clicks con vencimiento prellenado; parte semanal de 5 días en 6 taps con defaults perfectos; bloqueo de alérgenos ejemplar; búsqueda que resuelve «cómo va la lavadora» a la primera; denegaciones amables por rol.

## Incidencias P1 (trianguladas por 2–3 auditores; hacen perder tiempo real hoy)

| ID | Incidencia | Evidencia |
|---|---|---|
| UX-P1-1 | **«Hoy» es una fixture** aun con Postgres: ni fecha real ni nada accionable; lo urgente (jornada pendiente, gasto por aprobar, hueco sin confirmar, cobro confirmable) exige 2–5 clicks módulo a módulo. | H-01/H-05 · F-01 · I-01 |
| UX-P1-2 | **El toggle de «Hoy» rompe el sync**: encola `routine_occurrence` sin handler → banner rojo permanente «Revisión necesaria» sin pantalla desde la que resolverlo (el mismo bug ya corregido en Rutinas). | H-01 · F-02 · I-02 |
| UX-P1-3 | **Móvil pierde 5 de 11 módulos y la señal de sync**: bottom-nav de 4 + sidebar oculto dejan Wiki/Rutinas/Calendario/Contactos/Ajustes sin entrada, y la píldora de pendientes desaparece justo en el dispositivo de Ana. | H-02 · F-03 · I-05 |
| UX-P1-4 | **Triaje de conflictos solo en Empleo y feedback que miente**: un rechazo fuera de agregados laborales es irresoluble; `queueCommand` (4 copias) anuncia «se sincronizará» ante un `rejected`; tras reconectar, el flush es mudo y la nota «guardado en este dispositivo» persiste ya sincronizado. | H-03/H-04 · I-04 |
| UX-P1-5 | **Emergencias offline solo cumple en el camino irreal**: con página cacheada 99–102 ms (✓ ≤500 ms), pero navegando por SPA sin visita completa previa cae al fallback `/offline` genérico — sin 112, sin contactos, sin CSS. | I-03 |

## P2 principales (fricción clara)

- El menú abre en **lunes**, no en hoy (cambiar la comida de hoy: 5 interacciones).
- Defaults ausentes que la app ya conoce: importe del pago (placeholder que hay que reteclear), «pagar todo», fecha de rutina; motivo textual obligatorio incluso para **aprobar** un gasto.
- «Marcar hecha» sin feedback (solo cambia la fecha pequeña) y **el doble tap consume la ocurrencia siguiente**.
- Duplicar semana sin confirmación visible; pendientes laborales enterrados a 804–1088 px.
- **Gasto sin UI de foto**: la tubería de blobs+antivirus existe completa pero no hay ni un file input (hueco AC-11 de flujo).
- AC-05 a medias: el total del devengo está a 1 tap con orígenes navegables, pero los pendientes no proyectados no se explican.
- Formularios de accesos siempre expandidos y caducidad sin presets; 4 de 11 módulos aún fixtures indistinguibles de datos reales.
- Coste estructural de acción: 2 viajes seriales (sync + recarga completa con re-firma del snapshot) = **832 ms click→UI en 4G**, con `busy` global bloqueando la página.

## Propuesta de ola front-end (ordenada por tiempo-ahorrado ÷ esfuerzo)

1. **(XS) Defaults inmediatos**: menú abre en hoy; pago prellenado con el pendiente («pagar todo» a un click); fecha de rutina por defecto; motivo opcional al aprobar; guard anti doble-tap en «Marcar hecha».
2. **(S) Arreglar el toggle de «Hoy»** (agregado correcto o retirarlo hasta el punto 4) y **triaje de conflictos global**: extender la tarjeta de triaje a todos los agregados y enlazarla desde el banner.
3. **(S) Feedback honesto unificado**: un solo `queueCommand` con estados reales (Enviado ✓ / Pendiente / Rechazado con causa), refresco automático al reconectar, nota local que desaparece al sincronizar, y una sola semántica de chips/colores en toda la app.
4. **(M) «Hoy» real**: load desde Postgres con fecha real y un bloque «Necesita tu decisión» por rol (jornada pendiente, gasto por aprobar, hueco sin confirmar, cobro confirmable, rutina de hoy) accionable a 1 click.
5. **(S) Móvil completo**: quinto slot «Más» en la bottom-nav con el resto de módulos y Salir; píldora de sync visible en móvil.
6. **(M) Emergencias siempre**: precachear la ruta en el service worker en el primer login (o pintar el fallback offline desde el CriticalSnapshot, que ya lleva 112 y contactos). Cierra AC-10 en el camino real.
7. **(M) Foto en el gasto**: file input → `saveOfflineBlob` → `flushBlobs` (todo existe ya del lado técnico). Cierra el flujo AC-11.
8. **(S) Jerarquía**: pendientes laborales arriba del expediente; feedback visible al duplicar semana.
9. **(L) Latencia de acción**: actualización optimista + `invalidate()` selectivo por dependencia en vez de `invalidateAll`, y sustituir el `busy` global por estados por control. Objetivo: click→UI <200 ms percibidos también en 4G.
10. **(M) Navegación mínima**: fusionar Recetas dentro de Menú y promover la búsqueda a overlay global (el atajo ⌘K ya existe); revisar Calendario/Rutinas según el mapa propuesto en el informe heurístico.

Los tres informes enlazados contienen las tablas por tarea (clicks, campos, defaults, latencias), las mediciones de Emergencias y Lighthouse, y la evidencia código:línea de cada hallazgo.
