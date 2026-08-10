<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { StaffMemberView } from '$lib/staff/model';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
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

<svelte:head><title>Personal · Casa Clara</title></svelte:head>

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
</style>
