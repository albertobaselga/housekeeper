<script lang="ts">
  import { enhance } from '$app/forms';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let changing = $state(false);
</script>

<svelte:head><title>Tu acceso · Casa Clara</title></svelte:head>

<div class="page-wrap">
  <PageHeader
    eyebrow="Tu acceso"
    title="Tu contraseña"
    description="Solo tú la conoces. Nadie de la casa puede verla; quien administra el hogar únicamente puede ponerte una nueva si la pierdes."
  />

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
</div>
