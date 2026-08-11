<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { CONTACT_KIND_LABELS } from '$lib/contacts/kinds';
  import { readCriticalSnapshot } from '$lib/offline/idb';
  import { isSavedHouseholdData, savedAtLabel } from '$lib/offline/saved';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const live = $derived(data.live);

  /**
   * Contactos del paquete offline firmado, usados SOLO cuando el servidor no
   * ha podido leer los de la casa. Se aceptan únicamente si el paquete es de
   * contenido real (`live-…`): un paquete de demostración guardado en este
   * mismo navegador jamás se enseña como si fuera esta casa.
   */
  let saved = $state<{ label: string; contacts: Array<{ id: string; name: string; phone: string; kind: string }> } | null>(
    null
  );

  onMount(async () => {
    if (!browser || !data.unreadable) return;
    try {
      const snapshot = await readCriticalSnapshot(context.household.id);
      if (!isSavedHouseholdData(snapshot)) return;
      const contacts = snapshot!.payload.contacts.filter(
        (entry): entry is { id: string; name: string; phone: string; kind: string } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === 'string' &&
          typeof (entry as { name?: unknown }).name === 'string' &&
          typeof (entry as { phone?: unknown }).phone === 'string' &&
          // El 112 ya está arriba, fijo y sin depender de nada guardado.
          (entry as { id: string }).id !== 'emergency-112'
      );
      if (contacts.length > 0) saved = { label: savedAtLabel(snapshot!.generatedAt), contacts };
    } catch {
      // Sin IndexedDB o con el almacén ilegible se queda el aviso a secas, que
      // ya es la verdad: no tenemos los contactos de la casa.
    }
  });

  function telHref(phone: string): string {
    return `tel:${phone.replace(/[^+\d]/g, '')}`;
  }
</script>

<div class="page-wrap emergency-page">
  <!-- El único botón de banda completa visible en la primera pantalla era
       «Imprimir», que es una acción de escritorio, mientras «Llamar al 112»
       quedaba debajo. Imprimir baja al final; el 112 abre la pantalla y cabe
       entero a 320 px. -->
  <PageHeader
    eyebrow="Acceso prioritario"
    title="Emergencias"
    support="Se abre aunque no haya cobertura"
    description="Esta pantalla se guarda en tu dispositivo: se abre aunque no haya cobertura."
  />

  <section class="emergency-callout">
    <div><span aria-hidden="true">+</span><strong>112</strong></div>
    <a href="tel:112">Llamar al 112</a>
  </section>

  {#if live}
    <div class="emergency-layout">
      <section class="card"><p class="eyebrow">Contactos destacados del hogar</p><h2>A quién llamar</h2>
        {#if live.featured.length > 0}
          <div class="emergency-contacts" data-lista="principal">
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
  {:else if data.unreadable}
    <!--
      No hemos podido leer los contactos de esta casa. Se dice, y no se rellena
      el hueco: el 112 de arriba es lo único que esta pantalla puede afirmar
      con certeza, porque no sale de ninguna base de datos.
    -->
    <div class="emergency-layout">
      <section class="card" role="status">
        <p class="eyebrow">Contactos de la casa</p>
        <h2>No podemos leerlos ahora mismo</h2>
        <p>
          Ha fallado la conexión con los datos de la casa, así que no podemos enseñarte sus
          teléfonos. Preferimos decírtelo a enseñarte un número que no sea el correcto.
        </p>
        <p><strong>Para una urgencia, llama al 112.</strong> Es el número de emergencias y funciona siempre.</p>
        {#if saved}
          <p class="offline-proof" role="status"><span aria-hidden="true">✓</span>{saved.label}</p>
          <div class="emergency-contacts">
            {#each saved.contacts as contact (contact.id)}
              <div>
                <span aria-hidden="true">{contact.name.slice(0, 1)}</span>
                <div><strong>{contact.name}</strong><small>{CONTACT_KIND_LABELS[contact.kind as keyof typeof CONTACT_KIND_LABELS] ?? 'Contacto'}</small></div>
                <a href={telHref(contact.phone)}>{contact.phone}</a>
              </div>
            {/each}
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

  {#if !data.unreadable}
    <!-- La prueba de que esto funciona sin cobertura es tranquilidad, no acción:
         va después de los teléfonos, no entre ellos y el 112. -->
    <p class="offline-proof" role="status"><span aria-hidden="true">✓</span>{live ? 'Contactos del hogar · disponibles sin conexión' : data.emergency?.updatedLabel}</p>
  {/if}

  <!-- Imprimir es de escritorio y va al final, donde no le quita sitio al 112. -->
  <div class="action-row destructiva">
    <button class="button secondary print-button" type="button" onclick={() => window.print()}>Imprimir esta pantalla</button>
  </div>
</div>
