<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
</script>

<svelte:head><title>Contactos · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#snippet actions()}{#if context.capabilities.includes('contact.write')}<button class="button primary" type="button">Añadir contacto</button>{/if}{/snippet}
  <PageHeader eyebrow="Directorio compartido" title="Contactos" description="Personas y servicios útiles, con los esenciales siempre a mano." {actions} />

  <section class="contact-grid">
    {#each data.contacts.contacts as contact}
      <article class="card contact-card" class:featured={contact.featured}>
        <span class={`contact-avatar ${contact.kind}`} aria-hidden="true">{contact.kind === 'emergency' ? '+' : contact.name.slice(0, 1)}</span>
        <div><p class="eyebrow">{contact.role}</p><h2>{contact.name}</h2><a href={`tel:${contact.phone.replaceAll(' ', '')}`}>{contact.phone}</a></div>
        <a class="call-button" href={`tel:${contact.phone.replaceAll(' ', '')}`} aria-label={`Llamar a ${contact.name}`}>Llamar</a>
      </article>
    {/each}
  </section>
</div>
