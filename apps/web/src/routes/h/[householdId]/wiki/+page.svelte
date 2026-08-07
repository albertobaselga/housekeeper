<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { untrack } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import {
    cloneWikiTemplate,
    createWikiPage,
    createWikiSpace,
    parseTermList,
    queueWikiCommand,
    setWikiPageState,
    setWikiSpaceTemplate
  } from '$lib/wiki/commands';
  import type { WikiPageNode } from '$lib/server/wiki.server';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const home = $derived(data.home);
  const base = $derived(`/h/${context.household.id}/wiki`);

  // Las acciones de escritura solo existen sobre datos reales de Postgres; en
  // modo fixture (demo sin base de datos) la página es de solo lectura.
  let queued = $state(false);
  let busy = $state(false);

  async function dispatch(envelope: Parameters<typeof queueWikiCommand>[0]): Promise<void> {
    busy = true;
    try {
      const outcome = await queueWikiCommand(envelope);
      if (outcome === 'synced') await invalidateAll();
      else queued = true;
    } finally {
      busy = false;
    }
  }

  function publishPage(pageId: string): void {
    if (!home) return;
    void dispatch(setWikiPageState({ householdId: home.householdId, pageId, status: 'published' }));
  }

  function togglePin(pageId: string, pinned: boolean): void {
    if (!home) return;
    void dispatch(setWikiPageState({ householdId: home.householdId, pageId, pinned: !pinned }));
  }

  let newPageTitle = $state('');
  let newPageSpaceId = $state('');
  let newPageBody = $state('');
  let newPageTags = $state('');
  let newPagePublish = $state(false);

  function submitNewPage(event: SubmitEvent): void {
    event.preventDefault();
    if (!home || !newPageTitle.trim() || !newPageSpaceId || !newPageBody.trim()) return;
    void dispatch(
      createWikiPage({
        householdId: home.householdId,
        spaceId: newPageSpaceId,
        title: newPageTitle,
        bodyMarkdown: newPageBody,
        tags: parseTermList(newPageTags),
        publish: home.canPublish && newPagePublish
      })
    ).then(() => {
      newPageTitle = '';
      newPageBody = '';
      newPageTags = '';
      newPagePublish = false;
    });
  }

  // Plantillas (F4-01): alternar la marca de plantilla y clonar con nombre nuevo.
  let cloneNames = $state<Record<string, string>>({});

  function toggleTemplate(spaceId: string, isTemplate: boolean): void {
    if (!home) return;
    void dispatch(setWikiSpaceTemplate({ householdId: home.householdId, spaceId, isTemplate: !isTemplate }));
  }

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

  // Modo fixture (sin base de datos): lectura pura, sin acciones de escritura.
  let selectedSpace = $state('Todo');
  let selectedId = $state<string>(untrack(() => data.wiki?.pages[0]?.id ?? ''));
  let filteredPages = $derived(
    !data.wiki ? [] : selectedSpace === 'Todo' ? data.wiki.pages : data.wiki.pages.filter((page) => page.space === selectedSpace)
  );
  let selectedPage = $derived(data.wiki?.pages.find((page) => page.id === selectedId) ?? filteredPages[0]);
</script>

<svelte:head><title>Wiki de la casa · Casa Clara</title></svelte:head>

