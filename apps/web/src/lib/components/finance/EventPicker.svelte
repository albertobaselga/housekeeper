<script lang="ts">
  let {
    events,
    selectedIds,
    ontoggle,
    oncreate
  }: {
    events: ReadonlyArray<{ id: string; name: string }>;
    selectedIds: readonly string[];
    ontoggle: (eventId: string, add: boolean) => void;
    oncreate: (name: string) => void;
  } = $props();

  let open = $state(false);
  let newName = $state('');

  const panelId = $props.id();

  const names = $derived(
    events.filter((entry) => selectedIds.includes(entry.id)).map((entry) => entry.name).join(', ')
  );
</script>

<!--
  Es un POPOVER, no un diálogo: no atrapa el foco ni bloquea el fondo, así que
  no lleva el rol de diálogo modal (que prometería lo que no cumple y lo
  suspendería en el axe de la fase 7). Se anuncia con aria-expanded/
  aria-controls y cierra con Escape solo mientras está abierto: Svelte exige
  que `<svelte:window>` viva en el nivel superior del marcado (no puede ir
  dentro de un `{#if}`), así que lo que se apaga con `open` es el propio
  manejador —pasa a `undefined` y Svelte quita el escuchador del DOM— y no hay
  ningún `keydown` armado en el documento mientras el popover está cerrado.
-->
<svelte:window
  onkeydown={open
    ? (event) => {
        if (event.key === 'Escape') open = false;
      }
    : undefined}
/>

<span class="event-picker">
  <button
    type="button"
    class="button secondary small-button"
    aria-expanded={open}
    aria-controls={panelId}
    title={names || 'Asignar a eventos'}
    onclick={() => (open = !open)}
  >◈{selectedIds.length ? ` ${selectedIds.length}` : ''}</button>
  {#if open}
    <div class="event-picker-panel" id={panelId}>
      {#each events as entry (entry.id)}
        <label class="check-row">
          <input
            type="checkbox"
            checked={selectedIds.includes(entry.id)}
            onchange={(event) => ontoggle(entry.id, event.currentTarget.checked)}
          />
          {entry.name}
        </label>
      {/each}
      {#if events.length === 0}<p>Sin eventos aún</p>{/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          const name = newName.trim();
          if (name) {
            oncreate(name);
            newName = '';
          }
        }}
      >
        <input aria-label="Nuevo evento" placeholder="Nuevo evento…" bind:value={newName} />
        <button class="button secondary small-button" type="submit">+</button>
      </form>
      <button class="button secondary small-button" type="button" onclick={() => (open = false)}>Cerrar</button>
    </div>
  {/if}
</span>

<style>
  .event-picker {
    position: relative;
    display: inline-block;
  }
  .event-picker-panel {
    position: absolute;
    z-index: 30;
    top: 110%;
    right: 0;
    min-width: 14rem;
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--canvas);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
  }
</style>
