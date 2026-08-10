<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { CONTACT_KIND_LABELS } from '$lib/contacts/kinds';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const live = $derived(data.live);

  function telHref(phone: string): string {
    return `tel:${phone.replace(/[^+\d]/g, '')}`;
  }
</script>

<div class="page-wrap emergency-page">
  {#snippet actions()}<button class="button secondary print-button" type="button" onclick={() => window.print()}>Imprimir</button>{/snippet}
  <PageHeader eyebrow="Acceso prioritario" title="Emergencias" description="Esta pantalla se guarda en tu dispositivo: se abre aunque no haya cobertura." {actions} />

  <p class="offline-proof" role="status"><span aria-hidden="true">✓</span>{live ? 'Contactos del hogar · disponibles sin conexión' : data.emergency?.updatedLabel}</p>

  <section class="emergency-callout">
    <div><span aria-hidden="true">+</span><div><p>Emergencia vital</p><strong>112</strong></div></div>
    <a href="tel:112">Llamar al 112</a>
  </section>

  {#if live}
    <div class="emergency-layout">
      <section class="card"><p class="eyebrow">Contactos destacados del hogar</p><h2>A quién llamar</h2>
        {#if live.featured.length > 0}
          <div class="emergency-contacts">
            {#each live.featured as contact (contact.id)}
              <div>
                <span aria-hidden="true">{contact.name.slice(0, 1)}</span>
                <div><strong>{contact.name}</strong><small>{contact.roleLabel || CONTACT_KIND_LABELS[contact.kind]}</small></div>
                <a href={telHref(contact.phone)}>{contact.phone}</a>
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty-state">
            <span aria-hidden="true">☎</span>
            <h3>Añade los contactos de emergencia de tu hogar</h3>
            <p>
              Todavía no hay contactos destacados. Los que marques como «destacado» en el directorio
              aparecerán aquí y en el modo sin conexión.
            </p>
            {#if live.canWrite}
              <a class="button primary" href={`/h/${context.household.id}/contacts`}>Ir a Contactos</a>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {:else if data.emergency}
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
  {/if}
</div>
