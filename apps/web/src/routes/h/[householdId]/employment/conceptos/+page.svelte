<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import EmploymentPersonBar from '$lib/components/employment/EmploymentPersonBar.svelte';
  import EmploymentTabs from '$lib/components/employment/EmploymentTabs.svelte';
  import ExpensesPendingCard from '$lib/components/employment/ExpensesPendingCard.svelte';
  import ExtraWorkPendingCard from '$lib/components/employment/ExtraWorkPendingCard.svelte';
  import ManualAdjustmentsCard from '$lib/components/employment/ManualAdjustmentsCard.svelte';
  import OutboxTriageCard from '$lib/components/employment/OutboxTriageCard.svelte';
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import { currentPeriod } from '$lib/employment/model';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  // Mismo patrón que el resumen: acciones optimistas con invalidate selectivo,
  // y cada tarjeta hija lleva su propia instancia.
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  const overview = $derived(data.overview);

  const agreement = $derived(overview?.hasEmploymentData ? overview.agreement : null);
  const selectedOption = $derived(
    overview?.agreements.find((option) => option.id === agreement?.id) ?? null
  );
  const isOwnAgreement = $derived(
    agreement !== null && agreement.employeeMembershipId === context.membershipId
  );

  const canRegisterExtra = $derived(isOwnAgreement && can(context.role, 'work.register.self'));
  // Apuntar trabajo a nombre de otra persona es cosa de quien administra: el
  // servidor lo vuelve a comprobar por rol; esto solo decide qué se dibuja.
  const canRegisterForEmployee = $derived(agreement !== null && can(context.role, 'work.confirm'));
  const selectedEmployeeLabel = $derived(
    overview?.agreements.find((option) => option.id === agreement?.id)?.employeeLabel ??
      'la empleada'
  );
  const canSubmitExpense = $derived(isOwnAgreement && can(context.role, 'expense.create.self'));
  const canConfirmWork = $derived(agreement !== null && can(context.role, 'work.confirm'));
  const canCloseSettlement = $derived(agreement !== null && can(context.role, 'settlement.close'));

  // La misma verdad que en el resumen: los importes solo los ven quien
  // administra y la propia empleada; al resto se le dice, no se le pinta vacío.
  const seesAmounts = $derived(
    can(context.role, 'settlement.close') || can(context.role, 'payment.confirm.self')
  );
</script>

<div class="page-wrap">
  <PageHeader
    eyebrow="Contrato"
    title="Conceptos del mes"
    description="Jornadas extra, gastos, adelantos y ausencias: aquí se apuntan y aquí se deciden."
  />

  <!-- El mismo predicado que decide la portada, no el recuento de acuerdos: la
       portada ya existe siempre, y contar filas dejaba a la casa de una sola
       empleada con esta pestaña y ningún camino de vuelta a ella. -->
  {#if overview && context.role !== 'employee_live_in' && selectedOption}
    <EmploymentPersonBar
      householdId={overview.householdId}
      employeeLabel={selectedOption.employeeLabel}
      active={selectedOption.active}
    />
  {/if}

  <EmploymentTabs
    householdId={context.household.id}
    current="conceptos"
    empleada={agreement?.id ?? null}
  />

  <ActionStatus status={actionStatus} />

  {#if !overview}
    <article class="card">
      <p>
        Los conceptos se apuntan sobre el contrato real del hogar. Si administras y ves esto,
        es que este entorno no tiene base de datos conectada.
      </p>
    </article>
  {:else if !overview.hasEmploymentData}
    <article class="card quiet-card">
      <span class="card-icon" aria-hidden="true">·</span>
      <h2>Sin contrato de trabajo registrado</h2>
      <p>Cuando el hogar registre un contrato con la empleada, aquí se apuntarán sus conceptos.</p>
    </article>
  {:else}
    <!-- De quién es lo dice la barra de arriba; cambiar de persona se hace en
         la portada de Contrato. -->
    <OutboxTriageCard householdId={overview.householdId} />

    {#if agreement && (overview.pendingExtras.length > 0 || canRegisterExtra || canRegisterForEmployee)}
      <ExtraWorkPendingCard
        householdId={overview.householdId}
        agreementId={agreement.id}
        extras={overview.pendingExtras}
        types={overview.registrableTypes}
        ownMembershipId={context.membershipId}
        canRegister={canRegisterExtra}
        canRegisterForEmployee={canRegisterForEmployee}
        employeeLabel={selectedEmployeeLabel}
        canConfirm={canConfirmWork}
        principal={true}
      />
    {/if}

    {#if agreement && (overview.pendingExpenses.length > 0 || canSubmitExpense || canCloseSettlement)}
      <ExpensesPendingCard
        householdId={overview.householdId}
        agreementId={agreement.id}
        expenses={overview.pendingExpenses}
        canSubmit={canSubmitExpense}
        canResolve={canCloseSettlement}
      />
    {/if}

    <!-- Conceptos apuntados a mano: adelantos, ausencias y cualquier importe
         pactado fuera de catálogo. La empleada los ve en solo lectura (la RLS
         de 0022 le enseña sus filas); apunta y anula quien administra. -->
    {#if agreement && seesAmounts}
      <ManualAdjustmentsCard
        householdId={overview.householdId}
        agreementId={agreement.id}
        adjustments={overview.manualAdjustments}
        currentPeriod={overview.accrual?.period ?? currentPeriod()}
        canRecord={canCloseSettlement}
      />
    {/if}

    {#if !seesAmounts}
      <!-- Ausencia por permiso, no por falta de datos. -->
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">·</span>
        <h2>Importes reservados</h2>
        <p>
          Los importes solo los ven quien administra el hogar y la empleada. Tú puedes
          revisar aquí las jornadas y los gastos pendientes.
        </p>
      </article>
    {/if}
  {/if}
</div>
