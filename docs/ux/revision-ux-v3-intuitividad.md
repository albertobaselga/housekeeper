# Revisión UX v3 · Auditoría de intuitividad

**Fecha:** 8 de agosto de 2026
**Método:** recorrido completo con Playwright (build de producción, base de datos propia `housekeeper_ux_audit`, puerto 4383) simulando a personas de 55+ años sin costumbre de aplicaciones. Recorridos: Alberto (admin, escritorio 1280×800), Ana (empleada interna, móvil 390×844), Marta (miembro), Lucía (apoyo) y hogar vacío (primer uso). Evidencias en pantallazos (`scratchpad/ux-audit/`, fuera del repo).
**Pregunta única:** ¿la pantalla se explica sola, o hay que llamar a alguien para que te la explique?

---

## 1. Resumen ejecutivo · veredicto por rol

| Rol | ¿La usaría sin ayuda una persona no técnica? | Resumen |
| --- | --- | --- |
| **Alberto (admin familiar)** | **A medias.** | «Hoy», Menú, Rutinas y Contactos se entienden con poco esfuerzo. «Acuerdos y pagos» y la wiki exigen que alguien se las explique: hablan en idioma de contable y de Confluence, no de casa. |
| **Ana (empleada interna, móvil)** | **Sí, con una explicación inicial.** | El circuito diario (rutinas, menú, gasto, jornada extra, confirmar cobro) funciona y usa frases razonables («confirma que lo has recibido»). Tropieza con «minutos trabajados», «parte semanal», «disputarlo» y con chips «Sin confirmar» sobre los que no puede actuar. |
| **Marta (miembro familia)** | **No en «Acuerdos y pagos»; sí en el resto.** | Su pantalla de pagos **parece rota**: dice «Todavía no hay liquidaciones» y «No hay una versión del acuerdo vigente» cuando lo cierto es que su rol no puede verlas. La app no distingue «no hay nada» de «no puedes verlo». |
| **Lucía (apoyo)** | **Sí para lo poco que ve, pero sin explicaciones.** | La navegación oculta bien lo que no le toca (no ve Pagos ni Ajustes). Si llega por enlace directo, recibe un «403 · Tu rol no permite abrir esta sección» seco, sin botón de vuelta. Nada le dice qué se espera de ella. |
| **Primer uso (hogar vacío)** | **No.** | Wiki y Menú son callejones sin salida: la wiki dice al administrador «Tu rol no tiene contenido visible» y no deja crear una página hasta crear antes un «espacio»; el menú pide «grupos de comensales» pero los comensales se crean en otra pestaña («Recetas») sin ninguna pista. Contactos es el único vacío bien resuelto. |

**Diagnóstico transversal:** la aplicación está bien construida por debajo (guarda todo, avisa de alérgenos, separa confirmaciones), pero **habla tres idiomas que este público no habla: Confluence («espacios», «borradores», «plantillas»), contabilidad («devengo», «liquidación», «materializar») e informática («sincronizado», «servidor», «rol», «RLS», «ICS», «Markdown»)**. Casi todos los hallazgos se arreglan cambiando literales y valores por defecto, no lógica.

---

## 2. Hallazgos priorizados

### P1 — Bloquean el uso autónomo

**P1-1 · Wiki: toda la sección está en jerga de Confluence.**
- *Pantalla:* Wiki de la casa (portada, crear página, editor).
- *Evidencia:* la portada encadena «CONOCIMIENTO COMPARTIDO», «EN PORTADA / Fijadas», «POR ESPACIOS / Espacios de la casa», «ACTIVIDAD / Recientes», «ESCRIBIR / Nueva página» con campos «Espacio», «Contenido (Markdown)», «Etiquetas (separadas por comas)», y «ORGANIZAR / Nuevo espacio». Cada página muestra «0 lecturas en 30 días».
- *Por qué confunde:* «wiki», «espacio», «página», «Markdown» y «etiquetas» no significan nada para este público; seis bloques compiten en una sola pantalla y ninguno responde «¿para qué sirve esto y qué hago yo aquí?».
- *Propuesta:* rediseño completo de literales y portada (sección 3). Es un cambio de textos y orden, no de modelo de datos.

