# Sistema móvil de Casa Clara

> Decisión de diseño, no informe. Las tres auditorías (interna, administración y
> sistema) coinciden en los síntomas y se contradicen en cuatro o cinco números;
> aquí se elige uno de cada y se dice por qué. Lo que esta nota fija es lo que hay
> que construir. Toda medida citada está verificada contra `main` (`0fdf873`) o
> contra las capturas de las tres auditorías.

---

## 1 · El diagnóstico

**No hay sistema: hay 529 reglas que se acumularon.** `apps/web/src/app.css` declara
33 tokens en `:root` — 23 de color, 4 de radio, 3 de sombra, 3 de layout — y **cero
de espaciado y cero de tipografía**. Los dos ejes que deciden la densidad en un
teléfono son exactamente los dos que nadie tokenizó, así que cada componente
inventó los suyos: **40 valores distintos de espaciado en 329 declaraciones** y
**39 tamaños de letra en 139**, de los cuales 21 están por debajo de 14 px con
saltos de 0,16 px. Veinticinco sabores de «pequeño» no son una jerarquía: son
adivinanzas por componente. Y como nada está tokenizado, ningún punto de ruptura
puede cambiar la densidad: de las 109 declaraciones de `@layer responsive`, 10
apilan columnas y solo 4 tocan tipografía — ninguna de las 4 toca contenido. La
consecuencia es medible y es absurda: una fila de tarea mide **64 px a 1280 y 64 px
a 390**, y la tira de cuatro cifras de Pagos mide **80 px a 1280 y 315 px a 390**,
3,9 veces más alta en el dispositivo con un tercio del espacio.

**Y lo único que sí se adapta es el marco, hacia arriba.** Entre el 33 % y el 41 %
de la primera pantalla a 390 px —y entre el 51 % y el 61 % a 320— se gasta en
repetirle a la persona dónde está antes de enseñarle un dato: cabecera fija de
64 px con el nombre de la casa en la que ya sabe que está, un `h1` de 32 px que dice
**lo mismo que la pestaña activa de la barra inferior en 6 de 8 pantallas**, un
eyebrow decorativo y una descripción de bienvenida servida en cada visita. Mientras
tanto el contenido encoge: el título de una tarea mide **14,08 px** y el importe
total de Pagos mide **16 px**, el mismo tamaño que un párrafo. La inversión es
exacta —lo que más ocupa es lo que menos informa— y de ella salen los tres síntomas
caros que las tres auditorías encontraron por separado: la casilla de la compra de
**13×13 px**, las **25 cifras en 12 posiciones horizontales distintas**, y la primera
acción del expediente a **1.059 px** del principio. Por eso la reparación no es una
lista de arreglos: es cerrar las dos escalas que faltan, poner presupuesto al marco
y devolverle el tamaño al dato.

---

## 2 · El sistema

### 2.0 Las contradicciones, resueltas

Antes de las escalas, lo que las tres auditorías pedían distinto. Estas decisiones
mandan sobre el texto de los tres informes.

| Cuestión | interna | admin | sistema | **Decisión** |
|---|---|---|---|---|
| Diana mínima | 44 px | 44 px + 8 de separación | 48 px sin excepciones | **44×44 como suelo absoluto, sin lista de excepciones, + 8 px de separación; y regla de fila: lo que se pulsa muchas veces es la fila entera, de 56 px.** 48 en todo gastaría el presupuesto vertical que estamos recuperando, y lo que hoy falla no es 44 frente a 48: es la casilla de 13 y el enlace de 19. |
| Piso tipográfico | 14 px para contenido | 13 px duro | 11 px absoluto | **12 px para etiqueta de 1–3 palabras (columna, pestaña, navegación); 14 px para cualquier cosa que sea una frase.** El 11 px se proponía para una etiqueta de columna: el píxel de más cuesta nada y cierra la discusión. |
| Marco a 320 px | ≤ 30 % | «la primera acción entera cabe» | ≤ 25 % | **≤ 20 % a 390 y ≤ 25 % a 320, y además la prueba dura de la administración.** Con el topbar fuera el 25 % sale solo; la prueba de la primera acción es la que de verdad importa y no se puede aprobar por casualidad. |
| Cabecera de página | ≤ 96 px | 22–24 px en una línea | ~44 px, el `h1` dice el estado | **44 px: una línea de 24 px que dice el estado.** Los 96 px de la interna eran el presupuesto de comprimir eyebrow + `h1` + descripción; pero ninguno de los tres tiene lector en móvil. Quitados, 96 son 44. |
| Tablas de la Guía | fichas apiladas < 480 px | — | scroller con máscara | **Tabla de datos → filas-ficha por debajo de 600 px. La máscara es para tiras de chips, no para tablas.** Una tabla con scroll horizontal mudo esconde justo la columna «Avisar si». |
| Tiras de pestañas | `Select` nativo o envoltura | — | scroller con máscara | **≤ 4 pestañas: envuelven a dos líneas, ninguna invisible. > 4: scroller con máscara en degradado y un chip siempre cortado a la mitad.** Menú tiene 3 → envuelven. Los apartados de la Guía son 7 → scroller. |
| Topbar en móvil | (se queja de sus piezas) | (se queja de sus piezas) | fuera por debajo de 48rem | **Fuera por debajo de 52rem**, con sus cuatro contenidos re-alojados (§4). El nombre del hogar sobrevive **solo en Hoy**, que es lo que el commit `0fdf873` quería decir, a 1/8 del coste. |
| La crema `#f6f3ec` | — | — | «opcional: casi-blanco en móvil» | **Se queda.** Está en producción: `theme-color`, icono, manual con 20 capturas. Repintar un producto vivo por gusto es lo que ninguna de las tres auditorías pide. El riesgo estético se gasta entero en la tipografía (§2.2). |
| Pasos de espaciado | 6 | 6 | 7 | **7**, con el séptimo (48) disponible solo a partir de 48rem. |
| Las 4 cifras de Pagos | «no repitas el total tres veces» | «columna fija de importes» | «rejilla 2×2, nunca apilar» | **Las tres, y en este orden**: primero se borra la cifra repetida, luego rejilla 2×2, luego columna fija. Apilar mejor un dato que sobra no arregla nada. |
| Sombras | — | — | ninguna en móvil | **Ninguna en móvil** salvo lo que flota (hoja «Más», popover, overlay). Las actuales (`0 12px 34px`, `0 28px 80px`) son sombras de página de marketing y emborronan el borde de una lista densa. |

