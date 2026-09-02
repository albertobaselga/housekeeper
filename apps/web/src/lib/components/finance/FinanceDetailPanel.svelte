<script lang="ts">
  import type { FinanceTxDto } from '@housekeeper/server';
  import { financeApi, type FinanceDetailMode } from '$lib/finance/api';
  import { detailCards, originRows } from '$lib/finance/detail';
  import { dateLabel, formatCents, STATUS_LABEL, summarizeTxs } from '$lib/finance/format';
  import { modalDialog } from '$lib/components/modal-dialog';

  let { mode, householdId, live = true, onClose }: {
    mode: FinanceDetailMode | null;
    householdId: string;
    /** false en modo demo (sin base): el panel no hace fetch, pinta lo que tiene. */
    live?: boolean;
    onClose: () => void;
  } = $props();

  let fetched = $state<FinanceTxDto[] | null>(null);
  let partnerByTx = $state<Record<string, FinanceTxDto>>({});
  let loadError = $state(false);

  $effect(() => {
    fetched = null;
    partnerByTx = {};
    loadError = false;
    const current = mode;
    if (!current || !live) return;
    const api = financeApi(householdId);
    void (async () => {
      try {
        if (current.kind === 'ids') fetched = (await api.transactionsByIds(current.ids)).rows;
        else if (current.kind === 'grupo') fetched = (await api.transactionsByGroups([current.groupId])).rows;
        else if (!current.tx.raw && current.tx.transferGroupId) {
          // Espejo sin datos de fichero: los datos del origen son los del
          // cargo real emparejado en el mismo grupo (contrato del original).
          const legs = (await api.transactionsByGroups([current.tx.transferGroupId])).rows;
          const partner = legs.find((leg) => leg.id !== current.tx.id && leg.raw);
          if (partner) partnerByTx = { [current.tx.id]: partner };
        }
      } catch {
        loadError = true;
      }
    })();
  });

  const cards = $derived(detailCards(mode, fetched));
  const figures = $derived(summarizeTxs(cards));
  const heading = $derived(
    mode === null ? ''
      : mode.kind === 'movimiento' ? (mode.tx.providerDisplay || mode.tx.provider || mode.tx.concept)
      : mode.label
  );
</script>

{#if mode}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="sheet-backdrop" onclick={onClose}></div>
  <div class="finance-panel" role="dialog" aria-modal="true" aria-labelledby="finance-panel-title"
    use:modalDialog={{ onClose }}>
    <header class="finance-panel-head">
      <div>
        <h2 id="finance-panel-title">{heading}</h2>
        {#if mode.kind === 'ids' && mode.sub}<p class="finance-panel-sub">{mode.sub}</p>{/if}
        {#if mode.kind !== 'movimiento'}
          <p class="finance-panel-figs cifra pequena">
            {figures.count} mov{figures.count === 1 ? '' : 's'} · {formatCents(figures.totalCents.toString(), { signed: true })} · ticket {formatCents(figures.ticketCents.toString())}
          </p>
        {/if}
      </div>
      <button type="button" class="button secondary small-button" onclick={onClose} aria-label="Cerrar el detalle">✕</button>
    </header>

    {#if loadError}
      <p class="note error" role="status">No hemos podido cargar el detalle. Vuelve a intentarlo.</p>
    {:else if cards.length === 0 && mode.kind !== 'movimiento'}
      <p class="audit-note">{live ? 'Cargando…' : 'El detalle por grupo necesita conexión con la base de datos.'}</p>
    {/if}

    <div class="finance-panel-cards">
      {#each cards as tx (tx.id)}
        {@const origin = originRows(tx, partnerByTx[tx.id])}
        <article class="card">
          <div class="finance-panel-row">
            <span>
              <strong>{tx.concept}</strong>
              <small>{dateLabel(tx.opDate)} · {tx.accountName} · {STATUS_LABEL[tx.status] ?? tx.status}</small>
            </span>
            <strong class="cifra pequena">{formatCents(tx.amountCents, { signed: true })}</strong>
          </div>
          {#if tx.transferGroupId}<p class="audit-note">⇄ Transferencia interna (grupo vinculado).</p>{/if}
          {#if origin}
            <details class="finance-origen" open>
              <summary>{origin.label} · {origin.rows.length}</summary>
              <dl>
                {#each origin.rows as [key, value] (key)}
                  <div><dt>{key}</dt><dd>{value}</dd></div>
                {/each}
              </dl>
            </details>
          {/if}
        </article>
      {/each}
    </div>
  </div>
{/if}

<style>
  .finance-panel {
    position: fixed; z-index: 80; inset-block: 0; right: 0;
    display: grid; grid-template-rows: auto 1fr; align-content: start; gap: var(--space-3);
    width: min(28rem, 100%); overflow-y: auto;
    background: var(--surface); box-shadow: var(--shadow-over); padding: var(--pad-card);
  }
  .finance-panel-head { display: flex; align-items: start; justify-content: space-between; gap: var(--space-3); }
  .finance-panel-sub { color: var(--ink-soft); font-size: var(--text-meta); }
  .finance-panel-figs { color: var(--ink-soft); }
  .finance-panel-cards { display: grid; gap: var(--space-2); align-content: start; }
  .finance-panel-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); }
  .finance-panel-row > span { display: grid; min-width: 0; }
  .finance-panel-row small { color: var(--ink-faint); font-size: var(--text-meta); }
  .finance-origen summary { min-height: var(--row-data); cursor: pointer; color: var(--ink-soft); font-size: var(--text-meta); font-weight: 700; }
  .finance-origen dl { display: grid; gap: var(--space-1); margin: 0; }
  .finance-origen div { display: grid; grid-template-columns: minmax(6rem, 10rem) minmax(0, 1fr); gap: var(--space-2); font-size: var(--text-meta); }
  .finance-origen dt { color: var(--ink-faint); }
  .finance-origen dd { margin: 0; overflow-wrap: anywhere; }
</style>
