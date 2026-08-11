<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { StaffMemberView } from '$lib/staff/model';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const context = useAppContext();

  const staff = $derived(data.staff);

  // Las dos etiquetas que esta pantalla puede necesitar, escritas aquí y no
  // tomadas de ROLE_LABELS: importar el diccionario global desde una ruta más
  // reordena los trozos de JavaScript y le cuesta bytes al arranque de Hoy, que
  // va justo de presupuesto. Es la misma decisión que tomó Ajustes con sus
  // mensajes de rechazo.
  const STAFF_ROLE_LABELS: Readonly<Record<string, string>> = {
    employee_live_in: 'Empleada interna',
    helper: 'Apoyo del hogar'
  };

  const DATE_LABEL = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long' });
  const formatDay = (iso: string) => DATE_LABEL.format(new Date(iso));

  /** Una frase por estado. Nada de siglas ni de colores sin texto. */
  function statusLabel(member: StaffMemberView): string {
    if (member.status === 'trabajando') return 'Trabaja en la casa';
    if (member.status === 'sin_contrato') return 'Tiene acceso, sin contrato en vigor';
    return 'Trabajó aquí';
  }

  function accessLine(member: StaffMemberView): string {
    if (member.revokedAt) return `Sin acceso desde el ${formatDay(member.revokedAt)}`;
    if (member.expiresAt) return `Puede entrar hasta el ${formatDay(member.expiresAt)}`;
    return `En la casa desde el ${formatDay(member.startsAt)}`;
  }
</script>

<!-- Sin <svelte:head><title>: el único <title> de la aplicación lo pinta el
     +layout.svelte de la raíz, y la etiqueta de esta ruta está declarada en
     `$lib/app-title` («personal»). Dos <title> darían dos elementos, y el que
     había aquí anunciaba además el nombre del PROYECTO en vez del de la casa
     que se está mirando. -->
