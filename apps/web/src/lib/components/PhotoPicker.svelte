<script lang="ts">
  import type { Snippet } from 'svelte';

  /*
   * Los dos campos de la foto, bajo una sola leyenda. Elegir una foto guardada
   * y hacerla ahora son DOS campos distintos: con el atributo `capture` puesto,
   * el móvil abre la cámara y ya no ofrece la galería ni los ficheros, así que
   * con un solo campo siempre falta una de las dos formas.
   *
   * Nació dentro del alta de gastos (ExpensesPendingCard) y se extrae para que
   * el alta de cupones use exactamente el mismo par de campos. Aquí solo se
   * elige: preparar, subir o guardar sin red lo decide quien lo usa, porque un
   * justificante y la foto de un cupón no se tratan igual.
   *
   * Lo que va debajo de los campos (la ayuda, «Preparando la foto…», el fichero
   * elegido) llega como `children` y queda dentro del mismo `fieldset`.
   *
   * Domados (sistema móvil §2.9): cada campo es un botón con su nombre en
   * castellano y el control nativo, oculto a la vista pero no al teclado ni
   * al lector, va dentro de su etiqueta. Sin domar se veían dos «Choose File ·
   * No file chosen» idénticos, en inglés, y en un móvil en castellano también
   * el de la cámara decía «Elegir archivo». Lo elegido lo dice quien usa el
   * componente (la vista previa del cupón, «Adjunto: …» del gasto), que es
   * quien sabe qué ha pasado con el fichero.
   */
  let {
    legend,
    pickLabel,
    cameraLabel = 'Hacer la foto ahora',
    pickAccept = 'image/*',
    disabled = false,
    describedBy,
    onpick,
    children
  }: {
    legend: string;
    pickLabel: string;
    cameraLabel?: string;
    /** `accept` del campo de elegir; el de la cámara es siempre `image/*`. */
    pickAccept?: string;
    disabled?: boolean;
    /** `id` de la ayuda (y del aviso) que se lee con cada uno de los dos campos. */
    describedBy?: string;
    /** El fichero recién elegido, tal cual lo da el navegador. */
    onpick: (file: File) => void;
    children?: Snippet;
  } = $props();

  let pickInput = $state<HTMLInputElement | null>(null);
  let cameraInput = $state<HTMLInputElement | null>(null);

  /** Vacía los dos campos (tras guardar, o al quitar la foto elegida). */
  export function clear(): void {
    if (pickInput) pickInput.value = '';
    if (cameraInput) cameraInput.value = '';
  }

  function choose(input: HTMLInputElement): void {
    const chosen = input.files?.[0];
    if (!chosen) return;
    // Los dos campos comparten una sola selección: el último gana.
    if (input === pickInput && cameraInput) cameraInput.value = '';
    if (input === cameraInput && pickInput) pickInput.value = '';
    onpick(chosen);
  }
</script>

<fieldset class="receipt-field">
  <legend>{legend}</legend>
  <div class="photo-pick-row">
    <label class="button secondary photo-pick">{pickLabel}
      <input
        class="sr-only"
        type="file"
        accept={pickAccept}
        bind:this={pickInput}
        {disabled}
        aria-describedby={describedBy}
        onchange={(event) => choose(event.currentTarget)}
      />
    </label>
    <label class="button secondary photo-pick">{cameraLabel}
      <input
        class="sr-only"
        type="file"
        accept="image/*"
        capture="environment"
        bind:this={cameraInput}
        {disabled}
        aria-describedby={describedBy}
        onchange={(event) => choose(event.currentTarget)}
      />
    </label>
  </div>
  {@render children?.()}
</fieldset>

<style>
  /* Los dos botones en una fila si caben; si no, uno debajo del otro. */
  .photo-pick-row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .photo-pick { position: relative; flex: 1 1 12rem; cursor: pointer; }
  /* El control va oculto dentro: el anillo de foco se pinta en el botón. */
  .photo-pick:has(input:focus-visible) { outline: 2px solid var(--primary); outline-offset: 2px; }
  .photo-pick:has(input:disabled) { cursor: not-allowed; opacity: .55; }
</style>
