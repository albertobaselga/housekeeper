<script lang="ts">
  import { categoryOptionGroups, type FinanceCategoryOptionSource } from '$lib/finance/category-options';

  let {
    categories,
    value,
    onchange,
    label = 'Categoría'
  }: {
    categories: readonly FinanceCategoryOptionSource[];
    value: string | null;
    onchange: (categoryId: string) => void;
    label?: string;
  } = $props();

  const groups = $derived(categoryOptionGroups(categories));
</script>

<select
  aria-label={label}
  value={value ?? ''}
  onchange={(event) => {
    const next = event.currentTarget.value;
    if (next) onchange(next);
  }}
>
  <option value="" disabled>— categoría —</option>
  {#each groups as group (group.parentId)}
    {#if group.options.length === 1}
      <option value={group.options[0]!.id}>{group.options[0]!.label}</option>
    {:else}
      <optgroup label={group.label}>
        {#each group.options as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </optgroup>
    {/if}
  {/each}
</select>
