<script lang="ts">
  import { enhance } from '$app/forms';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { centsToEuroInput } from '$lib/employment/model';
  import type {
    AgreementVersionAdminView,
    EmployeeCandidateView
  } from '$lib/server/agreement-terms.server';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const admin = $derived(data.admin);

  /**
   * Fila editable del catálogo. Se parte SIEMPRE de la versión vigente, porque
   * editar aquí no es corregir: es pactar de nuevo. El formulario se envía
   * entero y el servidor apila una versión con todo el catálogo, así que lo que
   * no se toca se conserva tal cual y lo que se borra deja de existir a partir
   * de esa fecha, no antes.
   */
  type TypeDraft = {
    code: string;
    name: string;
    unit: 'per_hour' | 'per_shift' | 'fixed_amount';
    rate: string;
    referenceMinutes: string;
    active: boolean;
  };

  type SupplementDraft = {
    code: string;
    name: string;
    amount: string;
    addsToPay: boolean;
    startsOn: string;
    endsOn: string;
    active: boolean;
  };

  type Draft = {
    effectiveFrom: string;
    monthlySalary: string;
    contractedWeeklyMinutes: number;
    annualVacationDays: number;
    reason: string;
    types: TypeDraft[];
    supplements: SupplementDraft[];
  };

  function draftFromVersion(version: AgreementVersionAdminView | undefined, today: string): Draft {
    return {
      effectiveFrom: today,
      monthlySalary: version ? centsToEuroInput(version.monthlySalaryCents) : '',
      contractedWeeklyMinutes: version?.weeklyMinutes ?? 2400,
      annualVacationDays: version?.annualVacationDays ?? 30,
      reason: '',
      types: (version?.extraWorkTypes ?? []).map((type) => ({
        code: type.code,
        name: type.name,
        unit: type.unit,
        rate: type.rateCents === null ? '' : centsToEuroInput(type.rateCents),
        referenceMinutes: type.referenceMinutes === null ? '' : String(type.referenceMinutes),
        active: type.active
      })),
      supplements: (version?.supplements ?? []).map((supplement) => ({
        code: supplement.code,
        name: supplement.name,
        amount: supplement.amountCents === null ? '' : centsToEuroInput(supplement.amountCents),
        addsToPay: supplement.addsToPay,
        startsOn: supplement.startsOn ?? '',
        endsOn: supplement.endsOn ?? '',
        active: supplement.active
      }))
    };
  }

  const EMPTY_TYPE: TypeDraft = {
    code: '',
    name: '',
    unit: 'per_shift',
    rate: '',
    referenceMinutes: '600',
    active: true
  };
  const EMPTY_SUPPLEMENT: SupplementDraft = {
    code: '',
    name: '',
    amount: '',
    addsToPay: true,
    startsOn: '',
    endsOn: '',
    active: true
  };

  let openAgreementId = $state<string | null>(null);
  let drafts = $state<Record<string, Draft>>({});
  let creating = $state(false);
  let createDraft = $state<Draft>({
    effectiveFrom: '',
    monthlySalary: '',
    contractedWeeklyMinutes: 2400,
    annualVacationDays: 30,
    reason: '',
    types: [{ ...EMPTY_TYPE }],
    supplements: []
  });
  let createEmployee = $state('');
  let createStartsOn = $state('');

  function openEditor(agreementId: string, versions: AgreementVersionAdminView[], today: string): void {
    if (openAgreementId === agreementId) {
      openAgreementId = null;
      return;
    }
    const current = versions.find((version) => version.state === 'vigente') ?? versions[0];
    drafts = { ...drafts, [agreementId]: draftFromVersion(current, today) };
    openAgreementId = agreementId;
  }

  function addType(draft: Draft): void {
    draft.types = [...draft.types, { ...EMPTY_TYPE }];
  }
  function removeType(draft: Draft, index: number): void {
    draft.types = draft.types.filter((_, position) => position !== index);
  }
  function addSupplement(draft: Draft): void {
    draft.supplements = [...draft.supplements, { ...EMPTY_SUPPLEMENT }];
  }
  function removeSupplement(draft: Draft, index: number): void {
    draft.supplements = draft.supplements.filter((_, position) => position !== index);
  }

  function candidateLabel(candidate: EmployeeCandidateView): string {
    return candidate.name;
  }
</script>

<svelte:head><title>Condiciones del acuerdo · Casa Clara</title></svelte:head>

