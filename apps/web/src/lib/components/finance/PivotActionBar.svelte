<script lang="ts">
  import type { AnaliticaCategory, AnaliticaEventSummary } from '$lib/finance/analitica-data';

  let {
    concepts, movs, events, categories, invAccounts, categoryOnlySelection = false,
    onMoveToEvent, onNewEvent, onMoveToCategory, onSetRecurrence, onInvest, onOpenPanel, onClear
  }: {
    // R6: contadores de presentación (cuántos ítems/movimientos hay en la
    // selección), no importes — Number es correcto aquí, nunca céntimos.
    concepts: number;
    movs: number;
    events: AnaliticaEventSummary[];
    categories: AnaliticaCategory[];
    invAccounts: { id: string; name: string }[];
    categoryOnlySelection?: boolean;
    onMoveToEvent: (eventId: string) => void;
    onNewEvent: (name: string) => void;
    onMoveToCategory: (categoryId: string) => void;
    onSetRecurrence: (r: 'recurrente' | 'extraordinario') => void;
    onInvest: (accountId: string) => void;
    onOpenPanel: () => void;
    onClear: () => void;
  } = $props();

  let newEventName = $state('');
  const parents = $derived(categories.filter((c) => c.parentId === null && c.kind !== 'transferencia'));
  function pick(details: HTMLDetailsElement | null, fn: () => void): void {
    if (details) details.open = false;
    fn();
  }
</script>

<div class="barra" role="toolbar" aria-label="Acciones sobre la selección" data-testid="pivot-actionbar">
  <span class="cifra resumen">{concepts} concepto{concepts === 1 ? '' : 's'} · {movs} mov{movs === 1 ? '' : 's'}</span>

  <details>
    <summary>Mover a evento ▾</summary>
    <div class="menu">
      {#each events as e (e.id)}
        <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onMoveToEvent(e.id))}>{e.name}</button>
      {/each}
      {#if events.length === 0}<p class="vacio">Sin eventos aún</p>{/if}
      <form onsubmit={(ev) => { ev.preventDefault(); if (newEventName.trim()) { onNewEvent(newEventName.trim()); newEventName = ''; } }}>
        <input type="text" placeholder="+ Nuevo evento…" bind:value={newEventName} aria-label="Nombre del evento nuevo" />
        <button type="submit">+</button>
      </form>
    </div>
  </details>

  <details>
    <summary title={categoryOnlySelection ? 'Las categorías no pueden soltarse sobre otra categoría' : undefined}>Mover a categoría ▾</summary>
    {#if !categoryOnlySelection}
      <div class="menu alto">
        {#each parents as p (p.id)}
          <button type="button" class="padre" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onMoveToCategory(p.id))}>{p.name}</button>
          {#each categories.filter((c) => c.parentId === p.id) as c (c.id)}
            <button type="button" class="hija" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onMoveToCategory(c.id))}>{c.name}</button>
          {/each}
        {/each}
      </div>
    {:else}
      <div class="menu"><p class="vacio">Las categorías no pueden soltarse sobre otra categoría</p></div>
    {/if}
  </details>

  <details>
    <summary>Naturaleza ▾</summary>
    <div class="menu">
      <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onSetRecurrence('recurrente'))}>♻ Recurrente</button>
      <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onSetRecurrence('extraordinario'))}>✦ Extraordinario</button>
    </div>
  </details>

  <details>
    <summary title="Marcar los cargos seleccionados como aportación a inversión (cuentan como ahorro)">▲ Inversión ▾</summary>
    <div class="menu">
      {#if invAccounts.length === 0}<p class="vacio">Crea una cuenta de inversión en Ajustes.</p>{/if}
      {#each invAccounts as acc (acc.id)}
        <button type="button" onclick={(ev) => pick(ev.currentTarget.closest('details'), () => onInvest(acc.id))}>{acc.name}</button>
      {/each}
    </div>
  </details>

  <button type="button" class="plana" onclick={onOpenPanel}>Abrir panel</button>
  <button type="button" class="plana" aria-label="limpiar selección" onclick={onClear}>×</button>
</div>

<style>
  .barra { position: fixed; z-index: 40; inset-inline: 0; bottom: calc(var(--bottom-nav-h) + var(--space-3)); margin-inline: auto; width: fit-content; max-width: calc(100% - var(--space-6)); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-lg); box-shadow: var(--shadow-over); padding: var(--space-2) var(--space-3); }
  .resumen { font-size: var(--text-meta); font-variant-numeric: tabular-nums; }
  details { position: relative; }
  summary { list-style: none; cursor: pointer; border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); background: var(--surface); }
  summary::-webkit-details-marker { display: none; }
  .menu { position: absolute; z-index: 41; bottom: calc(100% + var(--space-1)); left: 0; min-width: 14rem; background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2); display: grid; gap: var(--space-1); }
  .menu.alto { max-height: 16rem; overflow-y: auto; }
  .menu button { border: 0; background: transparent; cursor: pointer; text-align: left; padding: var(--space-1) var(--space-2); border-radius: var(--r-sm); font-size: var(--text-meta); }
  .menu button:hover, .menu button:focus-visible { background: var(--primary-pale); }
  .menu .padre { font-weight: 700; }
  .menu .hija { padding-left: var(--space-4); }
  .menu form { display: flex; gap: var(--space-1); margin-top: var(--space-1); }
  .menu input { flex: 1; border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--space-1); font-size: max(1em, 1rem); }
  .plana { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); cursor: pointer; padding: var(--space-1) var(--space-2); font-size: var(--text-meta); }
  .vacio { color: var(--ink-soft); font-size: var(--text-meta); padding: var(--space-1); }
</style>
