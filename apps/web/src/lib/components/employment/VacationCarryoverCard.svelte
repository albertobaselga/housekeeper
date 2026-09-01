<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import {
    carryOverVacationDays,
    compensateVacationCarryover,
    rejectVacationCarryover
  } from '$lib/employment/commands';
  import { employmentTabHref } from '$lib/employment/model';
  import type { CommandEnvelopeV1 } from '@casa-clara/contracts';
  import type {
    VacationCarryoverDecisionView,
    VacationCarryoverProposalView
  } from '$lib/employment/model';

  let {
    householdId,
    today,
    proposals,
    decisions,
    canDecide,
    showPerson
  }: {
    householdId: string;
    /** Hoy en la zona del hogar: de aquí sale el mes al que se pide imputar. */
    today: string;
    /** Años cerrados con días sin disfrutar y sin decisión. Vacío para quien no administra. */
    proposals: VacationCarryoverProposalView[];
    /** Lo ya decidido, como línea aparte del derecho del año. */
    decisions: VacationCarryoverDecisionView[];
    /** Sólo la familia administradora decide; el resto lo lee. */
    canDecide: boolean;
    /** Con varias personas en la casa, cada línea dice de quién es. */
    showPerson: boolean;
  } = $props();

  // svelte-ignore state_referenced_locally -- el hogar no cambia dentro de la página
  const optimistic = new OptimisticActions({ householdId, invalidateToken: 'cc:vacations' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // Lo decidido en esta sesión desaparece de la lista de propuestas al instante
  // y sólo vuelve si el servidor rechaza la decisión.
  let settled = $state<string[]>([]);
  const pending = $derived(
    proposals.filter((proposal) => !settled.includes(keyOf(proposal)))
  );

  let rejectOpen = $state<string | null>(null);
  let rejectReason = $state('');

  function keyOf(proposal: VacationCarryoverProposalView): string {
    return `${proposal.agreementId}:${proposal.sourceYearIndex}`;
  }

  function decide(proposal: VacationCarryoverProposalView, envelope: CommandEnvelopeV1): void {
    const key = keyOf(proposal);
    void optimistic.run(envelope, {
      apply: () => {
        settled = [...settled, key];
        rejectOpen = null;
        rejectReason = '';
      },
      revert: () => {
        settled = settled.filter((candidate) => candidate !== key);
      },
      messageOverrides: {
        vacation_carryover_decided: 'Esos días ya se habían decidido desde otro sitio.',
        vacation_day_rate_not_agreed:
          'El contrato no pacta cuánto vale un día de vacaciones no disfrutado.',
        vacation_nothing_to_carry: 'Ese año de contrato ya no tiene días sin disfrutar.',
        vacation_year_not_closed: 'Ese año de contrato todavía no ha terminado.'
      }
    });
  }
</script>

{#if pending.length > 0 || decisions.length > 0}
  <article class="card">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Vacaciones</p>
        <h2>Días de años ya cerrados</h2>
      </div>
    </div>

    <!-- Lo decidido va primero y como LÍNEA APARTE del derecho del año: sumar
         los días arrastrados al derecho nuevo convertiría un «30» en un «48»
         que se lee como un error de la aplicación. -->
    {#if decisions.length > 0}
      <div class="ledger-list">
        {#each decisions as decision (decision.id)}
          <div>
            <span>
              <strong>{decision.summary}</strong>
              {#if showPerson || decision.detail}
                <small>
                  {showPerson ? decision.employeeLabel : ''}{showPerson && decision.detail
                    ? ' · '
                    : ''}{decision.detail ?? ''}
                </small>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    {#each pending as proposal (keyOf(proposal))}
      <section class="carryover-proposal">
        <h3>{proposal.headline}</h3>
        <p class="audit-note">
          {showPerson ? `${proposal.employeeLabel} · ` : ''}{proposal.detail}
        </p>
        {#if proposal.compensationBasis}
          <p class="audit-note">{proposal.compensationBasis}</p>
        {/if}

        {#if canDecide}
          <div class="action-row">
            <button
              class="button primary small-button"
              type="button"
              onclick={() =>
                decide(
                  proposal,
                  carryOverVacationDays({
                    householdId,
                    agreementId: proposal.agreementId,
                    sourceYearIndex: proposal.sourceYearIndex
                  })
                )}
            >Arrastrarlos</button>

            {#if proposal.compensationLabel}
              <button
                class="button secondary small-button"
                type="button"
                onclick={() =>
                  decide(
                    proposal,
                    compensateVacationCarryover({
                      householdId,
                      agreementId: proposal.agreementId,
                      sourceYearIndex: proposal.sourceYearIndex,
                      period: today.slice(0, 7)
                    })
                  )}
              >Pagar {proposal.compensationLabel}</button>
            {:else}
              <!-- Sin tarifa pactada no se ofrece compensar: ni un cero ni una
                   estimación. Se dice qué falta y se lleva a pactarlo. -->
              <a
                class="button secondary small-button"
                href={employmentTabHref(householdId, 'acuerdo', proposal.agreementId)}
              >Pactar el precio del día</a>
            {/if}

            <button
              class="button secondary small-button"
              type="button"
              aria-expanded={rejectOpen === keyOf(proposal)}
              onclick={() => {
                rejectOpen = rejectOpen === keyOf(proposal) ? null : keyOf(proposal);
                rejectReason = '';
              }}
            >Darlos por perdidos</button>
          </div>

          {#if rejectOpen === keyOf(proposal)}
            <form
              class="action-form"
              onsubmit={(event) => {
                event.preventDefault();
                const reason = rejectReason.trim();
                if (!reason) return;
                decide(
                  proposal,
                  rejectVacationCarryover({
                    householdId,
                    agreementId: proposal.agreementId,
                    sourceYearIndex: proposal.sourceYearIndex,
                    reason
                  })
                );
              }}
            >
              <label>Por qué se pierden
                <input
                  type="text"
                  autocomplete="off"
                  enterkeyhint="done"
                  bind:value={rejectReason}
                  maxlength="500"
                  required
                  placeholder="Se habló con ella y prefirió no arrastrarlos…"
                />
              </label>
              <p class="audit-note">
                Los días se pierden y queda escrito quién lo decidió y por qué. No se puede
                deshacer: para corregirlo hay que hablarlo y apuntar lo que se acuerde.
              </p>
              <div class="action-row">
                <button
                  class="button primary small-button"
                  type="submit"
                  disabled={!rejectReason.trim()}
                >Darlos por perdidos</button>
              </div>
            </form>
          {/if}
        {/if}
      </section>
    {/each}

    <p class="card-footnote">
      El año de vacaciones es el del contrato, no el natural. Los días que quedan al cerrarse un
      año no se pierden solos: se arrastran, se pagan o se dan por perdidos, y quede lo que quede
      decidido consta aquí con su fecha y su motivo.
    </p>

    <ActionStatus status={actionStatus} />
  </article>
{/if}

<style>
  .carryover-proposal {
    margin-top: var(--space-5);
  }
  .carryover-proposal h3 {
    font-size: var(--text-body);
    letter-spacing: 0.02em;
  }
</style>
