<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Emergencias · Casa Clara</title></svelte:head>

<div class="page-wrap emergency-page">
  {#snippet actions()}<button class="button secondary print-button" type="button" onclick={() => window.print()}>Imprimir</button>{/snippet}
  <PageHeader eyebrow="Acceso prioritario" title="Emergencias" description="Información breve, accionable y conservada en el snapshot crítico." {actions} />

  <p class="offline-proof" role="status"><span aria-hidden="true">✓</span>{data.emergency.updatedLabel}</p>

  <section class="emergency-callout">
    <div><span aria-hidden="true">+</span><div><p>Emergencia vital</p><strong>112</strong></div></div>
    <a href="tel:112">Llamar al 112</a>
  </section>

  <div class="emergency-layout">
    <section class="card"><p class="eyebrow">Contactos prioritarios</p><h2>A quién llamar</h2>
      <div class="emergency-contacts">
        {#each data.emergency.contacts as contact}
          <div><span aria-hidden="true">{contact.name.slice(0, 1)}</span><div><strong>{contact.name}</strong><small>{contact.role}</small></div><a href={`tel:${contact.phone.replaceAll(' ', '')}`}>{contact.phone}</a></div>
        {/each}
      </div>
    </section>
    <section class="card"><p class="eyebrow">Pasos seguros</p><h2>Qué hacer primero</h2>
      <ol class="instruction-list">
        {#each data.emergency.instructions as instruction, index}<li><span>{index + 1}</span><div><strong>{instruction.title}</strong><p>{instruction.body}</p></div></li>{/each}
      </ol>
    </section>
  </div>
</div>
