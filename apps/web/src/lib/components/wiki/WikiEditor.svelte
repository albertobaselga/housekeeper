<script lang="ts">
  import { untrack } from 'svelte';
  import { editWikiPage, parseTermList } from '$lib/wiki/commands';
  import { queueCommand, type QueueCommandResult } from '$lib/offline/queue-command';
  import MilkdownSurface from './MilkdownSurface.svelte';

  // Editor route-lazy: solo se importa dinámicamente desde la página de la
  // guía. El Markdown canónico vive en `body`; hay UN solo editor visible (el
  // visual de Milkdown) y el texto sin formato (Markdown) queda escondido en
  // «Opciones avanzadas». Al guardar construye el envelope `edit` del contrato
  // con baseRevision = la revisión mostrada al abrir el editor, y lo encola
  // offline-first.
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

  // Por defecto el editor visual; si Milkdown no consigue montar (sin red
  // para el chunk, navegador raro…) cae automáticamente al texto plano con un
  // aviso discreto. «Escribir en Markdown» vive en Opciones avanzadas.
  let markdownMode = $state(false);
  let visualFailed = $state(false);
  let surface = $state<{ currentMarkdown: () => string | null } | null>(null);

  function flushBody(): void {
    // El listener de Milkdown va con debounce: se vuelca el estado actual
    // del editor visual antes de cambiar de modo o guardar.
    const flushed = surface?.currentMarkdown();
    if (typeof flushed === 'string') body = flushed;
  }

  function toggleMarkdownMode(): void {
    if (!markdownMode) flushBody();
    markdownMode = !markdownMode;
  }

  function onVisualError(): void {
    visualFailed = true;
    markdownMode = true;
  }

  async function save(): Promise<void> {
    saving = true;
    try {
      flushBody();
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

  <span class="editor-content-label" id="wiki-content-label">El texto</span>
  <div class="editor-body">
    {#if visualFailed}
      <p class="audit-note" role="status">El editor con formato no ha podido cargarse; puedes seguir escribiendo el texto igualmente.</p>
    {/if}
    {#if markdownMode || visualFailed}
      <label class="sr-only" for="wiki-body">El texto</label>
      <textarea id="wiki-body" rows="12" bind:value={body}></textarea>
    {:else}
      <MilkdownSurface bind:this={surface} value={body} onChange={(markdown) => (body = markdown)} onError={onVisualError} />
    {/if}
  </div>

  <details class="wiki-advanced">
    <summary>Opciones avanzadas</summary>
    <div class="stack">
      <label for="wiki-summary">Qué has cambiado (opcional)</label>
      <input id="wiki-summary" type="text" autocomplete="off" enterkeyhint="next" bind:value={summary} maxlength="500" placeholder="p. ej. Añadido el programa de toallas" />
      <label for="wiki-tags">Palabras para encontrarla (separadas por comas)</label>
      <input id="wiki-tags" type="text" autocomplete="off" enterkeyhint="next" bind:value={tags} />
      <label for="wiki-aliases">Otros nombres con los que buscarla (separados por comas)</label>
      <input id="wiki-aliases" type="text" autocomplete="off" enterkeyhint="done" bind:value={aliases} />
      {#if !visualFailed}
        <button class="text-button" type="button" onclick={toggleMarkdownMode}>
          {markdownMode ? 'Volver al editor con formato' : 'Escribir en Markdown'}
        </button>
      {/if}
    </div>
  </details>

  <button
    class="button primary"
    type="button"
    disabled={saving || !title.trim() || !body.trim()}
    onclick={() => void save()}
  >{saving ? 'Guardando…' : 'Guardar cambios'}</button>
</div>
