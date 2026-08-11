<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { APP_HOME_SCREEN_NAME } from '$lib/app-title';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let changing = $state(false);

  /**
   * Los avisos de ESTE dispositivo.
   *
   * Todo lo que sabe el navegador se resuelve aquí, después de montar, y con el
   * módulo cargado bajo demanda: `$lib/push/subscribe` no viaja en el arranque
   * de esta pantalla ni de ninguna otra.
   *
   * Nada de esto pide permiso solo. El diálogo del sistema aparece únicamente
   * cuando alguien pulsa el botón, y esa es toda la insistencia que hay en la
   * aplicación: no hay ofrecimiento contextual en ninguna otra pantalla, ni
   * insignia, ni recordatorio. La razón está en la sección de más abajo.
   */
  type Availability = 'checking' | 'available' | 'blocked' | 'needs-home-screen' | 'unsupported';
  let availability = $state<Availability>('checking');
  let subscribed = $state(false);
  let working = $state(false);
  let notice = $state('');

  async function refreshDeviceState(): Promise<void> {
    const push = await import('$lib/push/subscribe');
    const state = push.pushAvailability();
    availability = state.kind;
    subscribed = state.kind === 'available' ? (await push.currentSubscription()) !== null : false;
  }

  $effect(() => {
    if (!browser || !data.pushPublicKey) return;
    void refreshDeviceState().catch(() => {
      availability = 'unsupported';
    });
  });

  async function toggleNotices(): Promise<void> {
    if (!data.pushPublicKey || working) return;
    working = true;
    notice = '';
    try {
      const push = await import('$lib/push/subscribe');
      if (subscribed) {
        notice = (await push.disablePush())
          ? 'Apagados. Este teléfono ya no recibe avisos.'
          : 'No hemos podido apagarlos. Inténtalo dentro de un rato.';
      } else {
        const result = await push.enablePush(data.pushPublicKey);
        notice = result.ok
          ? 'Listo. Te avisaremos en este teléfono, y solo de lo que dice la lista de aquí abajo.'
          : result.reason === 'denied'
            ? 'Perfecto, no te avisamos. No volvemos a preguntártelo: si algún día los quieres, este interruptor sigue aquí.'
            : 'No hemos podido encenderlos. Comprueba que tienes conexión e inténtalo otra vez.';
      }
      await refreshDeviceState();
      await invalidate('cc:push');
    } finally {
      working = false;
    }
  }
</script>

