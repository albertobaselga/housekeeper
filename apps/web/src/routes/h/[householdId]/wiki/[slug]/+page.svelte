<script lang="ts">
  import { invalidate } from '$app/navigation';
  import type { Component } from 'svelte';
  import { writable } from 'svelte/store';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import WikiMarkdown from '$lib/components/wiki/WikiMarkdown.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { listOutbox } from '$lib/offline/idb';
  import { describeErrorCode } from '$lib/offline/error-codes';
  import type { ActionFeedback } from '$lib/offline/optimistic';
  import { queueCommand, type QueueCommandResult } from '$lib/offline/queue-command';
  import { lastFlushAt } from '$lib/offline/sync';
  import { setWikiPageState } from '$lib/wiki/commands';
  import { parseWikiMarkdown, type WikiBlock } from '$lib/wiki/markdown';
  import type { PageData } from './$types';

  /*
   * PATRÓN DE REFERENCIA — acción con latencia <200 ms percibidos y feedback
   * honesto. Para replicarlo en otra página:
   *
   * 1. `depends('cc:<módulo>')` en su +page.server.ts e `invalidate('cc:<módulo>')`
   *    tras cada acción confirmada, en vez de `invalidateAll()`: un solo load
   *    re-ejecutado, sin re-firmar el snapshot del layout en cada acción.
   * 2. Actualización OPTIMISTA: al guardar se pinta el estado nuevo al
   *    instante desde el borrador local (`optimistic`/`stateOverride`),
   *    mientras `queueCommand` viaja. La UI nunca espera a la red para
   *    responder al gesto.
   * 3. Reconciliación con el ACK real (`QueueCommandResult`):
   *      - synced   → invalidate selectivo y se retira el estado optimista
   *                   cuando llegan los datos frescos (sin parpadeo).
   *      - queued   → el estado optimista se mantiene con nota ámbar
   *                   «guardado en este dispositivo», y `lastFlushAt` (store
   *                   de sync.ts) avisa cuando un flush posterior lo confirma
   *                   para limpiar la nota e invalidar — o revertir si el ACK
   *                   tardío fue rejected/conflict.
   *      - rejected/conflict → REVERSIÓN inmediata del estado optimista y
   *                   aviso rojo con la causa traducida. Nunca se anuncia
   *                   como «se sincronizará».
   */

  type EditorDraft = {
    operationId: string;
    title: string;
    bodyMarkdown: string;
    tags: string[];
    aliases: string[];
  };

  type EditorProps = {
    householdId: string;
    pageId: string;
    baseRevision: number;
    initialTitle: string;
    initialBody: string;
    initialTags?: string[];
    initialAliases?: string[];
    onSaved: (result: QueueCommandResult, draft: EditorDraft) => void;
  };

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const view = $derived(data.view);
  const base = $derived(`/h/${context.household.id}/wiki`);

  // Editor route-lazy: el módulo solo se carga al pulsar Editar.
  let Editor = $state<Component<EditorProps> | null>(null);
  let busy = $state(false);

  // Estado optimista del contenido (borrador recién guardado) y del estado de
  // página (fijar/publicar), más la operación pendiente de ACK si la hubo.
  let optimistic = $state<{ title: string; blocks: WikiBlock[]; tags: string[]; aliases: string[] } | null>(null);
  let stateOverride = $state<{ status?: 'draft' | 'published'; pinned?: boolean } | null>(null);
  let pendingOpId = $state<string | null>(null);
  // Nota unificada (P2-5): mismo componente/copy que el resto de páginas.
  const feedback = writable<ActionFeedback | null>(null);

  // Lo que se pinta: el borrador optimista si existe; si no, los datos del load.
  const shownTitle = $derived(optimistic?.title ?? view?.revision.title ?? data.fixture?.title ?? 'Guía de la casa');
  const lastAuthor = $derived(view?.revisions[0]?.author ?? '');
  const shownBlocks = $derived(optimistic?.blocks ?? data.blocks);
  const shownTags = $derived(optimistic?.tags ?? view?.revision.tags ?? []);
  const shownAliases = $derived(optimistic?.aliases ?? view?.revision.aliases ?? []);
  const shownStatus = $derived(stateOverride?.status ?? view?.page.status);
  const shownPinned = $derived(stateOverride?.pinned ?? view?.page.pinned ?? false);

  async function beginEditing(): Promise<void> {
    if (!view?.canWrite) return;
    Editor = (await import('$lib/components/wiki/WikiEditor.svelte')).default as Component<EditorProps>;
  }

  /** Datos frescos confirmados: se retira todo estado optimista a la vez. */
  async function settleWithServer(): Promise<void> {
    await invalidate('cc:wiki');
    optimistic = null;
    stateOverride = null;
  }

  function revertOptimistic(errorCode: string | undefined, fallback: string): void {
    optimistic = null;
    stateOverride = null;
    pendingOpId = null;
    const cause = describeErrorCode(errorCode);
    feedback.set({ tone: 'error', text: cause ? `${fallback}: ${cause}.` : `${fallback}.` });
  }

  async function applyResult(result: QueueCommandResult, operationId: string): Promise<void> {
    if (result.outcome === 'synced') {
      pendingOpId = null;
      feedback.set({ tone: 'success', text: result.message });
      await settleWithServer();
    } else if (result.outcome === 'queued') {
      pendingOpId = operationId;
      feedback.set({ tone: 'pending', text: result.message });
    } else {
      // rejected/conflict: reversión inmediata + causa veraz (nunca «se sincronizará»).
      optimistic = null;
      stateOverride = null;
      pendingOpId = null;
      feedback.set({ tone: 'error', text: result.message });
    }
  }

  function onEditorSaved(result: QueueCommandResult, draft: EditorDraft): void {
    Editor = null;
    // Optimista: el contenido nuevo se muestra YA, con el mismo parser que el
    // servidor; la confirmación (o la reversión) llega después.
    optimistic = {
      title: draft.title,
      blocks: parseWikiMarkdown(draft.bodyMarkdown, { wikiBasePath: base }),
      tags: draft.tags,
      aliases: draft.aliases
    };
    void applyResult(result, draft.operationId);
  }

  async function dispatchState(input: { status?: 'draft' | 'published'; pinned?: boolean }): Promise<void> {
    if (!view) return;
    busy = true;
    stateOverride = { ...stateOverride, ...input };
    try {
      const envelope = setWikiPageState({ householdId: context.household.id, pageId: view.page.id, ...input });
      await applyResult(await queueCommand(envelope), envelope.operationId);
    } finally {
      busy = false;
    }
  }

  // Reconciliación diferida: cuando un flush posterior (reconexión, otra
  // acción) aplica cambios, se comprueba el destino REAL de la operación que
  // quedó en cola y la nota «guardado en este dispositivo» deja de mentir.
  $effect(() => {
    if ($lastFlushAt === null || !pendingOpId) return;
    const operationId = pendingOpId;
    void (async () => {
      const record = (await listOutbox(context.household.id)).find((candidate) => candidate.id === operationId);
      if (pendingOpId !== operationId) return;
      if (!record) {
        pendingOpId = null;
        feedback.set({ tone: 'success', text: 'Cambio sincronizado.' });
        await settleWithServer();
      } else if (record.status === 'rejected') {
        revertOptimistic(record.lastErrorCode, 'No se pudo guardar');
      } else if (record.status === 'conflict') {
        revertOptimistic(record.lastErrorCode, 'Conflicto con otro cambio');
      }
    })();
  });
