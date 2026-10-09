<script lang="ts">
  import { tick } from 'svelte';

  import { checkCouponDraft, emptyCouponDraft, type CouponDraft } from '$lib/coupons/draft';
  import type { PhotoPhase } from '$lib/coupons/photo';
  import type { CouponPhotoChange, CouponWallet } from '$lib/coupons/wallet.svelte';
  import CouponFields from './CouponFields.svelte';
  import CouponPhotoField from './CouponPhotoField.svelte';

  /*
   * Añadir un cupón: FOTO PRIMERO, CAMPOS DESPUÉS (spec de cupones §8.2). Los
   * campos aparecen en cuanto hay una foto elegida, mientras sube; «Guardar»
   * espera a que esté subida. El orden no es capricho: es el hueco donde la
   * fase 2 meterá la propuesta de campos sacada de la foto (§12) sin tocar el
   * modelo, porque los campos ya se alimentan de un `CouponDraft`.
   *
   * En el móvil, el «después» tiene que VERSE: al elegir la foto, la pantalla
   * baja lo justo para enseñar su fase y el título del paso 2. Antes, a 320 no
   * cambiaba nada y a 390 se veía un «Foto guardada ✓» en verde con los campos
   * fuera de la pantalla, y parecía que ya estaba (revisión UX, ronda 2, I2).
   * El foco no se mueve a un campo: abriría el teclado encima de la foto.
   *
   * Plegado (`hidden`) no se desmonta: lo escrito y la foto siguen ahí al
   * volver a abrirlo. Solo «Cancelar» lo tira (revisión UX, ronda 2, m9).
   */
  let {
    householdId,
    merchants,
    today,
    wallet,
    createdByName,
    hidden = false,
    onclose
  }: {
    hidden?: boolean;
    householdId: string;
    merchants: readonly string[];
    /** Hoy en Madrid, para repetir en palabras la caducidad elegida. */
    today: string;
    wallet: CouponWallet;
    /** Quien lo guarda, para pintar la ficha antes de que vuelva el acuse. */
    createdByName: string;
    onclose: () => void;
  } = $props();

  let form = $state<HTMLFormElement | null>(null);
  let photoField = $state<ReturnType<typeof CouponPhotoField> | null>(null);
  let photoPhase = $state<PhotoPhase>('empty');
  let photo = $state<CouponPhotoChange | null>(null);
  let draft = $state<CouponDraft>(emptyCouponDraft());
  let problem = $state<string | null>(null);
  let problemField = $state<keyof CouponDraft | null>(null);
  let saving = $state(false);

  const fieldsVisible = $derived(photoPhase !== 'empty');

  let stepTwo = $state<HTMLElement | null>(null);
  let shownPhase: PhotoPhase = 'empty';
  $effect(() => {
    const phase = photoPhase;
    const before = shownPhase;
    shownPhase = phase;
    // Solo al elegir una foto (no en cada fase): la persona está mirando los
    // botones de la foto y lo nuevo aparece debajo.
    if (phase !== 'preparing' || before === 'preparing') return;
    void tick().then(() => stepTwo?.scrollIntoView({ block: 'nearest' }));
  });

  function reset(): void {
    photoField?.clear();
    photo = null;
    draft = emptyCouponDraft();
    problem = null;
    problemField = null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!photo || saving) return;
    const check = checkCouponDraft(draft);
    if (!check.ok) {
      problem = check.message;
      problemField = check.field;
      await tick();
      form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    problem = null;
    problemField = null;
    saving = true;
    try {
      const outcome = await wallet.create(check.fields, photo, createdByName);
      // Rechazado: el cupón desaparece de la lista y el formulario se queda con
      // lo escrito, para corregir sin volver a empezar. El motivo lo dice el
      // aviso de la página.
      if (outcome === 'synced' || outcome === 'queued') {
        reset();
        onclose();
      }
    } finally {
      saving = false;
    }
  }

  function cancel(): void {
    reset();
    onclose();
  }
</script>

<section class="card coupon-create-card" id="coupon-create" aria-labelledby="coupon-create-title" {hidden}>
  <!-- `tabindex=-1`: al abrir el alta desde la cartera vacía, el botón que lo
       abrió desaparece y el foco viene aquí. -->
  <h2 id="coupon-create-title" tabindex="-1">Añadir un cupón</h2>
  <form class="action-form coupon-create" bind:this={form} onsubmit={(event) => void submit(event)} novalidate>
    <CouponPhotoField
      bind:this={photoField}
      bind:phase={photoPhase}
      {householdId}
      legend="Primero, la foto del cupón"
      readyText="Foto lista ✓ · Ahora, escribe dónde sirve y qué ofrece."
      idPrefix="cupon-nuevo"
      onready={(ready) => (photo = ready)}
      onreset={() => (photo = null)}
    />
    {#if fieldsVisible}
      <h3 class="coupon-step" bind:this={stepTwo}>Después, lo que pone el cupón</h3>
      <CouponFields
        bind:draft
        {merchants}
        {today}
        idPrefix="cupon-nuevo"
        invalidField={problemField}
        errorId="cupon-nuevo-error"
      />
      {#if problem}<p class="form-error" id="cupon-nuevo-error" role="alert">{problem}</p>{/if}
      <div class="action-row">
        <button class="button primary" type="submit" disabled={!photo || saving}>
          {saving ? 'Guardando…' : 'Guardar el cupón'}
        </button>
        <button class="button secondary" type="button" onclick={cancel}>Cancelar</button>
      </div>
      {#if !photo && photoPhase !== 'failed'}
        <p class="field-hint">Se puede guardar en cuanto la foto esté guardada.</p>
      {/if}
    {:else}
      <div class="action-row">
        <button class="button secondary" type="button" onclick={cancel}>Cancelar</button>
      </div>
    {/if}
  </form>
</section>

<style>
  .coupon-create-card[hidden] { display: none; }
  .coupon-create-card h2:focus { outline: none; }
  /* El formulario abre la tarjeta: sin el divisor de «zona de acciones». */
  .coupon-create { margin-top: var(--space-3); border-top: 0; padding-top: 0; }
  /*
   * Los dos pasos, con el mismo peso: «Primero, la foto» (la leyenda de los
   * campos de la foto) y «Después, lo que pone el cupón». Por encima de las
   * etiquetas de los campos, no por debajo.
   */
  .coupon-create :global(.receipt-field > legend),
  .coupon-step {
    color: var(--ink);
    font-size: var(--text-strong);
    font-weight: 700;
  }
  /* Al bajar hasta el paso 2 se deja ver encima de la barra inferior, con
     sitio debajo para el primer campo (y para que el texto más largo de «Foto
     lista» no lo vuelva a esconder). */
  .coupon-step { scroll-margin-block: var(--space-3) calc(var(--bottom-nav-h) + var(--space-6) * 3); }
</style>
