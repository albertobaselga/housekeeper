<script lang="ts">
  import { suggestChips, type SearchChip, type SuggestGroup } from '$lib/finance/pivot-state';
  import type { AnaliticaPivotRow } from '$lib/finance/analitica-data';

  const MAX_PER_GROUP = 5;
  const DEBOUNCE_MS = 150;
  const TYPE_LABEL: Record<SearchChip['type'], string> = {
    prov: 'Proveedor', concept: 'Concepto', event: 'Evento', cat: 'Categoría', free: 'Texto'
  };

  let { rows, catPathOf, chips, onChips }: {
    rows: AnaliticaPivotRow[];
    catPathOf: (id: string) => string;
    chips: SearchChip[];
    onChips: (next: SearchChip[]) => void;
  } = $props();

  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let debounced = $state('');
  let open = $state(false);
  let expandedGroups = $state<Set<string>>(new Set());

  $effect(() => {
    const value = query;
    const t = setTimeout(() => (debounced = value), DEBOUNCE_MS);
    return () => clearTimeout(t);
  });

  const groups = $derived<SuggestGroup[]>(debounced.trim().length >= 2 ? suggestChips(rows, catPathOf, debounced) : []);
  const showDropdown = $derived(open && debounced.trim().length >= 2);

  function addChip(chip: SearchChip): void {
    onChips([...chips, chip]);
    query = '';
    debounced = '';
    open = false;
  }
  const removeChip = (idx: number) => onChips(chips.filter((_, i) => i !== idx));

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (query.trim()) addChip({ type: 'free', value: query.trim() });
    } else if (e.key === 'Escape') {
      if (showDropdown) open = false;
      else if (chips.length > 0) removeChip(chips.length - 1);
    }
  }

  // Atajo global «/»: enfoca el buscador salvo que el foco esté en otro campo.
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key !== '/') return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    e.preventDefault();
    input?.focus();
    open = true;
  }
  const chipDisplay = (chip: SearchChip) =>
    chip.type === 'cat' ? catPathOf(chip.value) : chip.type === 'concept' && chip.prov ? `${chip.value} (${chip.prov})` : chip.value;
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="buscador">
  <input bind:this={input} type="text" aria-label="Buscar"
    placeholder="Buscar proveedor, concepto, evento o categoría…  /"
    value={query} oninput={(e) => { query = e.currentTarget.value; open = true; }}
    onfocus={() => (open = true)} onkeydown={onKeydown} />

  {#if showDropdown}
    <div class="desplegable" role="listbox" aria-label="Sugerencias">
      {#if groups.length === 0}
        <p class="sin-resultados">Sin resultados para «{debounced}»</p>
      {:else}
        {#each groups as g (g.group)}
          {@const cap = expandedGroups.has(g.group) ? g.items.length : MAX_PER_GROUP}
          <p class="grupo">{g.group}</p>
          {#each g.items.slice(0, cap) as item (item.chip.type + item.chip.value)}
            <button type="button" class="sugerencia" onmousedown={(e) => e.preventDefault()} onclick={() => addChip(item.chip)}>
              <span>{item.label}</span><small>{item.detail}</small>
            </button>
          {/each}
          {#if g.items.length > cap}
            <button type="button" class="mas" onmousedown={(e) => e.preventDefault()}
              onclick={() => (expandedGroups = new Set(expandedGroups).add(g.group))}>{g.items.length - cap} más…</button>
          {/if}
        {/each}
      {/if}
    </div>
  {/if}

  {#if chips.length > 0}
    <div class="chips">
      {#each chips as chip, i (i)}
        <span class="chip activa">🔍 {TYPE_LABEL[chip.type]}: {chipDisplay(chip)}
          <button type="button" aria-label="quitar filtro" onclick={() => removeChip(i)}>×</button></span>
      {/each}
      <button type="button" class="limpiar" onclick={() => onChips([])}>limpiar</button>
    </div>
  {/if}
</div>

<style>
  .buscador { position: relative; flex: 1 1 14rem; max-width: 24rem; }
  input { width: 100%; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); padding: var(--space-2); font-size: max(1em, 1rem); }
  .desplegable { position: absolute; z-index: 30; inset-inline: 0; top: 100%; background: var(--surface-strong); border: 1px solid var(--line-strong); border-radius: var(--r-md); box-shadow: var(--shadow-over); padding: var(--space-2); max-height: 18rem; overflow-y: auto; }
  .grupo { color: var(--ink-faint); font-size: var(--text-micro); text-transform: uppercase; letter-spacing: .04em; margin: var(--space-2) 0 var(--space-1); }
  .sugerencia, .mas { display: flex; justify-content: space-between; gap: var(--space-2); width: 100%; border: 0; background: transparent; cursor: pointer; text-align: left; padding: var(--space-1) var(--space-2); border-radius: var(--r-sm); font-size: var(--text-meta); }
  .sugerencia:hover, .sugerencia:focus-visible, .mas:hover { background: var(--primary-pale); }
  .sugerencia small { color: var(--ink-soft); }
  .sin-resultados { color: var(--ink-soft); font-size: var(--text-meta); padding: var(--space-2); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
  .chip { border: 1px solid var(--primary); border-radius: var(--r-full); background: var(--primary-soft); padding: var(--space-1) var(--space-2); font-size: var(--text-meta); font-weight: 700; }
  .chip button { border: 0; background: transparent; cursor: pointer; padding: 0 var(--space-1); }
  .limpiar { border: 0; background: transparent; cursor: pointer; color: var(--ink-soft); font-size: var(--text-meta); text-decoration: underline; }
</style>
