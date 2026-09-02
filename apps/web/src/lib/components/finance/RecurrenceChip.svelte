<script lang="ts">
  import { parseRecurrence } from '$lib/finance/manual-form';

  let {
    value,
    onchange,
    label = 'Tipo de gasto'
  }: {
    value: 'recurrente' | 'extraordinario' | null;
    onchange: (next: 'recurrente' | 'extraordinario' | null) => void;
    /** Rótulo accesible: el nombre por defecto para las tablas, o el de un
     * `<label>` envolvente cuando lo pide quien la usa (ManualForm, mismo
     * patrón que CategorySelect). */
    label?: string;
  } = $props();
</script>

<select
  aria-label={label}
  value={value ?? ''}
  onchange={(event) => onchange(parseRecurrence(event.currentTarget.value))}
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