### 2.1 Escala de espaciado — 7 pasos, base 4

```css
:root {
  --space-1: .25rem;  /*  4 px */
  --space-2: .5rem;   /*  8 px */
  --space-3: .75rem;  /* 12 px */
  --space-4: 1rem;    /* 16 px */
  --space-5: 1.5rem;  /* 24 px */
  --space-6: 2rem;    /* 32 px */
  --space-7: 3rem;    /* 48 px — solo a partir de 48rem */
}
```

**Regla:** ningún `gap`, `padding`, `margin` ni `border-radius` fuera de esta lista o
de los tokens de radio. Los 23 valores por debajo de 16 px se mapean al paso más
cercano; los ajustes ópticos (`.05rem`, `.08rem`, `.13rem`, `.22rem`, `.28rem`) van a
`0` o a `--space-1`. Nadie percibe la diferencia entre `.55rem` y `.58rem`: es coste
de mantenimiento disfrazado de intención.

Encima de la escala, **tres tokens de densidad que sí cambian con el ancho** — hoy
solo lo hacen dos paddings sueltos, y son las dos únicas medidas de densidad
adaptativas de todo el sistema:

```css
:root {                        /* compacto: móvil primero */
  --pad-page-x: var(--space-3);   /* 12 px de gutter (hoy 18,4) */
  --pad-page-y: var(--space-3);
  --pad-card:   var(--space-3);
  --gap-card:   var(--space-2);   /* 8 px entre tarjetas (hoy 16, fijo) */
  --gap-section: var(--space-5);
}
@media (min-width: 48rem) {    /* cómodo */
  :root { --pad-page-x: var(--space-6); --pad-page-y: var(--space-6);
          --pad-card: var(--space-5);  --gap-card: var(--space-4);
          --gap-section: var(--space-7); }
}
```

**Hueco mínimo entre bloques distintos: nunca 0.** Hoy el hueco vertical más
frecuente entre hermanos es exactamente `0`, 233 veces — por eso en Rutinas el `h2`
«Rutinas de la casa» queda pegado al primer título de rutina.

### 2.2 Escala tipográfica — 7 roles nombrados por función

| token | móvil | ≥48rem | peso | para qué |
|---|---|---|---|---|
| `--text-micro` | **12 px** / 1.4 | 12 px | 600 | etiqueta de columna, pestaña, navegación. Máximo 3 palabras. **Nunca una frase.** |
| `--text-meta` | 13 px / 1.4 | 13 px | 400 | apoyo: fecha, autoría, origen, cadencia |
| `--text-body` | 15 px / 1.5 | 16 px | 400 | texto corrido (la Guía) |
| `--text-strong` | **16 px** / 1.35 | 16 px | 500 | **el nombre de la cosa en cada fila** (hoy 14,08 px) |
| `--text-title` | 20 px / 1.25 | 22 px | 700 | título de tarjeta (`h2`) |
| `--text-page` | **24 px** / 1.2 | 32 px | 700 | título de pantalla (hoy 32 fijo / 48) |
| `--text-data` | 24 px / 1 | 28 px | 700 | **el número**: importe, hora, cuenta. `font-variant-numeric: tabular-nums` |

**Pesos: exactamente tres — 400, 500, 700.** Se eliminan 650, 750 y 800. No existen
en ninguna fuente de sistema y redondean distinto en cada plataforma: hoy `.button`,
`.side-nav a` y `.eyebrow` salen **Black en Android y Bold en iPhone**. 53
declaraciones → 3 valores.

**Alturas de línea: tres** (1.2 para ≥20 px, 1.35 para 15–16 px, 1.4 para ≤13 px).

**Disciplina por pantalla: como máximo 4 de los 7 tamaños y 3 pesos.** Hoy una
pantalla usa 27 tamaños y 45 combinaciones tamaño/peso.

**La inversión, en una frase:** el título de pantalla baja de 32 a 24 px y el título
de fila sube de 14 a 16. El marco encoge 8 px y el contenido crece 2. La pantalla se
lee más grande ocupando menos.

#### La fuente: enviar una de verdad, una sola

Hoy `font-family: Inter, …` está declarado y **Inter no se envía**: no hay
`@font-face`, no hay ficheros en `apps/web/static/` y `document.fonts` devuelve 0
caras. El producto no tiene tipografía: tiene la del teléfono de cada cual.

Se envía **un `woff2` variable, autoalojado, subconjunto latino, `font-display: swap`,
precacheado por `src/service-worker.ts`, ≤ 40 KB**. No entra en el presupuesto de
`verify-today-bundle.mjs` (que cuenta JavaScript), pero sí en el de red: si el
subconjunto no baja de 40 KB, no se envía.

**Elección: Atkinson Hyperlegible Next.** La justificación no es estética: se diseñó
para legibilidad a tamaño pequeño y para baja visión, desambiguando 1/l/I y 0/O —
que es exactamente el modo de fallo de un importe o una hora de 13 px leídos de pie,
en el súper o en una cocina, con la otra mano ocupada. Y de paso deja de parecerse a
Inter, con lo que el producto deja de tener el aspecto por defecto. **Condición de
aceptación antes de mergear**: cifras tabulares lining reales, diacríticos completos
del español (á é í ó ú ñ ü ¿ ¡), licencia OFL, eje de peso 400–700. Si su juego de
cifras no aguanta la columna de dinero, la alternativa es Source Sans 3. Es el
riesgo estético de esta propuesta y se sostiene solo con el argumento de uso.

