<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { ROLE_LABELS, type Role } from '$lib/auth/capabilities';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Ajustes · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader eyebrow="Administración" title="Ajustes del hogar" description="Miembros, acceso y preferencias generales de esta demo." />

  <div class="settings-layout">
    <section class="card"><p class="eyebrow">Miembros</p><h2>Accesos activos</h2>
      <div class="member-list">
        {#each data.settings.members as member}
          <div><span class="avatar">{member.initials}</span><span><strong>{member.name}</strong><small>{ROLE_LABELS[member.role as Role]}</small></span><span class="status-chip success">Demo</span></div>
        {/each}
      </div>
    </section>
    <div class="stack">
      <section class="card"><p class="eyebrow">Hogar</p><h2>{data.settings.household.name}</h2><dl class="settings-list"><div><dt>Idioma</dt><dd>{data.settings.preferences.locale}</dd></div><div><dt>Zona horaria</dt><dd>{data.settings.preferences.timeZone}</dd></div><div><dt>Primero de la semana</dt><dd>{data.settings.preferences.weekStarts}</dd></div></dl></section>
      <section class="card warning-card"><p class="eyebrow">Entorno de prueba</p><h2>Datos exclusivamente sintéticos</h2><p>Las sesiones viven en memoria y desaparecen al reiniciar el servidor. Esta interfaz no sustituye autenticación ni RLS de producción.</p></section>
    </div>
  </div>
</div>
