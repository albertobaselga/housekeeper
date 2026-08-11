# Mapa de aceptación del brief v2 adaptado

Este documento es la fuente de verdad para declarar terminado el brief. Los datos del prototipo `demo-v0.1.0` no constituyen evidencia de producción. Cada criterio debe tener una prueba reproducible, identificada con el código indicado y ejecutada sobre Postgres/RLS reales cuando corresponda.

## Desviaciones aprobadas

1. **AC-03:** las compensaciones no caducan. El saldo se conserva hasta su consumo o ajuste trazable; no existe aviso de caducidad.
2. **Fase 4:** incluye plantillas de wiki, exportación de traspaso y caducidad/revocación inmediata de accesos. Se mantienen únicamente los cinco roles del brief.
3. **Fuera de alcance:** asistente conversacional y bitácora diaria.
4. **Recibo:** PDF mensual informal, claramente rotulado como no oficial. No se afirma conformidad con un modelo laboral oficial.
5. **WhatsApp:** solo enlaces `wa.me` iniciados conscientemente por una persona. No se usa Cloud API ni se envían mensajes automáticos.
6. **Idioma:** interfaz inicial únicamente en español, con claves y modelo preparados para i18n; no se exige contenido traducido en esta entrega.
7. **Entornos:** esta oleada entrega local y staging sintético. No autoriza producción ni datos reales.
8. **AC-26, sustituido el 10/08/2026 a petición del propietario** (enmienda E2 de `docs/rutinas-y-calendario.md`). Decía «no existe porcentaje **ni histórico** de cumplimiento de rutinas»; el histórico se pidió expresamente —«poder ver lo que hizo en el pasado para comprobarlo»— y la redacción anterior lo prohibía junto con lo que de verdad se quería evitar. La nueva separa las dos cosas: **hechos con autoría sí, indicadores de cumplimiento no.** El criterio anterior existía por una razón y no se ha ablandado: enseñar *qué se hizo* es la memoria de la casa; enseñar *cuánto cumple alguien* es una evaluación de desempeño sobre una trabajadora, y sigue prohibida —ahora con más superficie vigilada, porque también se nombran la comparativa y el color que califica—.

Con estas adaptaciones, el objetivo es **25/26 literales y 26/26 según el contrato adaptado**.

## Criterios trazables

