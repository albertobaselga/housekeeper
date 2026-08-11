<script lang="ts">
  import type { TodayRoutinesView } from '$lib/server/today.server';

  /**
   * «Esta semana» (enmienda E5.3): lo que vence en los próximos días, para
   * decidir si da tiempo hoy o se planifica. Va DESPUÉS de lo de hoy y
   * claramente separado, porque no significa lo mismo: lo de hoy es lo que
   * toca; esto es información.
   *
   * NO ES ACCIONABLE a propósito: aquí no hay ninguna casilla ni ningún botón.
   * Marcar por adelantado una tarea que aún no se ha hecho es una mentira, y en
   * una lista de planificación el gesto estaría a un dedo de distancia del de
   * hoy. Lo único que se puede abrir es el detalle (E5.2).
   *
   * Vive en su propio chunk, cargado con `import()` desde Hoy —igual que la
   * agenda y el triaje del outbox—: la propia enmienda dice «cabe en el
   * presupuesto o va en carga diferida; se mide, no se supone», y medido no
   * cabía. Los textos vienen todos resueltos del servidor, así que este
   * componente no calcula ni formatea nada.
   */
  let { view }: { view: TodayRoutinesView } = $props();
</script>

{#if view.week.length > 0 || view.weekRepeats.length > 0}
<section class="routine-week" aria-labelledby="today-week-title">
  <h3 id="today-week-title">Esta semana</h3>
  {#if view.weekRepeats.length > 0}
    <!-- Lo que se repite casi a diario, dicho UNA vez con su cadencia: siete
         líneas iguales no ayudan a planificar nada. -->
    <ul class="routine-week-repeats">
      {#each view.weekRepeats as repeat (repeat.key)}
        <li>{repeat.title} <small>{repeat.cadence}</small></li>
      {/each}
    </ul>
  {/if}
  {#each view.week as group (group.key)}
    <h4>{group.label}</h4>
    <ul aria-label={group.label}>
      {#each group.items as item (item.key)}
        <li>
          {#if item.details}
            <details class="routine-detail"><summary>{item.title}</summary><p>{item.details}</p></details>
          {:else}
            {item.title}
          {/if}
        </li>
      {/each}
    </ul>
  {/each}
</section>
{/if}
