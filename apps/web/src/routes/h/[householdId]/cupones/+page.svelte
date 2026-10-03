<script lang="ts">
  import { tick } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import CouponCreate from '$lib/components/coupons/CouponCreate.svelte';
  import CouponDetailSheet from '$lib/components/coupons/CouponDetailSheet.svelte';
  import CouponNotes from '$lib/components/coupons/CouponNotes.svelte';
  import CouponRow from '$lib/components/coupons/CouponRow.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { CouponBucket, CouponView } from '$lib/coupons/types';
  import {
    BUCKETS,
    BUCKET_LABEL,
    bucketFromParam,
    countByBucket,
    effectiveCoupons,
    elsewhereHint,
    headerTitle,
    matchesQuery,
    merchantsFrom,
    paramForBucket,
    visibleCoupons
  } from '$lib/coupons/view';
  import { CouponWallet } from '$lib/coupons/wallet.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  /*
   * La cartera de cupones de la familia (spec de cupones §8.2).
   *
   * El servidor manda la cartera ENTERA y aquí se reparte: el filtro (`?ver=`),
   * la búsqueda y la ficha (`?cupon=`) no vuelven a pedir nada. Lo hecho en
   * esta pantalla se superpone a lo recibido hasta que el acuse trae los datos
   * frescos (`CouponWallet`), con el cubo de cada cupón decidido por el mismo
   * dominio que el servidor.
   */
  const wallet = new CouponWallet(context.household.id);
  $effect(() => wallet.start());

  const live = $derived(data.live);
  const today = $derived(data.coupons.today);
  const coupons = $derived(effectiveCoupons(data.coupons.coupons, wallet.overlay, today));
  // Los comercios del servidor más los de las altas que aún no han vuelto.
  const merchants = $derived(merchantsFrom(coupons));

  const bucket = $derived(bucketFromParam(page.url.searchParams.get('ver')));
  let query = $state('');
  // Con búsqueda, cada filtro cuenta lo que coincide: así se ve que lo buscado
  // está en «Usados» sin tener que ir a mirarlo.
  const counts = $derived(countByBucket(coupons.filter((coupon) => matchesQuery(coupon, query))));
  const shown = $derived(visibleCoupons(coupons, bucket, query));

  // Lo buscado que está en OTRO filtro: la pantalla lo dice en vez de un «no hay» seco.
  const elsewhere = $derived(elsewhereHint(BUCKETS.filter((target) => target !== bucket && counts[target] > 0)));

  const openId = $derived(page.url.searchParams.get('cupon'));
  const openCoupon = $derived(openId ? (coupons.find((coupon) => coupon.id === openId) ?? null) : null);

  let creating = $state(false);
  let addButton = $state<HTMLButtonElement | null>(null);

  // Al cerrar el alta (guardada o cancelada) el formulario desaparece con el
  // foco dentro: vuelve al botón que la abrió.
  async function closeCreate(): Promise<void> {
    creating = false;
    await tick();
    addButton?.focus();
  }

  // «Añadir» / «Cerrar». Desde la cartera vacía, el botón que lo abre está en
  // el estado vacío, que se va: el foco caía a `<body>` y va al título del
  // alta (revisión UX, ronda 2, m1). Desde la barra, el botón se queda (pasa
  // a «Cerrar») y el foco con él.
  async function toggleCreate(): Promise<void> {
    creating = !creating;
    if (!creating) return;
    // Otra tarea: el «Uso anulado ✓» de hace un momento ya no viene a cuento,
    // y flotaría encima de los campos del alta. Los errores se quedan.
    wallet.retireNotes(null);
    await tick();
    if (focusLost()) document.getElementById('coupon-create-title')?.focus();
  }

  const BUCKET_SINGULAR: Readonly<Record<CouponBucket, string>> = {
    available: 'disponible',
    used: 'usado',
    expired: 'caducado',
    discarded: 'descartado'
  };

  const EMPTY_BY_BUCKET: Readonly<Record<CouponBucket, { title: string; text: string }>> = {
    available: {
      title: 'No hay cupones disponibles',
      text: 'Los usados, los caducados y los descartados siguen guardados en sus filtros.'
    },
    used: { title: 'No hay cupones usados', text: 'Aquí aparecen los cupones a los que ya no les quedan usos.' },
    expired: {
      title: 'No hay cupones caducados',
      text: 'Aquí aparecen los cupones cuya fecha ya pasó. No se borran: siguen aquí por si acaso.'
    },
    discarded: { title: 'No hay cupones descartados', text: 'Lo que descartes queda aquí y se puede recuperar.' }
  };

  function hrefWith(patch: Record<string, string | null>): string {
    const params = new URLSearchParams(page.url.searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const search = params.toString();
    return search ? `?${search}` : page.url.pathname;
  }

  const filterHref = (target: CouponBucket) => hrefWith({ ver: target === 'available' ? null : paramForBucket(target), cupon: null });

  function chooseFilter(event: MouseEvent, target: CouponBucket): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void goto(filterHref(target), { noScroll: true, keepFocus: true });
  }

  /*
   * La ficha va en la URL (`?cupon=<id>`): el aviso de Hoy enlaza directo a
   * ella y el botón «atrás» del móvil la cierra. Abrirla apunta una entrada en
   * el historial marcada como nuestra; cerrarla vuelve atrás si la abrimos
   * aquí, o sustituye la entrada si se llegó con el enlace ya puesto.
   */
  function openDetail(id: string): void {
    void goto(hrefWith({ cupon: id }), {
      noScroll: true,
      keepFocus: true,
      state: { couponSheet: true } as App.PageState
    });
  }

  function closeDetail(): void {
    if ((page.state as { couponSheet?: boolean }).couponSheet) {
      history.back();
      return;
    }
    void goto(hrefWith({ cupon: null }), { replaceState: true, noScroll: true, keepFocus: true });
  }

  /*
   * El foco, cuando se le va el sitio. Al cerrar la ficha, `modalDialog` lo
   * devuelve a quien la abrió; pero si se llegó por enlace (el «Verlo» de Hoy)
   * no hubo botón, y si el cupón cambió de filtro su fila ya no está: el foco
   * caía a `<body>` (revisión UX, m1). Entonces va a la fila del cupón y, si no
   * está en este filtro, al título de la página.
   */
  function focusLost(): boolean {
    const active = document.activeElement;
    return !active || active === document.body || !active.isConnected;
  }

  function rowLink(id: string): HTMLElement | null {
    return (
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a.coupon-open')).find(
        (link) => new URL(link.href).searchParams.get('cupon') === id
      ) ?? null
    );
  }

  function pageTitle(): HTMLElement | null {
    const heading = document.querySelector<HTMLElement>('#main-content h1');
    if (heading) heading.tabIndex = -1;
    return heading;
  }

  function focusCouponOrTitle(id: string): void {
    if (!focusLost()) return;
    (rowLink(id) ?? pageTitle())?.focus();
  }

  /**
   * Un aviso se fue con el foco dentro (se deshizo un uso, se cerró un error,
   * pasó su tiempo): el foco vuelve al «Usar» de su cupón; si no lo tiene, a
   * su fila; si es un error sin cupón con el alta abierta, al alta; y si no,
   * al título.
   */
  function refocusAfterNote(couponId: string): void {
    const use = couponId ? document.querySelector<HTMLElement>(`[data-coupon-use="${CSS.escape(couponId)}"]`) : null;
    const form = creating ? document.getElementById('coupon-create-title') : null;
    (use ?? (couponId ? rowLink(couponId) : null) ?? form ?? pageTitle())?.focus();
  }

  // Cubre las tres formas de cerrar: «✕», Escape y el «atrás» del móvil.
  afterNavigate(({ from, to }) => {
    const closed = from?.url.searchParams.get('cupon');
    if (closed && !to?.url.searchParams.get('cupon')) void tick().then(() => focusCouponOrTitle(closed));
  });

  /*
   * «Usar» desde la fila. El de un cupón de un solo uso lo pasa a «Usados» al
   * instante y su fila desaparece con el foco dentro: el foco va entonces al
   * «Deshacer» del aviso, que es lo siguiente que se puede querer hacer.
   */
  async function useFromRow(coupon: CouponView): Promise<void> {
    const pending = wallet.use(coupon, context.user.name);
    await tick();
    if (focusLost()) document.querySelector<HTMLElement>('.coupon-notes .use-note button')?.focus();
    await pending;
  }
