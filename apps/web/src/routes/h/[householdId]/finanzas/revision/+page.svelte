<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import CategorySelect from '$lib/components/finance/CategorySelect.svelte';
  import RecurrenceChip from '$lib/components/finance/RecurrenceChip.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { financeCommand } from '$lib/finance/commands';
  import { STATUS_LABEL, formatCents } from '$lib/finance/format';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:finance' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let hidden = $state<string[]>([]);
  let ruleFor = $state<string[]>([]);
  let localCategory = $state<Record<string, string>>({});

  const rows = $derived((data.revision?.rows ?? []).filter((row) => !hidden.includes(row.id)));
  const suggested = $derived(
    rows.filter((row) => (localCategory[row.id] ?? row.categoryId) && row.status.startsWith('sugerida'))
  );

  function setCategory(rowId: string, categoryId: string): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, categoryId }),
      {
        apply: () => (localCategory = { ...localCategory, [rowId]: categoryId }),
        revert: () => {
          const { [rowId]: _gone, ...rest } = localCategory;
          localCategory = rest;
        }
      }
    );
  }

  // `null` («—» del RecurrenceChip) es un cambio legítimo: devuelve el
  // movimiento a sin clasificar. Se envía siempre, sin guarda muda.
  function setRecurrence(rowId: string, recurrence: 'recurrente' | 'extraordinario' | null): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, recurrence })
    );
  }

  function confirmRow(rowId: string): void {
    const withRule = ruleFor.includes(rowId);
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.transaction.update',
        transactionId: rowId,
        status: 'confirmada',
        ...(withRule ? { createRule: { ruleType: 'proveedor_exacto' as const } } : {})
      }),
      {
        apply: () => (hidden = [...hidden, rowId]),
        revert: () => (hidden = hidden.filter((id) => id !== rowId)),
        settle: () => (hidden = hidden.filter((id) => id !== rowId))
      }
    );
  }

  function confirmSuggested(): void {
    const ids = suggested.map((row) => row.id);
    if (ids.length === 0) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transactions.bulk', transactionIds: ids, status: 'confirmada' }),
      {
        apply: () => (hidden = [...hidden, ...ids]),
        revert: () => (hidden = hidden.filter((id) => !ids.includes(id))),
        settle: () => (hidden = hidden.filter((id) => !ids.includes(id)))
      }
    );
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Revisión" support={`${rows.length} movimientos por revisar`} />
  <ActionStatus status={actionStatus} />

  {#if !data.revision}
    <p class="empty-state">Ahora mismo no podemos leer los movimientos.</p>
  {:else if rows.length === 0}
    <p class="empty-state">Nada que revisar en este periodo ✨</p>
  {:else}
    {#if suggested.length > 0}
      <button class="button primary" type="button" onclick={confirmSuggested}>
        ✓ Confirmar {suggested.length} sugerencias
      </button>
    {/if}
    <div class="revision-scroll">
      <table class="wiki-table">
        <thead>
          <tr>
            <th>Fecha</th><th>Cuenta</th><th>Concepto</th><th>Importe</th><th>Estado</th>
            <th>Categoría</th><th>Tipo</th><th title="crear regla al confirmar">Regla</th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td class="cifra">{row.opDate}</td>
              <td>{row.accountName}</td>
              <td title={row.concept}>
                {row.transferGroupId ? '⇄ ' : ''}{row.providerDisplay ?? row.provider ?? row.concept.slice(0, 55)}
                {#if row.provider}
                  <a href={`/h/${context.household.id}/finanzas/ajustes?prov=${encodeURIComponent(row.provider)}`}
                    title="Editar alias del proveedor">✎</a>
                {/if}
              </td>
              <td class="cifra">{formatCents(row.amountCents)}</td>
              <td><span class="status-chip">{STATUS_LABEL[row.status] ?? row.status}</span></td>
              <td>
                <CategorySelect categories={data.revision.categories}
                  value={localCategory[row.id] ?? row.categoryId}
                  onchange={(categoryId) => setCategory(row.id, categoryId)} />
              </td>
              <td><RecurrenceChip value={row.recurrence} onchange={(next) => setRecurrence(row.id, next)} /></td>
              <td>
                <input type="checkbox" aria-label="Crear regla al confirmar"
                  checked={ruleFor.includes(row.id)}
                  onchange={(event) => {
                    const on = event.currentTarget.checked;
                    ruleFor = on ? [...ruleFor, row.id] : ruleFor.filter((id) => id !== row.id);
                  }} />
              </td>
              <td>
                <button class="button secondary small-button" type="button"
                  disabled={!(localCategory[row.id] ?? row.categoryId)}
                  onclick={() => confirmRow(row.id)}>Confirmar</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .revision-scroll { overflow-x: auto; }
</style>
