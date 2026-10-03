<script lang="ts">
  import { tick, untrack } from 'svelte';

  import { modalDialog } from '$lib/components/modal-dialog';
  import { checkCouponDraft, draftFromCoupon, type CouponDraft } from '$lib/coupons/draft';
  import { photoChangeHold, type PhotoPhase } from '$lib/coupons/photo';
  import type { CouponView } from '$lib/coupons/types';
  import { expiryLabel, madridToday, shortDate, useLine, usesLabel } from '$lib/coupons/view';
  import type { CouponPhotoChange, CouponWallet } from '$lib/coupons/wallet.svelte';
  import CouponFields from './CouponFields.svelte';
  import CouponNotes from './CouponNotes.svelte';
  import CouponPhotoField from './CouponPhotoField.svelte';

  /*
   * La ficha de un cupón, en hoja (`?cupon=<id>`), como el detalle de Finanzas.
   * Es lo que se abre en la puerta del súper: arriba, el CÓDIGO en grande con
   * «Copiar» y, justo debajo, «Usar» —tras usarlo, un toque lo apunta, sin
   * buscar el botón bajo la foto—; luego la foto (un toque la pone a pantalla
   * completa para el lector de la caja), los datos, los usos con «Anular este
   * uso» y, tras el divisor, «Descartar» o «Recuperar».
   *
   * Los avisos (el «Uso apuntado ✓ · Deshacer» y los de guardar) van al pie
   * de la hoja, pegados abajo mientras se desplaza (`CouponNotes`): aparecer
   * arriba empujaba el código y el «Usar» que el dedo acababa de tocar
   * (sistema móvil §2.5), y fijos tapaban lo último de la hoja.
   *
   * La foto viene de la ruta con sesión y no se guarda en el móvil: sin red no
   * se ve, y la ficha lo dice en vez de enseñar un icono roto. El código y los
   * datos sí están, que es lo que hace falta en la caja.
   */
  let {
    coupon,
    today,
    live,
    wallet,
    merchants,
    householdId,
    userName,
    onClose
  }: {
    coupon: CouponView;
    today: string;
    /** false en la demostración: la ficha se lee, pero no se escribe. */
    live: boolean;
    wallet: CouponWallet;
    merchants: readonly string[];
    householdId: string;
    /** Nombre de quien mira, para el uso que se pinta antes del acuse. */
    userName: string;
    onClose: () => void;
  } = $props();

  const STATE_CHIP: Readonly<Record<CouponView['bucket'], string | null>> = {
    available: null,
    used: 'Usado',
    expired: 'Caducado',
    discarded: 'Descartado'
  };

  let sheet = $state<HTMLElement | null>(null);
  let copied = $state(false);
  let copyFallback = $state(false);
  let photoFailed = $state(false);
  let fullPhoto = $state(false);

  let editing = $state(false);
  let draft = $state<CouponDraft | null>(null);
  let newPhoto = $state<CouponPhotoChange | null>(null);
  let changingPhoto = $state(false);
  let photoPhase = $state<PhotoPhase>('empty');
  let problem = $state<string | null>(null);
  let problemField = $state<keyof CouponDraft | null>(null);
  let saving = $state(false);
  /** El uso cuya anulación espera el «Sí»: anular no tiene vuelta atrás (55000). */
  let armedVoid = $state<string | null>(null);

  const chip = $derived(STATE_CHIP[coupon.bucket]);
  // «Usar» es LA acción solo de un cupón disponible. En uno usado o caducado
  // se puede (D-usos: se registra, no se controla), pero no invita: tras el
  // primer toque, uno de un solo uso pasa a «Usado» y un segundo toque
  // apuntaría otro uso (revisión UX, ronda 2, m5).
  const useWeight = $derived(coupon.bucket === 'available' ? 'primary' : 'secondary');

  /*
   * Los avisos de ESTE cupón. Al abrir otro, los de éxito que hablan de otro
   * cupón se retiran; al cerrar la ficha, todos los de éxito. Si no, la ficha
   * de la panadería decía «Uso anulado ✓ · Droguería Sol» (revisión UX, ronda
   * 2, m8). `untrack`: el efecto sigue al cupón, no a los avisos.
   */
  $effect(() => {
    const id = coupon.id;
    untrack(() => wallet.retireNotes(id));
  });
  $effect(() => () => wallet.retireNotes(null));

  /** Un aviso se fue con el foco dentro: a «Usar» si está, si no a la hoja. */
  function refocusInSheet(): void {
    const target = sheet?.querySelector<HTMLElement>('.coupon-use');
    if (target) target.focus();
    else sheet?.focus();
  }
  const createdOn = $derived(shortDate(madridToday(new Date(coupon.createdAt)), today));
  const photoBusy = $derived(photoChangeHold(changingPhoto, photoPhase) === 'busy');

  // Solo cuando cambia la DIRECCIÓN de la foto (otra foto, o la de la ruta tras
  // la vista previa de un cambio) se vuelve a intentar. Un `$derived` no avisa
  // si el valor es el mismo: sin él, cada recarga de datos tras una acción
  // volvía a pedir una foto que ya había fallado.
  const photoUrl = $derived(coupon.photoUrl);
  $effect(() => {
    void photoUrl;
    photoFailed = false;
  });

  /*
   * El fallo de la foto se escucha desde aquí, ni con `onerror` ni con una
   * acción `use:`: con cualquiera de los dos Svelte pinta en el HTML del
   * servidor un `onerror="this.__e=event"` en línea (para no perder el evento
   * antes de hidratar), y la CSP de la casa, sin `unsafe-inline`, lo bloquea.
   * Si la foto ya había fallado al hidratar, `complete` sin tamaño lo delata.
   */
  let photoImage = $state<HTMLImageElement | null>(null);
  $effect(() => {
    const node = photoImage;
    if (!node) return;
    const fail = () => (photoFailed = true);
    if (node.complete && node.naturalWidth === 0) fail();
    node.addEventListener('error', fail);
    return () => node.removeEventListener('error', fail);
  });

  /*
   * El foco no puede caerse de la hoja. Anular un uso quita su fila, guardar la
   * edición quita el formulario: el botón que tenía el foco desaparece y el
   * navegador lo manda a `<body>`, FUERA del diálogo, donde ni Escape ni el
   * ciclo de Tab de `modalDialog` lo alcanzan. Tras cada acción que puede
   * hacerlo, el foco vuelve a un sitio con sentido dentro de la hoja.
   */
  async function keepFocus(selector: string): Promise<void> {
    await tick();
    if (!sheet || sheet.contains(document.activeElement)) return;
    const target = sheet.querySelector<HTMLElement>(selector);
    if (target) target.focus();
    else sheet.focus();
  }

  /*
   * Anular un uso NO se deshace: la base no desanula (55000), y volver a «Usar»
   * apuntaría HOY y a nombre de quien toca, perdiendo la fecha y el autor de
   * lo que se apuntó. Por eso pide un segundo toque, como archivar en el Menú.
   */
  async function armVoid(useId: string): Promise<void> {
    armedVoid = useId;
    await tick();
    sheet?.querySelector<HTMLElement>('.coupon-void-confirm')?.focus();
  }

  async function disarmVoid(useId: string): Promise<void> {
    armedVoid = null;
    await tick();
    sheet?.querySelector<HTMLElement>(`[data-void="${useId}"]`)?.focus();
  }

  function voidUse(useId: string): void {
    armedVoid = null;
    void wallet.voidUse(coupon, useId);
    void keepFocus('#coupon-uses-title');
  }

  function toggleDiscarded(): void {
    void (coupon.bucket === 'discarded' ? wallet.restore(coupon) : wallet.discard(coupon));
    void keepFocus('.coupon-discard');
  }

  async function copyCode(): Promise<void> {
    if (!coupon.code) return;
    try {
      await navigator.clipboard.writeText(coupon.code);
      copied = true;
      copyFallback = false;
      setTimeout(() => (copied = false), 2500);
    } catch {
      // Sin portapapeles (navegador antiguo o sin permiso): se selecciona el
      // código para copiarlo a mano.
      copyFallback = true;
      const value = sheet?.querySelector('.coupon-code-value');
      if (value) window.getSelection()?.selectAllChildren(value);
    }
  }

  async function startEdit(): Promise<void> {
    draft = draftFromCoupon(coupon);
    newPhoto = null;
    changingPhoto = false;
    photoPhase = 'empty';
    problem = null;
    problemField = null;
    editing = true;
    await tick();
    sheet?.querySelector<HTMLElement>('.coupon-edit input')?.focus();
  }

  function cancelEdit(): void {
    editing = false;
    draft = null;
    newPhoto = null;
    changingPhoto = false;
    photoPhase = 'empty';
    void keepFocus('.coupon-edit-open');
  }

  /** «Dejar la foto de antes»: se renuncia al cambio de foto, no a la edición. */
  async function keepOldPhoto(): Promise<void> {
    changingPhoto = false;
    newPhoto = null;
    photoPhase = 'empty';
    if (problemField === null) problem = null;
    await tick();
    sheet?.querySelector<HTMLElement>('.coupon-photo-change')?.focus();
  }

  async function saveEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!draft || saving) return;
    const hold = photoChangeHold(changingPhoto, photoPhase);
    if (hold === 'busy') return;
    if (hold === 'failed') {
      // Guardar sin la foto cerraría la ficha con «Guardado ✓» y la foto vieja,
      // cuando se pidió cambiarla: se dice, y se deja elegir.
      problem = 'La foto nueva no se ha guardado. Vuelve a intentarlo o deja la de antes.';
      problemField = null;
      await tick();
      sheet?.querySelector<HTMLElement>('.coupon-edit .form-error')?.focus();
      return;
    }
    const check = checkCouponDraft(draft);
    if (!check.ok) {
      problem = check.message;
      problemField = check.field;
      await tick();
      sheet?.querySelector<HTMLElement>('.coupon-edit [aria-invalid="true"]')?.focus();
      return;
    }
    saving = true;
    try {
      const outcome = await wallet.update(coupon, check.fields, newPhoto);
      if (outcome === 'synced' || outcome === 'queued') cancelEdit();
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="sheet-backdrop" onclick={onClose}></div>
<div
  class="coupon-sheet"
  role="dialog"
  aria-modal="true"
  aria-labelledby="coupon-sheet-title"
  tabindex="-1"
  bind:this={sheet}
  use:modalDialog={{ onClose }}
>
  <header class="coupon-sheet-head">
    <div>
      <h2 id="coupon-sheet-title">{coupon.merchant}</h2>
      <p class="coupon-sheet-offer">{coupon.offer}</p>
      <!-- Con acciones, la línea de los chips está SIEMPRE, vacía si no hay
           ninguno: «Usar» o «Descartar» hacen aparecer «Usado» o
           «Descartado», y si la línea naciera entonces empujaría el código y
           el propio «Usar» (revisión UX, ronda 2, m5). El hueco lo guarda un
           chip invisible, que mide lo mismo que uno de verdad. -->
      {#if chip || coupon.expiresSoon || live}
        <p class="coupon-sheet-chips">
          {#if chip}<span class="status-chip">{chip}</span>{/if}
          {#if coupon.expiresSoon}<span class="status-chip warning">Caduca pronto</span>{/if}
          {#if !chip && !coupon.expiresSoon}<span class="status-chip chip-room" aria-hidden="true">&nbsp;</span>{/if}
        </p>
      {/if}
    </div>
    <button type="button" class="button secondary small-button" onclick={onClose} aria-label="Cerrar el cupón">✕</button>
  </header>

  {#if editing && draft}
    <form class="action-form coupon-edit" onsubmit={(event) => void saveEdit(event)} novalidate>
      <h3>Editar el cupón</h3>
      <CouponFields
        bind:draft
        {merchants}
        {today}
        idPrefix="cupon-editar"
        invalidField={problemField}
        errorId="cupon-editar-error"
      />
      {#if changingPhoto}
        <CouponPhotoField
          bind:phase={photoPhase}
          {householdId}
          legend="La foto nueva"
          readyText="Foto nueva lista ✓ · Se cambia al guardar los cambios."
          idPrefix="cupon-editar"
          onready={(ready) => (newPhoto = ready)}
          onreset={() => (newPhoto = null)}
        />
        <div class="action-row">
          <button class="button secondary" type="button" onclick={() => void keepOldPhoto()}>Dejar la foto de antes</button>
        </div>
      {:else}
        <div class="action-row">
          <button class="button secondary coupon-photo-change" type="button" onclick={() => (changingPhoto = true)}>Cambiar la foto</button>
        </div>
      {/if}
      {#if problem}<p class="form-error" id="cupon-editar-error" role="alert" tabindex="-1">{problem}</p>{/if}
      <div class="action-row">
        <button class="button primary" type="submit" disabled={saving || photoBusy}>
          {saving ? 'Guardando…' : 'Guardar los cambios'}
        </button>
        <button class="button secondary" type="button" onclick={cancelEdit}>Cancelar</button>
      </div>
    </form>
  {:else}
    <div class="coupon-code">
      {#if coupon.code}
        <p class="coupon-code-value" id="coupon-code-value">{coupon.code}</p>
        <button
          class="button secondary"
          type="button"
          onclick={() => void copyCode()}
          aria-describedby="coupon-code-value"
        >{copied ? 'Copiado ✓' : 'Copiar'}</button>
        {#if copyFallback}
          <p class="field-hint" role="status">No se ha podido copiar solo: el código ha quedado marcado para copiarlo a mano.</p>
        {/if}
      {:else}
        <p class="coupon-code-none">Sin código: enseña la foto en caja.</p>
      {/if}
    </div>
    <!-- El cambio del botón a «Copiado ✓» no siempre se anuncia: esta región
         está siempre en la página y dice lo que ha pasado. -->
    <p class="sr-only" role="status">{copied ? 'Código copiado' : ''}</p>

    {#if live}
      <!-- Justo debajo del código: en la caja, tras enseñarlo, un toque lo
           apunta sin bajar hasta pasada la foto. `aria-disabled` durante la
           guardia de doble toque, para que el foco no se caiga del botón. -->
      <div class="action-row coupon-sheet-actions">
        {#if coupon.bucket !== 'discarded'}
          <button
            class="button {useWeight} coupon-use"
            type="button"
            aria-disabled={Boolean(wallet.using[coupon.id]) || undefined}
            onclick={() => {
              if (!wallet.using[coupon.id]) void wallet.use(coupon, userName);
            }}
          >Usar</button>
        {/if}
        <button class="button secondary coupon-edit-open" type="button" onclick={() => void startEdit()}>Editar</button>
      </div>
    {/if}

    {#if photoUrl}
      {#if photoFailed}
        <p class="note info">La foto no se puede cargar ahora. Con conexión, vuelve a abrir el cupón.</p>
      {:else}
        <button
          type="button"
          class="coupon-photo"
          onclick={() => (fullPhoto = true)}
          aria-label={`Ver la foto del cupón de ${coupon.merchant} a pantalla completa`}
        >
          <img src={photoUrl} alt="" bind:this={photoImage} />
        </button>
      {/if}
    {/if}

    <dl class="coupon-facts">
      <div><dt>Caducidad</dt><dd>{expiryLabel(coupon.expiresOn, today)}</dd></div>
      <div><dt>Usos</dt><dd>{usesLabel(coupon)}</dd></div>
      {#if coupon.notes}<div><dt>Notas</dt><dd class="coupon-notes">{coupon.notes}</dd></div>{/if}
      <div><dt>Lo guardó</dt><dd>{coupon.createdByName}, el {createdOn}</dd></div>
    </dl>

    <section class="coupon-uses" aria-labelledby="coupon-uses-title">
      <h3 id="coupon-uses-title" tabindex="-1">
        {coupon.uses.length === 0 ? 'Todavía no se ha usado' : `Usos apuntados (${coupon.uses.length})`}
      </h3>
      {#if coupon.uses.length > 0}
        <ul class="fila-lista coupon-use-list">
          {#each coupon.uses as use (use.id)}
            <li class="fila-dato">
              <span>{useLine(use, today)}</span>
              {#if live}
                {#if armedVoid === use.id}
                  <span class="fila-fin">
                    <button
                      class="button danger small-button coupon-void-confirm"
                      type="button"
                      aria-label={`Sí, anular este uso: ${useLine(use, today)}. No se puede deshacer.`}
                      onclick={() => voidUse(use.id)}
                    >Sí, anular</button>
                    <button
                      class="button secondary small-button"
                      type="button"
                      onclick={() => void disarmVoid(use.id)}
                    >Cancelar</button>
                  </span>
                {:else}
                  <button
                    class="button secondary small-button"
                    type="button"
                    data-void={use.id}
                    aria-label={`Anular este uso: ${useLine(use, today)}`}
                    onclick={() => void armVoid(use.id)}
                  >Anular este uso</button>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if live}
      <!-- Un solo botón que cambia de verbo: el foco se queda en él al
           descartar y al recuperar, en vez de caerse con el botón que se va. -->
      <div class="action-row destructiva">
        <button
          class="button coupon-discard {coupon.bucket === 'discarded' ? 'secondary' : 'danger'}"
          type="button"
          onclick={toggleDiscarded}
        >{coupon.bucket === 'discarded' ? 'Recuperar' : `Descartar el cupón de ${coupon.merchant}`}</button>
      </div>
    {/if}
  {/if}

  <!-- Los avisos, al pie de la hoja y lo último de ella: no empujan nada y
       no tapan lo último. -->
  <CouponNotes {wallet} placement="sheet" refocus={refocusInSheet} />

  {#if fullPhoto}
    <div
      class="photo-full"
      role="dialog"
      aria-modal="true"
      aria-label={`Foto del cupón de ${coupon.merchant}`}
      use:modalDialog={{ onClose: () => (fullPhoto = false) }}
    >
      <button
        type="button"
        class="button secondary small-button photo-full-close"
        onclick={() => (fullPhoto = false)}
        aria-label="Cerrar la foto"
      >✕</button>
      <img src={photoUrl} alt={`Foto del cupón de ${coupon.merchant}`} />
    </div>
  {/if}
</div>

<style>
  /*
   * `grid-auto-rows: max-content`: cada fila mide lo que su contenido. Sin
   * esto, con un alto fijo (`inset-block: 0`), cuando la ficha no cabía la
   * rejilla ENCOGÍA las filas que se dejan (la foto, con `overflow`, tiene un
   * mínimo de 0) en vez de desbordar: la hoja nunca se desplazaba y la foto
   * del cupón sin código quedaba en 8 px a 320×568 (revisión UX, I1).
   */
  .coupon-sheet {
    position: fixed;
    z-index: 80;
    inset-block: 0;
    right: 0;
    display: grid;
    grid-auto-rows: max-content;
    align-content: start;
    gap: var(--space-3);
    width: min(28rem, 100%);
    overflow-y: auto;
    background: var(--surface);
    box-shadow: var(--shadow-over);
    /* Sin relleno abajo: el final de la hoja es el de sus avisos (`CouponNotes`). */
    padding: var(--pad-card) var(--pad-card) 0;
  }
  .coupon-sheet:focus { outline: none; }
  .coupon-uses h3:focus { outline: none; }
  .coupon-sheet-head { display: flex; align-items: start; justify-content: space-between; gap: var(--space-3); }
  .coupon-sheet-head > div { display: grid; gap: var(--space-1); min-width: 0; }
  .coupon-sheet-head h2 { overflow-wrap: anywhere; }
  .coupon-sheet-offer { color: var(--ink-soft); overflow-wrap: anywhere; }
  .coupon-sheet-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .coupon-sheet-chips .status-chip:not(.warning) { background: var(--canvas-deep); color: var(--ink-soft); }
  .coupon-sheet-chips .chip-room { visibility: hidden; }

  /* El código, lo primero y en grande: se lee de pie, con el móvil en la mano. */
  .coupon-code {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--surface-strong);
    padding: var(--space-3);
  }
  .coupon-code-value {
    font: var(--font-data);
    color: var(--ink);
    font-weight: 700;
    font-variant-numeric: tabular-nums lining-nums;
    letter-spacing: .04em;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .coupon-code .field-hint { grid-column: 1 / -1; }
  .coupon-code-none { grid-column: 1 / -1; color: var(--ink-soft); }

  .coupon-photo {
    display: block;
    width: 100%;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--canvas-deep);
    padding: 0;
    cursor: zoom-in;
    /* `clip` y no `hidden`: recorta las esquinas sin hacer del botón un
       contenedor de desplazamiento, que la rejilla podría encoger a 0. */
    overflow: clip;
  }
  .coupon-photo img { width: 100%; max-height: 18rem; object-fit: contain; }

  .coupon-facts { display: grid; gap: var(--space-2); margin: 0; }
  .coupon-facts > div { display: grid; grid-template-columns: minmax(5.5rem, 7rem) minmax(0, 1fr); gap: var(--space-2); }
  .coupon-facts dt { color: var(--ink-soft); font-size: var(--text-meta); font-weight: 700; }
  .coupon-facts dd { margin: 0; overflow-wrap: anywhere; }
  .coupon-notes { white-space: pre-line; }

  .coupon-uses { display: grid; gap: var(--space-1); }
  .coupon-uses .fila-fin { flex-wrap: nowrap; }

  .coupon-uses h3 { font-size: var(--text-strong); }
  .coupon-use-list { margin: 0; padding: 0; list-style: none; }
  .coupon-uses .fila-dato > span { min-width: 0; font-size: var(--text-meta); }

  /* La foto a pantalla completa: el lector de la caja la necesita grande. */
  .photo-full {
    position: fixed;
    z-index: 90;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--ink);
    padding: var(--space-3);
  }
  .photo-full img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .photo-full-close { position: absolute; top: var(--space-3); right: var(--space-3); }
</style>
