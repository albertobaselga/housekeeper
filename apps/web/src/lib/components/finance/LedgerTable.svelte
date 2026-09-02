<script lang="ts">
  import type { FinanceTxDto } from '@housekeeper/server';
  import { ledgerRowMeta, txTitle } from '$lib/finance/detail';
  import { formatCents } from '$lib/finance/format';
  import type { FinanceCategoryOptionSource } from '$lib/finance/category-options';
  import CategorySelect from './CategorySelect.svelte';
  import EventPicker from './EventPicker.svelte';
  import RecurrenceChip from './RecurrenceChip.svelte';

  // [FASE 5] Todo lo de edición es OPCIONAL: quien no lo pasa (Dashboard,
  // Analítica) recibe exactamente la lista de solo lectura de la fase 4.
  let {
    rows,
    eventNameById,
    onOpen,
    selectedIds,
    onToggleSelect,
    categories,
    events,
    onSetCategory,
    onToggleEvent,
    onCreateEvent,
    onSetRecurrence,
    onDeleteManual,
    onUnlink
  }: {
    rows: FinanceTxDto[];
    eventNameById: Record<string, string>;
    onOpen: (tx: FinanceTxDto) => void;
    selectedIds?: ReadonlySet<string>;
    onToggleSelect?: (id: string, on: boolean) => void;
    categories?: readonly FinanceCategoryOptionSource[];
    events?: ReadonlyArray<{ id: string; name: string }>;
    onSetCategory?: (id: string, categoryId: string) => void;
    onToggleEvent?: (tx: FinanceTxDto, eventId: string, add: boolean) => void;
    onCreateEvent?: (name: string) => void;
    onSetRecurrence?: (id: string, next: 'recurrente' | 'extraordinario' | null) => void;
    onDeleteManual?: (id: string) => void;
    onUnlink?: (transferGroupId: string) => void;
  } = $props();

  const editable = $derived(Boolean(onSetCategory || onToggleSelect || onSetRecurrence));
  const isManual = (tx: FinanceTxDto): boolean => tx.batchId === null && tx.dedupHash.startsWith('manual-');
</script>

<div class="ledger-list finance-ledger" data-lista="principal">
  {#each rows as tx (tx.id)}
    <div class="finance-row-wrap">
      <button type="button" class="finance-row" onclick={() => onOpen(tx)}>
        <span>
          <strong>{tx.transferGroupId ? '⇄ ' : ''}{txTitle(tx)}</strong>
          <small>{ledgerRowMeta(tx, eventNameById)}</small>
        </span>
        <strong class="cifra pequena" class:positivo={BigInt(tx.amountCents) > 0n}>
          {formatCents(tx.amountCents, { signed: true })}
        </strong>
      </button>
      {#if editable}
        <div class="finance-row-tools">
          {#if onToggleSelect}
            <input
              type="checkbox"
              aria-label="Seleccionar movimiento"
              checked={selectedIds?.has(tx.id) ?? false}
              onchange={(event) => onToggleSelect(tx.id, event.currentTarget.checked)}
            />
          {/if}
          {#if categories && onSetCategory}
            <CategorySelect {categories} value={tx.categoryId} onchange={(categoryId) => onSetCategory(tx.id, categoryId)} />
          {/if}
          {#if events && onToggleEvent && onCreateEvent}
            <EventPicker
              {events}
              selectedIds={tx.eventIds}
              ontoggle={(eventId, add) => onToggleEvent(tx, eventId, add)}
              oncreate={onCreateEvent}
            />
          {/if}
          {#if onSetRecurrence}
            <RecurrenceChip value={tx.recurrence} onchange={(next) => onSetRecurrence(tx.id, next)} />
          {/if}
          {#if onUnlink && tx.transferGroupId}
            <button class="button secondary small-button" type="button" title="Desvincular transferencia"
              onclick={() => onUnlink(tx.transferGroupId!)}>⇄</button>
          {/if}
          {#if tx.provider}
            <a class="button secondary small-button" title="Editar alias del proveedor"
              href={`ajustes?prov=${encodeURIComponent(tx.provider)}`}>✎</a>
          {/if}
          {#if onDeleteManual && isManual(tx)}
            <button class="button danger small-button" type="button" onclick={() => onDeleteManual(tx.id)}>Borrar</button>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div><span><strong>Sin movimientos</strong><small>No hay movimientos con estos filtros.</small></span></div>
  {/each}
</div>

<style>
  .finance-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
    min-height: var(--row-action); width: 100%;
    border: 0; padding: var(--space-2) 0;
    background: none; text-align: left;
  }
  .finance-row > span { display: grid; min-width: 0; }
  .finance-row small { overflow: hidden; color: var(--ink-faint); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
  .positivo { color: var(--success); }
  .finance-row-wrap { border-top: 1px solid var(--line); }
  .finance-row-wrap:first-child { border-top: 0; }
  .finance-row-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding-bottom: var(--space-2); }
</style>
