<script lang="ts">
  import { untrack } from 'svelte';
  import { editWikiPage, parseTermList } from '$lib/wiki/commands';
  import { queueCommand, type QueueCommandResult } from '$lib/offline/queue-command';
  import { nextEditorTab, type EditorTab } from '$lib/wiki/editor-tabs';
  import MilkdownSurface from './MilkdownSurface.svelte';

  // Editor route-lazy: solo se importa dinámicamente desde la página de wiki.
  // El Markdown canónico vive en `body`; la pestaña Visual (Milkdown) y la
  // pestaña Markdown (textarea) editan ese MISMO estado. Al guardar construye
  // el envelope `edit` del contrato con baseRevision = la revisión mostrada al
  // abrir el editor, y lo encola offline-first.
  let {
    householdId,
    pageId,
    baseRevision,
    initialTitle,
    initialBody,
    initialTags = [],
    initialAliases = [],
    onSaved
  }: {
    householdId: string;
    pageId: string;
    baseRevision: number;
    initialTitle: string;
    initialBody: string;
    initialTags?: string[];
    initialAliases?: string[];
    /**
     * Resultado VERAZ del encolado unificado más el borrador tal cual se
     * envió: la página lo usa para pintar el contenido nuevo al instante
     * (edición optimista) y reconciliarlo con el ACK del servidor.
     */
    onSaved: (
      result: QueueCommandResult,
      draft: {
        operationId: string;
        title: string;
        bodyMarkdown: string;
        tags: string[];
        aliases: string[];
      }
    ) => void;
  } = $props();

  let title = $state(untrack(() => initialTitle));
  let body = $state(untrack(() => initialBody));
  let summary = $state('');
  let tags = $state(untrack(() => initialTags.join(', ')));
  let aliases = $state(untrack(() => initialAliases.join(', ')));
  let saving = $state(false);

  // Por defecto la pestaña Visual; si Milkdown no consigue montar (sin red
  // para el chunk, navegador raro…) cae automáticamente al textarea y la
  // pestaña Visual desaparece con un aviso discreto.
  let tab = $state<EditorTab>('visual');
  let visualFailed = $state(false);
  let tablist = $state<HTMLDivElement | null>(null);
  let surface = $state<{ currentMarkdown: () => string | null } | null>(null);

  function selectTab(next: EditorTab): void {
    tab = next;
  }

  function onVisualError(): void {
    visualFailed = true;
    tab = 'markdown';
  }

  function onTablistKeydown(event: KeyboardEvent): void {
    const next = nextEditorTab(tab, event.key, !visualFailed);
    if (!next || next === tab) return;
    event.preventDefault();
    tab = next;
    tablist?.querySelector<HTMLButtonElement>(`#wiki-tab-${next}`)?.focus();
  }

  async function save(): Promise<void> {
    saving = true;
    try {
      // El listener de Milkdown va con debounce: se vuelca el estado actual
      // del editor visual antes de construir el envelope.
      const flushed = surface?.currentMarkdown();
      if (typeof flushed === 'string') body = flushed;
      const envelope = editWikiPage({
        householdId,
        pageId,
        baseRevision,
        title,
        bodyMarkdown: body,
        summary,
        tags: parseTermList(tags),
        aliases: parseTermList(aliases)
      });
      const result = await queueCommand(envelope);
      onSaved(result, {
        operationId: envelope.operationId,
        title,
        bodyMarkdown: body,
        tags: parseTermList(tags),
        aliases: parseTermList(aliases)
      });
    } finally {
      saving = false;
    }
  }
</script>

<div class="editor-panel">
  <label for="wiki-title">Título</label>
  <input id="wiki-title" type="text" autocomplete="off" enterkeyhint="next" bind:value={title} maxlength="200" />

  <span class="editor-content-label" id="wiki-content-label" aria-hidden="true">Contenido</span>
  <div class="editor-body">
    <div class="editor-tabs" role="tablist" aria-label="Modo de edición del contenido" bind:this={tablist}>
      {#if !visualFailed}
        <button
          id="wiki-tab-visual"
          role="tab"
          type="button"
          aria-selected={tab === 'visual'}
          aria-controls="wiki-panel-visual"
          tabindex={tab === 'visual' ? 0 : -1}
          onclick={() => selectTab('visual')}
          onkeydown={onTablistKeydown}
        >Visual</button>
      {/if}
      <button
        id="wiki-tab-markdown"
        role="tab"
        type="button"
        aria-selected={tab === 'markdown'}
        aria-controls="wiki-panel-markdown"
        tabindex={tab === 'markdown' ? 0 : -1}
        onclick={() => selectTab('markdown')}
        onkeydown={onTablistKeydown}
      >Markdown</button>
    </div>

    {#if visualFailed}
      <p class="audit-note" role="status">El editor visual no ha podido cargarse; puedes seguir editando en Markdown.</p>
    {/if}

    {#if tab === 'visual' && !visualFailed}
      <div id="wiki-panel-visual" role="tabpanel" aria-labelledby="wiki-tab-visual">
        <MilkdownSurface bind:this={surface} value={body} onChange={(markdown) => (body = markdown)} onError={onVisualError} />
      </div>
    {:else}
      <div id="wiki-panel-markdown" role="tabpanel" aria-labelledby="wiki-tab-markdown">
        <label class="sr-only" for="wiki-body">Contenido (Markdown)</label>
        <textarea id="wiki-body" rows="12" bind:value={body}></textarea>
      </div>
    {/if}
  </div>

  <label for="wiki-summary">Resumen del cambio</label>
  <input id="wiki-summary" type="text" autocomplete="off" enterkeyhint="next" bind:value={summary} maxlength="500" placeholder="Qué has cambiado y por qué" />
  <label for="wiki-tags">Etiquetas (separadas por comas)</label>
  <input id="wiki-tags" type="text" autocomplete="off" enterkeyhint="next" bind:value={tags} />
  <label for="wiki-aliases">Alias de búsqueda (separados por comas)</label>
  <input id="wiki-aliases" type="text" autocomplete="off" enterkeyhint="done" bind:value={aliases} />
  <p class="audit-note">Editas sobre la revisión {baseRevision}. Si alguien guardó otra más nueva, el servidor pedirá resolverlo a mano.</p>
  <button
    class="button primary"
    type="button"
    disabled={saving || !title.trim() || !body.trim()}
    onclick={() => void save()}
  >{saving ? 'Guardando…' : 'Guardar cambios'}</button>
</div>