<PageHeader
  eyebrow="Acuerdo"
  title="Condiciones del acuerdo"
  description="Cada cambio crea una versión nueva. Lo ya pactado no se reescribe nunca."
/>

{#if !admin}
  <article class="card">
    <p>
      Esta pantalla es de quien administra el hogar. Si administras y la ves vacía,
      es que este entorno no tiene base de datos conectada.
    </p>
  </article>
{:else}
  {#if form?.created}
    <p class="form-ok" role="status">Acuerdo dado de alta con su primera versión.</p>
  {/if}
  {#if form?.stacked}
    <p class="form-ok" role="status">Versión nueva añadida. La anterior sigue en el historial.</p>
  {/if}

  {#each admin.agreements as agreement (agreement.id)}
    <article class="card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">{agreement.employeeName}</p>
          <h2>Desde el {agreement.startsOnLabel}</h2>
        </div>
        <span class="status-chip {agreement.status === 'active' ? 'success' : 'warning'}">
          {agreement.status === 'active' ? 'Activo' : 'Finalizado'}
        </span>
      </div>

      <div class="ledger-list">
        {#each agreement.versions as version (version.id)}
          <div>
            <span>
              <strong>v{version.versionNumber} · desde el {version.effectiveFromLabel}</strong>
              <small>
                {version.reason} · {version.weeklyLabel} · {version.annualVacationDays} días de vacaciones
              </small>
              <small>
                {#each version.extraWorkTypes as type (type.id)}
                  {type.name}: {type.active
                    ? (type.rateLabel ?? 'sin tarifa · no la ve')
                    : 'desactivado · no lo ve'}{' · '}
                {/each}
                {#each version.supplements as supplement (supplement.id)}
                  {supplement.name}: {supplement.amountLabel ?? 'sin importe'}
                  {supplement.addsToPay ? '(suma al pago)' : '(lo paga la casa)'}{supplement.active ? '' : ' · retirado'}{' · '}
                {/each}
              </small>
            </span>
            <span>
              <strong>{version.salaryLabel}</strong>
              <small>
                {#if version.state === 'vigente'}Vigente{:else if version.state === 'futura'}Entra en vigor{:else}Histórica{/if}
              </small>
            </span>
          </div>
        {/each}
      </div>

      <div class="action-row">
        <button
          class="button secondary small-button"
          type="button"
          aria-expanded={openAgreementId === agreement.id}
          onclick={() => openEditor(agreement.id, agreement.versions, admin.today)}
        >Cambiar las condiciones</button>
      </div>

      {#if openAgreementId === agreement.id && drafts[agreement.id]}
        {@const draft = drafts[agreement.id]}
        <form
          class="action-form"
          method="POST"
          action="?/stackVersion"
          use:enhance={() => async ({ result, update }) => {
            await update({ reset: false });
            if (result.type === 'success') openAgreementId = null;
          }}
        >
          <input type="hidden" name="agreementId" value={agreement.id} />
          <h3>Versión nueva</h3>
          <p>
            <small>
              Se parte de lo pactado hoy. Lo que cambies entra en vigor en la fecha que
              indiques; lo anterior sigue valiendo para todo lo trabajado antes.
            </small>
          </p>

          <div class="form-grid">
            <label>Entra en vigor el
              <input type="date" name="effectiveFrom" bind:value={draft.effectiveFrom} required />
            </label>
            <label>Salario mensual
              <input type="text" inputmode="decimal" name="monthlySalary" bind:value={draft.monthlySalary} required placeholder="1.500,00" />
            </label>
            <label>Jornada semanal (minutos)
              <input type="number" name="contractedWeeklyMinutes" bind:value={draft.contractedWeeklyMinutes} min="1" max="10080" required />
            </label>
            <label>Vacaciones al año (días naturales)
              <input type="number" name="annualVacationDays" bind:value={draft.annualVacationDays} min="0" max="365" required />
            </label>
          </div>
          <label>Motivo del cambio
            <input type="text" name="reason" bind:value={draft.reason} maxlength="500" required placeholder="Por qué cambian las condiciones" />
          </label>

          <h3>Trabajo extra</h3>
          <p><small>Lo que esté desactivado o sin tarifa no lo verá la empleada, ni en sus condiciones ni al registrar trabajo.</small></p>
          {#each draft.types as type, index (index)}
            <div class="form-grid">
              <label>Código
                <input type="text" name={`type.${index}.code`} bind:value={type.code} required placeholder="jornada_extra" pattern="[a-z][a-z0-9_]{'{'}1,38{'}'}[a-z0-9]" />
              </label>
              <label>Nombre
                <input type="text" name={`type.${index}.name`} bind:value={type.name} required maxlength="80" placeholder="Jornada extra" />
              </label>
              <label>Se paga
                <select name={`type.${index}.unit`} bind:value={type.unit}>
                  <option value="per_hour">Por hora</option>
                  <option value="per_shift">Por jornada</option>
                  <option value="fixed_amount">Importe fijo por supuesto</option>
                </select>
              </label>
              <label>Tarifa (vacío = sin tarifa)
                <input type="text" inputmode="decimal" name={`type.${index}.rate`} bind:value={type.rate} placeholder="50,00" />
              </label>
              {#if type.unit !== 'per_hour'}
                <label>Duración de la jornada (minutos)
                  <input type="number" name={`type.${index}.referenceMinutes`} bind:value={type.referenceMinutes} min="1" max="10080" />
                </label>
              {:else}
                <input type="hidden" name={`type.${index}.referenceMinutes`} value="" />
              {/if}
              <label class="check-label">
                <input type="checkbox" name={`type.${index}.active`} bind:checked={type.active} />
                Se lo permito
              </label>
              <button class="button secondary small-button" type="button" onclick={() => removeType(draft, index)}>Quitar</button>
            </div>
          {/each}
          <div class="action-row">
            <button class="button secondary small-button" type="button" onclick={() => addType(draft)}>Añadir tipo de trabajo extra</button>
          </div>

          <h3>Complementos</h3>
          <p><small>«Lo paga la casa» consta en sus condiciones pero NO entra en la transferencia del mes.</small></p>
          {#each draft.supplements as supplement, index (index)}
            <div class="form-grid">
              <label>Código
                <input type="text" name={`supplement.${index}.code`} bind:value={supplement.code} required placeholder="antiguedad" pattern="[a-z][a-z0-9_]{'{'}1,38{'}'}[a-z0-9]" />
              </label>
              <label>Nombre
                <input type="text" name={`supplement.${index}.name`} bind:value={supplement.name} required maxlength="80" placeholder="Complemento de antigüedad" />
              </label>
              <label>Importe al mes
                <input type="text" inputmode="decimal" name={`supplement.${index}.amount`} bind:value={supplement.amount} placeholder="30,00" />
              </label>
              <label>Quién lo cobra
                <select name={`supplement.${index}.addsToPay`} bind:value={supplement.addsToPay}>
                  <option value={true}>Suma a su transferencia</option>
                  <option value={false}>Lo paga la casa aparte</option>
                </select>
              </label>
              <label>Desde (opcional)
                <input type="date" name={`supplement.${index}.startsOn`} bind:value={supplement.startsOn} />
              </label>
              <label>Hasta (opcional)
                <input type="date" name={`supplement.${index}.endsOn`} bind:value={supplement.endsOn} />
              </label>
              <label class="check-label">
                <input type="checkbox" name={`supplement.${index}.active`} bind:checked={supplement.active} />
                Vigente
              </label>
              <button class="button secondary small-button" type="button" onclick={() => removeSupplement(draft, index)}>Quitar</button>
            </div>
          {/each}
          <div class="action-row">
            <button class="button secondary small-button" type="button" onclick={() => addSupplement(draft)}>Añadir complemento</button>
          </div>

          {#if form?.stackError && form?.agreementId === agreement.id}
            <p class="form-error" role="alert">{form.stackError}</p>
          {/if}
          <div class="action-row">
            <button class="button primary small-button" type="submit">Guardar como versión nueva</button>
          </div>
        </form>
      {/if}
    </article>
  {/each}

  <article class="card">
    <div class="section-heading">
      <div><p class="eyebrow">Alta</p><h2>Nuevo acuerdo</h2></div>
    </div>
    {#if admin.candidates.length === 0}
      <p>
        No hay ninguna empleada interna sin acuerdo activo. Da de alta primero su acceso
        en Ajustes; el hogar admite varios acuerdos vivos a la vez, uno por persona.
      </p>
    {:else}
      <div class="action-row">
        <button
          class="button secondary small-button"
          type="button"
          aria-expanded={creating}
          onclick={() => (creating = !creating)}
        >Dar de alta un acuerdo</button>
      </div>
      {#if creating}
        <form
          class="action-form"
          method="POST"
          action="?/create"
          use:enhance={() => async ({ result, update }) => {
            await update({ reset: false });
            if (result.type === 'success') creating = false;
          }}
        >
          <div class="form-grid">
            <label>Empleada
              <select name="employeeMembershipId" bind:value={createEmployee} required>
                <option value="" disabled>Elige a quién</option>
                {#each admin.candidates as candidate (candidate.membershipId)}
                  <option value={candidate.membershipId}>{candidateLabel(candidate)}</option>
                {/each}
              </select>
            </label>
            <label>El acuerdo empieza el
              <input type="date" name="startsOn" bind:value={createStartsOn} required />
            </label>
            <label>La primera versión rige desde
              <input type="date" name="effectiveFrom" bind:value={createDraft.effectiveFrom} required />
            </label>
            <label>Salario mensual
              <input type="text" inputmode="decimal" name="monthlySalary" bind:value={createDraft.monthlySalary} required placeholder="1.500,00" />
            </label>
            <label>Jornada semanal (minutos)
              <input type="number" name="contractedWeeklyMinutes" bind:value={createDraft.contractedWeeklyMinutes} min="1" max="10080" required />
            </label>
            <label>Vacaciones al año (días naturales)
              <input type="number" name="annualVacationDays" bind:value={createDraft.annualVacationDays} min="0" max="365" required />
            </label>
          </div>
          <label>Motivo
            <input type="text" name="reason" bind:value={createDraft.reason} maxlength="500" required placeholder="Alta del acuerdo" />
          </label>

          <h3>Trabajo extra</h3>
          {#each createDraft.types as type, index (index)}
            <div class="form-grid">
              <label>Código
                <input type="text" name={`type.${index}.code`} bind:value={type.code} required placeholder="jornada_extra" />
              </label>
              <label>Nombre
                <input type="text" name={`type.${index}.name`} bind:value={type.name} required maxlength="80" />
              </label>
              <label>Se paga
                <select name={`type.${index}.unit`} bind:value={type.unit}>
                  <option value="per_hour">Por hora</option>
                  <option value="per_shift">Por jornada</option>
                  <option value="fixed_amount">Importe fijo por supuesto</option>
                </select>
              </label>
              <label>Tarifa (vacío = sin tarifa)
                <input type="text" inputmode="decimal" name={`type.${index}.rate`} bind:value={type.rate} />
              </label>
              {#if type.unit !== 'per_hour'}
                <label>Duración de la jornada (minutos)
                  <input type="number" name={`type.${index}.referenceMinutes`} bind:value={type.referenceMinutes} min="1" max="10080" />
                </label>
              {:else}
                <input type="hidden" name={`type.${index}.referenceMinutes`} value="" />
              {/if}
              <label class="check-label">
                <input type="checkbox" name={`type.${index}.active`} bind:checked={type.active} />
                Se lo permito
              </label>
            </div>
          {/each}
          <div class="action-row">
            <button class="button secondary small-button" type="button" onclick={() => addType(createDraft)}>Añadir tipo</button>
          </div>

          <h3>Complementos</h3>
          {#each createDraft.supplements as supplement, index (index)}
            <div class="form-grid">
              <label>Código
                <input type="text" name={`supplement.${index}.code`} bind:value={supplement.code} required />
              </label>
              <label>Nombre
                <input type="text" name={`supplement.${index}.name`} bind:value={supplement.name} required maxlength="80" />
              </label>
              <label>Importe al mes
                <input type="text" inputmode="decimal" name={`supplement.${index}.amount`} bind:value={supplement.amount} />
              </label>
              <label>Quién lo cobra
                <select name={`supplement.${index}.addsToPay`} bind:value={supplement.addsToPay}>
                  <option value={true}>Suma a su transferencia</option>
                  <option value={false}>Lo paga la casa aparte</option>
                </select>
              </label>
              <label class="check-label">
                <input type="checkbox" name={`supplement.${index}.active`} bind:checked={supplement.active} />
                Vigente
              </label>
            </div>
          {/each}
          <div class="action-row">
            <button class="button secondary small-button" type="button" onclick={() => addSupplement(createDraft)}>Añadir complemento</button>
          </div>

          {#if form?.createError}
            <p class="form-error" role="alert">{form.createError}</p>
          {/if}
          <div class="action-row">
            <button class="button primary small-button" type="submit">Dar de alta el acuerdo</button>
          </div>
        </form>
      {/if}
    {/if}
  </article>
{/if}

<style>
  .check-label {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
</style>
