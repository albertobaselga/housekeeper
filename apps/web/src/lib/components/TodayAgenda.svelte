<script lang="ts">
  import type { TodayAgendaItem } from '$lib/server/today.server';

  // Agenda real del día (eventos de los calendarios enlazados, Ola E). Se
  // carga como chunk aparte desde Hoy (mismo mecanismo que OutboxTriage) para
  // respetar el presupuesto de JavaScript inicial de 120 KB.
  let {
    householdId,
    agenda,
    showLink
  }: { householdId: string; agenda: TodayAgendaItem[]; showLink: boolean } = $props();
</script>

<article class="card" aria-labelledby="today-agenda-title">
  <div class="section-heading">
    <div><p class="eyebrow">Agenda</p><h2 id="today-agenda-title">Hoy en el calendario</h2></div>
    {#if showLink}
      <a href={`/h/${householdId}/calendar`}>Ver calendario →</a>
    {/if}
  </div>
  <div class="ledger-list">
    {#each agenda as event (event.id)}
      <div>
        <span>
          <strong>{event.title}</strong>
          <small>{event.timeLabel} · {event.sourceLabel}</small>
        </span>
      </div>
    {/each}
  </div>
</article>