{#snippet pageNode(node: WikiPageNode)}
  <li class="wiki-node">
    <div class="wiki-node-row">
      <a href={`${base}/${node.slug}`}>
        <strong>{node.title}</strong>
        <small>
          {node.updatedLabel}
          · {node.reads30d} lectura{node.reads30d === 1 ? '' : 's'} en 30 días
        </small>
      </a>
      {#if node.status === 'draft'}<span class="status-chip warning">Borrador</span>{/if}
      {#if node.pinned}<span class="status-chip success">Fijada</span>{/if}
      {#if home?.canPublish}
        {#if node.status === 'draft'}
          <button class="button secondary small-button" type="button" disabled={busy} onclick={() => publishPage(node.id)}>Publicar</button>
        {/if}
        <button class="button secondary small-button" type="button" disabled={busy} onclick={() => togglePin(node.id, node.pinned)}>
          {node.pinned ? 'Desfijar' : 'Fijar'}
        </button>
      {/if}
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
  <PageHeader eyebrow="Conocimiento compartido" title="Wiki de la casa" description="Cómo funciona cada cosa, escrito para encontrarlo deprisa." />

  {#if home}
    {#if queued}<p class="success-message" role="status">Cambio guardado en la outbox local, pendiente de sincronizar.</p>{/if}

    {#if home.pinned.length}
      <section class="card" aria-labelledby="pinned-title">
        <div class="section-heading"><div><p class="eyebrow">En portada</p><h2 id="pinned-title">Fijadas</h2></div></div>
        <div class="wiki-pinned">
          {#each home.pinned as entry (entry.id)}
            <a href={`${base}/${entry.slug}`}>
              <small>{entry.spaceName}</small>
              <strong>{entry.title}</strong>
              <span>{entry.reads30d} lectura{entry.reads30d === 1 ? '' : 's'} en 30 días</span>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    <div class="content-grid">
      <section class="card" aria-labelledby="spaces-title">
        <div class="section-heading"><div><p class="eyebrow">Por espacios</p><h2 id="spaces-title">Espacios de la casa</h2></div></div>
        {#each home.spaces as space (space.id)}
          <div class="wiki-space">
            <div class="wiki-node-row">
              <h3>{space.name}</h3>
              {#if home.canPublish}
                <button class="button secondary small-button" type="button" disabled={busy} onclick={() => toggleTemplate(space.id, space.isTemplate)}>
                  Convertir en plantilla
                </button>
              {/if}
            </div>
            {#if space.description}<p class="article-summary">{space.description}</p>{/if}
            {#if space.pages.length}
              <ul class="wiki-tree">
                {#each space.pages as node (node.id)}
                  {@render pageNode(node)}
                {/each}
              </ul>
            {:else}
              <p class="audit-note">Todavía no hay páginas en este espacio.</p>
            {/if}
          </div>
        {:else}
          <p class="audit-note">Tu rol no tiene contenido visible en la wiki de este hogar.</p>
        {/each}

        {#if home.templates.length}
          <!-- Plantillas (F4-01): orígenes de clonación listados aparte de los espacios vivos. -->
          <div class="section-heading"><div><p class="eyebrow">Reutilizar</p><h2 id="templates-title">Plantillas</h2></div></div>
          {#each home.templates as template (template.id)}
            <div class="wiki-space" aria-labelledby="templates-title">
              <div class="wiki-node-row">
                <h3>{template.name}</h3>
                <span class="status-chip">Plantilla</span>
                {#if home.canPublish}
                  <button class="button secondary small-button" type="button" disabled={busy} onclick={() => toggleTemplate(template.id, template.isTemplate)}>
                    Dejar de ser plantilla
                  </button>
                {/if}
              </div>
              {#if template.description}<p class="article-summary">{template.description}</p>{/if}
              {#if home.canPublish}
                <form class="wiki-node-row" onsubmit={(event) => submitCloneTemplate(event, template.id)}>
                  <label>Nombre del espacio nuevo
                    <input type="text" bind:value={cloneNames[template.id]} maxlength="120" required />
                  </label>
                  <button class="button primary small-button" type="submit" disabled={busy}>Crear espacio desde plantilla</button>
                </form>
              {/if}
            </div>
          {/each}
        {/if}
      </section>

      <aside class="stack">
        <section class="card" aria-labelledby="recent-title">
          <div class="section-heading"><div><p class="eyebrow">Actividad</p><h2 id="recent-title">Recientes</h2></div></div>
          <ul class="wiki-recent">
            {#each home.recent as entry (entry.id)}
              <li>
                <a href={`${base}/${entry.slug}`}>
                  <strong>{entry.title}</strong>
                  <small>{entry.spaceName} · {entry.updatedLabel} · {entry.reads30d} lectura{entry.reads30d === 1 ? '' : 's'} en 30 días</small>
                </a>
              </li>
            {:else}
              <li><p class="audit-note">Sin actividad reciente.</p></li>
            {/each}
          </ul>
        </section>

        {#if home.searchGaps.length}
          <!-- Solo la familia recibe huecos (AC-18); para el resto la lista llega vacía. -->
          <section class="card" aria-labelledby="search-gaps-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Huecos documentales</p>
                <h2 id="search-gaps-title">Lo que la casa buscó y no encontró</h2>
              </div>
            </div>
            <ul class="wiki-recent">
              {#each home.searchGaps as gap (gap.representative)}
                <li>
                  <strong>{gap.representative}</strong>
                  <small>
                    {gap.missTotal} sin resultado{gap.missTotal === 1 ? '' : 's'}
                    · {gap.noClickTotal} sin clic
                    {#if gap.variants.length > 1}
                      · {gap.variants.length} variantes ({gap.variants.filter((variant) => variant !== gap.representative).join(', ')})
                    {/if}
                    · última el {gap.lastSeenLabel}
                  </small>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if home.canWrite && home.spaces.length}
          <section class="card" aria-labelledby="new-page-title">
            <div class="section-heading"><div><p class="eyebrow">Escribir</p><h2 id="new-page-title">Nueva página</h2></div></div>
            <form class="stack" onsubmit={submitNewPage}>
              <label>Título
                <input type="text" bind:value={newPageTitle} maxlength="200" required />
              </label>
              <label>Espacio
                <select bind:value={newPageSpaceId} required>
                  <option value="" disabled>Elige un espacio</option>
                  {#each home.spaces as space (space.id)}
                    <option value={space.id}>{space.name}</option>
                  {/each}
                </select>
              </label>
              <label>Contenido (Markdown)
                <textarea rows="6" bind:value={newPageBody} required></textarea>
              </label>
              <label>Etiquetas (separadas por comas)
                <input type="text" bind:value={newPageTags} />
              </label>
              {#if home.canPublish}
                <label class="inline-check"><input type="checkbox" bind:checked={newPagePublish} /> Publicar directamente</label>
              {/if}
              <button class="button primary" type="submit" disabled={busy}>Crear página</button>
            </form>
          </section>
        {/if}

        {#if home.canPublish}
          <section class="card" aria-labelledby="new-space-title">
            <div class="section-heading"><div><p class="eyebrow">Organizar</p><h2 id="new-space-title">Nuevo espacio</h2></div></div>
            <form class="stack" onsubmit={submitNewSpace}>
              <label>Nombre
                <input type="text" bind:value={newSpaceName} maxlength="120" required />
              </label>
              <label>Descripción
                <input type="text" bind:value={newSpaceDescription} maxlength="500" />
              </label>
              <button class="button secondary" type="submit" disabled={busy}>Crear espacio</button>
            </form>
          </section>
        {/if}
      </aside>
    </div>
  {:else if data.wiki}
    <div class="space-tabs" role="list" aria-label="Espacios de la wiki">
      {#each data.wiki.spaces as space}
        <button type="button" class:active={selectedSpace === space} onclick={() => selectedSpace = space}>{space}</button>
      {/each}
    </div>

    <div class="wiki-layout">
      <div class="wiki-list" aria-label="Páginas">
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
