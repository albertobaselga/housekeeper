<script lang="ts">
  import { onMount } from 'svelte';

  /*
   * Verificación de avisos al entrar (Frente C), cargada bajo demanda:
   * `$lib/push/subscribe` no viaja en el arranque de ninguna pantalla.
   *
   * `suppressed` lo controla AppShell: si el banner de instalación (Frente B)
   * tiene algo que ofrecer, este se calla. Nunca los dos a la vez.
   *
   * `householdId` es para la nota de «bloqueado» (ver `stage === 'blocked'`
   * abajo): sin él la nota igual sale, solo que sin enlace directo a Tu cuenta.
   */
  let {
    pushPublicKey,
    suppressed = false,
    householdId
  }: { pushPublicKey: string | null; suppressed?: boolean; householdId?: string } = $props();

  type Stage = 'idle' | 'offer' | 'working' | 'blocked';
  let stage = $state<Stage>('idle');
  let dismissedThisVisit = $state(false);
  /** Línea de error reintentable bajo el ofrecimiento; se limpia en cada intento. */
  let activationError = $state<string | null>(null);

  const DISMISS_KEY = 'housekeeper-push-dismissed';

  function readDismissed(): boolean {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  function persistDismissed(): void {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Sin sessionStorage el descarte no persiste, y no hay nada más que
      // romper: el banner podrá reaparecer antes de lo esperado en esa pestaña.
    }
  }

  async function evaluate(): Promise<void> {
    if (!pushPublicKey) return;
    dismissedThisVisit = readDismissed();

    try {
      const [subscribe, { entryPushAction }] = await Promise.all([
        import('$lib/push/subscribe'),
        import('$lib/push/entry-check')
      ]);

      const availability = subscribe.pushAvailability();
      const hasLiveSubscription =
        availability.kind === 'available' && availability.permission === 'granted'
          ? (await subscribe.currentSubscription()) !== null
          : false;

      const action = entryPushAction(availability, hasLiveSubscription, dismissedThisVisit);
      if (action === 'self-heal') {
        // El permiso ya está concedido: `enablePush` no muestra ningún diálogo,
        // solo repara la fila del servidor. Sin toque de por medio porque no
        // hace falta pedir nada.
        await subscribe.enablePush(pushPublicKey);
        stage = 'idle';
        return;
      }
      stage = action === 'offer' ? 'offer' : 'idle';
    } catch {
      // El chunk no llegó a cargar (despliegue nuevo con esta pestaña abierta
      // desde antes, sin red un instante): no hay nada honesto que ofrecer, y
      // desde luego no un `unhandledrejection` suelto. Silencio, como si el
      // canal no existiera.
      stage = 'idle';
    }
  }

  onMount(() => {
    void evaluate();
  });

  async function activate(): Promise<void> {
    if (!pushPublicKey || stage !== 'offer') return;
    stage = 'working';
    activationError = null;
    try {
      // El diálogo nativo del sistema aparece aquí, y solo aquí: justo después
      // del toque que llevó a este botón.
      const [{ enablePush }, { afterActivate }] = await Promise.all([
        import('$lib/push/subscribe'),
        import('$lib/push/entry-check')
      ]);
      const result = await enablePush(pushPublicKey);
      const outcome = afterActivate(result);
      if (outcome === 'done') {
        stage = 'idle';
        return;
      }
      if (outcome === 'blocked') {
        // No hay reintento posible desde aquí (§0.5: el permiso jamás se
        // dispara solo). La nota es breve y NO persistente: no cambia la
        // política de silencio de `blocked` en próximas visitas, solo avisa
        // de lo que acaba de pasar en esta.
        stage = 'blocked';
        return;
      }
      // `outcome === 'retry'`: contratiempo del momento (sin red, el servidor
      // no contestó). El permiso del navegador sigue por decidir, así que
      // volver al ofrecimiento es honesto.
      activationError = 'No se pudo activar; inténtalo otra vez.';
      stage = 'offer';
    } catch {
      activationError = 'No se pudo activar; inténtalo otra vez.';
      stage = 'offer';
    }
  }

  function dismiss(): void {
    persistDismissed();
    dismissedThisVisit = true;
    stage = 'idle';
  }

  /** La nota de «bloqueado» no persiste: cerrarla solo la quita de esta vista. */
  function dismissBlockedNote(): void {
    stage = 'idle';
  }
</script>

{#if (stage === 'offer' || stage === 'working') && !suppressed}
  <!-- `<section>` con nombre accesible ya implica role="region": añadirlo a
       mano dispara el aviso de rol redundante del linter de accesibilidad. -->
  <section class="note info push-banner" aria-label="Avisos en este dispositivo">
    <p>Activa los avisos en este dispositivo para enterarte del cierre del mes y del recibo.</p>
    {#if activationError}
      <p class="note fila error" role="alert">{activationError}</p>
    {/if}
    <div class="menu-slot-actions">
      <button class="button primary" type="button" disabled={stage === 'working'} onclick={() => void activate()}>
        {stage === 'working' ? 'Un momento…' : 'Activar'}
      </button>
      <button class="button secondary" type="button" disabled={stage === 'working'} onclick={dismiss}>
        Ahora no
      </button>
    </div>
  </section>
{:else if stage === 'blocked' && !suppressed}
  <section class="note info push-banner" aria-label="Avisos bloqueados en este dispositivo">
    <p>
      Este teléfono acaba de bloquear los avisos. Puedes desbloquearlos desde
      {#if householdId}<a href={`/h/${householdId}/account`}>Tu cuenta</a>{:else}Tu cuenta{/if}.
    </p>
    <div class="menu-slot-actions">
      <button class="button secondary" type="button" onclick={dismissBlockedNote}>Vale</button>
    </div>
  </section>
{/if}