**P1-2 · Wiki: «Convertir en plantilla» hace desaparecer un apartado entero con un clic y sin confirmación.**
- *Evidencia:* pulsando «Convertir en plantilla» junto a «Equipamiento», el espacio y todas sus páginas (incluida la recién creada «Cómo apagar la caldera») desaparecieron de «Espacios de la casa» y de «Recientes», y reaparecieron en una sección nueva «REUTILIZAR / Plantillas». Sin diálogo previo, sin explicación de qué es una plantilla.
- *Por qué confunde:* para un usuario no técnico esto es «he perdido mis notas». El botón está en primera línea de la portada, al lado del nombre del apartado, invitando al clic.
- *Propuesta:* mover la acción a un menú «⋯» del apartado, renombrar a «Usar como modelo para otra casa (avanzado)», pedir confirmación explicando el efecto, y que el espacio-plantilla **siga viéndose** en la lista normal con una insignia, en lugar de mudarse de sección.

**P1-3 · Wiki: crear una página deja un «Borrador» invisible por defecto.**
- *Evidencia:* el formulario «Nueva página» trae la casilla «Publicar directamente» **desmarcada**. Creamos «Cómo apagar la caldera» sin tocarla: quedó con chip «Borrador» y un botón «Publicar» aparte. Ana la ve listada como «Borrador» sin saber si puede fiarse de ella.
- *Por qué confunde:* quien escribe una instrucción para la casa espera que la casa la vea. «Borrador» es un concepto de oficina; nadie entenderá por qué su nota «no aparece».
- *Propuesta:* publicar por defecto. Sustituir la casilla por un enlace secundario «Guardar sin publicar todavía» dentro de «Opciones avanzadas».

**P1-4 · Wiki vacía: mensaje equivocado y callejón sin salida en el primer uso.**
- *Evidencia:* con el hogar vacío, el administrador ve «Tu rol no tiene contenido visible en la wiki de este hogar» y **no existe el formulario de crear página** (solo «Nuevo espacio», sin explicar que es requisito). Al lado, «HUECOS DOCUMENTALES / Lo que la casa buscó y no encontró: caldera · 0 sin resultados · 1 sin clic».
- *Por qué confunde:* al dueño de la casa se le dice que es un problema de «rol»; la única salida (crear un «espacio») no se anuncia; y «huecos documentales... sin clic» es analítica de producto, no lenguaje de casa.
- *Propuesta:* vacío guiado: «Aún no hay nada en la guía. Escribe la primera instrucción →» con un botón que cree el apartado «General» automáticamente. «Huecos documentales» → «Búsquedas sin respuesta», visible solo para el admin y al final de la página.

**P1-5 · Acuerdos y pagos: frases de máquina en pantalla.**
- *Pantalla:* Acuerdos y pagos (admin) y editor wiki.
- *Evidencia literal:* «El servidor materializa las líneas desde los hechos y congela los totales» (junto a «Cerrar liquidación»); «La tarifa se congela en el servidor con la versión vigente del acuerdo» (al resolver una jornada); «Cada línea conserva su origen y la regla vigente al cerrar el periodo»; en el editor wiki: «Editas sobre la revisión 1. Si alguien guardó otra más nueva, el servidor pedirá resolverlo a mano».
- *Por qué confunde:* «servidor», «materializar», «revisión» y «congelar» describen la implementación, no la consecuencia. El usuario necesita saber qué pasa, no cómo lo hace la base de datos.
- *Propuesta de literales:* «Al cerrar el mes, los importes quedan fijados y ya no cambian aunque cambie el acuerdo» / «Se pagará con la tarifa acordada en la fecha en que se trabajó» / (editor) mostrar aviso solo si ocurre el conflicto: «Otra persona guardó cambios mientras editabas. Revisa su versión antes de guardar la tuya».

