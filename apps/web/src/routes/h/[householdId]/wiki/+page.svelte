<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  type EditorProps = { householdId: string; pageId: string; initialValue: string; onSaved: () => void };

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  const canEdit = context.capabilities.includes('content.write');
  let selectedSpace = $state('Todo');
  let selectedId = $state<string>(untrack(() => data.wiki.pages[0]?.id ?? ''));
  let Editor = $state<Component<EditorProps> | null>(null);
  let saved = $state(false);
  let filteredPages = $derived(selectedSpace === 'Todo' ? data.wiki.pages : data.wiki.pages.filter((page) => page.space === selectedSpace));
  let selectedPage = $derived(data.wiki.pages.find((page) => page.id === selectedId) ?? filteredPages[0]);

  async function beginEditing(): Promise<void> {
    if (!canEdit) return;
    Editor = (await import('$lib/components/wiki/WikiEditor.svelte')).default;
  }
</script>

<svelte:head><title>Wiki de la casa · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader eyebrow="Conocimiento compartido" title="Wiki de la casa" description="Cómo funciona cada cosa, escrito para encontrarlo deprisa." />

  <div class="space-tabs" role="list" aria-label="Espacios de la wiki">
    {#each data.wiki.spaces as space}
      <button type="button" class:active={selectedSpace === space} onclick={() => selectedSpace = space}>{space}</button>
    {/each}
  </div>

  <div class="wiki-layout">
    <div class="wiki-list" aria-label="Páginas">
      {#each filteredPages as page}
        <button type="button" class:active={selectedPage?.id === page.id} onclick={() => { selectedId = page.id; Editor = null; saved = false; }}>
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
          {#if canEdit && !Editor}<button class="button secondary small-button" type="button" onclick={() => void beginEditing()}>Editar</button>{/if}
        </div>
        {#if saved}<p class="success-message" role="status">Cambio guardado en la outbox local.</p>{/if}
        {#if Editor}
          <Editor householdId={context.household.id} pageId={selectedPage.id} initialValue={selectedPage.body} onSaved={() => { Editor = null; saved = true; }} />
        {:else}
          <p class="article-summary">{selectedPage.summary}</p>
          {#each selectedPage.body.split('. ') as sentence}
            <p>{sentence}{sentence.endsWith('.') ? '' : '.'}</p>
          {/each}
          <footer>Actualizado {selectedPage.updated.toLocaleLowerCase('es')} · contenido ficticio</footer>
        {/if}
      </article>
    {/if}
  </div>
</div>