**El segundo rol no cuesta un segundo fichero.** `--font-data` es la misma familia
con `tabular-nums`, `letter-spacing: -.01em` y peso 700. **Toda hora, todo importe y
toda cuenta lo usan.** Ese es el «display» del producto: aquí lo característico es
que cada fila es *un momento y una cosa*, así que el número es el titular. Alineado
en columna fija, la lista se baja con la vista por las cifras sin leer.

#### El acento deja de decorar

Terracota `#a85a33` aparece hoy casi solo en `.eyebrow`, `.meal-list time`,
`.result-type` y `.wiki-pinned small`: el único color con carácter de la paleta está
reservado al texto más prescindible de la pantalla. A partir de ahora **el terracota
marca «ahora» y nada más**: la fecha de hoy, la hora de la siguiente tarea, la línea
del momento actual en la agenda, el periodo abierto en Pagos. Es información, no
adorno, y sale gratis: basta con quitarlo de los cuatro sitios decorativos —
empezando por `.eyebrow`, que además deja de pintarse en móvil.

### 2.3 Densidad por tipo de contenido — tres alturas de fila

La altura la elige **el contenido**, no el punto de ruptura.

| tipo | altura | cuándo | área pulsable |
|---|---|---|---|
| **fila-acción** | `min-height: 56px` | lo que se pulsa: tarea, ficha de la Guía, contacto, artículo de la compra | **la fila entera** |
| **fila-dato** | `min-height: 44px` | solo lectura: apunte del expediente, evento de agenda | ninguna |
| **fila-densa** | `min-height: 48px` | listas de marcar en marcha (la compra en el súper) | la fila entera |

Efecto medido en la Guía: `.wiki-list > button` pasa de 84–102 px a 56 → de 6 fichas
visibles a 390 px a ~11, y de 3 a 320 px a ~6.

**Un contenedor por pantalla.** Nada de tarjeta dentro de tarjeta: hoy la sangría
antes del texto es `page-wrap 18,4 + card 16 = 34,4 px` de 390 (el 9 % del ancho).
Con el gutter a 12 y `--pad-card` a 12, son 24.

**Un grupo de ≤ 4 cifras cortas nunca se apila**: o rejilla 2×2 de celdas de 55 px
(110 px en total), o una sola línea de resumen con enlace al detalle (44 px).
Sustituye a `@media (max-width: 36rem) { .summary-strip { grid-template-columns:
minmax(0,1fr) } }`, que es lo que produce los 315 px de hoy.

### 2.4 Dianas táctiles

- **Suelo absoluto 44×44 px para todo elemento interactivo. Sin lista de
  excepciones.** Hoy el 47 % está por debajo.
- **Separación mínima de 8 px entre dianas contiguas.** Hoy en Ajustes «Poner fecha
  límite» y «Quitar el acceso» están a 7 px, son idénticas y una es destructiva.
- `.button { min-height: 2.75rem }` = 44 px (hoy `2.65rem` = 42,4: se queda 2 px
  corto en toda la app, que es lo peor de los dos mundos).
- **`.small-button` deja de significar «más pequeño» y pasa a significar «más
  estrecho»**: 44 px de alto, menos relleno lateral. Hoy son 36 px.
- **Casillas y radios**: la marca puede medir 20 px, el área de toque mide 44. Hoy
  el `input[type=checkbox]` de la compra mide 13×13 (el 9 % del área necesaria) y el
  de los 15 alérgenos, 13×13 con 6 px entre etiquetas — el formulario que decide si
  un niño con alergia alta a la lactosa come o no.
- **Regla del enlace-fila**: ningún enlace de navegación puede ser un `<a>` suelto
  dentro de un encabezado. `.section-heading > a` mide 97×**19 px** y aparece 16
  veces: o la fila entera del encabezado es el enlace (≥48 px), o el enlace se
  convierte en chip con 12 px de relleno vertical.
- **Barra inferior**: 68 → **56 px**, icono de 20, etiqueta a **12 px/600** (hoy
  9,76 px: el texto más pequeño del producto está en el control más usado), área por
  destino ≥ 56×48.

### 2.5 Gramática de acciones

**Tres pesos y solo tres.** `primaria` (rellena, `--primary`), `secundaria` (borde,
`--line`), `peligro` (`--danger`, que existe en `:root` y no se usa nunca).

- **Una sola primaria por tarjeta, y es la que más se hace.** Hoy Calendario abre con
  una primaria de banda completa —«Enlazar un calendario», acción de una vez en la
  vida— y Hoy abre con una banda completa de «Emergencias». **Una acción que se usa
  menos de una vez al mes no lleva nunca botón de banda completa**: va debajo del
  contenido o en «Más».
- **Banda completa solo para** el envío final de un formulario y la acción primaria
  de una hoja o modal. Se borra `@media (max-width: 36rem) { .page-actions,
  .page-actions .button { width: 100% } }`, que hace exactamente lo contrario.
- **La acción irreversible no es lo primero que se toca.** «Empezar la cuenta del
  mes» abre una liquidación y hoy es el CTA más prominente, encima del resumen.
  Igual en Menú con «Copiar esta semana al lunes».
- **La destructiva va separada por un divisor, agrupada al final del bloque de su
  dueño, y nombra a su sujeto en el propio botón**: «Quitar el acceso a Ana», nunca
  a 212 px del nombre al que pertenece y a 9 px del nombre de la siguiente persona.
- **Una acción por fila, al final de la fila** (derecha en LTR), siempre en el mismo
  sitio. En el expediente, cuando hay dos jornadas por decidir, los dos botones
  «Decidir compensación» son idénticos y ninguno dice de cuál es.
