<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  /**
   * Las tres etapas son tres estados de la MISMA página, y las decide el
   * servidor: sin JavaScript, SvelteKit re-renderiza con `form` puesto después
   * del POST y eso es todo el mecanismo que hace falta. Nada de `$state`, nada
   * de `use:enhance`: dar de alta a una persona tiene que poder hacerse con el
   * navegador que haya delante, y `$app/forms` reordena los trozos compartidos
   * y le cuesta bytes al arranque de Hoy, que va justo de presupuesto.
   */
  const hired = $derived(form && 'hired' in form ? form.hired : null);
  const personaNueva = $derived(form && 'persona' in form ? form.persona : null);
  const personaExistente = $derived(data.persona);
  const etapa = $derived(
    hired ? 'entrega' : personaNueva || personaExistente ? 'contrato' : 'persona'
  );

  const ROLE_LABELS: Readonly<Record<string, string>> = {
    employee_live_in: 'empleada interna',
    helper: 'apoyo del hogar'
  };
</script>

<div class="page-wrap">
  <PageHeader
    eyebrow="Personal"
    title="Añadir una persona a la casa"
    description="Primero quién es y cómo entra; después, sus condiciones."
  />

  {#if data.personaNoEncontrada}
    <article class="card">
      <p>
        Esa persona no está entre las que tienen acceso y les falta contrato. Puede que ya
        se le haya pactado uno, o que su acceso se haya retirado.
      </p>
      <div class="action-row">
        <a class="button secondary" href={`/h/${data.householdId}/employment`}>
          Volver a la lista de personas
        </a>
      </div>
    </article>
  {:else if etapa === 'entrega' && hired}
    <!-- Etapa 3: la contraseña provisional se enseña UNA vez, para leerla en voz
         alta. Por eso aquí no hay redirección: la entrada al expediente recién
         creado es un botón de esta misma página, no un salto que se la lleve. -->
    <article class="card" aria-labelledby="alta-hecha">
      <div class="section-heading">
        <div><p class="eyebrow">Hecho</p><h2 id="alta-hecha">{hired.name} ya puede entrar</h2></div>
      </div>
      <div class="handout" role="status">
        {#if hired.withAgreement}
          <p>Su contrato queda registrado con estas condiciones.</p>
        {:else}
          <p>
            Se ha creado sólo el acceso. Sus condiciones se pactan cuando toque, desde la
            lista de personas.
          </p>
        {/if}
        <p>Dile estos dos datos <strong>en persona</strong>:</p>
        <dl class="handout-secret">
          <div><dt>Usuario</dt><dd>{hired.username}</dd></div>
          <div><dt>Contraseña</dt><dd>{hired.password}</dd></div>
        </dl>
        <p class="audit-note">
          Esta contraseña <strong>no vuelve a mostrarse</strong> y no se guarda en ninguna parte.
          Al entrar, la aplicación le pedirá que la cambie por una suya antes de dejarla ir a
          ninguna otra pantalla. Si se pierde antes de dársela, ponle otra desde
          <a href={`/h/${data.householdId}/settings`}>Ajustes del hogar</a>.
        </p>
      </div>
      <p class="audit-note">
        Su contrato queda a medias a propósito: falta el <strong>horario</strong> —hasta que se
        pacte, ella no ve ninguna sección de horario— y el <strong>catálogo de trabajo
        extra</strong>, sin el cual no puede registrar ninguna jornada. Las dos cosas se pactan
        en «Cambiar las condiciones», dentro de su expediente, que además lo avisa mientras
        falten.
      </p>
      <div class="action-row">
        {#if hired.agreementId}
          <a
            class="button primary"
            href={`/h/${data.householdId}/employment?empleada=${encodeURIComponent(hired.agreementId)}`}
          >Abrir su expediente</a>
        {/if}
        <a class="button secondary" href={`/h/${data.householdId}/employment`}>
          Volver a la lista de personas
        </a>
      </div>
    </article>
  {:else if etapa === 'contrato'}
    <!-- Etapa 2. Dos entradas y un solo diseño: la persona que se acaba de
         teclear (y que todavía no existe en ninguna base) o la que ya está en la
         casa esperando contrato. -->
    <article class="card" aria-labelledby="alta-contrato">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Paso 2 de 2</p>
          <h2 id="alta-contrato">Sus condiciones</h2>
        </div>
      </div>

      {#if personaNueva}
        <p>
          Vas a dar de alta a <strong>{personaNueva.displayName}</strong> como
          {ROLE_LABELS[personaNueva.role] ?? personaNueva.role}.
          <a href={`/h/${data.householdId}/employment/alta`}>Cambiar sus datos</a>
        </p>
        {#if personaNueva.role !== 'employee_live_in'}
          <p class="audit-note">
            El apoyo del hogar <strong>no genera contrato</strong> ni línea en la lista de
            personas empleadas. Créale sólo el acceso.
          </p>
        {/if}
      {:else if personaExistente}
        <p>
          <strong>{personaExistente.name}</strong> ya tiene acceso a la casa y lo que falta es
          pactar su contrato. {personaExistente.returning
            ? 'Vuelve a la casa: su contrato anterior ya terminó.'
            : 'Acaba de llegar: todavía no ha tenido ningún contrato aquí.'}
        </p>
      {/if}

      {#if form && 'hireError' in form && form.hireError}
        <p class="form-error" role="alert">{form.hireError}</p>
      {/if}
      {#if form && 'createError' in form && form.createError}
        <p class="form-error" role="alert">{form.createError}</p>
      {/if}

      <form
        class="action-form"
        method="POST"
        action={personaExistente ? '?/contrato' : '?/hire'}
      >
        {#if personaExistente}
          <input type="hidden" name="employeeMembershipId" value={personaExistente.membershipId} />
        {:else if personaNueva}
          <!-- Los datos de la persona viajan en el CUERPO de la petición, no en
               la URL: el nombre, el usuario y el correo acabarían si no en el
               historial del navegador y en los registros del servidor. -->
          <input type="hidden" name="displayName" value={personaNueva.displayName} />
          <input type="hidden" name="username" value={personaNueva.username} />
          <input type="hidden" name="email" value={personaNueva.email} />
          <input type="hidden" name="role" value={personaNueva.role} />
        {/if}

        <div class="form-grid">
          <label for="alta-starts">El contrato empieza el
            <input id="alta-starts" name="startsOn" type="date" value={data.today} required />
          </label>
          <label for="alta-salary">Salario mensual (€)
            <input id="alta-salary" name="monthlySalary" type="text" inputmode="decimal" placeholder="1.400,00" required />
          </label>
          <label for="alta-minutes">Jornada semanal (minutos)
            <input id="alta-minutes" name="contractedWeeklyMinutes" type="number" min="1" max="10080" value="2400" required />
          </label>
          <label for="alta-vacation">Días de vacaciones al año
            <input id="alta-vacation" name="annualVacationDays" type="number" min="0" max="365" value="30" required />
          </label>
        </div>
        <label for="alta-reason">Por qué se pacta así
          <input id="alta-reason" name="reason" type="text" value="Alta desde la aplicación" maxlength="500" />
        </label>

        <!-- Lo que casi nunca se sabe el primer día. Se ofrece, no se exige: al
             dar de alta no se sabe todo, y obligar a rellenarlo sólo conseguiría
             que alguien escribiera cualquier cosa. Vacío significa «no se
             pactó», que es la verdad, y nunca un cero. -->
        <details class="alta-opcional">
          <summary>Vacaciones no disfrutadas (opcional, se puede pactar después)</summary>
          <label for="alta-vac-rate">Precio del día de vacaciones no disfrutado (€)
            <input id="alta-vac-rate" name="unusedVacationDayRate" type="text" inputmode="decimal" placeholder="sin pactar" />
          </label>
          <p class="audit-note">
            Déjalo vacío si no se ha pactado. Sin precio no se compensan días en dinero:
            se arrastran o se rechazan, y la aplicación no estima ningún importe.
          </p>
          <label for="alta-vac-expiry">Los días arrastrados
            <select id="alta-vac-expiry" name="carryoverExpiryMode">
              <option value="months">caducan pasados unos meses</option>
              <option value="never">no expiran nunca</option>
            </select>
          </label>
          <!-- `required`, como su gemelo del acuerdo: borrar el 6 con el modo en
               «meses» mandaba el campo vacío y salía NaN. El servidor lo ignora
               cuando el modo es «nunca». -->
          <label for="alta-vac-months">Meses de margen (si caducan)
            <input id="alta-vac-months" name="carryoverExpiryMonths" type="number" min="1" max="120" value="6" required />
          </label>
        </details>

        <p class="audit-note">
          El horario, el trabajo extra y los complementos se pactan luego en «Cambiar las
          condiciones», apilando una versión: lo pactado no se reescribe nunca. Aquí sólo lo
          básico, porque al dar de alta no se sabe todo.
        </p>

        <div class="action-row">
          {#if personaExistente}
            <button class="button primary" type="submit">Pactar su contrato</button>
          {:else}
            <!-- Dos botones en vez de una casilla: son dos decisiones distintas
                 y cada una dice lo que hace. El servidor sigue leyendo el mismo
                 `withAgreement` de siempre. -->
            <button class="button primary" type="submit" name="withAgreement" value="on">
              Dar de alta con su contrato
            </button>
            <button class="button secondary" type="submit" name="withAgreement" value="">
              Sólo el acceso, las condiciones más tarde
            </button>
          {/if}
        </div>
      </form>
    </article>
  {:else if !data.canHire}
    <!-- Sin identidad real no hay cuentas que crear, y la pantalla lo dice en
         vez de ofrecer un alta imposible. Va DESPUÉS de la etapa del contrato a
         propósito: pactar el contrato de alguien que ya está en la casa no crea
         ninguna cuenta y no depende de esto. -->
    <article class="card">
      <p>
        Este entorno no gestiona cuentas de acceso, así que desde aquí no se puede crear
        ninguna. El acceso se repone y se da desde
        <a href={`/h/${data.householdId}/settings`}>Ajustes del hogar</a>.
      </p>
      <div class="action-row">
        <a class="button secondary" href={`/h/${data.householdId}/employment`}>
          Volver a la lista de personas
        </a>
      </div>
    </article>
  {:else}
    <!-- Etapa 1. No escribe nada: valida y pasa a la etapa 2. -->
    <article class="card" aria-labelledby="alta-persona">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Paso 1 de 2</p>
          <h2 id="alta-persona">Quién entra en la casa</h2>
        </div>
      </div>

      {#if form && 'hireError' in form && form.hireError}
        <p class="form-error" role="alert">{form.hireError}</p>
      {/if}

      <form class="action-form" method="POST" action="?/persona">
        <label for="alta-name">Nombre visible
          <input
            id="alta-name"
            name="displayName"
            type="text"
            value={form && 'draft' in form && form.draft ? form.draft.displayName : ''}
            autocomplete="off"
            required
          />
        </label>
        <label for="alta-username">Nombre de usuario (con esto entra)
          <input
            id="alta-username"
            name="username"
            type="text"
            value={form && 'draft' in form && form.draft ? form.draft.username : ''}
            autocomplete="off"
            pattern="[a-zA-Z0-9_.]&#123;3,30&#125;"
            required
          />
        </label>
        <label for="alta-email">Correo
          <input
            id="alta-email"
            name="email"
            type="email"
            value={form && 'draft' in form && form.draft ? form.draft.email : ''}
            autocomplete="off"
            required
          />
        </label>
        <p class="audit-note">
          El correo solo identifica la cuenta: <strong>a nadie se le escribe nunca</strong>. Si
          esta persona no tiene, vale algo como <code>nombre@casa.local</code>.
        </p>

        <!-- Sin `bind:value`: marcar la opción elegida obliga a Svelte a traer
             una primitiva que vive en el trozo compartido que Hoy carga al
             arrancar, y costaba más bytes de los que quedan de presupuesto.
             Volver a elegir entre dos opciones es más barato que eso. -->
        <label for="alta-role">Qué es en la casa
          <select id="alta-role" name="role" required>
            <option value="employee_live_in">Empleada interna</option>
            <option value="helper">Apoyo del hogar</option>
          </select>
        </label>
        <p class="audit-note">
          El <strong>apoyo del hogar</strong> no genera contrato ni línea en la lista de personas
          empleadas: se le crea el acceso y nada más. La <strong>empleada interna</strong> sí
          tiene contrato, y es la que aparece en esta sección.
        </p>

        <div class="action-row">
          <button class="button primary" type="submit">Seguir con sus condiciones</button>
          <a class="button secondary" href={`/h/${data.householdId}/employment`}>Cancelar</a>
        </div>
      </form>
    </article>
  {/if}
</div>

<style>
  /* La contraseña se dicta en voz alta: grande, monoespaciada y seleccionable. */
  .handout {
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    display: grid;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    padding: var(--space-4);
  }

  .handout-secret {
    display: grid;
    gap: var(--space-2);
    margin: 0;
  }

  .handout-secret div {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .handout-secret dt {
    color: var(--ink-soft);
    font-size: var(--text-micro);
    min-width: 6rem;
  }

  .handout-secret dd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--text-title);
    letter-spacing: 0.04em;
    margin: 0;
    user-select: all;
  }

  /* Lo opcional, plegado y con aire: el resumen es toda la diana. */
  .alta-opcional {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .alta-opcional > summary {
    cursor: pointer;
    font-size: var(--text-meta);
    font-weight: 500;
    min-height: var(--row-data);
    display: flex;
    align-items: center;
    touch-action: manipulation;
  }
</style>
