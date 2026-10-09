<script lang="ts">
  import PhotoPicker from '$lib/components/PhotoPicker.svelte';
  import { uploadAttachment } from '$lib/attachments/upload';
  import { PHOTO_OFFLINE_MESSAGE, photoPreview, photoUploadProblem, type PhotoPhase } from '$lib/coupons/photo';
  import type { CouponPhotoChange } from '$lib/coupons/wallet.svelte';
  import { syncStatus } from '$lib/offline/sync';

  /*
   * La foto de un cupón: se elige, se prepara EN EL MÓVIL y se sube EN ESE
   * MOMENTO, no al guardar. Así, mientras sube, la persona ya va escribiendo
   * los campos, y al pulsar «Guardar» no hay nada que esperar.
   *
   * Tres decisiones que no son las del justificante de un gasto:
   *
   * · Se reencoda SIEMPRE (`alwaysReencode`): la foto la ve toda la familia y
   *   no debe llevar dentro la posición GPS de la tienda ni los datos del
   *   móvil. Si el navegador no sabe reencodarla, no se sube el original.
   * · Sin red no hay alta (D-offline): la foto se queda preparada con su vista
   *   previa y «Volver a intentarlo» la sube cuando vuelva la conexión. No se
   *   guarda en la bandeja de salida, a diferencia del justificante. Ese botón
   *   solo sale cuando reintentar puede servir: ante una foto repetida, que
   *   pesa de más o que no es una imagen, saldría el mismo error otra vez.
   * · La vista previa no usa `blob:` (la CSP no lo admite): es un `data:`
   *   dibujado en un lienzo (`photoPreview`).
   */
  let {
    householdId,
    legend,
    readyText = 'Foto lista ✓',
    idPrefix,
    phase = $bindable('empty'),
    onready,
    onreset
  }: {
    householdId: string;
    legend: string;
    /**
     * Lo que dice la foto ya subida. No es «Guardado ✓»: el cupón todavía no
     * lo está, y quien lo leía como terminado se iba sin guardarlo (revisión
     * UX, ronda 2, I2). Cada uso dice cuál es el paso siguiente.
     */
    readyText?: string;
    /** Prefijo de los `id`: el alta y la ficha pueden estar a la vez en la página. */
    idPrefix: string;
    /** En qué punto está la foto; el alta enseña los campos en cuanto hay una elegida. */
    phase?: PhotoPhase;
    /** La foto ya está subida: su objeto y su vista previa. */
    onready: (photo: CouponPhotoChange) => void;
    /** Se ha elegido otra foto o se ha vaciado: la anterior ya no vale. */
    onreset?: () => void;
  } = $props();

  let picker = $state<ReturnType<typeof PhotoPicker> | null>(null);
  /** El fichero ya preparado: es lo que se reintenta subir. */
  let prepared = $state.raw<File | null>(null);
  let previewUrl = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let problem = $state<string | null>(null);
  /** ¿Sirve «Volver a intentarlo» con esta misma foto? */
  let retry = $state(false);
  /** Turno de la última elección: una respuesta tardía de una foto anterior no pisa la nueva. */
  let turn = 0;

  const online = $derived($syncStatus.phase !== 'offline');

  function isOffline(): boolean {
    return !online || (typeof navigator !== 'undefined' && navigator.onLine === false);
  }

  async function choose(file: File): Promise<void> {
    const mine = ++turn;
    phase = 'preparing';
    prepared = null;
    previewUrl = null;
    notice = null;
    problem = null;
    retry = false;
    onreset?.();
    try {
      // Bajo demanda, como en el gasto: quien no añade cupones no lo descarga.
      const { prepareAttachment } = await import('$lib/attachments/prepare');
      const result = await prepareAttachment(file, { alwaysReencode: true });
      if (mine !== turn) return;
      prepared = result.file;
      notice = result.notice;
      previewUrl = await photoPreview(result.file);
      if (mine !== turn) return;
    } catch (cause) {
      if (mine !== turn) return;
      phase = 'failed';
      problem =
        cause instanceof Error && cause.name === 'PrepareAttachmentError'
          ? cause.message
          : 'No se ha podido preparar la foto. Prueba a hacerla otra vez.';
      retry = false;
      picker?.clear();
      return;
    }
    await upload(mine);
  }

  async function upload(mine: number = turn): Promise<void> {
    const file = prepared;
    if (!file) return;
    if (isOffline()) {
      phase = 'failed';
      problem = PHOTO_OFFLINE_MESSAGE;
      retry = true;
      return;
    }
    phase = 'uploading';
    problem = null;
    retry = false;
    try {
      const storageObjectId = await uploadAttachment(householdId, file);
      if (mine !== turn) return;
      phase = 'ready';
      onready({ storageObjectId, previewUrl });
    } catch (cause) {
      if (mine !== turn) return;
      phase = 'failed';
      const failure = photoUploadProblem(cause, isOffline());
      problem = failure.message;
      retry = failure.retry;
    }
  }

  /** Vacía la foto (tras guardar el cupón o al cancelar). */
  export function clear(): void {
    turn += 1;
    phase = 'empty';
    prepared = null;
    previewUrl = null;
    notice = null;
    problem = null;
    retry = false;
    picker?.clear();
  }
</script>

<PhotoPicker
  bind:this={picker}
  {legend}
  pickLabel="Elegir una foto guardada"
  disabled={phase === 'preparing' || phase === 'uploading'}
  describedBy={problem ? `${idPrefix}-foto-ayuda ${idPrefix}-foto-aviso` : `${idPrefix}-foto-ayuda`}
  onpick={(file) => void choose(file)}
>
  <p class="field-hint" id={`${idPrefix}-foto-ayuda`}>Que se lea bien el código. La foto se guarda sin la ubicación ni los datos del móvil.</p>
  <!-- El hueco de la vista previa se guarda desde que se elige la foto: así
       lo de debajo (la fase y el paso siguiente) no salta cuando llega. -->
  {#if previewUrl}
    <img class="photo-preview" src={previewUrl} alt="Vista previa de la foto del cupón" />
  {:else if phase === 'preparing'}
    <div class="photo-preview" aria-hidden="true"></div>
  {/if}
  {#if phase === 'preparing'}
    <p class="note pending" role="status">Preparando la foto…</p>
  {:else if phase === 'uploading'}
    <p class="note pending" role="status">Guardando la foto…</p>
  {:else if phase === 'ready'}
    <p class="note success" role="status">{readyText}</p>
  {/if}
  {#if notice}<p class="field-hint">{notice}</p>{/if}
  {#if problem}
    <div class="note error photo-problem" id={`${idPrefix}-foto-aviso`} role="alert">
      <p>{problem}</p>
      {#if prepared && retry}
        <button class="button secondary small-button" type="button" onclick={() => void upload()}>Volver a intentarlo</button>
      {/if}
    </div>
  {:else if phase === 'empty' && !online}
    <p class="note pending" role="status">{PHOTO_OFFLINE_MESSAGE}</p>
  {/if}
</PhotoPicker>

<style>
  /* Una confirmación de QUÉ foto es, no la foto de consulta (esa está en la
     ficha): baja, para que en el móvil se vea con ella lo que viene después. */
  .photo-preview {
    width: 100%;
    height: 11rem;
    object-fit: contain;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--canvas-deep);
  }
  .photo-problem { justify-items: start; }
</style>
