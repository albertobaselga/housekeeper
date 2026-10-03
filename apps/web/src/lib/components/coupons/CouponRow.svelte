<script lang="ts">
  import type { CouponView } from '$lib/coupons/types';
  import { rowDetail } from '$lib/coupons/view';

  /*
   * Una fila de la cartera. La fila ENTERA abre la ficha (el enlace se estira
   * sobre ella con un `::after`) y al final hay un solo verbo, «Usar», y solo
   * en los disponibles: es lo que se hace en la caja. El enlace lleva su
   * `?cupon=` de verdad, así que sin JavaScript también abre la ficha.
   *
   * «Caduca pronto» va DENTRO del enlace, delante de la línea de apoyo, y no
   * al final de la fila: compartiendo el final con «Usar», el nombre se
   * quedaba en ~110 px a 320 y se partía en cuatro o cinco líneas (solo
   * cabían dos cupones en la primera pantalla), y el chip tapaba el enlace
   * estirado, así que tocarlo no abría la ficha (revisión UX de la fase 2, I2
   * y m6). Al final de la fila, una sola acción (sistema móvil §2.5).
   */
  let {
    coupon,
    today,
    href,
    canUse,
    using = false,
    onopen,
    onuse
  }: {
    coupon: CouponView;
    today: string;
    href: string;
    canUse: boolean;
    /** Guardia de doble toque: el uso de este cupón va de camino. */
    using?: boolean;
    onopen: () => void;
    onuse: () => void;
  } = $props();

  function open(event: MouseEvent): void {
    // Abrir en otra pestaña (o con el teclado modificado) sigue siendo un enlace normal.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onopen();
  }
</script>

<li class="fila-accion coupon-row">
  <a class="coupon-open" {href} onclick={open}>
    <strong>{coupon.merchant} · {coupon.offer}</strong>
    <!-- Detrás del chip, la línea sigue la frase: «Caduca pronto el lun 5 oct»,
         con su espacio, y no «Caduca prontoCaduca el…» (revisión UX, ronda 2, m6). -->
    <small>{#if coupon.expiresSoon}<span class="status-chip warning coupon-soon">Caduca pronto</span>{' '}{/if}{rowDetail(
        coupon,
        today
      )}</small>
  </a>
  {#if canUse}
    <span class="fila-fin">
      <!-- `aria-disabled` y no `disabled` durante la guardia de doble toque: un
           botón desactivado pierde el foco y el teclado caería a `<body>`. El
           segundo toque lo ignora la cartera. -->
      <button
        class="button secondary small-button"
        type="button"
        aria-disabled={using || undefined}
        aria-label={`Usar el cupón de ${coupon.merchant}: ${coupon.offer}`}
        data-coupon-use={coupon.id}
        onclick={() => {
          if (!using) onuse();
        }}
      >Usar</button>
    </span>
  {/if}
</li>

<style>
  .coupon-row { position: relative; }
  .coupon-open {
    display: grid;
    align-content: center;
    min-width: 0;
    /* 44 px de diana aunque la fila sea de una línea (A3). */
    min-height: var(--row-data);
    color: inherit;
    text-decoration: none;
  }
  /* El enlace se estira sobre la fila entera: tocar en cualquier hueco abre la ficha. */
  .coupon-open::after { content: ''; position: absolute; inset: 0; }
  .coupon-open:hover strong { color: var(--primary); }
  .coupon-open strong { overflow-wrap: anywhere; }
  .coupon-open small { color: var(--ink-soft); font-size: var(--text-meta); }
  /* En la línea de apoyo, sin el relleno vertical del chip: no alarga la fila. */
  .coupon-soon { padding-block: 0; }
  /* «Usar» queda por encima del enlace estirado. */
  .coupon-row .fila-fin { position: relative; z-index: 1; }
</style>
