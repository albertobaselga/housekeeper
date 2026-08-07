<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import type { Editor } from '@milkdown/kit/core';

  // Superficie del editor visual: monta Milkdown (commonmark + listener +
  // history) sobre un div en cliente. El Markdown CANÓNICO vive en el padre:
  // aquí solo se siembra el valor inicial y se notifica cada cambio ya
  // serializado. Los módulos de Milkdown se cargan con import() dinámico para
  // que el chunk del editor de wiki siga siendo ligero y para que un fallo de
  // carga caiga por `onError` al textarea.
  let {
    value,
    onChange,
    onReady,
    onError
  }: {
    value: string;
    onChange: (markdown: string) => void;
    onReady?: () => void;
    onError?: (error: unknown) => void;
  } = $props();

  const initialValue = untrack(() => value);

  let host: HTMLDivElement;
  let editor: Editor | null = null;
  let readMarkdown: (() => string) | null = null;

  /**
   * Markdown canónico serializado ahora mismo (sin esperar al debounce del
   * listener), o null si el editor aún no está montado. El padre lo usa antes
   * de guardar.
   */
  export function currentMarkdown(): string | null {
    try {
      return readMarkdown ? readMarkdown() : null;
    } catch {
      return null;
    }
  }

  onMount(() => {
    if (!browser) return;
    let cancelled = false;

    void (async () => {
      try {
        const [core, commonmarkModule, listenerModule, historyModule, utils] = await Promise.all([
          import('@milkdown/kit/core'),
          import('@milkdown/kit/preset/commonmark'),
          import('@milkdown/kit/plugin/listener'),
          import('@milkdown/kit/plugin/history'),
          import('@milkdown/kit/utils')
        ]);
        if (cancelled) return;
        const created = await core.Editor.make()
          .config((ctx) => {
            ctx.set(core.rootCtx, host);
            ctx.set(core.defaultValueCtx, initialValue);
            ctx.update(core.editorViewOptionsCtx, (previous) => ({
              ...previous,
              attributes: { 'aria-label': 'Contenido (editor visual)' }
            }));
            ctx.get(listenerModule.listenerCtx).markdownUpdated((_ctx, markdown, previous) => {
              if (markdown !== previous) onChange(markdown);
            });
          })
          .use(commonmarkModule.commonmark)
          .use(listenerModule.listener)
          .use(historyModule.history)
          .create();
        if (cancelled) {
          void created.destroy();
          return;
        }
        editor = created;
        readMarkdown = () => created.action(utils.getMarkdown());
        onReady?.();
      } catch (error) {
        if (!cancelled) onError?.(error);
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    const current = editor;
    const flush = readMarkdown;
    editor = null;
    readMarkdown = null;
    if (!current) return;
    // El listener markdownUpdated va con debounce: al desmontar (cambio a la
    // pestaña Markdown) se vuelca el estado final para no perder la última
    // pulsación.
    try {
      if (flush) onChange(flush());
    } catch {
      // Si el editor ya está roto conservamos el último Markdown notificado.
    }
    void current.destroy();
  });
</script>

<div class="milkdown-surface" bind:this={host}></div>
