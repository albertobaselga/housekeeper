# Plan de inclusión: «Manual de convivencia y operaciones v0.1»

Fuente: documento Word del hogar (v0.1, 29/07/2026), 10 secciones + 10 anexos,
~920 párrafos, 225 campos «Pendiente de completar por la familia». No se
versiona el .docx en el repo; el contenido entrará por el importador de wiki.

## Principio de mapeo

El manual NO es solo wiki: mezcla cuatro naturalezas distintas que la app ya
modela por separado. Importarlo todo como páginas planas desperdiciaría la
estructura; el plan reparte cada sección en su pieza nativa:

| Naturaleza | Contenido del manual | Destino en la app |
|---|---|---|
| Conocimiento consultable | Fichas de limpieza, cocina, colada, zonas, convivencia, niños, mantenimiento, anexos A–F | Wiki (Guía de la casa) |
| Tareas recurrentes | Rutina diaria, plan semanal, quincenal y periódico; inicio/durante/cierre de jornada | Rutinas (audiencia + frecuencia) |
| Datos estructurados | Alergias e intolerancias; contactos y emergencias (Anexo G); menú y recetas (Anexo D) | Comensales y restricciones · Contactos/Emergencias · Recetario + semanas plantilla |
| Decisiones abiertas | Los 225 «Pendiente de completar» | Borradores de wiki + página índice de pendientes |

## 1. Wiki — «Guía de la casa»

Espacios propuestos (uno por dominio real del manual, con nombres en lenguaje
de casa; los definitivos se alinearán con el rediseño de wiki en curso):

1. **La casa y sus zonas** — distribución, mapa funcional, almacenaje, reglas de colocación (+ Anexo A).
2. **Limpieza** — método general; una página por ficha operativa (mármol, tarima, terrazo); particularidades por zona (+ Anexo B productos autorizados).
3. **Cocina** — higiene, separación de alimentos, cocción/frío/recalentado, sobras y etiquetado, cierre de cocina; una página por aparato: Thermomix, horno e inducción, sartenes de acero (+ Anexo F electrodomésticos).
4. **Ropa y colada** — secuencia, manchas y delicados, lavado/secado, planchado, doblado y guardado, incidencias de ropa (+ Anexo C programas de lavado, como tabla).
5. **Los niños** — pautas, incumplimientos, salud y medicación, descanso, qué comunicar (+ Anexo E horarios y pautas).
6. **Convivencia** — comunicación temprana, jornada y descansos, ruido, privacidad recíproca, espacios privados, compra personal.
7. **Mantenimiento e incidencias** — qué revisar, límites de actuación, ordinaria vs urgente, actuación ante riesgo, consumibles.

Páginas **fijadas en portada**: «Principios generales», «Guía rápida: inicio de
jornada», «Guía rápida: cierre de jornada» (son lo que se consulta a diario).

Granularidad: una página por Heading2 del manual (≈45 páginas), agrupando los
apartados menores de 6 líneas con su hermano mayor. Las tablas del Word se
convierten a tablas Markdown; los avisos (callouts) a citas destacadas.

## 2. Rutinas — planes de trabajo

«Rutinas generales» se convierte en rutinas reales, no en texto:

- **Rutina diaria de referencia** → rutinas diarias con audiencia «Empleada» (o «Toda la casa» según ítem).
- **Plan semanal** → semanales (interval 1).
- **Plan quincenal** → semanales con «cada 2» (el modelo ya lo soporta).
- **Plan periódico** → mensuales/trimestrales según cada ítem.
- Inicio/durante/cierre de jornada de la «Guía rápida» quedan en wiki como
  chequeo consultable (fijadas), no como 20 micro-rutinas que ensuciarían Hoy.

Cada rutina llevará en «Detalles» el enlace conceptual a su página de wiki
(p. ej. «Ver ficha: tarima»).

## 3. Datos estructurados

- **Anexo G (contactos y emergencias)** → Contactos del hogar con tipo, y los
  críticos marcados «Destacado» para que aparezcan en Emergencias y offline.
- **Alergias, intolerancias y restricciones** → restricciones por comensal
  (alimentan las alertas de incompatibilidad del menú). Hoy están «Pendiente de
  completar» en el Word: quedan como tarea de la familia EN la app, no en papel.
- **Anexo D (menú y recetas familiares)** → recetas al recetario (1:1 con wiki)
  y las semanas tipo como **semanas plantilla con nombre** (función en
  desarrollo). El menú del Word deja de existir como documento.
- **Horarios y jornada** → ya viven en Acuerdos y pagos (acuerdo y versiones);
  el manual no debe duplicarlos: la página de wiki correspondiente remitirá a
  esa sección.

## 4. Los 225 «Pendiente de completar»

Regla de importación:

- Página con pendientes → se importa como **borrador** (solo lo ve la familia)
  con el marcador resaltado (`> Pendiente de completar por la familia: …`).
- Página sin pendientes → se publica directamente.
- Se genera una página índice «Pendientes de completar» (borrador, fijada para
  la familia) con enlace a cada hueco, para ir vaciándola.
- Publicar cada página al completarla es 1 toque («Publicar»); el historial de
  revisiones de la wiki sustituye al «Anexo J. Control de versiones».

## 5. Huecos que el manual revela en la app (decisiones para el propietario)

1. **Registro de incidencias (Anexo I)**: no existe módulo. Corto plazo: espacio
   «Mantenimiento e incidencias» de la wiki con una página por incidencia
   (editor visual + foto). Medio plazo: mini-módulo de incidencias
   (estado abierta/resuelta, foto, aviso en Hoy) — estimable como oleada corta.
2. **Lista quincenal personal de la interna (Anexo H)**: la compra de la app es
   del hogar. Opciones: sección «Personal» en la lista (visible solo para la
   interna y administración, coherente con «compra personal verificable»), o
   página de wiki. Recomendación: sección en la compra (encaja con el flujo
   existente de marcar/añadir).
3. **«Ruta de consulta» del manual** → la reemplaza el buscador global (⌘K) +
   portada de la Guía; no se importa como página.

## 6. Mecánica y secuencia

1. **Tras integrar el rediseño de wiki** (en curso: renombrados y portada
   simplificada), para que el contenido nazca con la estructura definitiva.
2. Script de conversión docx→Markdown (front-matter: espacio, título, etiquetas,
   fijada, borrador) en `packages/db/scripts/`, junto al importador existente.
3. `wiki-import.mjs --dry-run` sobre base local (transaccional, idempotente por
   hash) → revisión → importación real.
4. Alta de rutinas/contactos/restricciones por sus comandos normales (script de
   siembra una sola vez, idempotente por operationId).
5. La familia vacía «Pendientes de completar» desde la app y publica.

Nota de datos: v0.1 está redactado sin nombres propios («la persona interna»,
«los padres»). Los campos que se completen con datos personales reales entran
ya bajo el régimen del hogar en producción (RLS + sin PII en logs); las bases
de demostración siguen siendo solo sintéticas.
