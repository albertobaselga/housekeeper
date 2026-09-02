<script lang="ts">
  import CategorySelect from './CategorySelect.svelte';
  import { manualAmountCents } from '$lib/finance/manual-form';
  import type { FinanceCategoryOptionSource } from '$lib/finance/category-options';

  let {
    accounts,
    categories,
    onsubmit,
    oncancel
  }: {
    accounts: ReadonlyArray<{ id: string; name: string; kind: string }>;
    categories: readonly FinanceCategoryOptionSource[];
    onsubmit: (input: {
      accountId: string;
      opDate: string;
      concept: string;
      provider: string;
      amountCents: string;
      categoryId: string | null;
      recurrence: 'recurrente' | 'extraordinario' | null;
    }) => void;
    oncancel: () => void;
  } = $props();

  const selectable = $derived(accounts.filter((account) => account.kind !== 'inversion'));

  let movementKind = $state<'gasto' | 'ingreso'>('gasto');
  let amount = $state('');
  let opDate = $state(new Date().toISOString().slice(0, 10));
  let concept = $state('');
  let provider = $state('');
  // svelte-ignore state_referenced_locally -- solo es el valor inicial del campo
  let accountId = $state(
    accounts.find((account) => account.name.toLowerCase() === 'efectivo')?.id ?? accounts[0]?.id ?? ''
  );
  let categoryId = $state<string | null>(null);
  let recurrence = $state<'recurrente' | 'extraordinario' | null>(null);
  let formError = $state<string | null>(null);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const amountCents = manualAmountCents(amount, movementKind);
    if (!amountCents) {
      formError = 'Importe inválido: escribe un número mayor que cero, p. ej. 12,50';
      return;
    }
    if (concept.trim().length < 3 || !accountId) {
      formError = 'Faltan datos: concepto (mínimo 3 letras) y cuenta';
      return;
    }
    formError = null;
    onsubmit({
      accountId,
      opDate,
      concept: concept.trim(),
      provider: provider.trim(),
      amountCents,
      categoryId,
      recurrence
    });
  }
</script>

<form class="action-form" onsubmit={submit}>
  <fieldset>
    <legend>Añadir movimiento manual</legend>
    <label>Tipo
      <select bind:value={movementKind}>
        <option value="gasto">Gasto</option>
        <option value="ingreso">Ingreso</option>
      </select>
    </label>
    <label>Importe (€)<input inputmode="decimal" placeholder="0,00" bind:value={amount} /></label>
    <label>Fecha<input type="date" bind:value={opDate} /></label>
    <label>Concepto<input bind:value={concept} placeholder="Descripción…" /></label>
    <label>Proveedor<input bind:value={provider} placeholder="Beneficiario (opcional)" /></label>
    <label>Cuenta
      <select bind:value={accountId}>
        {#each selectable as account (account.id)}<option value={account.id}>{account.name}</option>{/each}
      </select>
    </label>
    <label>Categoría
      <CategorySelect {categories} value={categoryId} onchange={(id) => (categoryId = id)} />
    </label>
    <label>Recurrencia
      <select
        value={recurrence ?? ''}
        onchange={(event) => {
          const next = event.currentTarget.value;
          recurrence = next === '' ? null : (next as 'recurrente' | 'extraordinario');
        }}
      >
        <option value="">— sin clasificar —</option>
        <option value="recurrente">♻ Recurrente</option>
        <option value="extraordinario">✦ Extraordinario</option>
      </select>
    </label>
    {#if formError}<p class="form-error" role="alert">{formError}</p>{/if}
    <div>
      <button class="button primary" type="submit">Guardar</button>
      <button class="button secondary" type="button" onclick={oncancel}>Cancelar</button>
    </div>
  </fieldset>
</form>
