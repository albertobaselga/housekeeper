<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { financeCommand } from '$lib/finance/commands';
  import { formatCents } from '$lib/finance/format';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:finance' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let newName = $state('');
  let editId = $state<string | null>(null);
  let editName = $state('');

  const summary = $derived(data.eventos?.summary ?? []);
  const base = $derived(`/h/${context.household.id}/finanzas`);

  function create(event: SubmitEvent): void {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.event.create', name }),
      { settle: () => (newName = '') }
    );
  }

  function rename(eventId: string): void {
    const name = editName.trim();
    if (!name) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.event.update', eventId, name }),
      { settle: () => (editId = null) }
    );
  }

  function remove(entry: { id: string; name: string; totalCount: number }): void {
    const message = entry.totalCount
      ? `«${entry.name}» tiene ${entry.totalCount} movimientos asignados. Se desvincularán (los movimientos no se borran). ¿Continuar?`
      : `¿Borrar el evento «${entry.name}»?`;
    if (!window.confirm(message)) return;
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.event.delete', eventId: entry.id }));
  }
</script>

<div class="page-wrap">
  <PageHeader
    eyebrow="Finanzas"
    title="Eventos"
    support={data.eventos ? `${data.eventos.from} → ${data.eventos.to}` : undefined}
  />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />
  <ActionStatus status={actionStatus} />

  {#if !data.eventos}
    <p class="empty-state">Ahora mismo no podemos leer los eventos.</p>
  {:else}
    <form class="action-form" onsubmit={create}>
      <label>Nuevo evento
        <input placeholder="p. ej. Semana Santa 2026" bind:value={newName} />
      </label>
      <button class="button primary" type="submit">+ Crear</button>
    </form>

    <div class="eventos-scroll">
      <table class="wiki-table">
        <thead>
          <tr><th>Evento</th><th>Movs.</th><th>Gasto</th><th>Ingreso</th><th>Neto</th><th></th></tr>
        </thead>
        <tbody>
          {#each summary as entry (entry.id)}
            <tr>
              <td>
                {#if editId === entry.id}
                  <form onsubmit={(event) => { event.preventDefault(); rename(entry.id); }}>
                    <input aria-label="Nuevo nombre del evento" bind:value={editName}
                      onkeydown={(event) => { if (event.key === 'Escape') editId = null; }} />
                  </form>
                {:else}◈ {entry.name}{/if}
              </td>
              <td class="cifra">{entry.txCount}</td>
              <td class="cifra">{formatCents(entry.expenseCents)}</td>
              <td class="cifra">{formatCents(entry.incomeCents)}</td>
              <td class="cifra">{formatCents(entry.netCents)}</td>
              <td>
                <a class="button secondary small-button" href={`${base}/movimientos?ev=${entry.id}`} title="Ver movimientos">≡</a>
                <a class="button secondary small-button" href={`?open=${entry.id}`} title="Desglose por categoría">▾</a>
                <button class="button secondary small-button" type="button" title="Renombrar"
                  onclick={() => { editId = entry.id; editName = entry.name; }}>✎</button>
                <button class="button danger small-button" type="button" title="Borrar"
                  onclick={() => remove(entry)}>Borrar</button>
              </td>
            </tr>
          {/each}
          {#if summary.length === 0}
            <tr><td colspan="6">
              <p class="empty-state">Sin eventos todavía. Crea uno y asigna movimientos desde Movimientos.</p>
            </td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    {#if data.eventos.openId && data.eventos.detail}
      <section>
        <h2>Desglose por categoría</h2>
        <table class="wiki-table">
          <thead><tr><th>Categoría</th><th>Movs.</th><th>Total</th></tr></thead>
          <tbody>
            {#each data.eventos.detail as line (line.name)}
              <tr>
                <td>{line.name}</td>
                <td class="cifra">{line.count}</td>
                <td class="cifra">{formatCents(line.totalCents)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  {/if}
</div>

<style>
  .eventos-scroll { overflow-x: auto; }
</style>
