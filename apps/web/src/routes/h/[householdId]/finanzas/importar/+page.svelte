<script lang="ts">
  import { invalidate } from '$app/navigation';
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

  const BANK_LABELS: Record<string, string> = {
    caixabank: 'CaixaBank', deutsche_bank: 'Deutsche Bank', openbank: 'OpenBank', amex: 'American Express'
  };

  interface Preview {
    bank: string; newCount: number; dupCount: number; unknownRefs: string[];
    sample: Array<{ opDate: string; concept: string; provider: string | null; amountCents: string }>;
  }
  interface NewAccountDraft { bankRef: string; name: string; kind: string; ownerLabel: string }

  let file = $state<File | null>(null);
  let preview = $state<Preview | null>(null);
  let newAccounts = $state<NewAccountDraft[]>([]);
  let busy = $state(false);
  let importError = $state<string | null>(null);
  let importSuccess = $state<string | null>(null);

  const confirmDisabled = $derived(busy || newAccounts.some((draft) => !draft.name.trim()));

  async function doPreview(chosen: File): Promise<void> {
    busy = true;
    importError = null;
    importSuccess = null;
    try {
      const form = new FormData();
      form.append('file', chosen);
      const response = await fetch(`/api/v1/finance/imports/preview?household=${context.household.id}`, {
        method: 'POST',
        body: form
      });
      if (!response.ok) {
        importError = `No se pudo analizar el fichero: ${await response.text()}`;
        return;
      }
      const result = (await response.json()) as Preview;
      file = chosen;
      preview = result;
      newAccounts = result.unknownRefs.map((bankRef) => ({ bankRef, name: '', kind: 'personal', ownerLabel: 'familia' }));
    } finally {
      busy = false;
    }
  }

  async function doConfirm(): Promise<void> {
    if (!file || !preview) return;
    busy = true;
    importError = null;
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('payload', JSON.stringify({
        newAccounts: newAccounts.map((draft) => ({
          bankRef: draft.bankRef, name: draft.name.trim(), kind: draft.kind, ownerLabel: draft.ownerLabel
        }))
      }));
      const response = await fetch(`/api/v1/finance/imports/confirm?household=${context.household.id}`, {
        method: 'POST',
        body: form
      });
      if (!response.ok) {
        importError = `No se pudo confirmar la importación: ${await response.text()}`;
        return;
      }
      const result = (await response.json()) as { newCount: number; dupCount: number };
      importSuccess = `Importadas ${result.newCount} nuevas (${result.dupCount} duplicadas).`;
      file = null;
      preview = null;
      newAccounts = [];
      await invalidate('cc:finance');
    } finally {
      busy = false;
    }
  }

  function undoBatch(batch: { id: string; filename: string }): void {
    if (!window.confirm(`¿Deshacer la importación de ${batch.filename}?`)) return;
    // El aviso de confirmación («Importadas N nuevas…») es del flujo de
    // fichero, no de un comando: `OptimisticActions` no lo conoce y no lo
    // retira solo. Sin este reset se quedaba en pantalla para siempre —ni un
    // nuevo fichero ni el propio deshacer lo tocaban— y competía con la nota
    // «Guardado ✓» de `ActionStatus`, dos `.success-message` a la vez.
    importSuccess = null;
    importError = null;
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.import.undo', batchId: batch.id }));
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Importar" support="CaixaBank, Deutsche Bank, OpenBank o Amex" />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />
  <ActionStatus status={actionStatus} />
  {#if importSuccess}<p class="success-message" role="status">{importSuccess}</p>{/if}
  {#if importError}<p class="form-error" role="alert">{importError}</p>{/if}

  <label class="button primary importar-boton">
    Elegir fichero (.xls/.xlsx)
    <input type="file" accept=".xls,.xlsx" hidden
      onchange={(event) => {
        const chosen = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (chosen) void doPreview(chosen);
      }} />
  </label>
  {#if busy}<p role="status">Analizando…</p>{/if}

  {#if preview}
    <section>
      <h2>Previsualización — {BANK_LABELS[preview.bank] ?? preview.bank}</h2>
      <p><span class="status-chip">{preview.newCount} nuevas</span> <span class="status-chip">{preview.dupCount} duplicadas</span></p>
      {#each newAccounts as draft, index (draft.bankRef)}
        <fieldset class="cuenta-nueva">
          <legend>Cuenta nueva detectada: <span class="cifra">{draft.bankRef}</span></legend>
          <label>Nombre de la cuenta nueva
            <input value={draft.name} placeholder="p. ej. Cuenta común OpenBank"
              oninput={(event) => (newAccounts = newAccounts.map((entry, at) => (at === index ? { ...entry, name: event.currentTarget.value } : entry)))} />
          </label>
          <label>Tipo
            <select value={draft.kind}
              onchange={(event) => (newAccounts = newAccounts.map((entry, at) => (at === index ? { ...entry, kind: event.currentTarget.value } : entry)))}>
              <option value="comun">común</option><option value="personal">personal</option><option value="inversion">inversión</option>
            </select>
          </label>
          <label>Titular
            <input value={draft.ownerLabel}
              oninput={(event) => (newAccounts = newAccounts.map((entry, at) => (at === index ? { ...entry, ownerLabel: event.currentTarget.value } : entry)))} />
          </label>
        </fieldset>
      {/each}
      <div class="importar-scroll">
        <table class="wiki-table">
          <thead><tr><th>Fecha</th><th>Concepto</th><th>Importe</th></tr></thead>
          <tbody>
            {#each preview.sample as row, index (index)}
              <tr>
                <td class="cifra">{row.opDate}</td>
                <td title={row.concept}>{row.provider ?? row.concept}</td>
                <td class="cifra">{formatCents(row.amountCents)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <button class="button primary" type="button" disabled={confirmDisabled} onclick={() => void doConfirm()}>
        Confirmar importación
      </button>
    </section>
  {/if}

  <section>
    <h2>Historial de importaciones</h2>
    {#if !data.importar}
      <p class="empty-state">Ahora mismo no podemos leer el historial.</p>
    {:else if data.importar.batches.length === 0}
      <p class="empty-state">Aún no se ha importado ningún extracto.</p>
    {:else}
      <div class="importar-scroll">
        <table class="wiki-table">
          <thead><tr><th>Fecha</th><th>Fichero</th><th>Banco</th><th>Nuevas</th><th>Dup.</th><th></th></tr></thead>
          <tbody>
            {#each data.importar.batches as batch (batch.id)}
              <tr>
                <td class="cifra">{batch.importedAt.slice(0, 16).replace('T', ' ')}</td>
                <td>{batch.filename}</td>
                <td>{BANK_LABELS[batch.bank] ?? batch.bank}</td>
                <td class="cifra">{batch.newCount}</td>
                <td class="cifra">{batch.dupCount}</td>
                <td><button class="button secondary small-button" type="button" onclick={() => undoBatch(batch)}>Deshacer</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>

<style>
  .importar-boton { display: inline-block; }
  .importar-scroll { overflow-x: auto; }
  .cuenta-nueva { display: grid; gap: var(--space-2); }
</style>