**P1-6 · Marta: la pantalla de pagos parece estropeada en vez de restringida.**
- *Evidencia:* con dos liquidaciones existentes, Marta ve «Todavía no hay liquidaciones cerradas ni abiertas», «No hay una versión del acuerdo vigente en este periodo», «Total salarial —». Solo la sección Acuerdo dice la verdad: «Tu rol no puede ver los términos salariales».
- *Por qué confunde:* mensajes contradictorios; dos de ellos son literalmente falsos. Un usuario no técnico concluye «esto está roto» o «han borrado los datos».
- *Propuesta:* un único patrón para ausencia por permiso: «Los importes y liquidaciones solo los ven Alberto y Ana. Tú puedes revisar gastos y jornadas.» — y ocultar las tarjetas vacías en vez de mostrarlas con rayas.

**P1-7 · Menú en primer uso: los pasos previos están escondidos.**
- *Evidencia:* menú vacío → «Todavía no hay grupos de comensales en este hogar» con un formulario de grupo sin nadie que meter. Los comensales (y sus alergias) se crean en la pestaña «Recetas», dentro de «CATÁLOGO / Comensales y restricciones», un formulario con matriz de 14 alérgenos × 3 niveles. Nada conecta ambas pantallas. Además: «Todavía no hay recetas con datos estructurados» y «Alérgenos revisados (sin revisar, el menú bloquea sus recetas)».
- *Por qué confunde:* el orden real es comensales → grupo → menú, pero la app no lo cuenta; «datos estructurados» y el paréntesis técnico son incomprensibles; la matriz de alérgenos es una decisión de golpe demasiado grande para «apuntar que Leo no toma leche».
- *Propuesta:* en el menú vacío, guía de dos pasos: «1. Apunta quién come en casa → 2. Crea el grupo "Casa"». En el alta de comensal, empezar con «¿Tiene alergias o algo que evitar?» y desplegar solo lo marcado. Renombrar la pestaña «Recetas» a «Recetas y comensales» (o separar «Personas» en Ajustes).

**P1-8 · Liquidación recién cerrada: «Total transferido» miente.**
- *Evidencia:* nada más cerrar agosto (sin ningún pago registrado) la tarjeta muestra «Pagado / pendiente 0,00 € / 1.521,75 €» y a la vez «**Total transferido 1.521,75 €**».
- *Por qué confunde:* dice que se ha transferido un dinero que nadie ha enviado. Un empleador mayor puede creer que ya pagó; una empleada, que le deben algo ya enviado.
- *Propuesta:* revisar el literal/dato (parece que la fila «Total transferido» suma el total adeudado, no los pagos). Debe decir «Total a pagar: 1.521,75 € · Pagado: 0,00 €».

### P2 — Fricción o jerga que obliga a preguntar

**P2-1 · «Huecos» del menú.** «10 huecos del menú sin confirmar» (Hoy), «Guardar hueco» (botón del formulario), «No hay huecos de menú asignados para hoy». Nadie llama «hueco» a una comida. → «10 comidas de la semana sin confirmar», «Guardar», «Hoy no hay nada planificado».

**P2-2 · Rutinas: «Audiencia» + «Cada cuántas (1–12)» + «cada 1 semana(s)».** El formulario pide tres decisiones acopladas (Audiencia / Frecuencia / Cada cuántas) y las listas muestran «Empleada · cada 1 semana(s)». → «¿Quién la hace?» (Cualquiera / La familia / La empleada), «Se repite: cada [1] [semana/s ▾]» en un solo control, y en las listas «cada semana», «cada 2 días» en texto natural.

**P2-3 · Vocabulario distinto entre móvil y escritorio.** La misma sección se llama «Pagos» en la barra móvil y «Acuerdos y pagos» en escritorio; el rótulo interior es «EXPEDIENTE LABORAL». Tres nombres para una cosa. → elegir uno («Pagos» a secas, con subtítulo «Acuerdo, nómina y gastos») y usarlo en todas partes.

**P2-4 · Lista de la compra: dos clases de artículos sin explicación.** Los artículos añadidos a mano tienen casilla para marcar; los que vienen «del menú» (Pollo entero, Arroz…) **no tienen casilla**: no se pueden marcar como comprados. Además «Leche entera» aparece en dos líneas separadas (1 l del menú + 2 l manual) y el arroz sale como «0,26 kg». → casilla en todo, fusionar duplicados («Leche entera · 3 l»), redondear cantidades a medidas de tienda.