- **El acuse aparece donde estaba el dedo y no empuja nada.** Hoy «Guardado ✓» se
  *inserta* sobre la tarjeta y baja el contenido ~90 px (el dedo queda sobre otra
  fila), o aparece 500 px más abajo pegado a otro formulario. El hueco del acuse se
  **reserva** en la fila (`min-height` en el slot) y se pinta ahí. `ActionStatus.svelte`
  ya es el patrón correcto: gana una variante de fila y pasa a ser el único.
- **Un solo aviso.** `.queued-note`, `.success-message`, `.form-error`,
  `.wiki-confirm`, `.allergen-block` y `.demo-note` son 6 cajas con 6 rellenos y 5
  tamaños de letra: se colapsan en una `.note` con modificador de tono.
- **El verbo no cambia por el camino**: el botón que dice «Enviar la semana» produce
  «Semana enviada». Y **un borrador nunca se etiqueta «Enviado»**
  (`WeeklyReportCard.svelte:34`: `alreadyReported` es cierto si *existe* un parte,
  sin mirar el estado; la línea 157 trata todo lo que no es `confirmed`/`disputed`
  como «Enviado». Hoy la interna ve «Semana enviada» y «Borrador» a la vez, y no
  puede mandar su semana).

### 2.6 Tarjetas

- Radio: `--r-sm: 8px` (chips, campos), `--r-md: 12px` (botones, filas), `--r-lg:
  16px` (tarjetas, hojas), `--r-full: 999px` (**solo** chips de estado y avatares).
  Se borran los 16 literales sueltos. Anidamiento: radio interior = radio exterior −
  relleno, con suelo en 8.
- Sombra: **ninguna en móvil**. La separación la dan la línea de 1 px y el fondo. Un
  único token para lo que flota: `--shadow-over: 0 8px 24px rgb(28 42 34 / .18)`.
- **Una tarjeta = un asunto.** Si dentro hay dos listas del mismo dato, sobra una:
  hoy Hoy pinta las 6 rutinas del día en «Necesita tu decisión» **y otra vez** en
  «Rutinas · Vencen hoy» — 12 botones «Marcar hecha» para 6 tareas, 873 px de 2.374
  (el 37 % de la página).
- **Cada dato una sola vez por pantalla.** «1.430,00 €» aparece tres veces en Pagos;
  «SEMANA DEL 10 AGO – 16 AGO» dos veces con 600 px de separación en la compra.
- Estado vacío: sin `min-height: 18rem` (288 px de vacío reservado en Calendario a
  320 px). El vacío se dimensiona por su contenido y **es donde vive la descripción
  de la pantalla**, que es donde una explicación hace falta y donde sobra sitio.

### 2.7 Desbordamiento

**Ninguna tabla ni tira de controles puede esconder contenido sin señal.**

- **Tablas de datos** (las del manual de convivencia en la Guía): por debajo de
  600 px se pintan como **filas-ficha** — la primera columna es el título del bloque
  y el resto son pares etiqueta/valor a ancho completo. Se acabó el `overflow-x:
  auto` mudo que hoy corta «Avisar si» a media palabra («Hay manchas,») justo en la
  columna que dice cuándo hay que llamar a la familia.
- **Tiras de chips o pestañas**: ≤ 4 envuelven a dos líneas; > 4 van en scroller con
  **máscara en degradado** en el borde y **un chip siempre cortado a la mitad**,
  nunca pegado al borde. Hoy `.space-tabs` mide 467 px de contenido en 353 de caja:
  «Recetas y comensales» sale cortada a 390 y **no existe visualmente a 320**.
- **`scrollWidth === clientWidth` del documento sigue siendo ley** a 320 y a 390.
  Está verde en las 48 combinaciones medidas y es trabajo ya hecho: no se toca (§4).
- **Ninguna cifra envuelve jamás.** `.ledger-list > div` es hoy `flex-wrap: wrap;
  justify-content: space-between`, así que el envoltorio decide fila a fila si el
  importe va a la derecha o cae debajo: **a 390 px, 13 a la derecha y 12 caídas; a
  320, 3 y 22**, en 12 posiciones horizontales distintas. Ver §2.8.

### 2.8 `FilaDeImporte`: un solo componente para todo el dinero

```
[ concepto que se recorta con ellipsis ………… ] [ 1.430,00 € ]
                                                 ^ columna fija, tabular, nowrap
```

Rejilla `grid-template-columns: minmax(0, 1fr) auto`. El importe usa `--font-data`,
`white-space: nowrap` y nunca se mueve; **si algo no cabe, se recorta el concepto**.
Lo usan Pagos, Hoy, liquidaciones, saldos, versiones del acuerdo y la compra. Con
eso las cifras vuelven a formar columna y se pueden barrer con la vista, sumar de
cabeza y detectar un signo raro — que es la única razón por la que alguien abre esa
pantalla.

### 2.9 Formularios

- **Una sola columna por debajo de 600 px, sin excepciones.** Hoy `.action-form
  .form-grid { repeat(auto-fit, minmax(min(9rem, 100%), 1fr)) }` da **dos columnas de
  155 px a 390 px** para campos que llevan importes y meses. Los pares que de verdad
  son un par (horas + minutos, primer día + último día) se declaran explícitos, no
  por `auto-fit`.
- **Ningún desplegable con dinero dentro por debajo del ancho completo.** Hoy se
  elige la tarifa de una jornada viendo «Festivo o des⌄»: el valor mide 459 px y la
  caja útil, 113 (**el 25 % visible**). Curiosidad reveladora: a 320 px se lee mejor
  que a 390, porque la rejilla apila; el daño está en 360–430 px, que es donde están
  todos los teléfonos reales.
- **Los ejemplos van a texto de ayuda debajo del control, no a `placeholder`
  recortado** («Gratificación de verano, descuen…»). Y el texto de ayuda no se parte
  entre dos columnas dejando media frase dentro del desplegable.
