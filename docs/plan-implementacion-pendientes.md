# Plan de implementación de pendientes (08/08/2026)

Recopilación completa del tablero tras la ronda de intuitividad. Fuentes:
auditoría v3 (`docs/ux/revision-ux-v3-intuitividad.md`), huecos anotados por
los agentes de cada ronda, plan de importación del manual
(`docs/plan-import-manual-convivencia.md`) y restos de oleadas anteriores.

**Decisión del propietario aplicada**: el módulo de registro de incidencias
(Anexo I del manual) **se descarta** — no hace falta. El conocimiento de
mantenimiento entra como apartado normal de la Guía; el registro no se
construye ni en wiki ni como módulo.

## Ola A — Contenido real: importar el manual de convivencia

La app ya tiene la estructura; le falta el contenido. Todo según el plan de
importación aprobado, sin la parte de incidencias.

1. Script de conversión docx→Markdown (`packages/db/scripts/`), con
   front-matter (apartado, título, destacada, publicada/sin publicar) y tablas
   del Word como tablas Markdown.
2. Importación a la Guía (~45 notas en 7 apartados): páginas con «Pendiente de
   completar» entran **sin publicar** con el marcador resaltado; las completas
   se publican. Índice «Pendientes de completar» sin publicar y destacado.
   Destacadas: Principios generales, inicio y cierre de jornada.
3. Rutinas desde los planes del manual: diarias, semanales, quincenales
   (semanal cada 2) y periódicas, con su audiencia; detalle enlazando a la
   ficha de la Guía.
4. Contactos del Anexo G con tipo; los críticos como destacados (Emergencias
   y offline).
5. Recetas del Anexo D al recetario y las semanas tipo como plantillas con
   nombre.
6. Siembra idempotente (operationId determinista) y dry-run transaccional
   antes de la pasada real, sobre la base de demo `casaclara_docs` primero
   para revisión visual del propietario.

## Ola B — Comida: compra y comensales (P2 estructurales)

1. **P2-4 compra**: casilla también en artículos «del menú» (poder marcar lo
   comprado), fusión de duplicados manual+menú en una sola línea, y redondeo a
   medidas de compra reales (350 g → 1 paquete de 500 g; lógica en servidor
   con tabla/regla por unidad).
2. **Lista personal de la interna** (Anexo H): sección «Personal» dentro de la
   compra, visible solo para la interna y administración (coherente con la
   «compra personal verificable» del manual). *Asunción recomendada — vetable.*
3. **Alta progresiva de comensal** (resto del P1-7): primero nombre, después
   «¿Tiene alergias o restricciones?» desplegable; la matriz 14×3 solo si se
   abre. Nota por alérgeno en la UI de comensales (hueco de la Oleada 4).
4. **Archivado** de grupos, alimentos y recetas (los payloads no lo
   contemplan: ampliar contrato + comando + UI discreta), aprovechando que las
   plantillas ya degradan con gracia ante ausencias.

## Ola C — Literales y pulido restante (barata, sin rediseño)

1. **P2-2 rutinas**: «Se repite cada [1] [semana ▾]» como control único y
   «¿Quién la hace?» en vez de «Audiencia»; **P3-1** plurales correctos
   («cada 2 semanas», no «semana(s)»).
2. **P2-10/11 ajustes**: «Nueva caducidad/Fijar caducidad» → «Fecha límite del
   acceso»; «Revocar acceso» → «Quitar el acceso» (confirmación incluida);
   explicar en una línea qué contiene cada traspaso (apoyo vs familia).
3. **P2-12**: fuera tecnicismos de cara al usuario: «conexión ICS»
   (calendario), «RLS» (ajustes), «cookie HttpOnly» (login) → lenguaje llano.
4. **P3-7**: ocultar el atajo «⌘K» cuando no hay teclado físico; **P3-2**:
   últimas fechas ISO fuera de Pagos a formato humano.
5. Literal propio para el rechazo de plantilla sobre semana ocupada (hoy
   reutiliza el del duplicado, veraz pero genérico).

## Ola D — Robustez offline y datos reales restantes

1. **Snapshot crítico completo**: en modo real, el paquete offline aún sirve
   today/menú/notas de fixture (solo contactos son reales). Pasar a datos
   reales: menú del día, rutinas de hoy y notas destacadas de la Guía.
2. **Foto offline → gasto**: re-enlace diferido del justificante capturado sin
   conexión (hoy documentado como limitación).
3. **Justificante visible** en el histórico de una cuenta ya cerrada.
4. **Primera instrucción sin conexión**: crear «General» offline (hoy exige
   red porque el id llega con el ACK; solución: alta implícita en el comando
   de la nota o slug determinista).
5. **Acciones inline desde Hoy**: «Confirmar comida» y «Aceptar jornada» sin
   navegar (hoy el botón te lleva a la página).
6. **Dedupe visual** de añadidos optimistas idénticos simultáneos en compra.

## Ola E — Calendario real (la última demo restante)

Conexión de calendarios por enlace ICS entrante: persistir eventos de fuentes
(la tabla de estado de sync existe; faltan los eventos), pintarlos en
Calendario, quitar la banda de demostración, y documentar el enlace revocable.
Tras esto no queda ninguna pantalla con datos inventados.

## Descartado / aplazado sin fecha

- **Módulo de incidencias — descartado por decisión del propietario.**
- Clustering semántico con embeddings del worker; OCR de tiques; anulación
  (void) de cuentas cerradas; periodos de cuenta no mensuales; selección
  multi-empleada; reactivación de membresías revocadas; adjuntos dentro de
  notas de la Guía; apartados con ruta propia; plantillas de menú visibles
  para roles de lectura; reenvío parcial de emails del worker.

## Orden y verificación

Recomendado: **A y C en paralelo** (contenido + literales, sin solaparse),
después **B**, después **D**; **E** como cierre. Cada ola con el estándar de
la casa: suites completas (servidor + web + SQL), e2e fixture y e2e-db
actualizados, presupuesto de Hoy ≤ 120 KB, typecheck/lint limpios,
verificación visual con capturas, y refresco de la demo del 4381 al integrar.
