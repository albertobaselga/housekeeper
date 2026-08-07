<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import {
    parseEuroInput,
    queueEmploymentCommand,
    resolveExpense,
    submitExpense
  } from '$lib/employment/commands';
  import type { PendingExpenseView } from '$lib/employment/model';

  let {
    householdId,
    agreementId,
    expenses,
    canSubmit,
    canResolve
  }: {
    householdId: string;
    agreementId: string;
    expenses: PendingExpenseView[];
    canSubmit: boolean;
    canResolve: boolean;
  } = $props();

  let busy = $state(false);
  let queued = $state(false);
  let acted = $state<string[]>([]);

  let resolveOpenId = $state<string | null>(null);
  let resolveReason = $state('');

  let expenseDate = $state(new Date().toISOString().slice(0, 10));
  let expenseDescription = $state('');
  let expenseAmount = $state('');
  let expenseError = $state<string | null>(null);
  let expenseSent = $state(false);

  async function run(envelope: Parameters<typeof queueEmploymentCommand>[0], entityId?: string): Promise<void> {
    busy = true;
    try {
      const outcome = await queueEmploymentCommand(envelope);
      queued = outcome === 'queued';
      if (outcome === 'synced') {
        // El servidor ya lo aplicó: el overview fresco decide qué acciones quedan.
        await invalidateAll();
      } else if (entityId) {
        acted = [...acted, entityId];
      }
    } finally {
      busy = false;
    }
  }

  async function submitNewExpense(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // El importe en euros se convierte a céntimos sin pasar por floats.
    const amountCents = parseEuroInput(expenseAmount);
    if (!amountCents) {
      expenseError = 'Importe inválido: usa un número positivo, p. ej. 12,50';
      return;
    }
    if (!expenseDate || !expenseDescription.trim()) return;
    expenseError = null;
    await run(
      submitExpense({
        householdId,
        agreementId,
        incurredOn: expenseDate,
        description: expenseDescription,
        amountCents
      })
    );
    expenseDescription = '';
    expenseAmount = '';
    expenseSent = true;
  }

  async function decide(expenseId: string, resolution: 'approved' | 'rejected'): Promise<void> {
    if (!resolveReason.trim()) return;
    await run(
      resolveExpense({ householdId, expenseId, resolution, reason: resolveReason }),
      expenseId
    );
    resolveOpenId = null;
    resolveReason = '';
  }
</script>

<article class="card">
  <div class="section-heading">
    <div><p class="eyebrow">Gastos</p><h2>Gastos pendientes</h2></div>
    {#if expenses.length > 0}<span class="status-chip warning">{expenses.length} por revisar</span>{/if}
  </div>

  <div class="ledger-list">
    {#each expenses as expense (expense.id)}
      <div id={`gasto-${expense.id}`}>
        <span>
          <strong>{expense.description}</strong>
          <small>{expense.incurredOnLabel} · pendiente de aprobación</small>
        </span>
        <span class="inline-actions">
          <strong>{expense.amountLabel}</strong>
          {#if acted.includes(expense.id)}
            <span class="status-chip success">Enviado</span>
          {:else if canResolve}
            <button
              class="button secondary small-button"
              type="button"
              disabled={busy}
              aria-expanded={resolveOpenId === expense.id}
              onclick={() => { resolveOpenId = resolveOpenId === expense.id ? null : expense.id; resolveReason = ''; }}
            >Revisar</button>
          {/if}
        </span>
      </div>
      {#if canResolve && resolveOpenId === expense.id && !acted.includes(expense.id)}
        <form class="action-form" onsubmit={(event) => { event.preventDefault(); void decide(expense.id, 'approved'); }}>
          <label>Motivo de la decisión
            <input type="text" bind:value={resolveReason} maxlength="500" required placeholder="Justificante correcto, gasto del hogar…" />
          </label>
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={busy || !resolveReason.trim()}>Aprobar</button>
            <button
              class="button secondary small-button"
              type="button"
              disabled={busy || !resolveReason.trim()}
              onclick={() => void decide(expense.id, 'rejected')}
            >Rechazar</button>
          </div>
        </form>
      {/if}
    {:else}
      <div><span><strong>Sin gastos pendientes</strong><small>No hay justificantes esperando revisión.</small></span></div>
    {/each}
  </div>

  {#if canSubmit}
    <form class="action-form" onsubmit={(event) => void submitNewExpense(event)}>
      <h3>Añadir gasto</h3>
      <div class="form-grid">
        <label>Fecha
          <input type="date" bind:value={expenseDate} required />
        </label>
        <label>Importe (€)
          <input type="text" inputmode="decimal" bind:value={expenseAmount} required placeholder="12,50" />
        </label>
      </div>
      <label>Descripción
        <input type="text" bind:value={expenseDescription} maxlength="500" required placeholder="Farmacia, compra…" />
      </label>
      {#if expenseError}<p class="queued-note" role="alert">{expenseError}</p>{/if}
      <div class="action-row">
        <button class="button primary small-button" type="submit" disabled={busy}>Añadir gasto</button>
        {#if expenseSent && !queued}<span class="status-chip success">Enviado</span>{/if}
      </div>
    </form>
  {/if}

  {#if queued}
    <p class="queued-note" role="status">Guardado en este dispositivo; se sincronizará al recuperar la conexión.</p>
  {/if}
</article>