- **Controles nativos domados**: `input[type=file]` estilado (hoy sale **«Choose File
  / No file chosen» en inglés** en el flujo de la foto del justificante, que es un
  camino clave de la interna) y `input[type=date]` con formato explícito junto al
  campo (aquí pintó `08/10/2026`, mm/dd, con `locale: es-ES`).
- Se conserva `input, select, textarea { font-size: max(1em, 1rem) }` (§4).

### 2.10 Iconos

Los 12 glifos de texto de `NavIcon.svelte` (`☀ € ◌ ◇ ▤ ⌕ ✓ □ ☎ + ◈ ⚙`) se sustituyen
por SVG en línea a 20 px, trazo único, sin relleno. Hoy se renderizan con la fuente
del cuerpo, cambian de forma en cada plataforma (`☎` sale como emoji en iOS) y varios
no comunican nada: `◌` para Menú, `□` para Calendario, `◈` para tu cuenta. Es la
ganancia de reconocibilidad más barata que hay.

---

## 3 · Cómo se aplica a las pantallas que importan

### 3.1 Hoy — la pantalla que se abre todos los días

**Antes (390×844).** Marco de **346 px, el 41 %**: topbar 64 + relleno superior 28,8 +
eyebrow «LUNES, 10 DE AGOSTO» 17 + `h1` «Buenas noches, Ana» a 32 px en dos líneas 74
+ descripción «Lo importante de hoy, sin ruido.» 24 + botón de banda completa
«+ Emergencias» 42 + margen 32 + barra inferior 68. A 320 px el marco es el **61 %**
y la primera pantalla completa es: cabecera, saludo en tres líneas, la descripción,
el botón de Emergencias, el título de la tarjeta, el primer título de rutina — y el
«Marcar hecha» **cortado por la barra**. **1 acción entera de 15.** Debajo, las 6
rutinas del día salen dos veces (873 px duplicados de 2.374).

**Después.** Sin topbar (0) + relleno 12 + `h1` de estado en una línea de 24 px
—«Lun 10 ago · 3 de 6 hechas»— 29 + margen 12 + barra inferior 56 = **109 px, el
13 % a 390 y el 19 % a 320**. Se recuperan **237 px**. Las rutinas del día salen
**una vez**, en filas-acción de 56 px con la fila entera pulsable y el acuse en su
hueco reservado. Emergencias deja de ser el botón de banda completa de la cabecera
(no se usa una vez al mes) y pasa a fila al final de la lista y a «Más», sin perder
su ruta directa ni su funcionamiento sin conexión. Lo que estaba vencido dice que
está vencido en Hoy **y en Rutinas** («Vencía el 9 ago», nunca «próxima: dom, 9 ago»
para una fecha pasada). Objetivo comprobable: **≥ 3 acciones enteras a 320×568**;
la cuenta sale en ~5, y en ~9 a 390.

**Qué NO cambia:** el `h1` sigue existiendo y sigue siendo único y descriptivo (cambia
su texto, no su papel); el nombre del hogar sigue leyéndose en esta pantalla; el chip
optimista «Hecha ✓ · próxima el X» y el estado sin conexión se quedan tal cual.

### 3.2 La Guía de la casa — la que se consulta de pie

**Antes.** Marco de 300 px (36 % a 390, **53 % a 320**). Fichas de 84–102 px: **6 de
63 visibles a 390, 3 a 320**. La tira de 7 apartados mide 34 px de alto y se corta a
media palabra sin ninguna señal. En la portada de una nota a 320 px no se ve **ni una
celda entera** de la tabla, y el único botón de énfasis alto de la pantalla es
**«Editar»**, encima del contenido. La nota «Particularidades por zona» se lee con
scroll horizontal dentro de la tarjeta y la tercera columna —«Avisar si», la que dice
cuándo llamar a la familia— se parte a media palabra. Y la Guía está **escondida
detrás de «Más»** para la persona que vive en la casa, mientras Pagos —que se mira
una vez al mes— ocupa un sitio principal de la barra.

**Después.** La Guía entra en la barra inferior de la interna en el sitio de Pagos
(`handsOnOrder`: `today, routines, menu, wiki`); Pagos baja a la hoja «Más». Fichas
como filas-acción de 56 px con el título a 16 px y la meta a 13 → **~11 fichas a 390,
~6 a 320**. El `h1` dice el apartado y su cuenta («La casa y sus zonas · 11 fichas»),
no «Guía de la casa», que ya lo dice la pestaña activa. La tira de apartados va en
scroller con máscara y un chip siempre medio cortado. Las tablas del manual se pintan
como filas-ficha: la zona es el título del bloque y «Alcance» y «Avisar si» son pares
etiqueta/valor a ancho completo, sin recortes. «Editar» baja al pie de la nota como
secundaria: leer pasa cincuenta veces por cada edición.

**Qué NO cambia:** el render Markdown sin `@html` calculado en servidor, las notas
fijadas, el editor lazy con `baseRevision` y el conflicto humano.

### 3.3 El expediente de la administración — el caso difícil

Es el caso difícil porque es la pantalla más larga (**6.141 px a 390, 7.085 a 320 —
7,3 y 12,5 pantallas**), la que más cifras tiene y la única donde un error de lectura
cuesta dinero. Y hoy la primera pantalla entrega **cuatro números, tres de ellos el
mismo** («Total salarial 1.430,00 €», «Reembolsos 0,00 €», «Total previsto
1.430,00 €»), a 158 px por fila. A 320 px la primera pantalla no contiene **ninguna
cifra**: título, subtítulo, un campo de fecha y un botón. La primera acción está a
**1.059 px** (390) / **1.184 px** (320).

**Después, por orden de ganancia:**

1. **Se borra lo repetido antes de maquetarlo.** Cuando no hay reembolsos, «total
   salarial» y «total previsto» son el mismo número: una sola cifra grande
   (`--text-data`, 24 px, tabular) con una línea de desglose debajo. La tira de
   cuatro pasa de **315 px a ~110** con la rejilla 2×2.
