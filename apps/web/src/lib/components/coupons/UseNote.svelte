<script lang="ts">
  import { tick } from 'svelte';

  import type { CouponWallet } from '$lib/coupons/wallet.svelte';

  /*
   * El acuse de «Usar»: «Uso apuntado ✓ · Deshacer». Va aparte del
   * `ActionStatus` de la página porque lleva un botón y porque dura más: un
   * toque equivocado en la caja se descubre unos segundos después, no en los
   * cuatro de un «Guardado ✓». Un error se queda hasta que se cierra.
   *
   * Lo pinta `CouponNotes`, que lo pone al final de lo que se desplaza y pone
   * también la región viva (siempre presente: una que nace ya con su texto no
   * siempre se anuncia; revisión UX, ronda 2, m2).
   *
   * El foco no se cae, ni se queda atrapado:
   * · mientras está en «Deshacer», el aviso no se va solo (se iría con el foco
   *   dentro);
   * · al tocar «Deshacer», el cupón vuelve y el foco vuelve a SU «Usar». Antes
   *   se quedaba en el aviso, y el aviso, con el foco dentro, no se cerraba
   *   nunca (revisión UX, ronda 2, I1);
   * · si el aviso se va con el foco dentro (se cierra un error, o pasa el
   *   tiempo), quien lo pinta dice adónde va (`refocus`).
   */
  let { wallet, refocus }: { wallet: CouponWallet; refocus: (couponId: string) => void } = $props();

  const EPHEMERAL_MS = 10_000;

  let box = $state<HTMLElement | null>(null);
  let focused = $state(false);

  $effect(() => {
    const note = wallet.useNote;
    if (!note || note.tone === 'error' || (focused && note.undo)) return;
    const timer = setTimeout(() => void leave(), EPHEMERAL_MS);
    return () => clearTimeout(timer);
  });

  /** El aviso se va; si se lleva el foco, el foco vuelve a su cupón. */
  async function leave(): Promise<void> {
    const couponId = wallet.useNote?.couponId ?? '';
    const hadFocus = box?.contains(document.activeElement) ?? false;
    wallet.dismissUseNote();
    if (!hadFocus) return;
    await tick();
    refocus(couponId);
  }

  async function undo(): Promise<void> {
    const couponId = wallet.useNote?.couponId ?? '';
    // El uso se anula en pantalla al instante (antes del acuse): tras pintar,
    // el «Usar» del cupón ya está ahí para recibir el foco.
    const pending = wallet.undoLastUse();
    await tick();
    refocus(couponId);
    await pending;
  }
</script>

{#if wallet.useNote}
  {@const note = wallet.useNote}
  <div
    class="note use-note {note.tone}"
    tabindex="-1"
    bind:this={box}
    onfocusin={() => (focused = true)}
    onfocusout={(event) => {
      if (!box?.contains(event.relatedTarget as Node | null)) focused = false;
    }}
  >
    <p>{note.text}</p>
    {#if note.undo}
      <button
        class="button secondary small-button"
        type="button"
        aria-label={note.merchant ? `Deshacer el uso de ${note.merchant}` : undefined}
        onclick={() => void undo()}
      >Deshacer</button>
    {:else if note.tone === 'error'}
      <button class="button secondary small-button" type="button" onclick={() => void leave()}>
        Cerrar<span class="sr-only"> el aviso</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  .use-note { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-3); }
  /* El texto, del tono del aviso (verde, ámbar o rojo), y no el gris de
     cualquier `p` (revisión UX, ronda 2, m3). */
  .use-note > p { min-width: 0; color: inherit; overflow-wrap: anywhere; }
  .use-note:focus { outline: none; }
  .use-note:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
