<script lang="ts">
  import { groupExpenseCategories, type BreakdownRowInput } from '$lib/finance/breakdown';
  import { formatCents } from '$lib/finance/format';

  let { rows, categories, movementsHref }: {
    rows: BreakdownRowInput[];
    categories: { id: string; name: string; parentId: string | null }[];
    movementsHref: (categoryId: string) => string;
  } = $props();

  const nameById = $derived(new Map(categories.map((category) => [category.id, category.name])));
  // `group.percent` es el ancho de la barra en % (0–100), presentación pura ya
  // calculada por `groupExpenseCategories`; el importe real viaja en
  // `group.totalCents`/`sub.totalCents` (bigint) y solo pasa por `formatCents`.
  const groups = $derived(groupExpenseCategories(rows, nameById));
</script>

{#if groups.length === 0}
  <p class="audit-note">No hay gasto en este periodo.</p>
{:else}
  <div class="catbars">
    {#each groups as group (String(group.id))}
      <details class="catbar">
        <summary>
          <span class="catbar-name">{group.name}</span>
          <span class="catbar-track" aria-hidden="true"><i style="width: {group.percent}%"></i></span>
          <strong class="cifra pequena">{formatCents(group.totalCents)}</strong>
        </summary>
        <ul>
          {#each group.subs as sub, index (index)}
            <li>
              <span>{sub.name}
                {#if sub.categoryId !== null}
                  <a class="chip" href={movementsHref(sub.categoryId)}>ver →</a>
                {/if}
              </span>
              <strong class="cifra pequena">{formatCents(sub.totalCents)}</strong>
            </li>
          {/each}
        </ul>
      </details>
    {/each}
  </div>
{/if}

<style>
  .catbars { display: grid; gap: var(--space-2); }
  .catbar summary {
    display: grid; grid-template-columns: minmax(6rem, 10rem) minmax(0, 1fr) auto;
    align-items: center; gap: var(--space-3); min-height: var(--row-data); cursor: pointer;
  }
  .catbar-name { font-weight: 700; }
  .catbar-track { height: var(--space-4); overflow: hidden; border-radius: var(--r-sm); background: var(--primary-pale); }
  .catbar-track i { display: block; height: 100%; border-radius: var(--r-sm); background: var(--danger); opacity: .85; }
  .catbar ul { display: grid; gap: var(--space-1); margin: 0; padding: 0 0 var(--space-2); list-style: none; }
  .catbar li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); padding-left: var(--space-5); color: var(--ink-soft); font-size: var(--text-meta); }
</style>
