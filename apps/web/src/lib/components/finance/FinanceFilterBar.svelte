<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    mergeFilters, presetRanges, rangeLabel, shiftRange, todayLocal,
    type FinanceFilters, type FinanceGranularity
  } from '$lib/finance/filters';

  let { filters, accounts }: {
    filters: FinanceFilters;
    accounts: { id: string; name: string; kind: string }[];
  } = $props();

  const GRANULARITIES: { id: FinanceGranularity; label: string }[] = [
    { id: 'month', label: 'Mes' }, { id: 'quarter', label: 'Trim' }, { id: 'year', label: 'Año' }
  ];
  const presets = presetRanges(todayLocal());
  let showCustom = $state(false);
  let accountsOpen = $state(false);

  // Merge NO destructivo sobre el query string vivo: las claves de otras
  // pantallas (q, cat, rec, dims…) sobreviven a cada cambio de periodo.
  function apply(patch: Partial<FinanceFilters>): void {
    const merged = mergeFilters(page.url.searchParams, { ...filters, ...patch });
    void goto(`?${merged}`, { noScroll: true, keepFocus: true });
  }

  function pickPreset(event: Event & { currentTarget: HTMLSelectElement }): void {
    const select = event.currentTarget;
    const value = select.value;
    select.value = '';
    if (value === 'custom') { showCustom = true; return; }
    const preset = presets.find((candidate) => candidate.label === value);
    if (preset) { showCustom = false; apply(preset.range); }
  }

  function toggleAccount(id: string): void {
    const set = new Set(filters.accountIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    apply({ accountIds: [...set] });
  }
</script>

<div class="finance-filterbar" role="group" aria-label="Filtros del periodo">
  <button type="button" class="button secondary small-button" aria-label="Periodo anterior" onclick={() => apply(shiftRange(filters, -1))}>‹</button>
  <span class="finance-range">{rangeLabel(filters)}</span>
  <button type="button" class="button secondary small-button" aria-label="Periodo siguiente" onclick={() => apply(shiftRange(filters, 1))}>›</button>

  <select class="finance-preset" aria-label="Elegir periodo" onchange={pickPreset}>
    <option value="" disabled selected>Periodo…</option>
    {#each presets as preset (preset.label)}<option value={preset.label}>{preset.label}</option>{/each}
    <option value="custom">Personalizado…</option>
  </select>

  {#if showCustom}
    <label class="finance-date">Desde <input type="date" value={filters.from} onchange={(event) => apply({ from: event.currentTarget.value })} /></label>
    <label class="finance-date">Hasta <input type="date" value={filters.to} onchange={(event) => apply({ to: event.currentTarget.value })} /></label>
  {/if}

  <span class="chip-strip" role="group" aria-label="Granularidad">
    {#each GRANULARITIES as granularity (granularity.id)}
      <button type="button" class="chip" class:active={filters.granularity === granularity.id}
        aria-pressed={filters.granularity === granularity.id}
        onclick={() => apply({ granularity: granularity.id })}>{granularity.label}</button>
    {/each}
  </span>

  <button type="button" class="chip" aria-expanded={accountsOpen} onclick={() => (accountsOpen = !accountsOpen)}>
    Cuentas{filters.accountIds.length ? ` (${filters.accountIds.length})` : ''}
  </button>
  {#if accountsOpen}
    <nav class="chip-strip finance-accounts" aria-label="Filtrar por cuenta">
      {#each accounts as account (account.id)}
        <!-- Las cuentas virtuales (inversión) también se filtran: «todas» no
             puede omitirlas en silencio (regla del original). -->
        <!-- Nota (Issue Minor #7 de la revisión): con `accountIds` vacío
             («todas») los chips salen todos activos por diseño; pulsar uno
             no lo «despulsa», lo convierte en la única cuenta seleccionada.
             Es el comportamiento portado del original, no un bug — pero si
             el e2e de la T13/T14 espera lo contrario, es aquí donde mirar. -->
        <button type="button" class="chip" class:virtual={account.kind === 'inversion'}
          class:active={filters.accountIds.length === 0 || filters.accountIds.includes(account.id)}
          aria-pressed={filters.accountIds.length === 0 || filters.accountIds.includes(account.id)}
          onclick={() => toggleAccount(account.id)}>{account.name}</button>
      {/each}
    </nav>
  {/if}
  {#if filters.eventId}
    <button type="button" class="chip active" onclick={() => apply({ eventId: null })} aria-label="Quitar el filtro de evento">Evento filtrado ✕</button>
  {/if}
</div>

<style>
  .finance-filterbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .finance-range { min-width: 9rem; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
  .finance-preset, .finance-date input { min-height: 2.75rem; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface-strong); padding: var(--space-1) var(--space-2); }
  .finance-date { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--ink-soft); font-size: var(--text-meta); }
  .finance-accounts { flex-basis: 100%; }
  .chip.virtual { border-style: dashed; }
</style>