2. **`FilaDeImporte` en todo.** Las 25 cifras vuelven a una única columna a la
   derecha. Se acabó que la misma fila cambie de sitio según el teléfono.
3. **La página abre por el mes en curso y pliega el resto.** Histórico y detalle en
   `<details>` por periodo. ~6.100 px → ~1.800.
4. **La acción irreversible baja.** «Empezar la cuenta de agosto 2026» deja de ser lo
   primero y lo más relleno: va debajo del resumen y en peso secundario hasta que el
   mes esté para cerrar.
5. **Las anclas dejan de aterrizar debajo de la cabecera.** `scroll-margin-top` igual
   al cromo fijo, destino resaltado 2 s, y el botón dice de quién es: «Decidir la
   jornada del 8 de agosto», no dos «Decidir compensación» idénticos en pantalla.
6. **Formularios a una columna** (§2.9): el desplegable de tipo de jornada a ancho
   completo y la tarifa en línea de ayuda debajo, no dentro de la opción.
7. **El acuse en la fila donde se tocó**, no 500 px más abajo pegado a otro
   formulario.
8. **«Mis condiciones» se envuelve en `.page-wrap`.** Hoy es la única de 13 rutas del
   hogar cuyo `h1` empieza en `x=0` en vez de `x=18`, y al no tener `padding-bottom`
   su última línea —«45,00 € al mes», el seguro médico de la interna— queda **38 px
   por debajo de la barra inferior, sin scroll que la saque**, a 390 y a 320.
9. **Ajustes deja de apuntar al nombre equivocado**: «Quitar el acceso a Ana» con
   `--danger`, separada por divisor del bloque de la siguiente persona, a ≥8 px de
   cualquier otra diana.

**Qué NO cambia:** la confirmación por palabra escrita de «Quitar el acceso» (existe
y nombra a la persona: el problema es dónde cae, no que falte), el hash canónico de
liquidación, los estados del parte y las capacidades por rol.

---

## 4 · Qué se recorta del marco y qué no se toca

### Se recorta (390×844, por pantalla)

| pieza | hoy | después | por qué |
|---|---|---|---|
| topbar | 64 px, siempre | **0** por debajo de 52rem | sus 4 contenidos se re-alojan (abajo) |
| eyebrow | 17 px | 0 en móvil | decorativo en 6 de 8 pantallas; en Calendario repite literalmente la cabecera del mini-calendario dos filas más abajo |
| `.page-description` | 24–72 px | 0 en móvil | es copy de bienvenida servido en cada visita; se muda al estado vacío |
| `h1` | 37–74 px | **29** | 24 px, una línea, dice el estado y no la sección |
| relleno superior de `.page-wrap` | 28,8 px | 12 | `--pad-page-y` |
| barra inferior | 68 px | **56** | icono 20 + etiqueta 12 px |
| `.empty-state` | 288 px reservados | auto | Calendario a 320 px es hoy título + CTA + 288 px de vacío + el mismo CTA repetido |
| `.page-actions` a banda completa | 42 px | 0 | una acción de cabecera no lleva banda completa |
| avatar decorativo de Contactos | 100×100 px | 40 | el botón «Llamar» mide 71×35; la decoración triplica a la acción |
| `.summary-strip` apilada | 315 px | ~110 | rejilla 2×2 tras borrar el dato repetido |

**Total en Hoy: 346 → 109 px. 237 px devueltos al contenido.**

**Las cuatro piezas del topbar, re-alojadas:**
- *Nombre del hogar*: se queda **solo en Hoy**, como línea de apoyo. Es lo que quería
  decir `0fdf873` («la aplicación dice el nombre del hogar»), a 1/8 del coste. En una
  cuenta con varios hogares, esa línea es además el conmutador.
- *Búsqueda*: fila en la hoja «Más» y ruta propia. El overlay ⌘K se queda para
  escritorio; en móvil deja de decir «**Enter** busca … **Escape** cierra» a alguien
  que no tiene teclado, gana su ✕ y deja de recortar el marcador de posición en
  «Buscar en toda la».
- *Píldora de sync*: **solo se pinta cuando algo está pendiente**, reusando la banda
  de `.status-banner` que ya existe. Hoy es un punto verde de 24×44 px que dice «todo
  bien»: el píxel menos informativo de la app.
- *Avatar y salir*: ya viven en «Más». «Salir» se separa de la navegación con un
  divisor y su propio bloque, no con una regla dentro de la misma lista.

### No se toca

- **El trabajo de desbordamiento**: `minmax(0, 1fr)` en las rejillas, `min-width: 0`
  en los controles, `flex-wrap` en las cabeceras de sección. Cero desbordamiento en
  48 combinaciones medidas. Es la única cosa del sistema que ya está bien y hay
  regresión fácil.
- **`input, select, textarea { font-size: max(1em, 1rem) }`**: el suelo de 16 px
  contra el zoom de iOS. Las reglas de componente pueden subirlo, nunca bajarlo.
- **`env(safe-area-inset-bottom)`** en la barra inferior.
- **Los tokens de contraste y sus comentarios**: `--ink-faint` (4,58–4,99:1) y
  `--accent` (4,9:1) pasan AA y su razón está escrita en el CSS. **El contraste no es
  el problema de esta app: el tamaño sí.**
- **El verde `#21483a`** como color estructural, la crema y el icono: están en
  producción, en el `theme-color` y en 20 capturas del manual.
- **`ActionStatus.svelte`** como patrón de acuse y la barra de progreso de navegación
  sin CLS.
- **La hoja «Más»**: sus filas de 48 px son la única lista con densidad correcta de
  todo el producto. Se toma como referencia, no se retoca. (Sí se arregla que tape la
  barra entera: la pestaña activa tiene que seguir viéndose.)
