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
