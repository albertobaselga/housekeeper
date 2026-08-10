<script lang="ts">
  import { enhance } from '$app/forms';
  import { APP_NAME } from '$lib/app-title';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let pendingAccount = $state<string | null>(null);
  let signingIn = $state(false);
</script>

<main class="login-stage">
  <section class="login-card" aria-labelledby="login-title">
    <!-- Cabecera sin sesión: el producto genérico. Quien todavía no ha entrado
         no tiene por qué saber qué casa hay detrás de esta instalación, y una
         misma instalación sirve a varias. -->
    <div class="login-brand">
      <span class="brand-mark" aria-hidden="true">⌂</span>
      <div><strong>{APP_NAME}</strong></div>
    </div>

    {#if data.mode === 'password'}
      <h1 id="login-title">Entra en tu casa</h1>
      <p class="lede">Escribe tu nombre de usuario y tu contraseña. Si no la recuerdas, pídesela a quien administra la casa: te pondrá una nueva en un momento.</p>

      {#if form?.message}
        <p class="form-error" role="alert">{form.message}</p>
      {/if}

      <form
        method="POST"
        action="?/password"
        class="login-form"
        use:enhance={() => {
          signingIn = true;
          return async ({ update }) => {
            await update();
            signingIn = false;
          };
        }}
      >
        <label for="login-username">Tu nombre de usuario
          <input
            id="login-username"
            name="username"
            type="text"
            autocomplete="username"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint="next"
            required
            value={form?.username ?? ''}
          />
        </label>
        <label for="login-password">Tu contraseña
          <input
            id="login-password"
            name="password"
            type="password"
            autocomplete="current-password"
            enterkeyhint="go"
            required
          />
        </label>
        <input type="hidden" name="next" value={data.next ?? ''} />
        <button class="button primary full" type="submit" disabled={signingIn}>
          {signingIn ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    {:else}
      <p class="eyebrow"><span></span> Entorno local de demostración</p>
      <h1 id="login-title">Entra con una perspectiva</h1>
      <p class="lede">Cada cuenta permite comprobar una combinación distinta de rutas y capacidades. Todos los datos son sintéticos.</p>

      {#if form?.message}
        <p class="form-error" role="alert">{form.message}</p>
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

      <p class="demo-note"><strong>Demostración sin contraseña.</strong> Esta instalación no tiene cuentas reales: solo se habilita en local y con datos ficticios. No introduzcas datos reales.</p>
    {/if}
  </section>
</main>
