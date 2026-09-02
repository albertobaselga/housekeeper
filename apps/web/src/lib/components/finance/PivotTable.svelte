<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import {
    buildPivotTree,
    INTERNA_DIMS,
    INVERSION_DIMS,
    type PivotDimension,
    type PivotEventGroup
  } from '@housekeeper/domain/finance';
  import type { FinanceWritePayloadV1 } from '@housekeeper/contracts';
  import { monthLabel } from '$lib/finance/chart-data';
  import { categoryPath } from '$lib/finance/breakdown';
  import { formatCents } from '$lib/finance/format';
  import { isUuid } from '$lib/finance/filters';
  import {
    addDim, buildDragPayload, collectLeafItems, collectMovIdsByKey, createDragGhostElement, DIM_LABELS,
    dragGhostLabel, moveDim, parseChips, parseDims, parseIdList, PIVOT_DIMENSIONS,
    rangeBetween, removeDim, resolveSelectionIds, rowMatchesChips, sameSortKey, selectableListAny,
    serializeChips, serializeDims, serializeIdList, sortTree, summarizeCategoryDrop, summarizeEventDrop,
    toAnySelectable, toggleInMap, toMovementSelectable,
    type DragPayload, type PivotNodeLike, type PivotSortKey, type SelectableItem, type SortDir
  } from '$lib/finance/pivot-state';
  import {
    acuse, buildTxCategoryIndex, categoryAssignPayloads, categoryUndoPayloads, eventAssignPayloads,
    investTransaction, newEventPayloads, planCategoryUndo, recurrencePayloads, sendAll, splitByTx,
    splitForCategory, undoEventPayloads,
    type CategoryUndo
  } from '$lib/finance/pivot-actions';
  import type { AnaliticaCategory, AnaliticaEventSummary, AnaliticaPivotRow } from '$lib/finance/analitica-data';
  import PivotActionBar from './PivotActionBar.svelte';
  import PivotSearch from './PivotSearch.svelte';

  let {
    rows, months, categories, events, invAccounts, householdId, onOpenIds
  }: {
    rows: AnaliticaPivotRow[];
    months: string[];
    categories: AnaliticaCategory[];
    events: AnaliticaEventSummary[];
    invAccounts: { id: string; name: string }[];
    householdId: string;
    onOpenIds: (ids: string[], label: string, sub: string) => void;
  } = $props();

  // Ruta de categoría: la única del módulo es la de la fase 4 (separador «›»).
  const catPathOf = (id: string) => categoryPath(categories, id);

  // dims y dupev viven en la URL (merge no destructivo) con routing superficial:
  // no cambian los datos del servidor, solo la agrupación cliente.
  const dims = $derived(parseDims(page.url.searchParams.get('dims')));
  const chips = $derived(parseChips(page.url.searchParams.get('q')));
  // R24: dupev alimenta el `dupEventIds` del dominio (Set de ids) — filtrado
  // por isUuid igual que exev en el loader, para que un valor con forma
  // inválida en la URL no llegue nunca al dominio (aunque un id sin forma de
  // UUID ya no casaría con ningún evento real, la garantía la da el tipo, no
  // la suerte del `Set.has`).
  const dupEventIds = $derived(parseIdList(page.url.searchParams.get('dupev')).filter(isUuid));

  // `replaceState` de `$app/navigation` (routing superficial) solo actualiza
  // `page.state`, NUNCA `page.url` (fuente de `dims`/`chips`/`dupEventIds`
  // arriba): con ella la barra de direcciones cambia pero el árbol se queda
  // congelado con el valor anterior del parámetro — bug real que T14 destapó
  // (nada lo cubría hasta el e2e de fixture). `goto` con `replaceState: true`
  // sí actualiza `page.url` reactivamente y no añade entrada al historial; es
  // el mismo patrón que ya usa `toggleExcluded` más abajo en +page.svelte para
  // `?exev=`.
  function setShallowParam(key: string, value: string): void {
    const url = new URL(page.url);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }
  // serializeDims (fase 4) devuelve null para el orden por defecto ⇒ URL limpia.
  const setDims = (next: PivotDimension[]) => setShallowParam('dims', serializeDims(next) ?? '');
  const toggleDupEvent = (id: string) => {
    const next = dupEventIds.includes(id) ? dupEventIds.filter((x) => x !== id) : [...dupEventIds, id];
    setShallowParam('dupev', serializeIdList(next));
  };

  let expanded = $state<Set<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  };

  let sort = $state<{ key: PivotSortKey; dir: SortDir }>({ key: 'total', dir: 'asc' });
  const toggleSort = (key: PivotSortKey) => {
    sort = sameSortKey(sort.key, key) ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
  };
  const sortIndicator = (key: PivotSortKey) => (sameSortKey(sort.key, key) ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const hasSearch = $derived(chips.length > 0);
  const forceExpand = $derived(hasSearch);
  const filteredRows = $derived(rows.filter((r) => rowMatchesChips(r, chips, catPathOf)));

  // Árbol del dominio (fase 2); dupev duplica eventos bajo su categoría sin
  // alterar el TOTAL NETO (invariante del dominio, testeada allí).
  // opts canónico: { monthsCount, dupEventIds } — con `months` los promedios
  // saldrían todos a 0 (el dominio divide por monthsCount).
  const tree = $derived(
    buildPivotTree(filteredRows, dims, { monthsCount: months.length, dupEventIds: new Set(dupEventIds) })
  );

  // Gastos: ascendente = mayor gasto primero. Ingresos/eventos: dirección
  // contraria salvo por etiqueta, que ordena igual en las tres secciones.
  const oppositeDir = $derived<SortDir>(sort.dir === 'asc' ? 'desc' : 'asc');
  const ingresosDir = $derived(sort.key === 'label' ? sort.dir : oppositeDir);
  // Sin `as`: `sortTree<T extends SortableNodeLike & { children: T[] }>` infiere
  // T = PivotNode (el nodo del dominio, fase 2) directamente de `tree.gastos`,
  // y PivotNode es estructuralmente asignable a PivotNodeLike (mismos campos,
  // más `concepts` que aquí no hace falta).
  const gastoTree = $derived(sortTree(tree.gastos, sort.key, sort.dir));
  const ingresoTree = $derived(sortTree(tree.ingresos, sort.key, ingresosDir));
  const internaTree = $derived(tree.internas);
  const inversionTree = $derived(tree.inversiones);
  const eventTree = $derived(
    [...tree.eventos]
      .map((e) => ({ ...e, children: sortTree(e.children, sort.key, ingresosDir) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  );
  // Eventos sin movimientos en el periodo: fila vacía, sigue siendo drop target.
  // Anotar el retorno del `map` como `PivotEventGroup` (en vez de `as
  // PivotNodeLike[]` sobre `children: []`) da a `[]` el contexto `PivotNode[]`
  // sin casts: mismo tipo final que `eventTree` para el `[...a, ...b]` de abajo.
  const displayEventos = $derived(
    hasSearch
      ? eventTree
      : [
          ...eventTree,
          ...events
            .filter((e) => !eventTree.some((t) => t.eventId === e.id))
            .map(
              (e): PivotEventGroup => ({
                eventId: e.id, name: e.name, count: 0, netCents: 0n, avgCents: 0n, ticketCents: 0n, monthly: {}, children: []
              })
            )
        ].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  );

  const colSpan = $derived(4 + months.length);
  const isEmpty = $derived(hasSearch && gastoTree.length === 0 && ingresoTree.length === 0 && displayEventos.length === 0 && internaTree.length === 0 && inversionTree.length === 0);
  const cellText = (v: bigint | undefined) => (!v ? '·' : formatCents(v));
  const tintFor = (depth: number) =>
    depth === 0 ? '' : `background: color-mix(in srgb, var(--surface) ${100 - Math.min(depth, 4) * 7}%, var(--line-strong));`;
  const openLeaf = (node: PivotNodeLike) =>
    onOpenIds(node.movs.map((m) => m.id), node.label, `${node.movs.length} ${node.movs.length === 1 ? 'movimiento' : 'movimientos'}`);

  // ── Selección (Map inmutable + rango con Shift) ────────────────────────────
  let selected = $state<Map<string, SelectableItem>>(new Map());
  let lastKey = $state<string | null>(null);
  const selectionList = $derived([...selected.values()]);
  const selectionMovs = $derived(selectionList.reduce((s, i) => s + i.count, 0));
  const clearSelection = () => { selected = new Map(); lastKey = null; };


  // F6-M3: al cerrar el aviso (con «Deshacer» o con «✕») el elemento enfocado
  // desaparece del DOM y el foco cae al <body>; con teclado o lector se pierde
  // el sitio en una tabla larga. Se recuerda la fila que originó la acción y se
  // le devuelve el foco; si ya no está en el árbol, ancla la tabla entera.
  let tablaEl = $state<HTMLDivElement | null>(null);
  let anchorKey: string | null = null;
  let arrastreKey: string | null = null;
  function devolverFoco(): void {
    const destino = anchorKey !== null ? tablaEl?.querySelector(`[data-fila="${CSS.escape(anchorKey)}"]`) : null;
    if (destino instanceof HTMLElement) destino.focus();
    else tablaEl?.focus();
  }

  function clickItem(item: SelectableItem, siblings: SelectableItem[], shiftKey: boolean): void {
    if (shiftKey && lastKey) {
      const range = rangeBetween(siblings, lastKey, item.key);
      if (range) {
        const next = new Map(selected);
        for (const it of range) next.set(it.key, it);
        selected = next;
        lastKey = item.key;
        return;
      }
    }
    selected = toggleInMap(selected, item);
    lastKey = item.key;
  }

  // Sin `as`: cada árbol es un `PivotNode[]`/`PivotEventGroup['children']` del
  // dominio, estructuralmente asignable a `PivotNodeLike` (mismos campos, más
  // `concepts` que aquí no hace falta) — TS lo infiere sin forzar el tipo.
  const allRoots = $derived([
    ...gastoTree, ...ingresoTree, ...internaTree, ...inversionTree,
    ...displayEventos.flatMap((e) => e.children)
  ]);
  const movIdsByKey = $derived(collectMovIdsByKey(allRoots));
  // `AnaliticaPivotRow` no lleva categoryId por movimiento: cada fila del pivot
  // ya agrupa movimientos que comparten `catId` (fase 2, mismo groupBy que
  // `PivotSourceRow`), así que se aplana a pares {id, categoryId} usando el
  // catId de la fila que contiene cada mov — no es la firma literal del brief
  // (`buildTxCategoryIndex(rows)`), que asumía filas por movimiento.
  const txCatIndex = $derived(
    buildTxCategoryIndex(rows.flatMap((r) => r.movs.map((m) => ({ id: m.id, categoryId: r.catId }))))
  );

  // Claves que el árbol vigente sabe expandir: las de los nodos más las de las
  // filas de evento (`event/<id>`, que no pasan por `movIdsByKey`).
  const expandableKeys = $derived(
    new Set([...movIdsByKey.keys(), ...displayEventos.map((e) => `event/${e.eventId}`)])
  );

  // T12-M4 + F6-M7. La selección y el conjunto `expanded` se apoyan en claves
  // del árbol vigente; cuando el árbol se rehace dejan de significar lo mismo:
  //  - cambiar chips/dims reconstruye las claves (routing superficial, el
  //    loader NO se re-ejecuta), y
  //  - cambiar el rango en FinanceFilterBar sí re-ejecuta el loader: las
  //    MISMAS claves apuntan entonces a otros movimientos, y un ítem de
  //    concepto ni siquiera pasa por `movIdsByKey` (va por proveedor), así que
  //    una selección superviviente mandaría comando sobre movimientos que el
  //    usuario ya no está viendo.
  // La identidad de `rows` solo cambia al re-ejecutarse el loader (o al
  // cambiar el filtro de naturaleza de la página), que es exactamente el
  // disparador que hace falta. `vistoRows`/`vistoClave` NO son `$state`:
  // escribirlas dentro del `$effect` que las lee crearía un ciclo.
  let vistoRows: AnaliticaPivotRow[] | null = null;
  let vistoClave = '';
  $effect(() => {
    const clave = `${serializeDims(dims) ?? ''}|${serializeChips(chips)}`;
    const primera = vistoRows === null;
    const cambio = !primera && (vistoRows !== rows || vistoClave !== clave);
    vistoRows = rows;
    vistoClave = clave;
    if (!cambio) return;
    clearSelection();
    // F6-M7: las claves de `expanded` construidas con las dims anteriores ya no
    // existen en el árbol y se quedarían en el Set para siempre.
    const validas = [...expanded].filter((k) => expandableKeys.has(k));
    if (validas.length !== expanded.size) expanded = new Set(validas);
  });

  // ── Toast con Deshacer y envío secuencial de comandos ──────────────────────
  // `sendAll`/`acuse`/`COLA` viven en `$lib/finance/pivot-actions` (tarea 6),
  // ya probados allí (R14/R25): aquí solo se encadena `householdId` y el
  // `invalidate` de `$app/navigation` con el token canónico 'cc:finance'
  // (Task 8) a través de este cierre — `sendAll` real pide 3 argumentos
  // (householdId, payloads, { invalidate }), no uno solo como el brief.
  let toast = $state<{ message: string; onUndo?: () => Promise<void> } | null>(null);
  // F6-I5: mientras hay un lote en vuelo la barra se deshabilita (un segundo
  // clic impaciente relanzaba la cadena entera) y el toast va contando.
  let enviando = $state(false);
  const submit = (payloads: readonly FinanceWritePayloadV1[]) =>
    sendAll(householdId, payloads, {
      invalidate,
      onProgress: (done, total) => {
        if (total > 1) toast = { message: `Guardando ${done} de ${total}…` };
      }
    });

  /**
   * Único envoltorio de todo lo que escribe (acciones de la barra, drops y el
   * «Deshacer» del toast):
   * - T12-M5: un rechazo de IndexedDB o del outbox deja de ser una promesa sin
   *   manejar y se cuenta al usuario.
   * - F6-I5: `enviando` bloquea la barra mientras dura el lote.
   * - F6-M3: recuerda la fila que originó la acción para devolverle el foco
   *   cuando el aviso se cierre.
   */
  async function run(fn: () => Promise<void>): Promise<void> {
    if (enviando) return;
    anchorKey = selectionList[0]?.key ?? arrastreKey ?? anchorKey;
    enviando = true;
    try {
      await fn();
    } catch {
      toast = { message: 'No se pudo guardar el cambio.' };
    } finally {
      enviando = false;
    }
  }

  async function runCategoryUndo(plan: CategoryUndo): Promise<void> {
    const payloads = categoryUndoPayloads(plan);
    // F6-I1: el aviso es INCONDICIONAL. El servidor no revierte la regla por
    // ninguno de los dos caminos: `finance.category.assignConcept` siempre
    // INSERTA una regla nueva (nunca borra ni actualiza la anterior), así que
    // la rama `reassignments` deja DOS reglas con el mismo patrón apuntando a
    // categorías distintas, y la rama `bulkRestores` deja intacta la que creó
    // el drop. Decir «Deshecho» a secas prometía lo que la capa de reglas no
    // cumple.
    const aviso = ' · las reglas creadas se conservan (bórralas en Ajustes)';
    const saltos = plan.skipped > 0 ? ` · ${plan.skipped} sin categoría previa` : '';
    // T12-M6: aquí vivía una rama para el lote vacío con un mensaje sobre los
    // movimientos sin categoría previa. La guarda `puedeDeshacer` de
    // `applyCategoryAssignment` la hacía inalcanzable (sin reasignaciones ni
    // restauraciones no se ofrece «Deshacer»), y un mensaje muerto es peor que
    // ninguno: se borró en vez de condicionarla.
    const r = await submit(payloads);
    toast = { message: acuse(r, `Deshecho${aviso}${saltos}`) };
  }

  // ── Aplicadores compartidos ───────────────────────────────────────────────
  // La barra de acciones y el drag-and-drop (tarea 13) son dos caminos para el
  // MISMO gesto: comparten estas tres funciones para que no puedan divergir.
  // F6-I4 + T12-M1: los payloads los COMPONEN funciones puras de
  // `pivot-actions.ts` (probadas allí); aquí solo queda el acuse y el
  // «Deshacer», que son estado del componente.

  async function applyEventAssignment(
    items: readonly SelectableItem[], eventId: string, eventName: string, omitted: number
  ): Promise<void> {
    const { concepts, transactionIds, movs } = splitByTx(items);
    const r = await submit(eventAssignPayloads(items, eventId));
    toast = {
      message: acuse(r, summarizeEventDrop(movs, eventName, omitted)),
      ...(r.ok && (concepts.length > 0 || transactionIds.length > 0)
        ? {
            onUndo: async () => {
              const u = await submit(undoEventPayloads(items, eventId));
              toast = { message: acuse(u, 'Deshecho') };
            }
          }
        : {})
    };
  }

  /**
   * Evento nuevo: el id lo genera el cliente para poder encadenar «crear» y
   * «asignar» sin esperar al ACK. Así los movimientos sueltos (hojas con txId)
   * también se asignan — antes se perdían en silencio con un toast de éxito.
   */
  async function applyNewEventAssignment(
    items: readonly SelectableItem[], name: string, omitted: number
  ): Promise<void> {
    const existing = events.find((e) => e.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) return applyEventAssignment(items, existing.id, existing.name, omitted);
    const eventId = crypto.randomUUID();
    const r = await submit(newEventPayloads(items, name, eventId));
    toast = { message: acuse(r, summarizeEventDrop(splitByTx(items).movs, name, omitted)) };
  }

  async function applyCategoryAssignment(
    items: readonly SelectableItem[], categoryId: string, omitted: number
  ): Promise<void> {
    const reparto = splitForCategory(items, movIdsByKey);
    const omitidos = omitted + reparto.omitted;
    // El plan de deshacer cubre TODO lo que de verdad se mueve (conceptos Y
    // hojas de movimiento sueltas), no solo `reparto.concepts`: una hoja
    // (`txId` set, `provider: ''`) también se indexa por id exacto en
    // `planCategoryUndo` (ver el caso "mezcla" de `finance-pivot-actions.test.ts`).
    // Omitirla dejaría el plan vacío al recategorizar una única hoja y
    // «Deshacer» no restauraría nada, con un acuse engañoso («No hay nada que
    // asignar», por `sent === 0`).
    const undoItems = items.filter((i) => i.categoryId == null);
    const plan = planCategoryUndo(undoItems, movIdsByKey, txCatIndex);
    const movidos = reparto.moved;
    const r = await submit(categoryAssignPayloads(items, categoryId, movIdsByKey));
    // El caso MÁS habitual al recategorizar es partir de "sin clasificar"
    // (categoría previa null en TODOS los movimientos): `planCategoryUndo`
    // entonces sale con `reassignments: []` y `bulkRestores: []` (todo cae en
    // `skipped`), y no hay nada que un "Deshacer" pudiera restaurar. Sin esta
    // guarda, `runCategoryUndo` mandaría un lote vacío y `acuse` (que mira
    // `sent === 0` antes que nada) devolvería «No hay nada que asignar» — el
    // mismo fallo que ya se corrigió para la hoja suelta, con otro disparador.
    const puedeDeshacer = plan.reassignments.length > 0 || plan.bulkRestores.length > 0;
    toast = {
      // Con 0 movidos, summarizeCategoryDrop ya explica POR QUÉ no se movió nada
      // («las categorías no pueden soltarse sobre otra categoría»): ese texto es
      // mejor acuse vacío que el genérico.
      message: acuse(
        r,
        summarizeCategoryDrop(movidos, catPathOf(categoryId), omitidos),
        summarizeCategoryDrop(0, catPathOf(categoryId), omitidos)
      ),
      ...(r.ok && movidos > 0 && puedeDeshacer ? { onUndo: () => runCategoryUndo(plan) } : {})
    };
  }

  // ── Drag and drop nativo (la barra de acciones es la alternativa completa) ─
  let dragging = $state<DragPayload | null>(null);
  let newEventDrop = $state<DragPayload | null>(null);
  let newEventName = $state('');
  let newEventInput = $state<HTMLInputElement | null>(null);
  let popoverPos = $state<{ left: number; top: number } | null>(null);

  /**
   * T13-M6: `.pivot-scroll` tiene `overflow-x: auto`, y por regla de CSS eso
   * convierte también `overflow-y` en `auto`: un popover posicionado DENTRO de
   * la tabla se recorta siempre que se salga de su caja. Con `position: fixed`
   * y las coordenadas del rectángulo de la banda queda fuera del recorte.
   * `POPOVER_H` es una estimación del alto (campo + botones + relleno): solo
   * decide si abre hacia abajo o hacia arriba, y evita medir en dos pasadas.
   */
  const POPOVER_H = 56;
  const POPOVER_W = 320;
  const POPOVER_MARGEN = 8;
  function posicionaPopover(fila: HTMLElement): { left: number; top: number } {
    const r = fila.getBoundingClientRect();
    // La banda es una `<tr>` tan ancha como la tabla, que puede estar
    // desplazada horizontalmente dentro de `.pivot-scroll`: su `left` sale
    // negativo y el popover se iría fuera de la ventana. Se acota a la
    // ventana en los dos ejes.
    const acotado = (v: number, max: number) => Math.max(POPOVER_MARGEN, Math.min(v, max - POPOVER_MARGEN));
    return {
      left: acotado(r.left, window.innerWidth - POPOVER_W),
      top: acotado(r.bottom + POPOVER_H <= window.innerHeight ? r.bottom : r.top - POPOVER_H, window.innerHeight - POPOVER_H)
    };
  }

  function cancelNewEventDrop(): void {
    newEventDrop = null;
    newEventName = '';
    popoverPos = null;
  }

  // T13-M2: el popover no tomaba el foco —el atributo que lo pedía era inerte,
  // nadie lo leía— así que Escape solo cerraba estando ya dentro del campo y
  // con teclado no había manera de llegar sin tabular a ciegas por la tabla.
  $effect(() => {
    if (newEventDrop !== null) newEventInput?.focus();
  });

  /**
   * Escape a nivel del popover: se engancha a los TRES controles que contiene
   * (campo, «Crear y asignar», «Cancelar»), que son los únicos focalizables de
   * dentro, en vez de al `<form>` — un `<form>` con manejador de teclado es un
   * elemento no interactivo con escucha de teclado (aviso a11y de Svelte) y
   * `svelte-check` corre con cero avisos.
   */
  function onPopoverKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    cancelNewEventDrop();
  }

  /** T13-M4: soltar una fila sobre sí misma no es un gesto; hoy mandaba comando. */
  const sueltaSobreSiMisma = (e: DragEvent, destinoKey: string): boolean =>
    e.dataTransfer?.getData('text/plain') === destinoKey;

  function onDragStart(e: DragEvent, node: PivotNodeLike, nodeDims: readonly PivotDimension[]): void {
    const self = toAnySelectable(node, nodeDims);
    let items: SelectableItem[];
    let omitted = 0;
    if (self) {
      items = selected.has(node.key) && selectionList.length > 0 ? selectionList : [self];
    } else {
      const collected = collectLeafItems(node);
      items = collected.items;
      omitted = collected.omitted;
    }
    if (items.length === 0 || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    const payload = buildDragPayload(items, omitted);
    e.dataTransfer.setDragImage(createDragGhostElement(dragGhostLabel(payload)), 10, 10);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.key);
    arrastreKey = node.key;
    dragging = payload;
  }
  const onDragEnd = () => (dragging = null);

  // Los tres drops delegan en los aplicadores compartidos de la tarea 12: mismo
  // reparto conceptos/ids, mismos payloads, mismo acuse y mismo Deshacer que la
  // barra de acciones. Aquí solo se resuelve el gesto.
  // T13-M5: un drop aplicado limpia la selección, como ya hace cada `action*`
  // de la barra: si no, la barra sigue en pie con los mismos ítems y el
  // siguiente gesto los reenvía.
  function onDropCategory(e: DragEvent, categoryId: string, destinoKey: string): Promise<void> {
    const payload = dragging;
    dragging = null;
    if (!payload || payload.items.length === 0 || sueltaSobreSiMisma(e, destinoKey)) return Promise.resolve();
    return run(async () => {
      await applyCategoryAssignment(payload.items, categoryId, payload.omitted);
      clearSelection();
    });
  }

  function onDropEvent(e: DragEvent, eventId: string, eventName: string, destinoKey: string): Promise<void> {
    const payload = dragging;
    dragging = null;
    if (!payload || payload.items.length === 0 || sueltaSobreSiMisma(e, destinoKey)) return Promise.resolve();
    return run(async () => {
      await applyEventAssignment(payload.items, eventId, eventName, payload.omitted);
      clearSelection();
    });
  }

  function onDropNewEvent(e: DragEvent): void {
    const payload = dragging;
    dragging = null;
    if (!payload || payload.items.length === 0) return;
    popoverPos = e.currentTarget instanceof HTMLElement ? posicionaPopover(e.currentTarget) : null;
    newEventDrop = payload;
    newEventName = '';
  }
  function confirmNewEventDrop(): Promise<void> {
    const payload = newEventDrop;
    const name = newEventName.trim();
    // T13-M1: sin nombre no se cierra el popover ni se traga el arrastre — el
    // botón está deshabilitado, así que esto solo cubre un submit por Enter.
    if (!payload || !name) return Promise.resolve();
    cancelNewEventDrop();
    return run(async () => {
      await applyNewEventAssignment(payload.items, name, payload.omitted);
      clearSelection();
    });
  }

  // ── Acciones de la barra (delegan en los aplicadores) ──────────────────────
  function actionMoveToEvent(eventId: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return Promise.resolve();
    const name = events.find((e) => e.id === eventId)?.name ?? '';
    return run(async () => {
      await applyEventAssignment(items, eventId, name, 0);
      clearSelection();
    });
  }
  function actionNewEvent(name: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return Promise.resolve();
    return run(async () => {
      await applyNewEventAssignment(items, name, 0);
      clearSelection();
    });
  }
  function actionMoveToCategory(categoryId: string): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return Promise.resolve();
    return run(async () => {
      await applyCategoryAssignment(items, categoryId, 0);
      clearSelection();
    });
  }
  function actionSetRecurrence(rec: 'recurrente' | 'extraordinario'): Promise<void> {
    const items = selectionList;
    if (items.length === 0) return Promise.resolve();
    const movs = selectionMovs;
    return run(async () => {
      // Por concepto: assignConceptRecurrence. Hoja suelta: transaction.update
      // (finance.transactions.bulk NO admite recurrence, resolución nº 5).
      const r = await submit(recurrencePayloads(items, rec));
      const label = rec === 'recurrente' ? '♻ recurrente' : '✦ extraordinario';
      toast = { message: acuse(r, `${movs} movimiento${movs === 1 ? '' : 's'} → ${label}`) };
      clearSelection();
    });
  }
  function actionInvest(accountId: string): Promise<void> {
    // Solo cargos negativos sin cruzar (el servidor rechaza el resto): se envía
    // por id exacto resolviendo la selección completa.
    const ids = resolveSelectionIds(selectionList, movIdsByKey);
    if (ids.length === 0) {
      toast = { message: 'No hay nada que asignar' };
      return Promise.resolve();
    }
    const name = invAccounts.find((a) => a.id === accountId)?.name ?? '';
    return run(async () => {
      const r = await submit(ids.map((id) => investTransaction(id, accountId)));
      toast = { message: acuse(r, `${ids.length} movimiento${ids.length === 1 ? '' : 's'} → inversión ${name}`) };
      clearSelection();
    });
  }
  function actionOpenPanel(): void {
    const ids = resolveSelectionIds(selectionList, movIdsByKey);
    const n = selectionList.length;
    onOpenIds(ids, `${n} seleccionado${n === 1 ? '' : 's'}`, `${ids.length} movimiento${ids.length === 1 ? '' : 's'}`);
  }
</script>

{#snippet subtotalRow(label: string, data: { count: number; totalCents: bigint; avgCents: bigint; ticketCents: bigint; monthly: Record<string, bigint> }, tone: '' | 'ok' | 'warn', tooltip: string, testid = '')}
  <tr class="subtotal" class:aviso={tone === 'warn'} title={tooltip || undefined} data-testid={testid || undefined}>
    <td class="arbol" class:ok={tone === 'ok'}>{label}{tone === 'warn' ? ' ⚠' : ''}{hasSearch ? ' (filtrado)' : ''} <small>({data.count})</small></td>
    <td class="importe cifra">{cellText(data.totalCents)}</td>
    <td class="importe cifra">{cellText(data.avgCents)}</td>
    <td class="importe cifra">{cellText(data.ticketCents)}</td>
    {#each months as m (m)}<td class="importe cifra">{cellText(data.monthly[m])}</td>{/each}
  </tr>
{/snippet}

{#snippet nodeRow(node: PivotNodeLike, kind: 'gasto' | 'ingreso' | 'evento' | 'transferencia' | 'inversion', nodeDims: readonly PivotDimension[], siblings: SelectableItem[])}
  {@const isExpanded = forceExpand || expanded.has(node.key)}
  {@const hasChildren = node.children.length > 0}
  {@const canOpen = !hasChildren && node.movs.length > 0}
  {@const item = kind === 'transferencia' || kind === 'inversion' ? toMovementSelectable(node, nodeDims) : toAnySelectable(node, nodeDims)}
  {@const childSiblings = selectableListAny(node.children, nodeDims)}
  {@const natClass = (kind === 'gasto' || kind === 'ingreso') && nodeDims[node.depth] === 'nat'
    ? node.nat === 'recurrente' ? (kind === 'gasto' ? 'neg' : 'pos') : node.nat === 'extraordinario' ? 'suave' : ''
    : ''}
  {@const isDraggable = kind === 'gasto' || kind === 'ingreso' || kind === 'evento'}
  {@const dropCatId = (kind === 'gasto' || kind === 'ingreso') ? node.catId : null}
  <tr style={tintFor(node.depth)} class:clicable={hasChildren}
    class:dnd-target={dragging !== null && dropCatId !== null} class:dnd-dimmed={dragging !== null && dropCatId === null}
    onclick={() => hasChildren && toggle(node.key)}
    ondragover={dropCatId !== null ? (e) => e.preventDefault() : undefined}
    ondrop={dropCatId !== null ? (e) => { e.preventDefault(); void onDropCategory(e, dropCatId, node.key); } : undefined}>
    <td class="arbol" style={`padding-left: calc(var(--space-3) + ${node.depth} * var(--space-4));`}>
      <!-- El disparador de expansión es un BOTÓN: con teclado y lector de
           pantalla el árbol tiene que ser operable (spec §8, axe 0 serious).
           El onclick del <tr> queda solo como atajo de ratón. -->
      {#if hasChildren}
        <button type="button" class="flecha" aria-expanded={isExpanded}
          aria-label={`desplegar ${node.label}`}
          onclick={(e) => { e.stopPropagation(); toggle(node.key); }}>{isExpanded ? '▾' : '▸'}</button>
      {:else}
        <span class="flecha" aria-hidden="true"></span>
      {/if}
      <span class="asa" draggable={isDraggable} title="arrastrar" aria-hidden="true"
        style:visibility={isDraggable ? 'visible' : 'hidden'}
        onclick={(e) => e.stopPropagation()}
        ondragstart={isDraggable ? (e) => onDragStart(e, node, nodeDims) : undefined}
        ondragend={isDraggable ? onDragEnd : undefined}>⠿</span>
      <input type="checkbox" class="marca" style:visibility={item ? 'visible' : 'hidden'}
        tabindex={item ? 0 : -1} checked={item ? selected.has(node.key) : false}
        aria-label={`seleccionar ${node.label}`} data-fila={node.key}
        onclick={(e) => {
          // El clic nativo cambia `checked` en el DOM ANTES de correr este
          // manejador. En el camino de rango (Shift+clic) una fila que YA
          // estaba seleccionada sigue seleccionada: el valor reactivo no
          // cambia, Svelte no repinta (`set_checked` cachea el último valor
          // escrito), y la casilla queda desmarcada mientras el ítem sigue en
          // `selected`. `preventDefault()` cancela la activación nativa; los
          // «canceled activation steps» del checkbox restauran la
          // `checkedness` previa — justo la que Svelte tiene cacheada — así
          // que el pintado queda enteramente en manos de `checked={...}`.
          e.preventDefault();
          e.stopPropagation();
          if (item) clickItem(item, siblings, e.shiftKey);
        }} />
      {#if canOpen}
        <button type="button" class="abrir" title="abrir ficha"
          onclick={(e) => { e.stopPropagation(); openLeaf(node); }}>{node.label}</button>
      {:else}
        <span class={natClass}>{node.label}</span>
      {/if}
      <small>({node.count})</small>
    </td>
    <td class="importe cifra {natClass}">{cellText(node.totalCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.avgCents)}</td>
    <td class="importe cifra {natClass}">{cellText(node.ticketCents)}</td>
    {#each months as m (m)}<td class="importe cifra {natClass}">{cellText(node.monthly[m])}</td>{/each}
  </tr>
  {#if isExpanded}
    {#each node.children as child (child.key)}
      {@render nodeRow(child, kind, nodeDims, childSiblings)}
    {/each}
  {/if}
{/snippet}

<div class="pivot-controles">
  <PivotSearch rows={filteredRows.length ? filteredRows : rows} {catPathOf} {chips}
    onChips={(next) => setShallowParam('q', serializeChips(next))} />
  <div class="dims" role="group" aria-label="Dimensiones del pivot">
    {#each dims as d, i (d)}
      <span class="chip activa">
        <button type="button" disabled={i === 0} aria-label={`mover ${DIM_LABELS[d]} antes`} onclick={() => setDims(moveDim(dims, i, -1))}>◀</button>
        {DIM_LABELS[d]}
        <button type="button" disabled={i === dims.length - 1} aria-label={`mover ${DIM_LABELS[d]} después`} onclick={() => setDims(moveDim(dims, i, 1))}>▶</button>
        <button type="button" disabled={dims.length <= 1} aria-label={`quitar ${DIM_LABELS[d]}`} onclick={() => setDims(removeDim(dims, d))}>×</button>
      </span>
    {/each}
    {#each PIVOT_DIMENSIONS.filter((d) => !dims.includes(d)) as d (d)}
      <button type="button" class="chip" onclick={() => setDims(addDim(dims, d))}>{DIM_LABELS[d]}</button>
    {/each}
  </div>
</div>

{#if isEmpty}
  <p class="vacio">Sin resultados que coincidan con la búsqueda.
    <button type="button" class="limpiar" onclick={() => setShallowParam('q', '')}>limpiar búsqueda</button></p>
{:else}
  <!-- tabindex -1: ancla de foco cuando la fila que originó una acción ya no
       está en el DOM (F6-M3). No entra en el orden de tabulación. -->
  <div class="pivot-scroll" bind:this={tablaEl} tabindex="-1">
    <table class="pivot" data-testid="pivot-table">
      <thead>
        <tr>
          <th class="arbol"><button type="button" onclick={() => toggleSort('label')}>{dims.map((d) => DIM_LABELS[d]).join(' / ')}{sortIndicator('label')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('total')}>Acumulado{sortIndicator('total')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('avg')}>Promedio{sortIndicator('avg')}</button></th>
          <th class="importe"><button type="button" onclick={() => toggleSort('ticket')}>Ticket{sortIndicator('ticket')}</button></th>
          {#each months as m (m)}
            <th class="importe"><button type="button" onclick={() => toggleSort({ month: m })}>{monthLabel(m)}{sortIndicator({ month: m })}</button></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if ingresoTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-ingresos"><td colspan={colSpan}>INGRESOS</td></tr>
          {#each ingresoTree as node (node.key)}{@render nodeRow(node, 'ingreso', dims, selectableListAny(ingresoTree, dims))}{/each}
          {@render subtotalRow('Subtotal ingresos', tree.subtotales.ingresos, '', '')}
        {/if}
        {#if gastoTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-gastos"><td colspan={colSpan}>GASTOS</td></tr>
          {#each gastoTree as node (node.key)}{@render nodeRow(node, 'gasto', dims, selectableListAny(gastoTree, dims))}{/each}
          {@render subtotalRow('Subtotal gastos', tree.subtotales.gastos, '', '')}
        {/if}
        <tr class="banda" class:dnd-target={dragging !== null} data-testid="pivot-banda-eventos"
          ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); onDropNewEvent(e); }}>
          <td colspan={colSpan} class="banda-eventos">
            EVENTOS (soltar aquí = + nuevo evento · ☑ por evento = verlo en gastos/ingresos)
            {#if newEventDrop && popoverPos}
              <!-- T13-M2: Escape cierra desde CUALQUIER control del popover
                   (ver `onPopoverKeydown`), no solo estando dentro del campo. -->
              <form class="popover-evento" style:left={`${popoverPos.left}px`} style:top={`${popoverPos.top}px`}
                onsubmit={(e) => { e.preventDefault(); void confirmNewEventDrop(); }}>
                <input type="text" placeholder="＋ nuevo evento…" bind:value={newEventName} bind:this={newEventInput}
                  aria-label="Nombre del evento nuevo" onkeydown={onPopoverKeydown} />
                <!-- T13-M1: con el nombre vacío el submit se tragaba el
                     arrastre en silencio. Ahora no hay submit que tragar. -->
                <button type="submit" disabled={newEventName.trim().length === 0}
                  onkeydown={onPopoverKeydown}>Crear y asignar</button>
                <button type="button" class="cancelar" onclick={cancelNewEventDrop}
                  onkeydown={onPopoverKeydown}>Cancelar</button>
              </form>
            {/if}
          </td>
        </tr>
        {#each displayEventos as event (event.eventId)}
          {@const key = `event/${event.eventId}`}
          {@const evExpanded = forceExpand || expanded.has(key)}
          <tr class="clicable" class:dnd-target={dragging !== null} onclick={() => event.children.length > 0 && toggle(key)}
            ondragover={(e) => e.preventDefault()}
            ondrop={(e) => { e.preventDefault(); void onDropEvent(e, event.eventId, event.name, key); }}>
            <td class="arbol">
              {#if event.children.length > 0}
                <button type="button" class="flecha" aria-expanded={evExpanded}
                  aria-label={`desplegar ${event.name}`}
                  onclick={(e) => { e.stopPropagation(); toggle(key); }}>{evExpanded ? '▾' : '▸'}</button>
              {:else}
                <span class="flecha" aria-hidden="true"></span>
              {/if}
              <!-- F6-I3: la casilla de `dupev` solo tenía `title`, y un `title`
                   como única etiqueta es `label-title-only` de axe (serio): el
                   lector no lo anuncia de forma fiable y con teclado no
                   aparece. El `title` se queda como explicación larga. -->
              <input type="checkbox" checked={dupEventIds.includes(event.eventId)} disabled={event.children.length === 0}
                aria-label={`ver ${event.name} también en gastos e ingresos`}
                title="Ver los movimientos de este evento también dentro de sus categorías en GASTOS/INGRESOS"
                onclick={(e) => e.stopPropagation()} onchange={() => toggleDupEvent(event.eventId)} />
              🎉 {event.name} <small>({event.count})</small>
            </td>
            <td class="importe cifra">{cellText(event.netCents)}</td>
            <td class="importe cifra">{cellText(event.avgCents)}</td>
            <td class="importe cifra">{cellText(event.ticketCents)}</td>
            {#each months as m (m)}<td class="importe cifra">{cellText(event.monthly[m])}</td>{/each}
          </tr>
          {#if evExpanded}
            {#each event.children as child (child.key)}{@render nodeRow(child, 'evento', dims, selectableListAny(event.children, dims))}{/each}
          {/if}
        {/each}
        {#if displayEventos.length > 0}
          {@render subtotalRow('Subtotal eventos', tree.subtotales.eventos, '', '')}
        {/if}
        {#if internaTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-internas"><td colspan={colSpan}>INTERNAS</td></tr>
          {#each internaTree as node (node.key)}{@render nodeRow(node, 'transferencia', INTERNA_DIMS, [])}{/each}
          {@render subtotalRow('Subtotal internas', tree.subtotales.internas,
            tree.subtotales.internas.totalCents === 0n ? 'ok' : 'warn',
            tree.subtotales.internas.totalCents === 0n ? '' : 'Con todas las cuentas seleccionadas debe sumar 0: un valor distinto indica una pata fuera del filtro de cuentas o un descuadre real.')}
        {/if}
        {#if inversionTree.length > 0}
          <tr class="banda" data-testid="pivot-banda-inversion"><td colspan={colSpan}>INVERSIÓN</td></tr>
          {#each inversionTree as node (node.key)}{@render nodeRow(node, 'inversion', INVERSION_DIMS, [])}{/each}
          {@render subtotalRow('Subtotal inversión', tree.subtotales.inversiones, '', '')}
        {/if}
        {#if gastoTree.length > 0 || ingresoTree.length > 0 || displayEventos.length > 0}
          {@render subtotalRow('TOTAL NETO', tree.subtotales.totalNeto, '', '', 'pivot-total-neto')}
        {/if}
      </tbody>
    </table>
  </div>
  {#if hasSearch}
    <p class="nota">los KPIs muestran el total del periodo</p>
  {/if}
{/if}

{#if selectionList.length > 0}
  <!-- `events` (el prop íntegro), no `displayEventos`: mientras `hasSearch` es
       true, `displayEventos` se reduce a `eventTree` y omitiría eventos sin
       movimientos visibles en la búsqueda actual — aquí hace falta la lista
       completa del household para poder mover la selección a cualquiera. -->
  <PivotActionBar concepts={selectionList.length} movs={selectionMovs}
    {events} {categories} {invAccounts} {enviando}
    categoryOnlySelection={selectionList.every((i) => i.categoryId != null)}
    onMoveToEvent={actionMoveToEvent} onNewEvent={actionNewEvent}
    onMoveToCategory={actionMoveToCategory} onSetRecurrence={actionSetRecurrence}
    onInvest={actionInvest} onOpenPanel={actionOpenPanel} onClear={clearSelection} />
{/if}

{#if toast}
  <div class="pivot-toast" role="status" data-testid="pivot-toast">
    <span>{toast.message}</span>
    <!-- F6-M3: el foco vuelve al ancla ANTES de que el aviso salga del DOM; si
         no, cae al <body> y en una tabla larga se pierde el sitio. -->
    {#if toast.onUndo}<button type="button"
      onclick={() => { const u = toast?.onUndo; toast = null; devolverFoco(); if (u) void run(u); }}>Deshacer</button>{/if}
    <button type="button" aria-label="cerrar aviso" onclick={() => { toast = null; devolverFoco(); }}>✕</button>
  </div>
{/if}

<style>
  .pivot-controles { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: flex-start; margin-bottom: var(--space-2); }
  .dims { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .chip { border: 1px solid var(--line); border-radius: var(--r-full); background: var(--surface); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); }
  .chip.activa { border-color: var(--primary); background: var(--primary-soft); font-weight: 700; }
  .chip button { border: 0; background: transparent; cursor: pointer; padding: 0 var(--space-1); }
  .chip button:disabled { opacity: .35; cursor: default; }
  .pivot-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); }
  table.pivot { border-collapse: collapse; width: 100%; font-size: var(--text-meta); }
  .pivot th, .pivot td { padding: var(--space-1) var(--space-2); border-top: 1px solid var(--line); text-align: left; white-space: nowrap; }
  .pivot thead th { border-top: 0; }
  .pivot thead button { border: 0; background: transparent; cursor: pointer; font: inherit; color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; padding: 0; }
  .pivot .importe { text-align: right; font-variant-numeric: tabular-nums lining-nums; }
  .pivot .arbol { position: sticky; left: 0; background: inherit; }
  .pivot tr { background: var(--surface); }
  .pivot tr.clicable { cursor: pointer; }
  .flecha { display: inline-block; width: var(--space-4); color: var(--ink-faint); border: 0; background: transparent; font: inherit; padding: 0; text-align: left; }
  button.flecha { cursor: pointer; }
  .abrir { border: 0; background: transparent; cursor: pointer; font: inherit; padding: 0; text-decoration: underline dotted; }
  .asa { cursor: grab; color: var(--ink-faint); margin-right: var(--space-1); }
  tr.dnd-target { outline: 2px solid var(--primary); outline-offset: -2px; }
  tr.dnd-dimmed { opacity: .45; }
  /* T13-M6: `fixed`, no `absolute`. `.pivot-scroll` lleva `overflow-x: auto` y
     eso vuelve `auto` también el eje Y, así que un popover dentro de la tabla
     se recorta siempre. Las coordenadas las pone el gesto (`posicionaPopover`),
     que además lo abre hacia arriba cuando no cabe por debajo. */
  .popover-evento { position: fixed; z-index: 30; display: flex; gap: var(--space-1); background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2); }
  .popover-evento input { border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--space-1); font-size: max(1em, 1rem); }
  .popover-evento button { border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--primary); color: var(--ink-on-primary); cursor: pointer; padding: var(--space-1) var(--space-2); }
  .popover-evento button.cancelar { background: var(--surface); color: var(--ink); }
  .popover-evento button:disabled { opacity: .45; cursor: default; }
  :global(.pivot-drag-ghost) { position: fixed; top: -1000px; left: -1000px; padding: var(--space-1) var(--space-3); border-radius: var(--r-full); background: var(--primary); color: var(--ink-on-primary); font-size: var(--text-micro); white-space: nowrap; pointer-events: none; }

  /* Presupuesto de la spec §8: nada de movimiento para quien pide reducirlo.
     El resalte del destino se queda (es información, no animación). */
  @media (prefers-reduced-motion: reduce) {
    tr.dnd-target, tr.dnd-dimmed, .popover-evento, :global(.pivot-drag-ghost) { transition: none; animation: none; }
  }
  .banda td { background: var(--canvas-deep); font-weight: 700; font-size: var(--text-micro); letter-spacing: .06em; }
  .subtotal { background: var(--canvas); font-weight: 500; }
  .subtotal .ok { color: var(--success); }
  .subtotal.aviso { background: var(--danger-soft); color: var(--danger); }
  .pos { color: var(--success); }
  .neg { color: var(--danger); }
  .suave { color: var(--ink-soft); }
  .vacio, .nota { color: var(--ink-soft); font-size: var(--text-meta); margin-top: var(--space-2); }
  small { color: var(--ink-faint); }
  .limpiar { border: 0; background: transparent; cursor: pointer; color: var(--ink-soft); font-size: var(--text-meta); text-decoration: underline; }
  .marca { margin-right: var(--space-1); }
  .pivot-toast { position: fixed; z-index: 50; bottom: calc(var(--bottom-nav-h) + var(--space-6) + var(--space-6)); inset-inline: 0; margin-inline: auto; width: fit-content; max-width: calc(100% - var(--space-6)); display: flex; align-items: center; gap: var(--space-3); background: var(--primary); color: var(--ink-on-primary); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2) var(--space-3); font-size: var(--text-meta); }
  .pivot-toast button { border: 0; background: transparent; color: var(--ink-on-primary); cursor: pointer; font-weight: 700; text-decoration: underline; }

  /* Presupuesto de la spec §8: el módulo respeta prefers-reduced-motion. El
     toast aparece y desaparece sin desplazamiento ni fundido para quien lo pide. */
  @media (prefers-reduced-motion: reduce) {
    .pivot-toast, .pivot-toast button { transition: none; animation: none; }
  }
</style>