</script>

<svelte:head>
  <title>{shownTitle} · Casa Clara</title>
</svelte:head>

<div class="page-wrap">
  {#if view}
    {#snippet actions()}
      {#if view.canWrite && !Editor}
        <button class="button secondary" type="button" onclick={() => void beginEditing()}>Editar</button>
      {/if}
      {#if view.canPublish}
        {#if shownStatus === 'draft'}
          <button class="button primary" type="button" disabled={busy} onclick={() => void dispatchState({ status: 'published' })}>Publicar</button>
        {/if}
        <button class="button secondary" type="button" disabled={busy} onclick={() => void dispatchState({ pinned: !shownPinned })}>
          {shownPinned ? 'Quitar de destacados' : 'Destacar'}
        </button>
      {/if}
    {/snippet}
    <PageHeader eyebrow={view.page.spaceName} title={shownTitle} description={optimistic ? undefined : view.revision.summary} {actions} />

    <p class="audit-note wiki-meta">
      <a href={base}>← Guía de la casa</a>
      · Actualizada el {view.page.updatedLabel}{lastAuthor ? ` por ${lastAuthor}` : ''}
      {#if shownStatus === 'draft'}· <span class="status-chip warning">Guardada sin publicar</span>{/if}
      {#if shownPinned}· <span class="status-chip success">Destacada</span>{/if}
    </p>

    <ActionStatus status={feedback} />

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
          onSaved={onEditorSaved}
        />
      {:else}
        <WikiMarkdown blocks={shownBlocks} />
        {#if shownTags.length || shownAliases.length}
          <footer class="wiki-terms">
            {#each shownTags as tag}<span class="status-chip">{tag}</span>{/each}
            {#each shownAliases as alias}<span class="status-chip quiet">{alias}</span>{/each}
          </footer>
        {/if}
      {/if}
    </article>

    <details class="card wiki-history">
      <summary>Cambios anteriores ({view.revisions.length})</summary>
      <ul class="wiki-revisions">
        {#each view.revisions as revision (revision.id)}
          <li>
            <strong>Versión {revision.number}</strong>
            <span>{revision.author} · {revision.createdLabel}</span>
            {#if revision.summary}<small>{revision.summary}</small>{/if}
          </li>
        {/each}
      </ul>
      {#if view.diff}
        <h3>Qué cambió de la versión {view.diffAgainst} a la {view.revision.number}</h3>
        <pre class="wiki-diff">{#each view.diff as line}<span
            class={line.type}>{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '} {line.text}
</span>{/each}</pre>
      {:else}
        <p class="audit-note">Esta nota no tiene cambios anteriores.</p>
      {/if}
    </details>
  {:else if data.fixture}
    <PageHeader eyebrow={data.fixture.space} title={data.fixture.title} description={data.fixture.summary} />
    <p class="audit-note wiki-meta"><a href={base}>← Guía de la casa</a> · contenido ficticio</p>
    <article class="card wiki-article">
      <WikiMarkdown blocks={data.blocks} />
      <footer>Actualizado {data.fixture.updated.toLocaleLowerCase('es')} · contenido ficticio</footer>
    </article>
  {/if}
</div>
