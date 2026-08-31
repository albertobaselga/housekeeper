<script lang="ts">
  /**
   * De quién es lo que se está mirando, dicho SIEMPRE que el hogar emplea a
   * más de una persona. Primero se elige a la persona (en la portada de
   * Contrato) y luego se miran sus detalles: por eso aquí no hay tira de
   * chips, solo el nombre y el camino de vuelta para cambiar.
   */
  let {
    householdId,
    employeeLabel,
    active = true
  }: {
    householdId: string;
    employeeLabel: string;
    active?: boolean;
  } = $props();
</script>

<p class="person-bar">
  <span>
    Expediente de <strong>{employeeLabel}</strong>{active ? '' : ' (acuerdo terminado)'}
  </span>
  <a class="button secondary small-button" href={`/h/${householdId}/employment`}>Cambiar</a>
</p>

<style>
  .person-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0 0 var(--space-4);
    border-radius: var(--r-md);
    background: var(--primary-pale);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-meta);
  }
</style>