</script>

<div class="page-wrap">
  <!-- Sin acción en la cabecera: el título dice el estado en UNA línea (§2.0).
       Con «Añadir» a su lado se partía en dos a 320 y a 390, y a 320 la
       tercera fila de la lista quedaba bajo la barra (A6). «Añadir» vive en la
       barra de la lista, junto a «Buscar» (revisión UX de la fase 2, m3/I2). -->
  <PageHeader eyebrow="Cartera de la familia" title={headerTitle(countByBucket(coupons).available)} />

  {#snippet addToggle(label: string, hidden: string)}
    <!-- Con el formulario abierto deja de ser primario y solo lo pliega: la
         primaria es «Guardar el cupón» (sistema móvil §2.5). -->
    <button
      class="button small-button coupon-add {creating ? 'secondary' : 'primary'}"
      type="button"
      aria-expanded={creating}
      aria-controls="coupon-create"
      bind:this={addButton}
      onclick={() => void toggleCreate()}
    >
      {creating ? 'Cerrar' : label}<span class="sr-only">{creating ? ' el formulario del cupón' : hidden}</span>
    </button>
  {/snippet}

  {#if coupons.length > 0}
    <nav class="chip-strip" aria-label="Qué cupones ver">
      {#each BUCKETS as target (target)}
        <a
          class="chip"
          class:active={target === bucket}
          href={filterHref(target)}
          aria-current={target === bucket ? 'page' : undefined}
          onclick={(event) => chooseFilter(event, target)}
        >{BUCKET_LABEL[target]} {counts[target]}</a>
      {/each}
    </nav>

    <!-- La barra de la lista: buscar y añadir, en una sola línea de 44 px. -->
    <div class="coupon-toolbar">
      <label class="coupon-search">
        <span>Buscar</span>
        <input type="search" bind:value={query} autocomplete="off" enterkeyhint="search" spellcheck="false" />
      </label>
      {#if live}{@render addToggle('Añadir', ' un cupón')}{/if}
    </div>
  {/if}

  <!-- El alta, en UN solo sitio y montada siempre que se puede escribir. Antes
       se pintaba en dos ramas del `{#if}` de la cartera vacía: al guardar el
       primer cupón la cartera dejaba de estar vacía y Svelte cambiaba de rama,
       así que el formulario que guardaba se desmontaba y salía otro vacío, y
       con un rechazo se perdían lo escrito y la foto (revisión de
       integración, ronda 2, m-1). Plegada, solo se oculta: «Cerrar» no tira
       lo escrito (m9). -->
  {#if live}
    <CouponCreate
      hidden={!creating}
      householdId={context.household.id}
      {merchants}
      {today}
      {wallet}
      createdByName={context.user.name}
      onclose={() => void closeCreate()}
    />
  {/if}

  {#if coupons.length === 0}
    {#if !creating}
      <section class="empty-state">
        <span aria-hidden="true">✂</span>
        <h2>Todavía no hay cupones</h2>
        <p>
          Hazle una foto al vale y apunta dónde sirve y hasta cuándo. En la tienda, ábrelo aquí para
          enseñar el código y apunta el uso con un toque.
        </p>
        {#if live}{@render addToggle('Añadir el primer cupón', '')}{/if}
      </section>
    {/if}
  {:else}
    <section class="card" aria-labelledby="coupons-list-title">
      <h2 id="coupons-list-title" class="sr-only">{BUCKET_LABEL[bucket]}</h2>
      {#if shown.length > 0}
        <ul class="fila-lista coupon-list" data-lista="principal">
          {#each shown as coupon (coupon.id)}
            <CouponRow
              {coupon}
              {today}
              href={hrefWith({ cupon: coupon.id })}
              canUse={live && coupon.bucket === 'available'}
              using={Boolean(wallet.using[coupon.id])}
              onopen={() => openDetail(coupon.id)}
              onuse={() => void useFromRow(coupon)}
            />
          {/each}
        </ul>
      {:else if query.trim()}
        <div class="empty-state">
          <h3>Ningún cupón {BUCKET_SINGULAR[bucket]} coincide con «{query.trim()}»</h3>
          {#if elsewhere}
            <p>{elsewhere}</p>
          {:else}
            <p>Se busca en el comercio, lo que ofrece, el código y las notas de todos los cupones.</p>
          {/if}
        </div>
      {:else}
        <div class="empty-state">
          <h3>{EMPTY_BY_BUCKET[bucket].title}</h3>
          <p>{EMPTY_BY_BUCKET[bucket].text}</p>
        </div>
      {/if}
    </section>
  {/if}

  {#if !live}
    <p class="note info">Cupones de demostración: se pueden mirar, pero aquí no se usan ni se guardan.</p>
  {/if}

  <!-- Los avisos, lo ÚLTIMO de la página: flotan encima de la barra mientras
       se desplaza y no empujan nada (sistema móvil §2.5), y al final dejan a
       la vista la última fila (`CouponNotes`). Con la ficha abierta, los pinta
       la ficha. -->
  {#if !openCoupon}
    <CouponNotes {wallet} placement="page" refocus={refocusAfterNote} />
  {/if}
</div>

{#if openCoupon}
  <CouponDetailSheet
    coupon={openCoupon}
    {today}
    {live}
    {wallet}
    {merchants}
    householdId={context.household.id}
    userName={context.user.name}
    onClose={closeDetail}
  />
{/if}

<style>
  .coupon-list { margin: 0; padding: 0; list-style: none; }
  /* «Buscar», su campo y «Añadir» en una sola línea de 44 px: la lista
     empieza antes. */
  .coupon-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
  }
  .coupon-search {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--space-3);
    color: var(--ink-soft);
    font-size: var(--text-meta);
    font-weight: 700;
  }
  .coupon-search input {
    width: 100%;
    min-width: 0;
    min-height: var(--row-data);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-sm);
    background: var(--surface);
    padding: var(--space-2) var(--space-3);
    color: var(--ink);
    /* ≥16 px efectivos: evita el zoom automático de iOS al enfocar. */
    font-size: 1rem;
  }
</style>
