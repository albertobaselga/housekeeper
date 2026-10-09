<script lang="ts">
  import { tick } from 'svelte';

  import type { CouponWallet } from '$lib/coupons/wallet.svelte';
  import type { ActionFeedback } from '$lib/offline/optimistic';
  import UseNote from './UseNote.svelte';

  /*
   * Los avisos de la cartera: el de guardar (`wallet.actions.status`) y el de
   * «Usar» (`UseNote`), juntos, en la página y en la ficha.
   *
   * Van como ÚLTIMO hijo de lo que se desplaza (la página o la hoja) y con
   * `position: sticky`, no `fixed`. Mientras se desplaza, flotan pegados abajo
   * (encima de la barra en la página, al pie en la hoja) y no empujan nada,
   * como pedía el sistema móvil (§2.5). Al llegar al final, en cambio, ocupan
   * su sitio DEBAJO de lo último, y lo último se puede tocar. Fijos, sin hueco
   * reservado, tapaban «Descartar», «Guardar los cambios», «Cancelar» y la
   * última fila; con un error, sin fin (revisión UX, ronda 2, I1). Así el
   * hueco del acuse se reserva solo y la nota queda en la columna del
   * contenido también en escritorio (m9).
   *
   * El contenedor es la región viva, y está SIEMPRE: una que nace ya con su
   * texto no siempre se anuncia (m2). Educada (`status`) y no atómica: se lee
   * lo que cambia, no todo el bloque otra vez. Los errores llevan «Cerrar».
   *
   * El aviso de guardar es el de `ActionStatus` (mismas cajas, mismos 4 s, los
   * errores se quedan), pero pintado aquí: aquí no lleva región propia (la
   * pone el contenedor) y su error se cierra. No se añade esa variante a
   * `ActionStatus` porque Hoy lo carga de entrada, y Hoy no tiene bytes de
   * sobra (`verify:bundle`).
   */
  let {
    wallet,
    placement,
    refocus
  }: {
    wallet: CouponWallet;
    placement: 'page' | 'sheet';
    /** Adónde va el foco si un aviso se va con él dentro (el id del cupón, o '' si no hay). */
    refocus: (couponId: string) => void;
  } = $props();

  const EPHEMERAL_MS = 4000;

  let box = $state<HTMLElement | null>(null);
  let feedback = $state<ActionFeedback | null>(null);

  $effect(() => wallet.actions.status.subscribe((value) => (feedback = value)));

  $effect(() => {
    const current = feedback;
    if (!current || current.tone === 'error') return;
    const timer = setTimeout(() => wallet.actions.dismiss(), EPHEMERAL_MS);
    return () => clearTimeout(timer);
  });

  async function dismissStatus(): Promise<void> {
    const hadFocus = box?.contains(document.activeElement) ?? false;
    wallet.actions.dismiss();
    if (!hadFocus) return;
    await tick();
    refocus('');
  }
</script>

<div class="coupon-notes {placement}" role="status" aria-atomic="false" bind:this={box}>
  {#if feedback?.tone === 'error'}
    <div class="form-error coupon-note-closable">
      <p>{feedback.text}</p>
      <button class="button secondary small-button" type="button" onclick={() => void dismissStatus()}>
        Cerrar<span class="sr-only"> el aviso</span>
      </button>
    </div>
  {:else if feedback}
    <p class={feedback.tone === 'pending' ? 'queued-note' : 'success-message'}>{feedback.text}</p>
  {/if}
  <UseNote {wallet} {refocus} />
</div>

<style>
  .coupon-notes {
    position: sticky;
    /* Por encima de lo que se desplaza debajo (el «Usar» de cada fila va con
       `z-index: 1` sobre su enlace estirado). */
    z-index: 3;
    display: grid;
    gap: var(--space-2);
    /* El hueco entre avisos no tapa nada: solo los avisos reciben toques. */
    pointer-events: none;
  }
  .coupon-notes > :global(*) { pointer-events: auto; box-shadow: var(--shadow-over); }
  .coupon-notes > :is(.form-error, .success-message, .queued-note) { margin: 0; }
  .coupon-note-closable {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-3);
  }
  /* El texto, del tono del aviso, y no el gris de cualquier `p`. */
  .coupon-note-closable > p { min-width: 0; color: inherit; overflow-wrap: anywhere; }

  /* En la página: encima de la barra inferior y en la columna del contenido. */
  .coupon-notes.page {
    bottom: calc(var(--bottom-nav-h) + var(--space-3));
    justify-self: center;
    width: min(100%, 28rem);
  }

  /* En la hoja: al pie, con la zona segura del móvil. Su relleno es el final
     de la hoja, que ya no lleva uno propio abajo. */
  .coupon-notes.sheet {
    bottom: 0;
    padding-block: var(--space-3) calc(var(--space-3) + env(safe-area-inset-bottom));
  }
</style>
