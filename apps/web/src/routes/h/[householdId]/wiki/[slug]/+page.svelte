<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { Component } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import WikiMarkdown from '$lib/components/wiki/WikiMarkdown.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { queueWikiCommand, setWikiPageState, type QueueOutcome } from '$lib/wiki/commands';
  import type { PageData } from './$types';

  type EditorProps = {
    householdId: string;
    pageId: string;
    baseRevision: number;
    initialTitle: string;
    initialBody: string;
    initialTags?: string[];
    initialAliases?: string[];
    onSaved: (outcome: QueueOutcome) => void;
  };

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const view = $derived(data.view);
  const base = $derived(`/h/${context.household.id}/wiki`);

  // Editor route-lazy: el módulo solo se carga al pulsar Editar.
  let Editor = $state<Component<EditorProps> | null>(null);
  let queued = $state(false);
  let saved = $state(false);
  let busy = $state(false);

  async function beginEditing(): Promise<void> {
    if (!view?.canWrite) return;
    Editor = (await import('$lib/components/wiki/WikiEditor.svelte')).default as Component<EditorProps>;
  }

  async function onEditorSaved(outcome: QueueOutcome): Promise<void> {
    Editor = null;
    if (outcome === 'synced') {
      saved = true;
      await invalidateAll();
    } else {
      queued = true;
    }
  }

  async function dispatchState(input: { status?: 'draft' | 'published'; pinned?: boolean }): Promise<void> {
    if (!view) return;
    busy = true;
    try {
      const outcome = await queueWikiCommand(
        setWikiPageState({ householdId: context.household.id, pageId: view.page.id, ...input })
      );
      if (outcome === 'synced') await invalidateAll();
      else queued = true;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{view?.revision.title ?? data.fixture?.title ?? 'Wiki'} · Casa Clara</title>
</svelte:head>

<div class="page-wrap">
  {#if view}
    {#snippet actions()}
      {#if view.canWrite && !Editor}
        <button class="button secondary" type="button" onclick={() => void beginEditing()}>Editar</button>
      {/if}
      {#if view.canPublish}
        {#if view.page.status === 'draft'}
          <button class="button primary" type="button" disabled={busy} onclick={() => void dispatchState({ status: 'published' })}>Publicar</button>
        {/if}
        <button class="button secondary" type="button" disabled={busy} onclick={() => void dispatchState({ pinned: !view.page.pinned })}>
          {view.page.pinned ? 'Desfijar' : 'Fijar en portada'}
        </button>
      {/if}
    {/snippet}
    <PageHeader eyebrow={view.page.spaceName} title={view.revision.title} description={view.revision.summary} {actions} />

    <p class="audit-note wiki-meta">
      <a href={base}>← Wiki</a>
      · Actualizada el {view.page.updatedLabel}
      · {view.page.reads30d} lectura{view.page.reads30d === 1 ? '' : 's'} en 30 días
      {#if view.page.status === 'draft'}· <span class="status-chip warning">Borrador</span>{/if}
      {#if view.page.pinned}· <span class="status-chip success">Fijada</span>{/if}
    </p>

    {#if saved}<p class="success-message" role="status">Cambio sincronizado.</p>{/if}
    {#if queued}<p class="success-message" role="status">Cambio guardado en la outbox local, pendiente de sincronizar.</p>{/if}

    <article class="card wiki-article">
      {#if Editor}
        <Editor
          householdId={context.household.id}
          pageId={view.page.id}
          baseRevision={view.revision.number}
          initialTitle={view.revision.title}
          initialBody={view.revision.bodyMarkdown}
          initialTags={view.revision.tags}
          initialAliases={view.revision.aliases}
          onSaved={(outcome) => void onEditorSaved(outcome)}
        />
      {:else}
        <WikiMarkdown blocks={data.blocks} />
        {#if view.revision.tags.length || view.revision.aliases.length}
          <footer class="wiki-terms">
            {#each view.revision.tags as tag}<span class="status-chip">{tag}</span>{/each}
            {#each view.revision.aliases as alias}<span class="status-chip quiet">{alias}</span>{/each}
          </footer>
        {/if}
      {/if}
    </article>

    <details class="card wiki-history">
      <summary>Historial · {view.revisions.length} revisi{view.revisions.length === 1 ? 'ón' : 'ones'}</summary>
      <ul class="wiki-revisions">
        {#each view.revisions as revision (revision.id)}
          <li>
            <strong>r{revision.number}</strong>
            <span>{revision.author} · {revision.createdLabel}</span>
            {#if revision.summary}<small>{revision.summary}</small>{/if}
          </li>
        {/each}
      </ul>
      {#if view.diff}
        <h3>Cambios de r{view.diffAgainst} a r{view.revision.number}</h3>
        <pre class="wiki-diff">{#each view.diff as line}<span
            class={line.type}>{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '} {line.text}
</span>{/each}</pre>
      {:else}
        <p class="audit-note">Esta página solo tiene una revisión.</p>
      {/if}
    </details>
  {:else if data.fixture}
    <PageHeader eyebrow={data.fixture.space} title={data.fixture.title} description={data.fixture.summary} />
    <p class="audit-note wiki-meta"><a href={base}>← Wiki</a> · contenido ficticio</p>
    <article class="card wiki-article">
      <WikiMarkdown blocks={data.blocks} />
      <footer>Actualizado {data.fixture.updated.toLocaleLowerCase('es')} · contenido ficticio</footer>
    </article>
  {/if}
</div>
