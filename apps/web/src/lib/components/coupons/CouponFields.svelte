<script lang="ts">
  import {
    COUPON_DATE_MAX,
    COUPON_DATE_MIN,
    COUPON_LIMITS,
    expiryInWords,
    type CouponDraft,
    type CouponUsesMode
  } from '$lib/coupons/draft';

  /*
   * Los campos de un cupón, los mismos en el alta y en la edición. Se
   * alimentan de un `CouponDraft`: hoy lo rellena la persona; en la fase 2 una
   * propuesta sacada de la foto llegará como `Partial<CouponDraft>` y
   * precargará estos mismos campos (spec de cupones §12).
   *
   * Solo los campos: el `<form>`, el envío y la foto son de quien lo usa.
   * Los ejemplos van en `.field-hint`, nunca en el `placeholder`. Lo que se
   * puede dejar vacío dice «(opcional)», como en el resto de la casa; lo
   * obligatorio lleva `required`, que el lector de pantalla anuncia.
   *
   * El campo que el último intento de guardar señaló queda ligado a su
   * mensaje de error (`aria-describedby`): al volver a él, se oye qué le pasa.
   */
  let {
    draft = $bindable(),
    merchants,
    today,
    idPrefix,
    invalidField = null,
    errorId
  }: {
    draft: CouponDraft;
    /** Comercios ya usados en la casa, para el `datalist`. */
    merchants: readonly string[];
    /** Hoy en Madrid: la caducidad elegida se repite en palabras. */
    today: string;
    /** Prefijo de los `id`: el alta y la ficha pueden estar a la vez en la página. */
    idPrefix: string;
    /** El campo que el último intento de guardar señaló, para marcarlo. */
    invalidField?: keyof CouponDraft | null;
    /** `id` del mensaje de error del formulario. */
    errorId: string;
  } = $props();

  /** Ayuda del campo y, si es el señalado, también su error. */
  function describedBy(field: keyof CouponDraft, hint: string | null): string | undefined {
    const ids = [hint, invalidField === field ? errorId : null].filter(Boolean);
    return ids.length > 0 ? ids.join(' ') : undefined;
  }

  const expiryWords = $derived(expiryInWords(draft.expiresOn, today));

  const USES_OPTIONS: ReadonlyArray<{ value: CouponUsesMode; label: string }> = [
    { value: 'single', label: 'Un solo uso' },
    { value: 'multiple', label: 'Varios usos' },
    { value: 'unlimited', label: 'Sin límite' }
  ];
</script>

<label>Comercio
  <input
    type="text"
    bind:value={draft.merchant}
    required
    maxlength={COUPON_LIMITS.merchant}
    list={`${idPrefix}-comercios`}
    autocomplete="off"
    enterkeyhint="next"
    aria-invalid={invalidField === 'merchant' || undefined}
    aria-describedby={describedBy('merchant', `${idPrefix}-comercio-ayuda`)}
  />
</label>
<datalist id={`${idPrefix}-comercios`}>
  {#each merchants as merchant (merchant)}<option value={merchant}></option>{/each}
</datalist>
<p class="field-hint" id={`${idPrefix}-comercio-ayuda`}>Dónde sirve: la tienda, el súper o la web.</p>

<label>Qué ofrece
  <input
    type="text"
    bind:value={draft.offer}
    required
    maxlength={COUPON_LIMITS.offer}
    autocomplete="off"
    enterkeyhint="next"
    aria-invalid={invalidField === 'offer' || undefined}
    aria-describedby={describedBy('offer', `${idPrefix}-oferta-ayuda`)}
  />
</label>
<p class="field-hint" id={`${idPrefix}-oferta-ayuda`}>Por ejemplo, «2 × 1 en naranjas» o «5 € a partir de 30 €».</p>

<label>Código (opcional)
  <input
    type="text"
    class="coupon-code-input"
    bind:value={draft.code}
    maxlength={COUPON_LIMITS.code}
    autocomplete="off"
    autocapitalize="characters"
    spellcheck="false"
    enterkeyhint="next"
    aria-invalid={invalidField === 'code' || undefined}
    aria-describedby={describedBy('code', null)}
  />
</label>

<label>Caduca el (opcional)
  <input
    type="date"
    bind:value={draft.expiresOn}
    min={COUPON_DATE_MIN}
    max={COUPON_DATE_MAX}
    aria-invalid={invalidField === 'expiresOn' || undefined}
    aria-describedby={describedBy('expiresOn', `${idPrefix}-caducidad-ayuda`)}
  />
</label>
<!-- La fecha elegida, en palabras: el campo nativo pinta el formato del
     navegador, que en algunos es mes/día (sistema móvil §2.9). -->
<p class="field-hint" id={`${idPrefix}-caducidad-ayuda`} aria-live="polite">
  {expiryWords ? `${expiryWords}.` : 'Día, mes y año completo. Déjalo vacío si no caduca.'}
</p>

<fieldset class="uses-fieldset">
  <legend>¿Cuántas veces se puede usar?</legend>
  {#each USES_OPTIONS as option (option.value)}
    <label class="uses-option">
      <input type="radio" name={`${idPrefix}-usos`} value={option.value} bind:group={draft.usesMode} />
      <span>{option.label}</span>
    </label>
    {#if option.value === 'multiple' && draft.usesMode === 'multiple'}
      <label class="uses-count">¿Cuántos?
        <input
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          bind:value={draft.usesCount}
          required
          maxlength="3"
          autocomplete="off"
          enterkeyhint="next"
          aria-invalid={invalidField === 'usesCount' || undefined}
          aria-describedby={describedBy('usesCount', null)}
        />
      </label>
    {/if}
  {/each}
</fieldset>

<label>Notas (opcional)
  <textarea
    rows="2"
    bind:value={draft.notes}
    maxlength={COUPON_LIMITS.notes}
    autocomplete="off"
    aria-invalid={invalidField === 'notes' || undefined}
    aria-describedby={describedBy('notes', `${idPrefix}-notas-ayuda`)}
  ></textarea>
</label>
<p class="field-hint" id={`${idPrefix}-notas-ayuda`}>Lo que haga falta saber en caja: «solo en la tienda del centro», «a partir de 20 €».</p>

<style>
  .uses-fieldset { display: grid; gap: 0; margin: 0; border: 0; padding: 0; min-width: 0; }
  .uses-fieldset > legend { padding: 0; color: var(--ink-soft); font-size: var(--text-body); font-weight: 700; }
  /* La diana del radio es su etiqueta entera, de 44 px (A3 mide la etiqueta). */
  .uses-option { display: flex; align-items: center; gap: var(--space-2); min-height: var(--row-data); color: var(--ink); font-size: var(--text-strong); font-weight: 400; }
  .uses-option > input { width: 1.25rem; height: 1.25rem; min-height: 0; flex: none; margin: 0; accent-color: var(--primary); }
  .uses-count { margin: 0 0 var(--space-2) var(--space-6); }
  .uses-count > input { max-width: 8rem; }
  .coupon-code-input { font-variant-numeric: tabular-nums; letter-spacing: .04em; }
</style>
