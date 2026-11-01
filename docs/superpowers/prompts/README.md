# Prompts de funcionalidades por hacer

Cada fichero de esta carpeta es un **prompt**: el encargo completo de una
funcionalidad para una sesión futura de un agente (o de una persona), con las
decisiones que el propietario ya tomó, las que el redactor propone y las que
quedan abiertas, y el workflow que lleva desde el diseño hasta producción.

Se redactaron el 31 de octubre y el 1 de noviembre de 2026 en una
conversación con el propietario, antes de escribir una sola línea de código de
ninguna de las cuatro, para que cada una se construya después con calma y con
el mismo rigor que Finanzas y Cupones: spec aprobado, plan por tareas, TDD,
revisión adversarial, revisión de seguridad ejecutada, documentación y puesta
en producción con confirmación. Tres revisores independientes leyeron cada
prompt como constructores que no podían preguntar y comprobaron cada
referencia contra el repositorio; lo que encontraron está incorporado.

## Cómo se usa un prompt

1. Abre una sesión nueva en un worktree propio sobre `main` al día.
2. Pide que lea `workflow-comun.md` y el prompt de la funcionalidad, enteros.
3. El agente arranca por la fase 1 del workflow (diseño) y **no construye
   nada** hasta que el spec esté aprobado en la conversación.
4. Las tareas marcadas «⚠️ REQUIERE CONFIRMACIÓN DEL PROPIETARIO» no se
   ejecutan sin un «sí» expreso. Las credenciales de producción no están en la
   máquina del agente: él prepara los comandos y el propietario los ejecuta.

## Los prompts

| Orden | Prompt | Qué construye | Por qué en este orden |
|---|---|---|---|
| 1 | [`2026-10-31-modulo-garantias.md`](2026-10-31-modulo-garantias.md) | Archivo de garantías de la casa: artículo, identificador, fechas de compra y fin, varios documentos (fotos y PDF), búsqueda, aviso en Hoy | Sigue el molde de Cupones; es el más acotado y no cambia ninguna decisión vigente |
| 2 | [`2026-11-01-acceso-enlaces-magicos-resend.md`](2026-11-01-acceso-enlaces-magicos-resend.md) | Entrada por enlace y código por correo (Resend), sesión deslizante de 15 días, altas sin contraseña provisional, el correo vuelve acotado al acceso | Los dos siguientes lo necesitan: el asistente no puede enseñar contraseñas y la web pública da de alta a desconocidos. Cambia cómo entra la familia actual: corte comunicado |
| 3 | [`2026-10-31-webmcp-asistentes.md`](2026-10-31-webmcp-asistentes.md) | Servidor MCP remoto con OAuth para que ChatGPT y Claude administren la casa con los permisos de cada persona; regla de cobertura para todo módulo futuro; el producto pasa a llamarse Homekeeping en pantalla | Cubre Garantías; el alta de personas por el asistente se apoya en el acceso por correo; trae spike, ADR y una regla nueva en CONTRIBUTING |
| 4 | [`2026-10-31-web-publica-homekeeping.md`](2026-10-31-web-publica-homekeeping.md) | Web pública de Homekeeping, alta de hogares en autoservicio con Stripe (19,90 €/mes IVA incluido, 14 días de prueba), 5 + 3 plazas, legal | Cambia el modelo del producto (alta pública, cobro); usa el correo y el acceso del prompt 2 y promete el asistente del prompt 3 |

**Van en secuencia, no en paralelo.** Tocan los mismos puntos coordinados
(`HOUSEHOLD_MODULES`, `NAV_ENTRIES`, `SECTION_LABELS`, `auth-core.ts`, el
manual, `CONTRIBUTING.md`), varios traen migración (dos ramas a la vez
cogerían el mismo número y el runbook dejaría de poder decir «la última
migración es la NNNN»), el acceso cambia con el segundo, el nombre del
producto con el tercero, y el gate `mcp-coverage` del tercero pone en rojo
cualquier módulo que llegue después sin sus herramientas. Si el orden cambia,
cada prompt dice de qué depende, y hay que contar con un rebase y con repetir
las puertas.

## Lo común

[`workflow-comun.md`](workflow-comun.md) reúne lo que los cuatro comparten:
entorno, lecturas obligatorias, las siete fases con sus puertas, las reglas
que no se negocian, el procedimiento de producción y las trampas. Si un prompt
y el común se contradicen, manda el prompt.

## Cuando una funcionalidad se termina

El prompt no se borra: se le añade una cabecera «Ejecutado el … · spec … ·
plan … · en producción desde …» con los enlaces, y se deja como registro de lo
que se pidió frente a lo que se construyó. Lo que se aprendió del workflow se
corrige en `workflow-comun.md`.