- **La confirmación por palabra escrita** de «Quitar el acceso».
- **El acceso fijo a Emergencias y el 112 sin conexión**: cambia dónde vive el botón,
  no que exista ni que funcione sin red.
- **Los estados que sí son honestos**: «Vencía el 9 ago 2026» en Hoy es correcto y es
  el modelo a copiar en Rutinas.

---

## 5 · Plan de aplicación, por territorios

Hay tres trabajos en vuelo —**Contrato** (`routes/**/employment/**`,
`lib/components/employment/**`), **Guía** (`routes/**/wiki/**`,
`lib/components/wiki/**`) y **Rutinas/Hoy/Calendario** (`routes/**/{today,routines,
calendar}/**`, `lib/components/{TodayAgenda,TodayInlineAction}.svelte`)—. El plan
está ordenado para que **nada de lo que se hace ya toque el cuerpo de esas tres
pantallas**, y para que cuando aterricen encuentren el sistema puesto.

### T0 · Desbloqueo (antes que nada, 1 commit en `main`)

**No es UX y es lo primero**: sin esto no hay batería que guarde nada.

1. `apps/web/src/lib/server/fixtures.server.ts` — los cinco `DemoUser` traen
   `householdIds` pero **no `households`**. Desde `0fdf873`,
   `routes/h/[householdId]/+layout.server.ts:36-40` resuelve el hogar con
   `pickHousehold(locals.user.households, …)` y solo cae a `getHousehold()` si
   `fixturesAllowed()`, que es **falso cuando hay `DATABASE_URL`**. Resultado: **toda
   ruta `/h/<id>/*` responde 404 «Hogar no encontrado»** en modo fixture + Postgres,
   que es exactamente la configuración de `playwright.db.config.ts`: **los 34 casos de
   `test:e2e:db` están rotos ahora mismo en `main`**, y la demo persistente también.
   Dos auditorías independientes tropezaron con esto y lo parchearon en su worktree.
   El arreglo correcto no es copiar el parche: es **decidir si el hogar se resuelve por
   fixture o por sesión** y dejarlo escrito.
2. `apps/web/e2e/db-global-setup.ts` — la semilla inserta rutinas con
   `frequency`/`interval_count` pero sin `pattern`/`anchor_on`, y viola
   `routines_pattern_shape` de la migración `0023`.
3. `routes/**/employment/condiciones/+page.svelte` — envolver en `.page-wrap`. Son dos
   líneas y cae en territorio de Contrato, pero **hoy deja el importe del seguro
   médico de la interna permanentemente invisible bajo la barra**. Se hace ya y
   Contrato rebasa.

### T1 · Tokens sin repintar — `app.css` (`:root` + `base`)

Aditivo: se **añaden** `--space-*`, `--text-*`, `--r-*`, `--font-data`,
`--ink-on-primary` (hoy `#fff`/`white` a pelo 12 veces) sin migrar todavía las 329
declaraciones existentes. Con ellos, seis reglas quirúrgicas que ya se notan:

- `.button { min-height: 2.75rem }` y `.small-button` a 44 de alto / menos ancho.
- `.bottom-nav a { font-size: var(--text-micro) }` y la barra a 56 px.
- `h1 { font-size: var(--text-page) }` (se va el `clamp(2rem, 4vw, 3rem)` que se
  satura en el mínimo en todo móvil).
- `font-weight` reducido a 400/500/700 en las 53 declaraciones.
- Radios y sombras a token.
- La fuente: `@font-face`, `apps/web/static/`, precarga y precache en
  `src/service-worker.ts`.

**Colisión con los tres trabajos: ninguna** — es un fichero compartido, pero son
bloques nuevos y sustituciones mecánicas; el conflicto, si lo hay, es textual.

### T2 · El marco — `AppShell.svelte`, `PageHeader.svelte`, `NavIcon.svelte`, capa `shell`

- Topbar fuera por debajo de 52rem y sus cuatro contenidos re-alojados (§4).
- `PageHeader` gana `state` y deja de pintar `eyebrow` y `description` en móvil. **La
  firma sigue aceptando ambos**, así que las 15 llamadas actuales no se rompen y los
  tres trabajos en vuelo no tienen que tocar nada para beneficiarse.
- Cabecera a 44 px; `scroll-margin-top` global igual al cromo fijo.
- `handsOnOrder`: `wiki` entra en los cuatro primeros y `employment` baja a la hoja
  (una línea en `AppShell.svelte:40`).
- SVG en `NavIcon.svelte`.
- La hoja «Más» deja de tapar la barra; «Salir» en bloque aparte.

**Colisión: ninguna.** Ninguno de los tres trabajos posee el shell.

### T3 · Componentes compartidos — la superficie de integración

Se entregan **listos y documentados**, para que los tres trabajos los adopten dentro
de sus propias reescrituras en vez de inventar lo mismo tres veces:

- `FilaDeImporte.svelte` (§2.8).
- Clases `.fila-accion` / `.fila-dato` / `.fila-densa` (§2.3).
- `ActionStatus` con variante de fila y hueco reservado (§2.5).
- `.note` única con modificador de tono, que sustituye a las 6 cajas de aviso.
- Regla de tabla → filas-ficha y de tira de chips → máscara (§2.7).
- `.check-row`: casilla de 20 con diana de 44 y fila entera pulsable.

### T4 · Territorios libres — donde se prueba el sistema

Sin nadie trabajando encima: **Menú y Compra, Recetas, Contactos, Ajustes,
Emergencias, Búsqueda, Cuenta**. Se aplica el sistema entero y se convierten en la
referencia viva:

- **Compra**: `.check-row` (hoy la casilla mide 13×13 y la etiqueta 148×19, con la
  cantidad fuera del área pulsable), título propio en vez de «Menú de la casa», la
  semana rotulada una sola vez, y **URL propia para cada pestaña** (`?vista=compra`)
  para que se pueda enlazar desde «Más» y funcione el botón de atrás: hoy la lista de
  la compra está a dos niveles, que es justo donde ella menos puede navegar.
