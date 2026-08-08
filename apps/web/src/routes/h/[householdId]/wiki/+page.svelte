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

    // Sin apartados todavía: se crea «General» solo, sin pedir nada más.
    let spaceId = composerSpaceId || defaultSpaceId;
    if (!spaceId) {
      const outcome = await dispatch(
        createWikiSpace({ householdId: home.householdId, name: 'General', description: 'Notas generales de la casa' })
      );
      if (outcome !== 'synced') return;
      spaceId = home.spaces.find((space) => space.name === 'General')?.id ?? '';
      if (!spaceId) return;
      composerSpaceId = spaceId;
    }

    const outcome = await dispatch(
      createWikiPage({
        householdId: home.householdId,
        spaceId,
        title: composerTitle,
        bodyMarkdown: composerBody,
        tags: parseTermList(composerTags),
        publish: publish && home.canPublish
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

  // Modo fixture (sin base de datos): lectura pura, sin acciones de escritura.
  let selectedSpace = $state('Todo');
  let selectedId = $state<string>(untrack(() => data.wiki?.pages[0]?.id ?? ''));
  let filteredPages = $derived(
    !data.wiki ? [] : selectedSpace === 'Todo' ? data.wiki.pages : data.wiki.pages.filter((page) => page.space === selectedSpace)
  );
  let selectedPage = $derived(data.wiki?.pages.find((page) => page.id === selectedId) ?? filteredPages[0]);
</script>

<svelte:head><title>Guía de la casa · Casa Clara</title></svelte:head>

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
  <PageHeader
    eyebrow="Las instrucciones de tu casa"
    title="Guía de la casa"
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
        placeholder="¿Qué necesitas saber? p. ej. lavadora, caldera…"
      />
      <button class="button primary" type="submit">Buscar</button>
    </form>

    <!-- 2 · Un solo botón primario para escribir. -->
    {#if home.canWrite && !composerOpen}
      <div class="wiki-write-cta">
        <button class="button primary" type="button" onclick={() => void openComposer()}>
          Escribir una instrucción
        </button>
      </div>
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
            <p class="audit-note">Se guardará en el apartado «General», que se crea solo. Necesita conexión la primera vez.</p>
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

          {#if home.canPublish}
            <div class="wiki-composer-actions">
              <button class="button primary" type="submit" disabled={busy}>Guardar y publicar</button>
              <button class="text-button" type="button" disabled={busy} onclick={() => void submitComposer(false)}>
                Guardar sin publicar todavía
              </button>
              <button class="text-button" type="button" onclick={() => (composerOpen = false)}>Cancelar</button>
            </div>
          {:else}
            <div class="wiki-composer-actions">
              <button class="button primary" type="submit" disabled={busy}>Guardar</button>
              <button class="text-button" type="button" onclick={() => (composerOpen = false)}>Cancelar</button>
            </div>
            <p class="audit-note">Quedará guardada sin publicar hasta que la familia la publique.</p>
          {/if}
        </form>
      </section>
    {/if}

    <!-- 3 · Destacadas (sin contadores de lecturas). -->
    {#if home.pinned.length}
      <section class="card" aria-labelledby="pinned-title">
        <div class="section-heading"><div><h2 id="pinned-title">Destacadas</h2></div></div>
        <div class="wiki-pinned">
          {#each home.pinned as entry (entry.id)}
            <a href={`${base}/${entry.slug}`}>
              <small>{entry.spaceName}</small>
              <strong>{entry.title}</strong>
              <span>Actualizada el {entry.updatedLabel}</span>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    <!-- 4 · Apartados como tarjetas simples. -->
    {#if home.spaces.length || home.templates.length}
      <section aria-labelledby="spaces-title">
        <div class="section-heading">
          <div>
            <h2 id="spaces-title">Apartados</h2>
            {#if home.recent.length}
              <p class="audit-note">Última nota: {home.recent[0].title} · {home.recent[0].updatedLabel}</p>
            {/if}
          </div>
        </div>
        <div class="wiki-sections">
          {#each home.spaces as space (space.id)}
            {@const total = noteCount(space.pages)}
            <section class="card wiki-section-card">
              <div class="wiki-node-row">
                <h3>{space.name}</h3>
                <small class="wiki-section-count">{total} nota{total === 1 ? '' : 's'}</small>
              </div>
              {#if space.description}<p class="article-summary">{space.description}</p>{/if}
              {#if space.pages.length}
                <ul class="wiki-tree">
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
        {#if home.canPublish}
          <button class="text-button" type="button" disabled={busy} onclick={() => void createStarterSpaces()}>
            Crear los apartados de serie (General, Aparatos, Cocina y recetas)
          </button>
        {/if}
      </section>
    {:else}
      <section class="card empty-state">
        <span aria-hidden="true">⌂</span>
        <h2>Aún no hay nada publicado aquí</h2>
        <p>Cuando la familia escriba las instrucciones de la casa, las verás en esta página.</p>
      </section>
    {/if}

    <!-- 5 · Mantenimiento, plegado y solo para quien administra. -->
    {#if home.canPublish}
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
    <div class="space-tabs" role="list" aria-label="Apartados de la guía">
      {#each data.wiki.spaces as space}
        <button type="button" class:active={selectedSpace === space} onclick={() => selectedSpace = space}>{space}</button>
      {/each}
    </div>

    <div class="wiki-layout">
      <div class="wiki-list" aria-label="Notas">
        {#each filteredPages as page}
          <button type="button" class:active={selectedPage?.id === page.id} onclick={() => { selectedId = page.id; }}>
            <span class="wiki-icon" aria-hidden="true">{page.icon === 'bolt' ? 'ϟ' : page.icon === 'moon' ? '☾' : '◇'}</span>
            <span><small>{page.space}</small><strong>{page.title}</strong><span>{page.summary}</span></span>
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