<div class="page-wrap">
  <PageHeader
    eyebrow="Tu cuenta"
    title="Tu contraseña y tus avisos"
    description="Las dos cosas son tuyas y de nadie más. Nadie de la casa puede ver tu contraseña ni saber si tienes los avisos encendidos; quien administra el hogar únicamente puede ponerte una contraseña nueva si la pierdes."
  />

  {#if data.mustChangePassword}
    <section class="card warning-card" aria-labelledby="must-change-title">
      <p class="eyebrow">Antes de seguir</p>
      <h2 id="must-change-title">Esta contraseña no es tuya todavía</h2>
      <p>
        Entraste con la contraseña provisional que te dieron en mano, y la conoce quien te la dictó.
        Elige una tuya aquí abajo: hasta entonces esta es la única pantalla de la casa que se abre.
      </p>
    </section>
  {/if}

  <section class="card" aria-labelledby="password-title">
    <h2 id="password-title">Cambiar tu contraseña</h2>

    {#if data.passwordAuth}
      <p>
        Al cambiarla se cierran tus sesiones abiertas en los demás dispositivos: tendrás que volver a entrar en
        ellos con la nueva. Elige algo que solo tú puedas recordar y no la compartas con nadie de la casa.
      </p>

      {#if form?.changed}
        <p class="demo-note" role="status"><strong>Contraseña cambiada.</strong> Las demás sesiones que tuvieras abiertas se han cerrado.</p>
      {/if}
      {#if form?.message}
        <p class="form-error" role="alert">{form.message}</p>
      {/if}

      <form class="action-form" method="POST" action="?/changePassword" use:enhance={() => {
        changing = true;
        return async ({ update }) => {
          await update({ reset: true });
          changing = false;
        };
      }}>
        <label for="current-password">Tu contraseña de ahora
          <input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label for="new-password">Contraseña nueva (mínimo {data.minPasswordLength} caracteres)
          <input id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength={data.minPasswordLength} required />
        </label>
        <label for="repeat-password">Repite la contraseña nueva
          <input id="repeat-password" name="repeatPassword" type="password" autocomplete="new-password" minlength={data.minPasswordLength} required />
        </label>
        <div class="menu-slot-actions">
          <button class="button primary" type="submit" disabled={changing}>
            {changing ? 'Cambiando…' : 'Cambiar mi contraseña'}
          </button>
        </div>
      </form>
    {:else}
      <p class="demo-note">
        <strong>Esta instalación no usa contraseñas.</strong> Es una demostración con cuentas de prueba y datos
        ficticios: se entra eligiendo una cuenta en la pantalla de acceso, así que no hay nada que cambiar aquí.
      </p>
    {/if}
  </section>

  <section class="card" aria-labelledby="notices-title">
    <h2 id="notices-title">Tus avisos en este teléfono</h2>

    {#if !data.pushPublicKey}
      <p class="demo-note">
        <strong>Esta instalación no manda avisos al móvil.</strong> Le faltan las claves del canal, así que
        no hay nada que encender aquí. Todo se sigue viendo al entrar en la aplicación.
      </p>
    {:else if availability === 'needs-home-screen'}
      <p>
        En iPhone y iPad los avisos solo funcionan si abres la aplicación desde el icono de la pantalla de
        inicio, donde aparece como «{APP_HOME_SCREEN_NAME}». Si quieres, añádela: botón Compartir → «Añadir
        a pantalla de inicio», y entra otra vez desde ahí. Y si no, entra como siempre: no te pierdes nada.
      </p>
    {:else if availability === 'blocked'}
      <p>
        Este teléfono tiene los avisos bloqueados para esta aplicación. Se desbloquean desde los ajustes
        del teléfono, en la ficha de «{APP_HOME_SCREEN_NAME}» → Notificaciones. Si prefieres dejarlo así, no
        hace falta que hagas nada: la aplicación funciona igual.
      </p>
    {:else if availability === 'unsupported'}
      <p>Este navegador no sabe mandar avisos. La aplicación funciona igual sin ellos.</p>
    {:else}
      <p>
        Podemos avisarte en este teléfono cuando pase algo que te toca. Si los dejas apagados, la aplicación
        funciona exactamente igual: los avisos no son la única forma de enterarse de nada.
      </p>

      <ul class="notice-list">
        <li>Cuando esté listo el recibo de tu cuenta del mes, para que puedas mirarlo y confirmar el cobro.</li>
        <li>Cuando quede una cuenta del mes por pagar, a quien administra el hogar.</li>
      </ul>

      <div class="menu-slot-actions">
        <button
          class="button primary"
          type="button"
          disabled={working || availability === 'checking'}
          onclick={() => void toggleNotices()}
        >
          {#if working}
            Un momento…
          {:else if subscribed}
            Apagar los avisos en este teléfono
          {:else}
            Avisarme en este teléfono
          {/if}
        </button>
      </div>

      {#if notice}
        <p class="demo-note" role="status">{notice}</p>
      {/if}

      {#if data.pushDevices.length > 0}
        <ul class="device-list">
          {#each data.pushDevices as device (device.id)}
            <li>
              {device.deviceLabel ?? 'Un dispositivo tuyo'} ·
              {#if device.lastSuccessAt}
                último aviso recibido el {new Date(device.lastSuccessAt).toLocaleDateString('es-ES')}
              {:else}
                todavía no ha recibido ninguno
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <!--
      Esta promesa tiene el mismo peso tipográfico que el interruptor a
      propósito: es la mitad que convierte un ajuste en un compromiso, y la
      sostiene una prueba automatizada (`apps/worker/src/push.test.ts`), igual
      que se hizo con el AC-26. Si alguien añadiera un aviso de tarea, la suite
      falla antes de que llegue a ningún teléfono.
    -->
    <h3 class="promise-title">Lo que nunca te vamos a mandar</h3>
    <p class="promise">
      Recordatorios de tareas o de rutinas. Cuentas de lo que llevas hecho o dejas por hacer. Avisos porque
      no hayas entrado o no hayas confirmado algo. Nada por la noche, ni los domingos, ni mientras estés de
      vacaciones. <strong>Esto no es una opción que alguien pueda cambiar: la aplicación no sabe hacerlo.</strong>
    </p>
    <p class="promise">
      Y al revés: <strong>nadie de la casa puede ver si tienes los avisos encendidos</strong>, ni encendértelos.
      Tampoco quien administra el hogar. Tú tampoco ves los suyos.
    </p>
  </section>
</div>

<style>
  .notice-list, .device-list {
    margin: var(--space-3) 0 0;
    padding-left: var(--space-4);
    color: var(--muted);
    font-size: var(--text-meta);
    line-height: 1.55;
  }
  .device-list { list-style: none; padding-left: 0; font-size: var(--text-micro); }
  .promise-title {
    margin-top: var(--space-5);
    font-size: var(--text-body);
  }
  .promise {
    margin-top: var(--space-2);
    font-size: var(--text-meta);
    line-height: 1.6;
  }
</style>
