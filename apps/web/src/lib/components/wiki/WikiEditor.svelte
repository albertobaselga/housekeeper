<script lang="ts">
  import { untrack } from 'svelte';
  import {
    editWikiPage,
    parseTermList,
    queueWikiCommand,
    type QueueOutcome
  } from '$lib/wiki/commands';

  // Editor route-lazy: solo se importa dinámicamente desde la página de wiki.
  // Al guardar construye el envelope `edit` del contrato con baseRevision =
  // la revisión mostrada al abrir el editor, y lo encola offline-first.
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
    onSaved: (outcome: QueueOutcome) => void;
  } = $props();

  let title = $state(untrack(() => initialTitle));
  let body = $state(untrack(() => initialBody));
  let summary = $state('');
  let tags = $state(untrack(() => initialTags.join(', ')));
  let aliases = $state(untrack(() => initialAliases.join(', ')));
  let saving = $state(false);

  async function save(): Promise<void> {
    saving = true;
    try {
      const outcome = await queueWikiCommand(
        editWikiPage({
          householdId,
          pageId,
          baseRevision,
          title,
          bodyMarkdown: body,
          summary,
          tags: parseTermList(tags),
          aliases: parseTermList(aliases)
        })
      );
      onSaved(outcome);
    } finally {
      saving = false;
    }
  }
</script>

<div class="editor-panel">
  <label for="wiki-title">Título</label>
  <input id="wiki-title" type="text" bind:value={title} maxlength="200" />
  <label for="wiki-body">Contenido (Markdown)</label>
  <textarea id="wiki-body" rows="12" bind:value={body}></textarea>
  <label for="wiki-summary">Resumen del cambio</label>
  <input id="wiki-summary" type="text" bind:value={summary} maxlength="500" placeholder="Qué has cambiado y por qué" />
  <label for="wiki-tags">Etiquetas (separadas por comas)</label>
  <input id="wiki-tags" type="text" bind:value={tags} />
  <label for="wiki-aliases">Alias de búsqueda (separados por comas)</label>
  <input id="wiki-aliases" type="text" bind:value={aliases} />
  <p class="audit-note">Editas sobre la revisión {baseRevision}. Si alguien guardó otra más nueva, el servidor pedirá resolverlo a mano.</p>
  <button
    class="button primary"
    type="button"
    disabled={saving || !title.trim() || !body.trim()}
    onclick={() => void save()}
  >{saving ? 'Guardando…' : 'Guardar cambios'}</button>
</div>