**P2-5 · «Resolver» y estados laborales crípticos.** «Jornada extra por resolver», «Realizada sin aceptación previa», «performed_pending_resolution» traducido a medias. «Resolver» suena a pleito. → «Decidir cómo se compensa» con las dos opciones a la vista («Pagarla» / «Darle descanso»), y estados en frases: «Hecha, falta decidir la compensación».

**P2-6 · «Devengo en curso» y «Liquidaciones».** Términos de nómina. → «Lo que va sumando este mes» y «Cuentas de cada mes». «Abrir/Cerrar liquidación» → «Empezar la cuenta de agosto» / «Cerrar el mes».

**P2-7 · Parte semanal: «minutos» y «disputarlo».** «Minutos trabajados» obliga a calcular (¿480?); «la familia tiene tres días para confirmarlo o disputarlo» suena a juicio. → entrada en horas:minutos (o «8 h») y «…para confirmarlo o comentarlo contigo». (El propietario ya conocía el problema de los minutos; sigue vigente en parte semanal Y en «Registrar jornada extra».)

**P2-8 · Ana ve chips «Sin confirmar» sobre los que no puede actuar.** En su menú del día y semana aparecen «Sin confirmar» sin botón ni explicación de quién confirma. Parece tarea suya pendiente. → o mostrarle «Pendiente de la familia», o no mostrarle el estado.

**P2-9 · «Cambio sincronizado» y «Todo guardado».** Toast tras cada acción y píldora permanente en la cabecera. «Sincronizado» es de informático y no dice qué cambió. → «Guardado ✓» y, mejor, con eco de lo hecho: «Rutina marcada ✓».

**P2-10 · Ajustes: «Caducidad y revocación», «Fijar caducidad», «Revocar acceso».** Lenguaje notarial. → «¿Hasta cuándo puede entrar?», «Poner fecha límite», «Quitar el acceso».

**P2-11 · «Traspaso operativo de la casa … ZIP verificable … expediente laboral».** Dos botones «Descargar traspaso (apoyo)» / «(familia)» sin explicar la diferencia. → «Copia para quien cuide la casa: guía, rutinas, menú y contactos» con dos opciones descritas («versión para una persona de apoyo: sin datos de familia», «versión completa para la familia»). «ZIP verificable» → «un archivo comprimido».

**P2-12 · Textos técnicos sueltos visibles para todos.** «El calendario real llegará con la conexión ICS» (Calendario); «Esta interfaz no sustituye autenticación ni RLS de producción» (Ajustes); login: «Entra con una perspectiva… combinación distinta de rutas y capacidades», «cookie HttpOnly efímera». → «Pronto podrás conectar el calendario de tu móvil»; el resto, retirarlo de la interfaz o dejarlo en tono demo simple («Elige con quién quieres entrar»).

**P2-13 · Aviso de alérgenos: bien de fondo, duro de forma.** El bloqueo funciona (botón desactivado hasta marcar la casilla), pero dice «Bloqueado por incompatibilidad de alérgenos … Sé que hay una incompatibilidad y asumo la decisión». → «⚠ Este plato lleva leche y Leo no puede tomarla» / casilla «Lo sé y aun así quiero apuntarlo».

**P2-14 · «Raciones (vacío = comensales del grupo)» y «2 raciones · base 4».** Sintaxis de programador y un «base 4» indescifrable. → «Raciones (si lo dejas vacío: las personas del grupo)» y «2 raciones (la receta original es para 4)».

**P2-15 · Lucía y Diego: la ausencia no se explica en ningún sitio.** La navegación reducida es correcta, pero ninguna pantalla dice «esto es todo lo que tu acceso incluye», y el 403 de enlace directo no tiene botón de vuelta ni tono de casa. → una línea en «Hoy»: «Tu acceso incluye el menú, las rutinas y los contactos» y en el 403: «Esta parte es de la familia. ← Volver a Hoy».

