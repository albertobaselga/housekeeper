<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { ActionFeedback } from '$lib/offline/optimistic';

  /*
   * Nota de guardado UNIFICADA (H-04 / P2-5): el texto viene siempre del
   * resultado veraz de queueCommand (o de la reconciliación diferida), con el
   * mismo componente y copy en todas las páginas. Es efímera: éxito y
   * pendiente se autolimpian a los ~4 s o al llegar el siguiente estado; los
   * errores permanecen hasta la próxima acción (no se ocultan solos).
   */
  let { status }: { status: Writable<ActionFeedback | null> } = $props();

  const EPHEMERAL_MS = 4000;

  $effect(() => {
    const current = $status;
    if (!current || current.tone === 'error') return;
    const timer = setTimeout(() => status.set(null), EPHEMERAL_MS);
    return () => clearTimeout(timer);
  });
</script>

{#if $status}
  <p
    class={$status.tone === 'error' ? 'form-error' : $status.tone === 'pending' ? 'queued-note' : 'success-message'}
    role={$status.tone === 'error' ? 'alert' : 'status'}
  >{$status.text}</p>
{/if}