- **Menú**: pestañas que envuelven (3 ≤ 4), franjas «Sin decidir» plegadas, fichas de
  día sin repetir «ago» siete veces.
- **Contactos**: avatar 100 → 40, «Llamar» como acción de fila a 44, «Archivar»
  separada de «Editar».
- **Ajustes**: gramática de acciones destructivas (§2.5).
- **Emergencias**: «Llamar al 112» primero y entero en la primera pantalla a 320 px
  (hoy el único botón de banda completa visible es **«Imprimir»**, una acción de
  escritorio); teléfonos como filas pulsables de 44, no enlaces de 18,7 px.
- **Búsqueda**: sin lenguaje de teclado en móvil, con ✕, campo a 44.

### T5 · Dentro de los tres trabajos — criterio de aceptación de sus PR

No se les toca el cuerpo; se les pide que salgan cumpliendo esto:

| trabajo | qué adopta | qué arregla de paso |
|---|---|---|
| **Contrato** | `FilaDeImporte`, formularios a una columna, tira de cifras 2×2, `<details>` por periodo, anclas con `scroll-margin-top`, acuse en fila | `WeeklyReportCard.svelte:34` y `:157` (un borrador no se etiqueta «Enviado»); la acción irreversible deja de abrir la pantalla; `input[type=file]` en español |
| **Guía** | filas-acción de 56, tablas → filas-ficha, tira de apartados con máscara, `h1` de estado, «Editar» al pie | el `·` huérfano del pie; el buscador de la Guía a 44 px de alto |
| **Rutinas / Hoy / Calendario** | `h1` de estado, filas-acción, dato una sola vez, acuse sin salto | la duplicación de rutinas en Hoy; el párrafo corrido de Rutinas (título, cadencia y detalle son tres cosas, no una frase de 10,88 px); lo vencido marcado como vencido también en Rutinas; el CTA de configuración de Calendario fuera de la primera posición; el estado vacío sin 288 px reservados |

### T6 · Barrido final — cuando los tres trabajos hayan aterrizado

Migrar las declaraciones que queden a `--space-*` y `--text-*`, borrar los 16 radios
literales y encender el lint de CSS en modo error (§6). Es mecánico y es el paso que
convierte el sistema en irreversible.

---

## 6 · Cómo se comprueba

Ya existe `apps/web/e2e/mobile-overflow.dbe2e.ts`: 12 rutas × 2 anchos, mide
`scrollWidth` contra `clientWidth` del documento en el navegador y **nombra los
elementos que se salen** cuando falla. Está verde y es el modelo a copiar: medida
real, mensaje accionable, sin lista de excepciones.

### Batería nueva: `apps/web/e2e/mobile-densidad.dbe2e.ts`

Mismas rutas, los dos anchos (320×568 y 390×844), los dos roles. Son reglas de
sistema: siguen valiendo aunque «Pagos» pase a llamarse «Contrato», la Guía entre en
modo libro y Hoy y Calendario se reescriban.

| # | aserto | hoy |
|---|---|---|
| A1 | `marco / innerHeight ≤ .20` a 390 y `≤ .25` a 320 | 0,33–0,41 y 0,51–0,61 |
| A2 | **la primera acción de la ruta cabe entera en la primera ventana útil a 320×568** (436 px) | falla en Hoy, Pagos, Emergencias, Compra |
| A3 | ninguna diana `< 44×44`; separación ≥ 8 px entre dianas contiguas | 47 % por debajo de 44; 7 px en Ajustes |
| A4 | ningún `font-size` computado `< 12 px`; ninguno `< 14 px` en un nodo de más de 3 palabras | 9,76 px en la navegación; 30 % del texto bajo 12 |
| A5 | ≤ 4 tamaños y ≤ 3 pesos computados por pantalla | 27 y 6 |
| A6 | **≥ 3 elementos de la lista principal visibles a 320×568** | 1 en Guía, 1,5 en Rutinas, 0 cifras en Pagos |
| A7 | ninguna cifra de `FilaDeImporte` fuera de la columna: todas comparten `x` | 12 posiciones distintas |
| A8 | toda ruta del hogar: `h1.left === gutter` y el último elemento por encima de `nav.bottom-nav` | falla en `employment/condiciones` |

A6 necesita que la lista principal se pueda nombrar: se marca con
`data-lista="principal"` en cada ruta. Es una decisión de diseño, no un truco de
test — si una pantalla no sabe decir cuál es su lista principal, ese es el hallazgo.

### Lint de CSS (dos reglas, en el `check` del monorepo)

- **L1** — ningún `rem` a pelo en `gap`, `padding`, `margin`, `border-radius` ni
  `font-size` fuera de `:root`: todo resuelve a `--space-*`, `--r-*` o `--text-*`.
  (Hoy: 40 + 39 + 20 valores sueltos.)
- **L2** — ningún `font-weight` fuera de 400/500/700, y ningún color literal fuera de
  `:root` (hoy `#fff`/`white` 12 veces).

Empiezan en modo aviso durante T1–T5 y pasan a error en T6.

### Lo que ya guarda y se conserva

`mobile-overflow.dbe2e.ts` (A0: `scrollWidth === clientWidth`), `critical.a11y.ts`
(axe), `mobile-nav.e2e.ts` y `verify-today-bundle.mjs`. La fuente entra con su propia
comprobación de tamaño del subconjunto (≤ 40 KB) en el mismo script de presupuesto.

---

## 7 · El resumen en una frase

Casa Clara no necesita rediseñarse: necesita **dos escalas, un presupuesto de marco y
una columna para el dinero**. Lo caro no es lo que hay que dibujar, es lo que hay que
dejar de dibujar — y son 237 px por pantalla que hoy se gastan en decirle a alguien
dónde está en lugar de enseñarle lo que ha venido a ver.
