<script lang="ts">
  import { onMount } from 'svelte';
  import { APP_HOME_SCREEN_NAME } from '$lib/app-title';
  import type { BeforeInstallPromptEvent, InstallOffer } from '$lib/pwa/install';

  /*
   * Banner propio de instalación, cargado bajo demanda: `$lib/pwa/install` no
   * viaja en el arranque de ninguna pantalla, se importa al montar.
   *
   * `onOfferChange` deja que quien lo monta (AppShell) sepa si hay algo que
   * ofrecer AHORA MISMO, para que el banner de avisos (Frente C) nunca salga a
   * la vez que este (§0.5 / regla de prioridad del diseño).
   */
  let { onOfferChange }: { onOfferChange?: (offer: InstallOffer) => void } = $props();

  let offer = $state<InstallOffer>('none');
  let promptEvent: BeforeInstallPromptEvent | null = null;

  function notify(next: InstallOffer): void {
    offer = next;
    onOfferChange?.(next);
  }

  onMount(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    // El listener de `beforeinstallprompt` ya está registrado desde el layout
    // raíz (`$lib/pwa/prompt-capture`, importado ESTÁTICAMENTE): aquí solo
    // hace falta leer lo que ya capturó. `.catch`: si el chunk no llega a
    // cargar (despliegue nuevo con esta pestaña abierta desde antes), no debe
    // quedar un `unhandledrejection` suelto — simplemente no hay nada que
    // ofrecer.
    import('$lib/pwa/install')
      .then((pwa) => {
        if (cancelled) return;

        const recompute = (): void => {
          promptEvent = pwa.currentDeferredPrompt();
          notify(
            pwa.shouldOfferInstall({
              standalone: pwa.isInstalled(),
              apple: pwa.looksLikeApple(),
              hasDeferredPrompt: promptEvent !== null,
              coarsePointer: window.matchMedia('(pointer: coarse)').matches,
              dismissedThisVisit: pwa.installDismissedThisVisit()
            })
          );
        };

        unsubscribe = pwa.onDeferredPromptChange(recompute);
        recompute();
      })
      .catch(() => {
        if (!cancelled) notify('none');
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  });

  async function install(): Promise<void> {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice;
    // Aceptado o no, el evento diferido se consume una sola vez.
    promptEvent = null;
    notify('none');
  }

  async function dismiss(): Promise<void> {
    const pwa = await import('$lib/pwa/install');
    pwa.dismissInstallBanner();
    notify('none');
  }
</script>

{#if offer !== 'none'}
  <!-- `<section>` con nombre accesible ya implica role="region": añadirlo a
       mano dispara el aviso de rol redundante del linter de accesibilidad. -->
  <section class="note info install-banner" aria-label="Instalar la aplicación">
    {#if offer === 'prompt'}
      <p>Instala la aplicación en tu pantalla de inicio: se abre como una aplicación, sin pasar por el navegador.</p>
      <div class="menu-slot-actions">
        <button class="button primary" type="button" onclick={() => void install()}>Instalar</button>
        <button class="button secondary" type="button" onclick={() => void dismiss()}>Ahora no</button>
      </div>
    {:else}
      <p>
        Añádela a tu pantalla de inicio: toca <strong>Compartir</strong> y luego «Añadir a pantalla de
        inicio». Aparecerá como «{APP_HOME_SCREEN_NAME}».
      </p>
      <div class="menu-slot-actions">
        <button class="button secondary" type="button" onclick={() => void dismiss()}>Entendido</button>
      </div>
    {/if}
  </section>
{/if}
