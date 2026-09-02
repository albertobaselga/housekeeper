<script lang="ts">
  let {
    value,
    onchange
  }: {
    value: 'recurrente' | 'extraordinario' | null;
    onchange: (next: 'recurrente' | 'extraordinario' | null) => void;
  } = $props();
</script>

<select
  aria-label="Tipo de gasto"
  value={value ?? ''}
  onchange={(event) => {
    const next = event.currentTarget.value;
    onchange(next === '' ? null : (next as 'recurrente' | 'extraordinario'));
  }}
>
  <option value="">—</option>
  <option value="recurrente">♻ Recurrente</option>
  <option value="extraordinario">✦ Extraordinario</option>
</select>

<style>
  /* [FASE 5, T10 · corrección ronda 2, Important 1] Ver CategorySelect.svelte:
     mismo piso táctil de 44 px, mismo motivo. */
  select { min-height: var(--row-data); }
</style>