<div class="page-wrap">
  <PageHeader
    eyebrow="Administración"
    title="Personal de la casa"
    description="Quién trabaja aquí, quién trabajó antes y con qué contrato en cada momento."
  />

  {#if !staff}
    <section class="card">
      <p class="eyebrow">Sin datos</p>
      <h2>Aquí no hay personal que enseñar</h2>
      <p>
        Esta pantalla lee el expediente real del hogar. En la demostración sin base de datos no hay
        ninguno, y fuera de la administración de la casa tampoco se enseña.
      </p>
    </section>
  {:else}
    {#snippet person(member: StaffMemberView)}
      <li class="staff-card">
        <div class="staff-head">
          <div>
            <strong>{member.name}</strong>
            <small>{STAFF_ROLE_LABELS[member.role] ?? member.role} · {accessLine(member)}</small>
          </div>
          <span class={member.status === 'anterior' ? 'status-chip' : member.status === 'trabajando' ? 'status-chip success' : 'status-chip warning'}>
            {statusLabel(member)}
          </span>
        </div>

        {#if member.passwordPending}
          <p class="audit-note">
            Sigue con la <strong>contraseña provisional</strong> que se le entregó en mano. Hasta que la
            cambie, la aplicación no la deja pasar de «Tu contraseña».
          </p>
        {/if}

        {#if member.agreements.length === 0}
          <p class="empty-line">Sin ningún contrato registrado.</p>
        {:else}
          <ol class="agreement-list">
            {#each member.agreements as agreement (agreement.id)}
              <li>
                <div class="agreement-head">
                  <span class="eyebrow">{agreement.status === 'active' ? 'Contrato vigente' : 'Contrato anterior'}</span>
                  <span>{agreement.periodLabel}</span>
                </div>
                <ul class="version-list">
                  {#each agreement.versions as version (version.id)}
                    <li>
                      <div class="version-head">
                        <strong>v{version.versionNumber}</strong>
                        <span>desde el {version.effectiveFromLabel}</span>
                        {#if version.state === 'vigente'}<span class="status-chip success">En vigor</span>
                        {:else if version.state === 'futura'}<span class="status-chip warning">Entra más adelante</span>
                        {:else}<span class="status-chip">Histórica</span>{/if}
                      </div>
                      <small>{version.salaryLabel} al mes · {version.weeklyLabel} · {version.annualVacationDays} días de vacaciones al año</small>
                      <small class="version-reason">{version.reason}</small>
                    </li>
                  {/each}
                </ul>
              </li>
            {/each}
          </ol>
        {/if}
      </li>
    {/snippet}

    {#if data.canHire}
      <section class="card" aria-labelledby="hire-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Dar de alta</p>
            <h2 id="hire-title">Entra alguien nuevo en la casa</h2>
          </div>
        </div>

        {#if form?.hired}
          <div class="handout" role="status">
            <p>
              <strong>{form.hired.name} ya puede entrar.</strong>
              {#if form.hired.withAgreement}Su contrato queda registrado con estas condiciones.{/if}
            </p>
            <p>Dile estos dos datos <strong>en persona</strong>:</p>
            <dl class="handout-secret">
              <div><dt>Usuario</dt><dd>{form.hired.username}</dd></div>
              <div><dt>Contraseña</dt><dd>{form.hired.password}</dd></div>
            </dl>
            <p class="audit-note">
              Esta contraseña <strong>no vuelve a mostrarse</strong> y no se guarda en ninguna parte. Al entrar,
              la aplicación le pedirá que la cambie por una suya antes de dejarla ir a ninguna otra pantalla.
              Si se pierde antes de dársela, ponle otra desde
              <a href={`/h/${context.household.id}/settings`}>Ajustes del hogar</a>.
            </p>
          </div>
        {/if}

        {#if form?.hireError}
          <p class="form-error" role="alert">{form.hireError}</p>
        {/if}

        <!--
          Formulario liso: sin `use:enhance`, sin secciones que se abren y se
          cierran y sin nada que dependa de JavaScript. Dos razones, y las dos
          cuentan: dar de alta a una persona tiene que poder hacerse con el
          navegador que haya delante, y el trozo de `$app/forms` que arrastra la
          mejora progresiva reordenaba los trozos compartidos y le costaba 122
          bytes al arranque de Hoy, que va justo de presupuesto. Al enviar, la
          página se recarga entera y el listado de arriba ya trae a la persona
          nueva, que es exactamente lo que se quiere ver después de un alta.
        -->
        <form class="action-form" method="POST" action="?/hire">
          <label for="hire-name">Nombre visible
            <input id="hire-name" name="displayName" type="text" value={form?.draft?.displayName ?? ''} autocomplete="off" required />
          </label>
          <label for="hire-username">Nombre de usuario (con esto entra)
            <input id="hire-username" name="username" type="text" value={form?.draft?.username ?? ''} autocomplete="off" pattern="[a-zA-Z0-9_.]&#123;3,30&#125;" required />
          </label>
          <label for="hire-email">Correo
            <input id="hire-email" name="email" type="email" value={form?.draft?.email ?? ''} autocomplete="off" required />
          </label>
          <p class="audit-note">
            El correo solo identifica la cuenta: <strong>a nadie se le escribe nunca</strong>. Si esta persona no
            tiene, vale algo como <code>nombre@casa.local</code>.
          </p>
          <!--
            Este desplegable es el único campo que no recuerda lo tecleado
            cuando el alta se rechaza. Marcar la opción elegida obliga a Svelte
            a traer una primitiva que no usa ninguna otra pantalla, y esa
            primitiva vive en el trozo compartido que Hoy carga al arrancar:
            costaba 110 de los 34 bytes que quedan de presupuesto. Volver a
            elegir entre dos opciones es más barato que eso.
          -->
          <label for="hire-role">Qué es en la casa
            <select id="hire-role" name="role" required>
              <option value="employee_live_in">Empleada interna</option>
              <option value="helper">Apoyo del hogar</option>
            </select>
          </label>

          <label class="inline-check">
            <input type="checkbox" name="withAgreement" checked />
            Registrar ahora su contrato
          </label>
          <p class="audit-note">
            Sin esta casilla se crea solo el acceso, y sus condiciones se pactan cuando toque. Los campos de
            abajo se ignoran si la dejas sin marcar.
          </p>

          <label for="hire-starts">Empieza el
            <input id="hire-starts" name="startsOn" type="date" />
          </label>
          <label for="hire-salary">Salario mensual (€)
            <input id="hire-salary" name="monthlySalary" type="text" inputmode="decimal" placeholder="1.400,00" />
          </label>
          <label for="hire-minutes">Jornada semanal (minutos)
            <input id="hire-minutes" name="contractedWeeklyMinutes" type="number" min="1" max="10080" value="2400" />
          </label>
          <label for="hire-vacation">Días de vacaciones al año
            <input id="hire-vacation" name="annualVacationDays" type="number" min="0" max="365" value="30" />
          </label>
          <label for="hire-reason">Por qué se pacta así
            <input id="hire-reason" name="reason" type="text" value="Alta desde la aplicación" maxlength="500" />
          </label>
          <p class="audit-note">
            El trabajo extra y los complementos se pactan luego en
            <a href={`/h/${context.household.id}/employment/acuerdo`}>El acuerdo</a>, apilando una versión: lo
            pactado no se reescribe nunca.
          </p>

          <div class="menu-slot-actions">
            <button class="button primary" type="submit">Crear la cuenta</button>
          </div>
        </form>
      </section>
    {/if}

    <section class="card" aria-labelledby="staff-current">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Hoy</p>
          <h2 id="staff-current">Quien trabaja en la casa</h2>
        </div>
      </div>
      {#if staff.current.length === 0}
        <p class="empty-line">Ahora mismo no hay nadie dado de alta como personal de la casa.</p>
      {:else}
        <ul class="staff-list">
          {#each staff.current as member (member.membershipId)}
            {@render person(member)}
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card" aria-labelledby="staff-past">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Historial</p>
          <h2 id="staff-past">Quien trabajó antes</h2>
        </div>
      </div>
      {#if staff.past.length === 0}
        <p class="empty-line">Todavía no ha dejado la casa nadie.</p>
      {:else}
        <ul class="staff-list">
          {#each staff.past as member (member.membershipId)}
            {@render person(member)}
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card">
      <p class="eyebrow">Y también</p>
      <h2>Lo que se hace desde otras pantallas</h2>
      <p>
        Las condiciones se pactan y se cambian en
        <a href={`/h/${context.household.id}/employment/acuerdo`}>El acuerdo</a>: aquí solo se leen.
        Las fechas límite del acceso, quitar el acceso y reponer contraseñas están en
        <a href={`/h/${context.household.id}/settings`}>Ajustes del hogar</a>.
      </p>
    </section>
  {/if}
</div>

<style>
  .staff-list {
    display: grid;
    gap: 0.9rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .staff-card {
    border: 1px solid var(--line);
    border-radius: 0.9rem;
    display: grid;
    gap: 0.6rem;
    padding: 0.85rem;
  }

  .staff-head {
    align-items: start;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: space-between;
  }

  .staff-head small,
  .version-list small {
    color: var(--ink-soft);
    display: block;
    font-size: 0.78rem;
  }

  .version-reason {
    font-style: italic;
  }

  .agreement-list {
    display: grid;
    gap: 0.7rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .agreement-head {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.6rem;
    justify-content: space-between;
  }

  .version-list {
    border-left: 2px solid var(--line);
    display: grid;
    gap: 0.55rem;
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0 0 0 0.7rem;
  }

  .version-head {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .empty-line {
    color: var(--ink-soft);
    font-size: 0.85rem;
  }

  /* La contraseña se dicta en voz alta: grande, monoespaciada y seleccionable. */
  .handout {
    border: 1px solid var(--line);
    border-radius: 0.9rem;
    display: grid;
    gap: 0.6rem;
    margin-bottom: 0.9rem;
    padding: 0.9rem;
  }

  .handout-secret {
    display: grid;
    gap: 0.4rem;
    margin: 0;
  }

  .handout-secret div {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  .handout-secret dt {
    color: var(--ink-soft);
    font-size: 0.78rem;
    min-width: 6rem;
  }

  .handout-secret dd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1.15rem;
    letter-spacing: 0.04em;
    margin: 0;
    user-select: all;
  }

  .inline-check {
    align-items: center;
    display: flex;
    gap: 0.5rem;
  }
</style>