### P3 — Pulido

- **P3-1** Plurales de programador: «semana(s)», «día(s)», «mes(es)» → resolver la concordancia.
- **P3-2** Fechas en formato ISO en varios puntos: «vence el 2025-03-31», «Salario acordado 2026-08» → «vence el 31 de marzo de 2025», «Salario de agosto 2026».
- **P3-3** «Historial · 1 revisión» en páginas de la guía → «Cambios anteriores (1)».
- **P3-4** «0 lecturas en 30 días» repetido en cada tarjeta de la wiki: métrica de producto sin valor doméstico → eliminar (o dejarla solo al admin en una vista de mantenimiento).
- **P3-5** «Añadir a mano / Nuevo añadido» en la compra; «Alimento del catálogo: — Nombre libre —» → «Añadir otra cosa», selector «¿Qué es? (elige o escríbelo)».
- **P3-6** Tarjeta «GASTOS» desaparece del expediente del admin cuando no hay pendientes (sin estado vacío), mientras otras tarjetas sí lo tienen → mantener «Sin gastos pendientes» consistente. (En la vista de Ana sí existe.)
- **P3-7** El buscador dice «Buscar en toda la casa… ⌘K»: el atajo es ruido en tablet/móvil y para este público → ocultarlo salvo con teclado físico.

### Glosario de jerga a erradicar

| Jerga actual | Lenguaje de casa propuesto |
| --- | --- |
| Wiki de la casa | **Guía de la casa** |
| Espacio | Apartado |
| Página | Nota (o «instrucción») |
| Borrador | «Guardada sin publicar» (y dejar de ser el valor por defecto) |
| Plantilla (de espacio) | «Modelo» (solo en zona avanzada) |
| Huecos documentales | Búsquedas sin respuesta |
| Markdown / Visual | (desaparece; un solo editor con negrita y listas) |
| Etiquetas / Alias de búsqueda | «Palabras para encontrarla» (avanzado) |
| Revisión / Historial de revisiones | Cambios anteriores |
| Fijar / Desfijar | Destacar / Quitar de destacados |
| Hueco (del menú) | Comida (sin decidir / sin confirmar) |
| Franja | Comida del día (desayuno, comida, cena…) |
| Texto libre | «Escribir el plato a mano» |
| Audiencia | ¿Quién la hace? / ¿Para quién es? |
| Cada cuántas | Se repite cada… |
| Expediente laboral | Pagos (con subtítulo «acuerdo, nómina y gastos») |
| Liquidación | Cuenta del mes |
| Devengo en curso | Lo que va sumando este mes |
| Resolver (jornada) | Decidir cómo se compensa |
| Traspaso | Copia para otra persona |
| Caducidad / Revocar | Fecha límite de acceso / Quitar el acceso |
| Sincronizado / Cambio sincronizado | Guardado ✓ |
| Conexión ICS | El calendario de tu móvil |
| Rol («visibles para tu rol») | Tu acceso («lo que tú puedes ver») |
| Snapshot / RLS / cookie HttpOnly | (nunca en pantalla) |

---

## 3. Rediseño de la wiki → «Guía de la casa»

**Por qué no es intuitiva hoy (hipótesis comprobadas en el recorrido):**
1. **La palabra «wiki» no significa nada** para este público; el subtítulo actual («Cómo funciona cada cosa…») es mejor nombre que el título.
2. **Es Confluence doméstico:** espacios, páginas, borradores, plantillas, etiquetas, alias, revisiones, Markdown. Ocho conceptos para «apuntar cómo va la lavadora».
3. **La portada mezcla seis bloques** (fijadas + espacios + plantillas + actividad + crear página + crear espacio) sin decir cuál es el camino normal.
4. **Crear una nota pide 5 decisiones** (título, espacio, Markdown, etiquetas, ¿publicar?) y la opción por defecto —borrador— es la equivocada.
5. **El primer uso es un callejón sin salida** («Tu rol no tiene contenido visible», sin formulario de página hasta crear un espacio).
6. **Nada explica para qué sirve** ni qué conviene guardar ahí.