| ID | Comportamiento aceptado | Evidencia primaria obligatoria | Gate |
|---|---|---|---|
| AC-01 | Un cambio salarial con vigencia en junio no altera marzo cerrado. | Test temporal del motor + restricción de inmutabilidad DB. | F1 |
| AC-02 | La libranza del 09/03 pagada usa la tarifa vigente en su fecha y navega al origen. | Golden test de marzo + E2E de trazabilidad. | F1 |
| AC-03A | Una libranza compensada genera 0 € y +1 día; el asiento no caduca ni desaparece. | Test de libro append-only y proyección de saldo. | F1 |
| AC-04 | Trabajo sin aprobación queda pendiente y visible hasta resolución explícita. | Test de estados, job de avisos y E2E por ambos roles. | F1 |
| AC-05 | El devengo en curso muestra previsión, desglose y origen de cada cifra. | Test de motor + E2E de navegación. | F1 |
| AC-06A | El cierre crea vencimiento, evento de calendario y aviso D-3 por canales habilitados; WhatsApp es solo `wa.me`. | Integración de jobs/calendario + test que impide Cloud API. | F1 |
| AC-07 | Pagos parciales no marcan pagada la liquidación hasta cubrir el total; justificante opcional durable. | Test de concurrencia DB + E2E con Storage. | F1 |
| AC-08 | La empleada confirma el cobro con sello temporal separado del registro familiar. | Test RLS + E2E `employee_live_in`. | F1 |
| AC-09 | Una liquidación vencida sin pago confirmado permanece visible y escala avisos. | Test de reloj/job idempotente + E2E. | F1 |
| AC-10 | Emergencias abre completa en modo avión en ≤500 ms. | Playwright offline + medición en Android de referencia. | F1 |
| AC-11 | Un gasto con foto offline sincroniza una vez, conserva el adjunto y no se duplica. | Test service worker/IndexedDB/API idempotente. | F1 |
| AC-12 | `helper` no accede a ningún dato o endpoint laboral, incluida Storage. | Matriz negativa RLS/API/Storage. | F1 |
| AC-13 | La empleada exporta en un clic su histórico completo en PDF y CSV. | Contract test del export + E2E y validación de contenido. | F1 |
| AC-14 | Importación Markdown preserva carpetas, front-matter, enlaces y etiquetas sin arreglo manual. | Fixture de corpus, dry-run y comparación estructural. | F2 |
| AC-15 | Renombrar una página no rompe enlaces internos. | Test de ID/slug estable y publicación. | F2 |
| AC-16 | `lavadra` devuelve la página correcta entre los tres primeros resultados. | Benchmark funcional Postgres de ranking. | F2 |
| AC-17 | El alias `vitro` encuentra la página oficial. | Test de alias bajo permisos reales. | F2 |
| AC-18 | Búsquedas fallidas equivalentes forman un único hueco documental. | Fixture de clustering determinista + revisión de falsos positivos. | F2 |
| AC-19 | Un contacto en resultados permite llamar sin abrir su ficha. | E2E móvil y revisión accesible del enlace `tel:`. | F2 |
| AC-20 | La portada usa lecturas agregadas de 30 días sin guardar identidad. | Test de esquema/retención + inspección de eventos. | F2 |
| AC-21 | Asignar una receta incompatible muestra bloqueo y exige confirmación explícita. | Matriz comensal-alimento-alérgeno + E2E. | F3 |
| AC-22 | Escalar 4→6 recalcula cantidades lineales y conserva unidades no lineales. | Tests unitarios y de propiedades. | F3 |
| AC-23 | Duplicar semana copia platos, notas y recetas en una sola acción idempotente. | Test API/DB + E2E. | F3 |
| AC-24 | Compra suma ingredientes equivalentes, respeta unidades y agrupa por sección. | Fixtures de agregación + E2E offline. | F3 |
| AC-25 | Mantenimiento trimestral notifica a familia, no a empleada. | Test de recurrencia y destinatarios. | F3 |
| AC-26 (revisado 10/08/2026) | El historial de rutinas es consultable como hechos con su fecha y su autoría. No existe ningún indicador de cumplimiento —porcentaje, racha, media, comparativa ni codificación por color que califique—, en ninguna vista, API ni exportación. | `apps/web/tests/calendar-no-metrics.test.ts` (vocabulario del código, forma de lo devuelto y ausencia de color que califique) + `apps/web/e2e/calendar.dbe2e.ts` → «el pasado se ve con quién lo marcó, y sin ninguna nota (E2)». | F3 |

## Extensión de Fase 4 acordada

| ID | Comportamiento aceptado | Evidencia primaria obligatoria |
|---|---|---|
| F4-01 | Una plantilla crea una jerarquía wiki editable sin mezclar datos entre hogares. | Test de clonación multi-tenant y RLS. |
| F4-02 | El traspaso exporta contenido operativo, adjuntos y relaciones con manifest verificable. | Export/import round-trip sobre fixture completo. |
| F4-03 | `expires_at` bloquea al vencer y la revocación invalida inmediatamente sesiones activas. | Test de reloj, RLS y revocación de sesión para los cinco roles. |

## Regla de salida

- Ningún comando con cero pruebas puede quedar verde.
- Cero defectos P0/P1. Un P2 solo puede aplazarse con propietario, fecha y aceptación explícita.
- La evidencia se conserva como artefacto de CI: resultados, trazas Playwright, Lighthouse y matriz RLS.
- El staging continúa siendo sintético incluso cuando todos los gates estén verdes.
