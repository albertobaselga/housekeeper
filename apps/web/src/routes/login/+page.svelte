<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let pendingAccount = $state<string | null>(null);
</script>

<svelte:head><title>Entrar · Casa Clara</title></svelte:head>

<main class="login-stage">
  <section class="login-card" aria-labelledby="login-title">
    <div class="login-brand">
      <span class="brand-mark" aria-hidden="true">⌂</span>
      <div><strong>Casa Clara</strong><span>Familia Roble</span></div>
    </div>
    <p class="eyebrow"><span></span> Entorno local de demostración</p>
    <h1 id="login-title">Entra con una perspectiva</h1>
    <p class="lede">Cada cuenta permite comprobar una combinación distinta de rutas y capacidades. Todos los datos son sintéticos.</p>

    {#if form?.message}
      <p class="form-error" role="alert">{form.message}</p>
    {/if}

    {#if data.mode === 'magic-link'}
      {#if form?.sent}
        <p class="demo-note" role="status"><strong>Enlace enviado.</strong> Si el correo pertenece a este hogar, recibirás un enlace de acceso válido durante 10 minutos.</p>
      {:else}
        <form method="POST" action="?/magiclink" class="magic-form" use:enhance>
          <label for="magic-email">Correo del hogar</label>
          <input id="magic-email" name="email" type="email" autocomplete="email" required placeholder="tu@correo.es" />
          <input type="hidden" name="next" value={data.next ?? ''} />
          <button class="account-card" type="submit"><span class="account-copy"><strong>Enviarme un enlace de acceso</strong><span>Sin contraseñas: el enlace caduca en 10 minutos.</span></span><span class="account-arrow" aria-hidden="true">→</span></button>
        </form>
      {/if}
    {/if}

    <div class="account-grid" aria-label="Cuentas demo">
      {#each data.accounts as account}
        <form method="POST" action="?/demo" use:enhance={() => {
          pendingAccount = account.id;
          return async ({ update }) => {
            await update();
            pendingAccount = null;
          };
        }}>
          <input type="hidden" name="accountId" value={account.id} />
          <input type="hidden" name="next" value={data.next ?? ''} />
          <button class="account-card" type="submit" disabled={pendingAccount !== null}>
            <span class="avatar">{account.initials}</span>
            <span class="account-copy">
              <strong>{account.name}</strong>
              <span>{account.roleLabel}</span>
              <small>{account.email}</small>
            </span>
            <span class="account-arrow" aria-hidden="true">{pendingAccount === account.id ? '…' : '→'}</span>
          </button>
        </form>
      {/each}
    </div>

    <p class="demo-note"><strong>Demo sin contraseña.</strong> La sesión usa una cookie HttpOnly efímera y solo se habilita en local. No introduzcas datos reales.</p>
  </section>
</main>
