<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  const canWrite = context.capabilities.includes('menu.write');
  let selected = $state(4);
</script>

<svelte:head><title>Menú · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#snippet actions()}{#if canWrite}<button class="button primary" type="button">Editar semana</button>{/if}{/snippet}
  <PageHeader eyebrow={data.menu.weekLabel} title="Menú de la casa" description="Una semana visible de un vistazo, con notas que importan." {actions} />

  <div class="day-tabs" role="tablist" aria-label="Días de la semana">
    {#each data.menu.days as day, index}
      <button type="button" role="tab" aria-selected={selected === index} class:active={selected === index} onclick={() => selected = index}>
        <span>{day.day}</span><strong>{day.date}</strong>
      </button>
    {/each}
  </div>

  <section class="menu-layout">
    <article class="card featured-day">
      <p class="eyebrow">{data.menu.days[selected].day} {data.menu.days[selected].date}</p>
      <h2>Comidas previstas</h2>
      <div class="meal-feature"><span>14:00</span><div><small>Comida</small><strong>{data.menu.days[selected].lunch}</strong></div></div>
      <div class="meal-feature"><span>20:30</span><div><small>Cena</small><strong>{data.menu.days[selected].dinner}</strong></div></div>
      <aside class="allergen-note"><strong>Nota de preparación</strong><p>{data.menu.days[selected].note}</p></aside>
    </article>

    <article class="card week-overview">
      <div class="section-heading"><div><p class="eyebrow">Plan semanal</p><h2>El resto de la semana</h2></div><a href={`/h/${context.household.id}/recipes`}>Recetas →</a></div>
      {#each data.menu.days as day, index}
        <button type="button" class:active={selected === index} onclick={() => selected = index}>
          <span class="date-tile"><small>{day.day}</small><strong>{day.date}</strong></span>
          <span><strong>{day.lunch}</strong><small>{day.dinner}</small></span>
          <span aria-hidden="true">›</span>
        </button>
      {/each}
    </article>
  </section>
</div>
