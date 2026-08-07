<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
</script>

<svelte:head><title>Calendario · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#snippet actions()}{#if context.capabilities.includes('calendar.write')}<button class="button primary" type="button">Nuevo evento</button>{/if}{/snippet}
  <PageHeader eyebrow={data.calendar.month} title="Calendario" description="Solo lo que afecta a la casa y a quien necesita verlo." {actions} />

  <!-- Única fixture restante sin versión real: su fuente verdadera será el
       espejo ICS. Banda honesta hasta entonces (P2-2 de la re-auditoría). -->
  <p class="demo-note" role="note">Contenido de demostración: estos eventos no son de tu hogar. El calendario real llegará con la conexión ICS.</p>

  <div class="calendar-layout">
    <section class="card mini-calendar" aria-label={data.calendar.month}>
      <header><button type="button" aria-label="Mes anterior">←</button><h2>{data.calendar.month}</h2><button type="button" aria-label="Mes siguiente">→</button></header>
      <div class="calendar-grid week-labels" aria-hidden="true">{#each ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as day}<span>{day}</span>{/each}</div>
      <div class="calendar-grid dates">
        {#each Array(35) as _, index}
          {@const date = index - 4}
          <button type="button" class:muted={date < 1 || date > 31} class:today={date === 7} tabindex={date < 1 || date > 31 ? -1 : 0}>{date < 1 ? 31 + date : date > 31 ? date - 31 : date}</button>
        {/each}
      </div>
    </section>

    <section class="card event-list"><div class="section-heading"><div><p class="eyebrow">Próximamente</p><h2>Agenda compartida</h2></div></div>
      {#each data.calendar.events as event}
        <article><span class={`event-dot ${event.tone}`} aria-hidden="true"></span><time><strong>{event.date}</strong><span>{event.time}</span></time><div><strong>{event.title}</strong><small>{event.audience}</small></div></article>
      {/each}
    </section>
  </div>
</div>
