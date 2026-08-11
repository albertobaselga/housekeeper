<script lang="ts">
  import { tick, untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import MilkdownSurface from '$lib/components/wiki/MilkdownSurface.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import {
    cloneWikiTemplate,
    createWikiPage,
    createWikiSpace,
    parseTermList,
    setWikiSpaceTemplate,
    type QueueOutcome
  } from '$lib/wiki/commands';
  import type { WikiPageNode } from '$lib/server/wiki.server';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const home = $derived(data.home);
  const base = $derived(`/h/${context.household.id}/wiki`);

  // Las acciones de escritura solo existen sobre datos reales de Postgres; en
  // modo fixture (demo sin base de datos) la página es de solo lectura.
  // Patrón wiki: `invalidate('cc:wiki')` selectivo y nota veraz unificada.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:wiki' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let busy = $state(false);

  async function dispatch(envelope: Parameters<typeof optimistic.run>[0]): Promise<QueueOutcome> {
    busy = true;
    try {
      return await optimistic.run(envelope);
    } finally {
      busy = false;
    }
  }

  // ——— Escribir una instrucción (flujo mínimo: título + texto) ———
  let composerOpen = $state(false);
  let composerElement = $state<HTMLElement | null>(null);
  let composerTitle = $state('');
  let composerBody = $state('');
  let composerTags = $state('');
  let composerSpaceId = $state('');
  // Editor visual único; el texto sin formato (Markdown) queda en avanzadas.
  let composerMarkdown = $state(false);
  let composerVisualFailed = $state(false);
  let composerSurface = $state<{ currentMarkdown: () => string | null } | null>(null);

  const defaultSpaceId = $derived(
    home ? (home.spaces.find((space) => space.name === 'General')?.id ?? home.spaces[0]?.id ?? '') : ''
  );

  async function openComposer(spaceId?: string): Promise<void> {
    composerSpaceId = spaceId ?? (composerSpaceId || defaultSpaceId);
    composerOpen = true;
    await tick();
    composerElement?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function flushComposerBody(): void {
    const flushed = composerSurface?.currentMarkdown();
    if (typeof flushed === 'string') composerBody = flushed;
  }

  function toggleComposerMarkdown(): void {
    if (!composerMarkdown) flushComposerBody();
    composerMarkdown = !composerMarkdown;
  }

  /**
   * Guardado de la instrucción. Publica por defecto («Guardar y publicar»);
   * «Guardar sin publicar todavía» es la acción secundaria. El comando del
   * servidor no cambia: cambia lo que la UI envía por defecto.
   */
  async function submitComposer(publish: boolean): Promise<void> {
    if (!home) return;
    flushComposerBody();
    if (!composerTitle.trim() || !composerBody.trim()) return;

    // Sin apartados todavía: la nota viaja con el apartado «General» POR SLUG y
    // el servidor lo da de alta al aplicarla. Nada de esperar un identificador
    // que llegaba con el ACK: esto funciona igual sin conexión.
    const spaceId = composerSpaceId || defaultSpaceId;

    const outcome = await dispatch(
      createWikiPage({
        householdId: home.householdId,
        ...(spaceId ? { spaceId } : { spaceSlug: 'general', spaceName: 'General' }),
        title: composerTitle,
        bodyMarkdown: composerBody,
        tags: parseTermList(composerTags),
        publish: publish && home.canWrite
      })
    );
    if (outcome === 'synced' || outcome === 'queued') {
      composerTitle = '';
      composerBody = '';
      composerTags = '';
      composerOpen = false;
      composerMarkdown = false;
    }
  }

  // Apartados de serie del primer uso: nadie tiene que inventar la estructura.
  const STARTER_SPACES = [
    { name: 'General', description: 'Notas generales de la casa' },
    { name: 'Aparatos', description: 'Lavadora, caldera, placa… cómo funciona cada uno' },
    { name: 'Cocina y recetas', description: 'Recetas y costumbres de la cocina' }
  ];

  async function createStarterSpaces(): Promise<void> {
    if (!home) return;
    for (const space of STARTER_SPACES) {
      if (home.spaces.some((candidate) => candidate.name === space.name)) continue;
      const outcome = await dispatch(createWikiSpace({ householdId: home.householdId, ...space }));
      if (outcome !== 'synced' && outcome !== 'queued') return;
    }
  }

  // ——— Mantenimiento de la guía (solo quien administra) ———
  // «Usar como modelo» esconde el apartado de la portada: NUNCA sin confirmar.
  let templateConfirmId = $state<string | null>(null);

  function confirmTemplate(spaceId: string): void {
    if (!home) return;
    templateConfirmId = null;
    void dispatch(setWikiSpaceTemplate({ householdId: home.householdId, spaceId, isTemplate: true }));
  }

  function stopTemplate(spaceId: string): void {
    if (!home) return;
    void dispatch(setWikiSpaceTemplate({ householdId: home.householdId, spaceId, isTemplate: false }));
  }

  let cloneNames = $state<Record<string, string>>({});

  function submitCloneTemplate(event: SubmitEvent, templateSpaceId: string): void {
    event.preventDefault();
    const name = cloneNames[templateSpaceId]?.trim();
    if (!home || !name) return;
    void dispatch(
      cloneWikiTemplate({ householdId: home.householdId, templateSpaceId, name })
    ).then(() => {
      cloneNames = { ...cloneNames, [templateSpaceId]: '' };
    });
  }

  let newSpaceName = $state('');
  let newSpaceDescription = $state('');

  function submitNewSpace(event: SubmitEvent): void {
    event.preventDefault();
    if (!home || !newSpaceName.trim()) return;
    void dispatch(
      createWikiSpace({
        householdId: home.householdId,
        name: newSpaceName,
        description: newSpaceDescription
      })
    ).then(() => {
      newSpaceName = '';
      newSpaceDescription = '';
    });
  }

  function noteCount(nodes: WikiPageNode[]): number {
    return nodes.reduce((total, node) => total + 1 + noteCount(node.children), 0);
  }

  /** Cuántas notas hay en toda la guía: es lo que dice el titular de estado. */
  const totalNotes = $derived(
    home ? home.spaces.reduce((total, space) => total + noteCount(space.pages), 0) : 0
  );

  // Modo fixture (sin base de datos): lectura pura, sin acciones de escritura.
  let selectedSpace = $state('Todo');
  let selectedId = $state<string>(untrack(() => data.wiki?.pages[0]?.id ?? ''));
  let filteredPages = $derived(
    !data.wiki ? [] : selectedSpace === 'Todo' ? data.wiki.pages : data.wiki.pages.filter((page) => page.space === selectedSpace)
  );
  let selectedPage = $derived(data.wiki?.pages.find((page) => page.id === selectedId) ?? filteredPages[0]);
</script>

{#snippet pageNode(node: WikiPageNode)}
  <li class="wiki-node">
    <div class="wiki-node-row">
      <a href={`${base}/${node.slug}`}>
        <strong>{node.title}</strong>
        <small>{node.updatedLabel}</small>
      </a>
      {#if node.status === 'draft'}<span class="status-chip warning">Guardada sin publicar</span>{/if}
      {#if node.pinned}<span class="status-chip success">Destacada</span>{/if}
    </div>
    {#if node.children.length}
      <ul class="wiki-tree">
        {#each node.children as child (child.id)}
          {@render pageNode(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<div class="page-wrap">
  <!-- La Guía se consulta DE PIE. El h1 dice cuánta casa hay escrita y deja de
       gastar 300 px de marco (el 36 % de la pantalla a 390 y el 53 % a 320) en
       un eyebrow decorativo, un título de 32 px en dos líneas y tres líneas de
       descripción antes de la primera instrucción. -->
  <PageHeader
    eyebrow="Las instrucciones de tu casa"
    title={home ? `Guía de la casa · ${totalNotes} nota${totalNotes === 1 ? '' : 's'}` : 'Guía de la casa'}
    description="Aparatos, recetas, niños, limpieza. Escríbelo una vez y cualquiera lo encuentra."
  />

  {#if home}
    <ActionStatus status={actionStatus} />

    <!-- 1 · Buscador: la puerta de entrada normal a la guía. -->
    <form class="search-form" role="search" method="GET" action={`/h/${context.household.id}/search`}>
      <span aria-hidden="true">⌕</span>
      <label class="sr-only" for="wiki-search">Buscar en la guía de la casa</label>
      <input
        id="wiki-search"
        name="q"
        type="search"
        autocomplete="off"
        enterkeyhint="search"
        placeholder="¿Qué necesitas saber?"
      />
      <button class="button primary" type="submit">Buscar</button>
    </form>

    <!-- 2 · Las destacadas, como atajos y no como bloque repetido. Antes eran
         una rejilla de tarjetas de 3 × 84 px con el mismo dato que ya sale más
         abajo en su apartado; ahora son chips de una línea con máscara en
         degradado y un chip siempre cortado a la mitad, así que se ve que hay
         más. La nota sigue llevando su insignia «Destacada» en su sitio. -->
    {#if home.pinned.length}
      <nav class="chip-strip scroller" aria-label="Notas destacadas">
        {#each home.pinned as entry (entry.id)}
          <a class="chip" href={`${base}/${entry.slug}`}>{entry.title}</a>
        {/each}
      </nav>
    {/if}

    {#if home.canWrite && composerOpen}
      <section class="card wiki-composer" aria-labelledby="composer-title" bind:this={composerElement}>
        <div class="section-heading"><div><h2 id="composer-title">Escribir una instrucción</h2></div></div>
        <form class="stack" onsubmit={(event) => { event.preventDefault(); void submitComposer(true); }}>
          <label>¿Sobre qué?
            <input
              type="text"
              autocomplete="off"
              enterkeyhint="next"
              bind:value={composerTitle}
              maxlength="200"
              placeholder="p. ej. Cómo apagar la caldera"
              required
            />
          </label>

          <div class="editor-body">
            <span class="editor-content-label" id="composer-text-label">El texto</span>
            {#if composerVisualFailed}
              <p class="audit-note" role="status">El editor con formato no ha podido cargarse; puedes escribir el texto igualmente.</p>
            {/if}
            {#if composerMarkdown || composerVisualFailed}
              <textarea rows="8" bind:value={composerBody} aria-labelledby="composer-text-label"></textarea>
            {:else}
              <MilkdownSurface
                bind:this={composerSurface}
                value={composerBody}
                onChange={(markdown) => (composerBody = markdown)}
                onError={() => (composerVisualFailed = true)}
              />
            {/if}
          </div>

          {#if home.spaces.length}
            <label>¿Dónde la guardamos?
              <select bind:value={composerSpaceId}>
                {#each home.spaces as space (space.id)}
                  <option value={space.id}>{space.name}</option>
                {/each}
              </select>
            </label>
          {:else}
            <p class="audit-note">Se guardará en el apartado «General», que se crea solo. Funciona también sin conexión.</p>
          {/if}

          <details class="wiki-advanced">
            <summary>Opciones avanzadas</summary>
            <div class="stack">
              <label>Palabras para encontrarla (separadas por comas)
                <input type="text" autocomplete="off" enterkeyhint="done" bind:value={composerTags} />
              </label>
              {#if !composerVisualFailed}
                <button class="text-button" type="button" onclick={toggleComposerMarkdown}>
                  {composerMarkdown ? 'Volver al editor con formato' : 'Escribir en Markdown'}
                </button>
              {/if}
            </div>
          </details>

          <div class="wiki-composer-actions">
            <button class="button primary" type="submit" disabled={busy}>Guardar y publicar</button>
            <button class="text-button" type="button" disabled={busy} onclick={() => void submitComposer(false)}>
              Guardar sin publicar todavía
            </button>
            <button class="text-button" type="button" onclick={() => (composerOpen = false)}>Cancelar</button>
          </div>
          <p class="audit-note">
            Al publicarla entra en el libro de la guía y cuenta para la lectura de quien trabaja
            en casa. Sin publicar no se le pide a nadie que la lea.
          </p>
        </form>
      </section>
    {/if}

    <!-- 3 · Los apartados con sus notas: LA lista de esta pantalla, y por eso
         va justo debajo del buscador. Antes empezaba a 300 px del borde,
         detrás de la tarjeta de lectura y del botón de escribir, con fichas de
         84–102 px de las que solo se veían seis a 390 px y tres a 320. -->
    {#if home.spaces.length || home.templates.length}
      <section aria-labelledby="spaces-title">
        <h2 id="spaces-title" class="sr-only">Apartados</h2>
        <div class="wiki-sections">
          {#each home.spaces as space, index (space.id)}
            {@const total = noteCount(space.pages)}
            <section class="card wiki-section-card">
              <div class="wiki-node-row">
                <h3>{space.name}</h3>
                <small class="wiki-section-count">{total} nota{total === 1 ? '' : 's'}</small>
              </div>
              {#if space.pages.length}
                <ul class="wiki-tree" data-lista={index === 0 ? 'principal' : undefined}>
                  {#each space.pages as node (node.id)}
                    {@render pageNode(node)}
                  {/each}
                </ul>
              {:else}
                <p class="audit-note">
                  Todavía no hay notas en este apartado.
                  {#if home.canWrite}
                    <button class="text-button" type="button" onclick={() => void openComposer(space.id)}>Escribe la primera →</button>
                  {/if}
                </p>
              {/if}
            </section>
          {/each}
          {#each home.templates as template (template.id)}
            {@const total = noteCount(template.pages)}
            <!-- Un modelo sigue viéndose aquí con su insignia: nada «desaparece». -->
            <section class="card wiki-section-card">
              <div class="wiki-node-row">
                <h3>{template.name}</h3>
                <span class="status-chip">Modelo</span>
                <small class="wiki-section-count">{total} nota{total === 1 ? '' : 's'}</small>
              </div>
              {#if template.description}<p class="article-summary">{template.description}</p>{/if}
              <p class="audit-note">Sirve para crear apartados nuevos iguales; no sale en Destacadas. Se administra en «Mantenimiento de la guía».</p>
            </section>
          {/each}
        </div>
      </section>
    {:else if home.canWrite}
      <!-- Primer uso: vacío guiado, sin callejones sin salida. -->
      <section class="card empty-state">
        <span aria-hidden="true">⌂</span>
        <h2>La guía está vacía</h2>
        <p>Empieza por lo que más se pregunta en casa: ¿cómo va la lavadora? ¿a qué hora recogen a los niños?</p>
        <button class="button primary" type="button" onclick={() => void openComposer()}>Escribir la primera instrucción</button>
        <button class="text-button" type="button" disabled={busy} onclick={() => void createStarterSpaces()}>
          Crear los apartados de serie (General, Aparatos, Cocina y recetas)
        </button>
      </section>
    {:else}
      <section class="card empty-state">
        <span aria-hidden="true">⌂</span>
        <h2>Aún no hay nada publicado aquí</h2>
        <p>
          Aquí van las instrucciones de la casa: aparatos, recetas, niños, limpieza.
          Cuando la familia las escriba, las verás en esta página.
        </p>
      </section>
    {/if}

    <!-- 4 · Leerla entera. Es la vía de la acogida —se hace una vez— y convive
         con la consulta suelta, que es lo que se hace a diario: por eso va
         DEBAJO de la lista y no encima. Buscar y entrar a una nota sigue
         funcionando igual. -->
    <section class="card guide-reading-card" aria-labelledby="lectura-title">
      <div class="section-heading">
        <div>
          <h2 id="lectura-title">Leerla entera, como un libro</h2>
          <p class="audit-note">
            {#if home.reading.total === 0}
              Todavía no hay notas publicadas.
            {:else if home.reading.complete}
              Te la has leído entera: {home.reading.total} notas.
              {#if home.reading.changed > 0}
                {home.reading.changed} han cambiado desde entonces.
              {/if}
            {:else}
              Llevas {home.reading.read} de {home.reading.total} notas.
              {#if home.reading.nextTitle}Sigues por «{home.reading.nextTitle}».{/if}
            {/if}
          </p>
        </div>
        {#if home.reading.total > 0}
          <a class="button primary" href={`${base}/libro`}>
            {home.reading.read === 0 ? 'Empezar a leer' : home.reading.complete ? 'Releerla' : 'Seguir leyendo'}
          </a>
        {/if}
      </div>
      {#if home.reading.total > 0}
        <div
          class="book-progress-bar"
          role="progressbar"
          aria-label="Notas leídas de la guía"
          aria-valuenow={home.reading.read}
          aria-valuemin="0"
          aria-valuemax={home.reading.total}
        >
          <span style={`width: ${Math.round((home.reading.read / home.reading.total) * 100)}%`}></span>
        </div>
        <p class="audit-note">
          <a href={`${base}/progreso`}>
            {home.canWrite ? 'Ver quién se la ha leído' : 'Ver qué me falta'}
          </a>
        </p>
      {/if}
    </section>

    <!-- 5 · Escribir: leer pasa cincuenta veces por cada edición, así que el
         botón de escribir va después de lo que se lee, no delante. -->
    {#if home.canWrite && !composerOpen}
      <div class="wiki-write-cta">
        <button class="button primary" type="button" onclick={() => void openComposer()}>
          Escribir una instrucción
        </button>
      </div>
    {/if}

    <!-- 6 · Mantenimiento, plegado y solo para quien administra. -->
    {#if home.canWrite}
      <details class="card wiki-maintenance">
        <summary>Mantenimiento de la guía</summary>
        <div class="stack">
          {#if home.searchGaps.length}
            <section aria-labelledby="search-gaps-title">
              <div class="section-heading"><div><h3 id="search-gaps-title">Búsquedas sin respuesta</h3></div></div>
              <p class="audit-note">Lo que se buscó en casa y no encontró respuesta. Escribir esas notas es lo más útil.</p>
              <ul class="wiki-recent">
                {#each home.searchGaps as gap (gap.representative)}
                  <li>
                    <strong>{gap.representative}</strong>
                    <small>
                      {#if gap.missTotal > 0}{gap.missTotal} búsqueda{gap.missTotal === 1 ? '' : 's'} sin respuesta{/if}
                      {#if gap.missTotal > 0 && gap.noClickTotal > 0}·{/if}
                      {#if gap.noClickTotal > 0}{gap.noClickTotal} sin abrir ningún resultado{/if}
                      · última el {gap.lastSeenLabel}
                    </small>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}

          <section aria-labelledby="new-space-title">
            <div class="section-heading"><div><h3 id="new-space-title">Crear un apartado</h3></div></div>
            <form class="stack" onsubmit={submitNewSpace}>
              <label>Nombre
                <input type="text" autocomplete="off" enterkeyhint="next" bind:value={newSpaceName} maxlength="120" required />
              </label>
              <label>Para qué sirve (opcional)
                <input type="text" autocomplete="off" enterkeyhint="done" bind:value={newSpaceDescription} maxlength="500" />
              </label>
              <button class="button secondary" type="submit" disabled={busy}>Crear apartado</button>
            </form>
          </section>

          {#if home.spaces.length}
            <section aria-labelledby="manage-spaces-title">
              <div class="section-heading"><div><h3 id="manage-spaces-title">Modelos (avanzado)</h3></div></div>
              <p class="audit-note">Un modelo es un apartado que sirve de molde para crear otros iguales.</p>
              {#each home.spaces as space (space.id)}
                <div class="wiki-space">
                  <div class="wiki-node-row">
                    <h4>{space.name}</h4>
                    <button
                      class="button secondary small-button"
                      type="button"
                      disabled={busy}
                      onclick={() => (templateConfirmId = templateConfirmId === space.id ? null : space.id)}
                    >Usar como modelo (avanzado)</button>
                  </div>
                  {#if templateConfirmId === space.id}
                    <div class="wiki-confirm" role="alertdialog" aria-labelledby={`confirm-template-${space.id}`}>
                      <p id={`confirm-template-${space.id}`}>
                        <strong>¿Convertir «{space.name}» en modelo?</strong>
                        El apartado y sus notas dejarán de salir en Destacadas y pasarán a verse con la insignia «Modelo».
                        No se borra nada y puedes deshacerlo aquí mismo.
                      </p>
                      <div class="wiki-composer-actions">
                        <button class="button primary small-button" type="button" disabled={busy} onclick={() => confirmTemplate(space.id)}>
                          Sí, usar como modelo
                        </button>
                        <button class="button secondary small-button" type="button" onclick={() => (templateConfirmId = null)}>Cancelar</button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </section>
          {/if}

          {#if home.templates.length}
            <section aria-labelledby="templates-title">
              <div class="section-heading"><div><h3 id="templates-title">Modelos activos</h3></div></div>
              {#each home.templates as template (template.id)}
                <div class="wiki-space">
                  <div class="wiki-node-row">
                    <h4>{template.name}</h4>
                    <span class="status-chip">Modelo</span>
                    <button class="button secondary small-button" type="button" disabled={busy} onclick={() => stopTemplate(template.id)}>
                      Volver a apartado normal
                    </button>
                  </div>
                  {#if template.description}<p class="article-summary">{template.description}</p>{/if}
                  <form class="wiki-node-row" onsubmit={(event) => submitCloneTemplate(event, template.id)}>
                    <label>Nombre del apartado nuevo
                      <input type="text" autocomplete="off" enterkeyhint="done" bind:value={cloneNames[template.id]} maxlength="120" required />
                    </label>
                    <button class="button primary small-button" type="submit" disabled={busy}>Crear apartado desde el modelo</button>
                  </form>
                </div>
              {/each}
            </section>
          {/if}
        </div>
      </details>
    {/if}
  {:else if data.wiki}
    <!-- Siete apartados en 353 px de caja medían 467 px de contenido: «Recetas
         y comensales» salía cortada a 390 y no existía visualmente a 320. Con
         más de cuatro, scroller con máscara en degradado y un chip siempre
         cortado a la mitad: se ve que hay más. -->
    <div class="chip-strip" class:scroller={data.wiki.spaces.length > 4} role="list" aria-label="Apartados de la guía">
      {#each data.wiki.spaces as space}
        <button type="button" class="chip" class:active={selectedSpace === space} onclick={() => selectedSpace = space}>{space}</button>
      {/each}
    </div>

    <div class="wiki-layout">
      <div class="wiki-list" aria-label="Notas" data-lista="principal">
        {#each filteredPages as page}
          <button type="button" class:active={selectedPage?.id === page.id} onclick={() => { selectedId = page.id; }}>
            <span><strong>{page.title}</strong><span>{page.space} · {page.summary}</span></span>
            <time>{page.updated}</time>
          </button>
        {/each}
      </div>

      {#if selectedPage}
        <article class="card wiki-article">
          <div class="section-heading">
            <div><p class="eyebrow">{selectedPage.space}</p><h2>{selectedPage.title}</h2></div>
          </div>
          <p class="article-summary">{selectedPage.summary}</p>
          {#each selectedPage.body.split('. ') as sentence}
            <p>{sentence}{sentence.endsWith('.') ? '' : '.'}</p>
          {/each}
          <footer>Actualizado {selectedPage.updated.toLocaleLowerCase('es')} · contenido ficticio</footer>
        </article>
      {/if}
    </div>
  {/if}
</div>