### Antes → después

**Nombre y navegación**
- Antes: «Wiki de la casa» / eyebrow «CONOCIMIENTO COMPARTIDO».
- Después: **«Guía de la casa»**, subtítulo: «Las instrucciones de tu casa: aparatos, recetas, niños, limpieza. Escríbelo una vez y cualquiera lo encuentra».

**Portada**
- Antes: Fijadas → Espacios (+Convertir en plantilla) → Actividad/Recientes → Nueva página (5 campos) → Nuevo espacio. Contadores «0 lecturas en 30 días» por página.
- Después, en este orden:
  1. **Buscador** («¿Qué necesitas saber? p. ej. lavadora, caldera…»).
  2. **Un único botón primario: «✏️ Escribir una instrucción».**
  3. **«Destacadas»** (las fijadas de hoy, sin contadores).
  4. **Apartados como tarjetas grandes con icono** (Cocina y recetas 🍲, Aparatos 🔧, Niños 🧒, Limpieza 🧺…), cada una con el número de notas.
  5. (Solo admin, al final, plegado) **«Mantenimiento de la guía»**: búsquedas sin respuesta, administrar apartados, modelos. Aquí viven «Nuevo espacio» y «Convertir en plantilla» renombrados y con confirmación.
- Se elimina de la portada: «Actividad/Recientes» como bloque propio (puede ser una línea «Última nota: …»), los contadores de lecturas, y los dos formularios permanentes.

**Escribir una instrucción (antes «Nueva página»)**
- Antes: Título + Espacio (obligatorio elegir) + Contenido (Markdown) + Etiquetas + casilla «Publicar directamente» desmarcada.
- Después: **dos campos**: «¿Sobre qué?» (título) y el texto, con un editor único visual (negrita, lista, foto). «¿Dónde la guardamos?» propone un apartado con valor por defecto («General» o el último usado). **Botón único «Guardar y publicar»**; debajo, en pequeño, «Guardar sin publicar todavía». «Etiquetas», «alias» y «resumen del cambio» quedan dentro de «Opciones avanzadas» plegadas.

**Página / nota**
- Antes: chip «Fijada», «0 lecturas en 30 días», «Historial · 1 revisión», aviso permanente de revisiones en el editor.
- Después: título, texto, «Actualizada el 8 de agosto por Alberto», botón «Editar», «Destacar». «Cambios anteriores» plegado. El aviso de conflicto solo aparece si de verdad hay conflicto, redactado en humano.

**Recetas**
- La ficha de receta (raciones, tiempo, ingredientes) sigue viviendo en el apartado «Cocina y recetas» de la guía, y el menú enlaza ahí. «Todavía no hay recetas con datos estructurados» → «Aún no hay recetas. Escribe la primera →».

**Primer uso**
- Antes: «Tu rol no tiene contenido visible…» y solo «Nuevo espacio».
- Después: «La guía está vacía. Empieza por lo que más se pregunta en casa: ¿cómo va la lavadora? ¿a qué hora recogen a los niños?» + botón «Escribir la primera instrucción» (crea el apartado General solo). Ofrecer 3-4 apartados de serie ya creados (General, Aparatos, Cocina) para que nadie tenga que inventar la estructura.

---

## 4. Qué NO se propone aquí

Por estar ya en desarrollo por otro equipo: crear recetas desde el hueco del menú y semanas plantilla del menú. Los flujos actuales de menú se han auditado tal cual existen (hallazgos P1-7, P2-1, P2-4, P2-8, P2-13, P2-14).

## 5. Nota final

Casi todo lo anterior es **coste bajo**: literales, valores por defecto, orden de bloques y estados vacíos. Los únicos cambios con algo de lógica son: publicar por defecto en la guía (P1-3), confirmación de plantilla (P1-2), casillas en artículos «del menú» de la compra (P2-4), fila «Total transferido» (P1-8) y los mensajes de ausencia-por-permiso de Marta (P1-6). Priorizar wiki y Acuerdos y pagos: son las dos secciones donde hoy un usuario no técnico se rinde.
