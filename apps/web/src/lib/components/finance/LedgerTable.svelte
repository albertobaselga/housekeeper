<script lang="ts">
  import type { FinanceTxDto } from '@housekeeper/server';
  import { ledgerRowMeta } from '$lib/finance/detail';
  import { formatCents } from '$lib/finance/format';

  let { rows, eventNameById, onOpen }: {
    rows: FinanceTxDto[];
    eventNameById: Record<string, string>;
    onOpen: (tx: FinanceTxDto) => void;
  } = $props();
</script>

<div class="ledger-list finance-ledger" data-lista="principal">
  {#each rows as tx (tx.id)}
    <button type="button" class="finance-row" onclick={() => onOpen(tx)}>
      <span>
        <strong>{tx.transferGroupId ? '⇄ ' : ''}{tx.providerDisplay || tx.provider || tx.concept}</strong>
        <small>{ledgerRowMeta(tx, eventNameById)}</small>
      </span>
      <strong class="cifra pequena" class:positivo={BigInt(tx.amountCents) > 0n}>
        {formatCents(tx.amountCents, { signed: true })}
      </strong>
    </button>
  {:else}
    <div><span><strong>Sin movimientos</strong><small>No hay movimientos con estos filtros.</small></span></div>
  {/each}
</div>

<style>
  .finance-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
    min-height: var(--row-action); width: 100%;
    border: 0; border-top: 1px solid var(--line); padding: var(--space-2) 0;
    background: none; text-align: left;
  }
  .finance-row:first-child { border-top: 0; }
  .finance-row > span { display: grid; min-width: 0; }
  .finance-row small { overflow: hidden; color: var(--ink-faint); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
  .positivo { color: var(--success); }
</style>
