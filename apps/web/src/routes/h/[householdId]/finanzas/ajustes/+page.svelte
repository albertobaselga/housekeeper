<script lang="ts">
  import { page } from '$app/state';
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

  // svelte-ignore state_referenced_locally -- valor inicial del filtro (enlace ✎ de otras páginas)
  let providerFilter = $state(page.url.searchParams.get('prov') ?? '');
  let newSub = $state<{ parentId: string; name: string } | null>(null);

  const accounts = $derived(data.ajustes?.accounts ?? []);
  const categories = $derived(data.ajustes?.categories ?? []);
  const parents = $derived(categories.filter((cat) => cat.parentId === null));
  const providerRows = $derived(
    (data.ajustes?.providers ?? []).filter((row) =>
      (row.provider ?? '').toLowerCase().includes(providerFilter.toLowerCase())
    )
  );

  // Guardas sin `as` (Ruling R7): las dos vienen de un `<select>` con opciones
  // fijas, así que el valor siempre encaja — la guarda documenta esa garantía
  // en vez de forzarla con una aserción.
  function isAccountKind(value: string): value is 'comun' | 'personal' | 'inversion' {
    return value === 'comun' || value === 'personal' || value === 'inversion';
  }

  function isCategoryKind(value: string): value is 'gasto' | 'ingreso' {
    return value === 'gasto' || value === 'ingreso';
  }

  function saveAccount(account: (typeof accounts)[number], patch: Partial<(typeof accounts)[number]>): void {
    const next = { ...account, ...patch };
    if (!isAccountKind(next.kind)) return;
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.account.update',
        accountId: next.id,
        name: next.name,
        accountKind: next.kind,
        ownerLabel: next.ownerLabel,
        ownerAliases: next.ownerAliases,
        transferRefs: next.transferRefs
      })
    );
  }

  function addSubcategory(parent: { id: string; kind: string }, name: string): void {
    if (!isCategoryKind(parent.kind)) return;
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.category.create',
        name,
        categoryKind: parent.kind,
        parentId: parent.id
      }),
      { settle: () => (newSub = null) }
    );
  }

  function deleteCategory(categoryId: string): void {
    if (!window.confirm('¿Borrar esta categoría?')) return;
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.category.delete', categoryId }));
  }

  function deleteRule(ruleId: string): void {
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.rule.delete', ruleId }));
  }

  function saveAlias(provider: string, current: string | null, next: string): void {
    if (next.trim() === (current ?? '')) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.alias.update', provider, alias: next.trim() })
    );
  }

  function parseList(value: string, separator: string): string[] {
    return value.split(separator).map((part) => part.trim()).filter(Boolean);
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Ajustes del módulo" support="Cuentas, categorías, reglas y alias" />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />
  <ActionStatus status={actionStatus} />

  {#if !data.ajustes}
    <p class="empty-state">Ahora mismo no podemos leer los ajustes.</p>
  {:else if accounts.length === 0 && categories.length === 0}
    <p class="empty-state">Aún no hay cuentas ni categorías que configurar.</p>
  {:else}
    <section>
      <h2>Cuentas</h2>
      <div class="ajustes-scroll">
        <table class="wiki-table">
          <thead><tr><th>Nombre</th><th>Banco</th><th>Ref</th><th>Tipo</th><th>Titular</th><th>Alias de titulares (;)</th><th>Refs transferencia (,)</th></tr></thead>
          <tbody>
            {#each accounts as account (account.id)}
              <tr>
                <td><input aria-label={`Nombre de ${account.name}`} value={account.name}
                  onblur={(event) => event.currentTarget.value !== account.name && saveAccount(account, { name: event.currentTarget.value })} /></td>
                <td>{account.bank}</td>
                <td class="cifra">…{account.bankRef.slice(-4)}</td>
                <td>
                  <select aria-label={`Tipo de ${account.name}`} value={account.kind}
                    onchange={(event) => saveAccount(account, { kind: event.currentTarget.value })}>
                    <option value="comun">común</option><option value="personal">personal</option><option value="inversion">inversión</option>
                  </select>
                </td>
                <td><input aria-label={`Titular de ${account.name}`} value={account.ownerLabel}
                  onblur={(event) => event.currentTarget.value !== account.ownerLabel && saveAccount(account, { ownerLabel: event.currentTarget.value })} /></td>
                <td><input aria-label={`Alias de titulares de ${account.name}`} value={account.ownerAliases.join('; ')}
                  onblur={(event) => saveAccount(account, { ownerAliases: parseList(event.currentTarget.value, ';') })} /></td>
                <td>
                  {#if account.kind === 'inversion'}
                    <input aria-label={`Referencias de transferencia de ${account.name}`} value={account.transferRefs.join(', ')}
                      onblur={(event) => saveAccount(account, { transferRefs: parseList(event.currentTarget.value, ',') })} />
                  {:else}—{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Categorías</h2>
      {#each parents as parent (parent.id)}
        <div class="categoria-fila">
          <strong>{parent.name}</strong> <span class="status-chip">{parent.kind}</span>
          {#if parent.kind !== 'transferencia'}
            <button class="button secondary small-button" type="button"
              onclick={() => (newSub = { parentId: parent.id, name: '' })}>+ sub</button>
            <button class="button danger small-button" type="button" onclick={() => deleteCategory(parent.id)}>Borrar</button>
          {/if}
          <div class="subcategorias">
            {#each categories.filter((cat) => cat.parentId === parent.id) as child (child.id)}
              <span class="status-chip">{child.name}
                <button class="button secondary small-button" type="button" title={`Borrar ${child.name}`}
                  onclick={() => deleteCategory(child.id)}>×</button>
              </span>
            {/each}
            {#if newSub?.parentId === parent.id}
              <form onsubmit={(event) => { event.preventDefault(); if (newSub?.name.trim()) addSubcategory(parent, newSub.name.trim()); }}>
                <input aria-label="Nueva subcategoría" placeholder="nueva subcategoría ⏎" value={newSub.name}
                  oninput={(event) => (newSub = { parentId: parent.id, name: event.currentTarget.value })}
                  onkeydown={(event) => { if (event.key === 'Escape') newSub = null; }} />
              </form>
            {/if}
          </div>
        </div>
      {/each}
    </section>

    <section>
      <h2>Reglas de categorización</h2>
      <div class="ajustes-scroll">
        <table class="wiki-table">
          <thead><tr><th>Patrón</th><th>Tipo</th><th>Categoría</th><th>Origen</th><th></th></tr></thead>
          <tbody>
            {#each data.ajustes.rules as rule (rule.id)}
              <tr>
                <td class="cifra">{rule.pattern}</td>
                <td>{rule.ruleType}</td>
                <td>{rule.categoryName ?? '—'}</td>
                <td><span class="status-chip">{rule.origin}</span></td>
                <td><button class="button danger small-button" type="button" onclick={() => deleteRule(rule.id)}>Borrar</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Alias de proveedores</h2>
      <label>Filtrar proveedor
        <input bind:value={providerFilter} placeholder="Filtrar proveedor…" />
      </label>
      <div class="ajustes-scroll">
        <table class="wiki-table">
          <thead><tr><th>Proveedor</th><th>Alias</th><th>Nº mov</th><th>Total</th></tr></thead>
          <tbody>
            {#each providerRows as row (row.providerNorm)}
              <tr>
                <td class="cifra">{row.provider}</td>
                <td><input aria-label={`Alias de ${row.provider}`} value={row.alias ?? ''} placeholder="— sin alias —"
                  onblur={(event) => saveAlias(row.provider, row.alias, event.currentTarget.value)} /></td>
                <td class="cifra">{row.count}</td>
                <td class="cifra">{formatCents(row.totalCents)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>

<style>
  .ajustes-scroll { overflow-x: auto; }
  .categoria-fila { display: grid; gap: var(--space-1); padding: var(--space-2) 0; border-bottom: 1px solid var(--line); }
  .subcategorias { display: flex; flex-wrap: wrap; gap: var(--space-2); }

  /*
    Piso táctil de 44 px (mobile-densidad.dbe2e.ts, A3): a diferencia de
    CategorySelect/RecurrenceChip, esta pantalla no reutiliza esos
    componentes —edita campos propios de Ajustes (nombre, titular, alias,
    referencias)—, así que necesita su propia regla, con el mismo token
    --row-data que el resto del sistema.
  */
  input, select { min-height: var(--row-data); }
</style>
