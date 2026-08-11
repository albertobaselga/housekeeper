<script lang="ts">
  import type { TodayDoneRoutineRow, TodayRoutinesView } from '$lib/server/today.server';

  /**
   * «3 hechas hoy»: lo ya marcado, plegado y al fondo, con el gesto de
   * DESHACER dentro (enmienda E5.1).
   *
   * Deshacer vive aquí y no en otra pantalla porque el error que corrige es un
   * toque de más: hay que poder arreglarlo donde se cometió. No pide motivo —es
   * un error de dedo, no una corrección contable— y no borra nada: el servidor
   * anota el completado como anulado y devuelve la rutina al día que le tocaba.
   *
   * Quién ve el botón lo decide el servidor en `canUndo` (quien marcó, o la
   * administración) y lo vuelve a decidir la RLS al escribir. Aquí no hay
   * ninguna regla de permisos: solo se pinta lo que ya viene resuelto.
   *
   * Chunk aparte, cargado con `import()` desde Hoy: el presupuesto de arranque
   * de la pantalla se mide y esto no cabía. No se pierde nada por diferirlo,
   * porque deshacer necesita JavaScript de todos modos.
   */
  let {
    view,
    marked,
    undone,
    busy,
    onUndo
  }: {
    view: TodayRoutinesView;
    /** Filas marcadas en ESTA visita, para no plegarlas delante de quien acaba
     *  de tocarlas: la fila se movió aquí, no desapareció. */
    marked: Record<string, string>;
    undone: Record<string, true>;
    busy: Record<string, true>;
    onUndo: (row: TodayDoneRoutineRow) => void;
  } = $props();
</script>

{#if view.done.length > 0}
<details class="routine-done-list" open={Object.keys(marked).length > 0}>
  <summary>{view.doneLabel}</summary>
  <div class="ledger-list">
    {#each view.done as row (row.key)}
      {#if !undone[row.key]}
        <div class="routine-done">
          <span>
            {#if row.details}
              <details class="routine-detail"><summary>{row.title}</summary><p>{row.details}</p></details>
            {:else}
              <strong>{row.title}</strong>
            {/if}
            <small>{row.note}</small>
          </span>
          <span class="inline-actions">
            <span class="status-chip success" role="status">{row.chip}</span>
            {#if row.canUndo}
              <button
                class="button secondary small-button"
                type="button"
                disabled={busy[row.key]}
                onclick={() => onUndo(row)}
              >Deshacer</button>
            {/if}
          </span>
        </div>
      {/if}
    {/each}
  </div>
</details>
{/if}
