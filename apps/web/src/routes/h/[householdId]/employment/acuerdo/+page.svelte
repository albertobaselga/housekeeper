<script lang="ts">
  import { enhance } from '$app/forms';
  import {
    scheduleCoherence,
    weekdayName,
    type AgreementSchedule,
    type Weekday
  } from '@casa-clara/domain';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import EmploymentPersonBar from '$lib/components/employment/EmploymentPersonBar.svelte';
  import EmploymentTabs from '$lib/components/employment/EmploymentTabs.svelte';
  import { PAYER_CHOICES, type PayerChoice } from '$lib/employment/payer';
  import { centsToEuroInput, scheduleMismatchLabel } from '$lib/employment/model';
  import type { AgreementVersionAdminView } from '$lib/server/agreement-terms.server';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const agreement = $derived(data.agreement);
  /** La que rige hoy. Es lo que se viene a mirar; el resto es historial. */
  const current = $derived(
    agreement?.versions.find((version) => version.state === 'vigente') ??
      agreement?.versions[0] ??
      null
  );

  /**
   * Lo que la versión vigente todavía no pacta, en las palabras de lo que ella
   * NO puede hacer mientras falte. Es lo que el alta deja aplazado a propósito,
   * y el aplazamiento sólo vale si la pantalla lo dice.
   */
  const faltaPorPactar = $derived.by(() => {
    if (!current) return [];
    const falta: string[] = [];
    if (!current.schedule) {
      falta.push('el horario, y mientras falte ella no ve ninguna sección de horario');
    }
    // La misma condición que la política `extra_work_types_employee_read` de la
    // 0021 —activo Y con tarifa—, que es la que decide qué puede registrar.
    if (!current.extraWorkTypes.some((type) => type.available)) {
      falta.push('el trabajo extra, y mientras falte ella no puede registrar ninguna jornada');
    }
    return falta;
  });

  const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];
  const capitalise = (text: string) => `${text[0]!.toLocaleUpperCase('es')}${text.slice(1)}`;

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

  /** `addsToPay` viaja como texto, y por la misma constante que lee el servidor. */
  type SupplementDraft = {
    code: string;
    name: string;
    amount: string;
    addsToPay: PayerChoice;
    startsOn: string;
    endsOn: string;
    active: boolean;
  };

  /**
   * Un día de la semana en el editor. `mode` es la única pregunta que se le
   * hace a quien administra —«¿este día es como los demás, es distinto, o se
   * libra?»— y de las tres respuestas solo la primera no guarda nada.
   */
  type ScheduleDayDraft = {
    weekday: Weekday;
    mode: 'tipo' | 'distinto' | 'libra';
    startsAt: string;
    endsAt: string;
    longBreakMinutes: string;
    note: string;
  };

  type ScheduleDraft = {
    /** Sin marcar no se escribe nada y la empleada no ve sección de horario. */
    declared: boolean;
    startsAt: string;
    endsAt: string;
    longBreakMinutes: number;
    note: string;
    days: ScheduleDayDraft[];
  };

  type Draft = {
    effectiveFrom: string;
    monthlySalary: string;
    contractedWeeklyMinutes: number;
    annualVacationDays: number;
    unusedVacationDayRate: string;
    carryoverExpiryMode: 'months' | 'never';
    carryoverExpiryMonths: number;
    reason: string;
    types: TypeDraft[];
    supplements: SupplementDraft[];
    schedule: ScheduleDraft;
  };

  function emptyScheduleDraft(): ScheduleDraft {
    return {
      declared: false,
      startsAt: '09:00',
      endsAt: '18:00',
      longBreakMinutes: 60,
      note: '',
      days: WEEKDAYS.map((weekday) => ({
        weekday,
        mode: 'tipo' as const,
        startsAt: '',
        endsAt: '',
        longBreakMinutes: '',
        note: ''
      }))
    };
  }

  /**
   * El horario vigente convertido en borrador. Se parte de él y no de una
   * pantalla en blanco por una razón concreta: apilar una versión SIN horario
   * se lo retira a la empleada a partir de esa fecha, y eso tiene que ser una
   * decisión, no un despiste.
   */
  function scheduleDraftFrom(version: AgreementVersionAdminView | null): ScheduleDraft {
    const currentSchedule = version?.schedule ?? null;
    if (!currentSchedule) return emptyScheduleDraft();
    return {
      declared: true,
      startsAt: currentSchedule.startsAt,
      endsAt: currentSchedule.endsAt,
      longBreakMinutes: currentSchedule.longBreakMinutes,
      note: currentSchedule.note,
      days: WEEKDAYS.map((weekday) => {
        const day = currentSchedule.days.find((candidate) => candidate.weekday === weekday);
        if (!day || (!day.differs && day.note === '')) {
          return { weekday, mode: 'tipo' as const, startsAt: '', endsAt: '', longBreakMinutes: '', note: '' };
        }
        if (!day.works) {
          return { weekday, mode: 'libra' as const, startsAt: '', endsAt: '', longBreakMinutes: '', note: day.note };
        }
        return {
          weekday,
          mode: 'distinto' as const,
          startsAt: day.startsAt ?? '',
          endsAt: day.endsAt ?? '',
          longBreakMinutes: String(day.longBreakMinutes),
          note: day.note
        };
      })
    };
  }

  /**
   * Lo que sumaría a la semana el horario que se está escribiendo, comparado
   * con la jornada contratada del mismo formulario.
   *
   * Usa el MISMO motor que el servidor y las pruebas (`@casa-clara/domain`): si
   * este aviso se calculara aquí con aritmética propia, la pantalla y lo
   * guardado podrían decir dos cosas distintas del mismo horario.
   *
   * Devuelve null mientras el borrador no sea un horario válido —en mitad de
   * teclear «1» en un campo de hora no lo es—, porque avisar de una incoherencia
   * calculada sobre datos a medio escribir sería ruido, no información.
   */
  function livePreview(draft: Draft): { minutes: number; mismatch: string | null } | null {
    if (!draft.schedule.declared) return null;
    const pure: AgreementSchedule = {
      startsAt: draft.schedule.startsAt,
      endsAt: draft.schedule.endsAt,
      longBreakMinutes: Number(draft.schedule.longBreakMinutes),
      note: draft.schedule.note,
      days: draft.schedule.days
        .filter((day) => day.mode !== 'tipo')
        .map((day) => ({
          weekday: day.weekday,
          works: day.mode !== 'libra',
          startsAt: day.mode === 'distinto' && day.startsAt !== '' ? day.startsAt : null,
          endsAt: day.mode === 'distinto' && day.endsAt !== '' ? day.endsAt : null,
          longBreakMinutes:
            day.mode === 'distinto' && day.longBreakMinutes !== ''
              ? Number(day.longBreakMinutes)
              : null,
          note: day.note
        }))
    };
    try {
      const coherence = scheduleCoherence(pure, draft.contractedWeeklyMinutes);
      return {
        minutes: coherence.weeklyMinutes,
        // La frase la escribe el modelo, no esta plantilla: es la MISMA que
        // verá luego la versión guardada y la que lee la empleada.
        mismatch: scheduleMismatchLabel(
          coherence.weeklyMinutes,
          coherence.contractedWeeklyMinutes
        )
      };
    } catch {
      return null;
    }
  }

  function draftFromVersion(version: AgreementVersionAdminView | null, today: string): Draft {
    return {
      effectiveFrom: today,
      monthlySalary: version ? centsToEuroInput(version.monthlySalaryCents) : '',
      contractedWeeklyMinutes: version?.weeklyMinutes ?? 2400,
      annualVacationDays: version?.annualVacationDays ?? 30,
      // Vacío no es cero: es «no se pactó», y así se conserva al apilar si nadie
      // lo rellena. Un cero aquí quedaría escrito para siempre.
      unusedVacationDayRate:
        version?.unusedVacationDayRateCents == null
          ? ''
          : centsToEuroInput(version.unusedVacationDayRateCents),
      carryoverExpiryMode: version?.vacationCarryoverExpiry.mode ?? 'months',
      carryoverExpiryMonths:
        version?.vacationCarryoverExpiry.mode === 'months'
          ? version.vacationCarryoverExpiry.months
          : 6,
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
        addsToPay: supplement.addsToPay ? PAYER_CHOICES.addsToPay : PAYER_CHOICES.paidByHousehold,
        startsOn: supplement.startsOn ?? '',
        endsOn: supplement.endsOn ?? '',
        active: supplement.active
      })),
      schedule: scheduleDraftFrom(version)
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
    addsToPay: PAYER_CHOICES.addsToPay,
    startsOn: '',
    endsOn: '',
    active: true
  };

  // Un solo borrador, el de esta persona, sembrado con lo que rige hoy. Antes
  // había un diccionario de borradores porque la pantalla enseñaba a todo el
  // hogar; con una persona por pantalla, ese diccionario no tenía a quién
  // distinguir.
  //
  // Se siembra en un efecto y no en la inicialización porque cambiar de persona
  // no recrea el componente: la ruta es la misma y sólo cambia `?empleada`. Sin
  // esto, el editor de la segunda persona saldría con las condiciones de la
  // primera. `sembradoPara` es una variable normal a propósito: es el rastro de
  // lo ya hecho, no estado que nadie tenga que mirar.
  let draft = $state<Draft>(draftFromVersion(null, ''));
  let sembradoPara: string | null = null;
  let editorAbierto = $state(false);

  $effect(() => {
    // La clave lleva también la versión vigente: al apilar una, el editor tiene
    // que reabrirse partiendo de lo que rige AHORA, no de lo que regía antes de
    // guardar. Mientras la versión no cambie —un envío rechazado, por ejemplo—
    // lo tecleado se conserva.
    const clave = `${agreement?.id ?? ''}:${current?.id ?? ''}`;
    if (clave === sembradoPara) return;
    sembradoPara = clave;
    draft = draftFromVersion(current, data.today);
  });

  function addType(): void {
    draft.types = [...draft.types, { ...EMPTY_TYPE }];
  }
  function removeType(index: number): void {
    draft.types = draft.types.filter((_, position) => position !== index);
  }
  function addSupplement(): void {
    draft.supplements = [...draft.supplements, { ...EMPTY_SUPPLEMENT }];
  }
  function removeSupplement(index: number): void {
    draft.supplements = draft.supplements.filter((_, position) => position !== index);
  }
</script>

<!--
  El editor de horario, en su propio bloque para que el formulario largo tenga
  costuras visibles y no siete campos detrás de otros siete.
-->
{#snippet scheduleFields(editing: Draft)}
  <fieldset>
    <legend>Horario</legend>
    <p>
      <small>
        El horario es una condición del contrato: cambiarlo aquí crea versión nueva, igual
        que el salario. Si no lo declaras, a la empleada no se le enseña ninguna sección de
        horario —ni vacía ni con guiones—.
      </small>
    </p>
    <label class="inline-check">
      <input type="checkbox" name="schedule.declared" bind:checked={editing.schedule.declared} />
      Este contrato declara horario
    </label>

    {#if editing.schedule.declared}
      {@const preview = livePreview(editing)}
      <div class="form-grid">
        <label>Entra a las
          <input type="time" name="schedule.startsAt" bind:value={editing.schedule.startsAt} required />
        </label>
        <label>Sale a las
          <input type="time" name="schedule.endsAt" bind:value={editing.schedule.endsAt} required />
        </label>
        <label>Descanso al mediodía (minutos)
          <input
            type="number"
            name="schedule.longBreakMinutes"
            bind:value={editing.schedule.longBreakMinutes}
            min="0"
            max="1439"
            required
          />
        </label>
      </div>
      <label>Nota sobre el horario (opcional)
        <input
          type="text"
          name="schedule.note"
          bind:value={editing.schedule.note}
          maxlength="500"
          placeholder="Cuándo se toma el descanso, por ejemplo"
        />
      </label>

      <p>
        <small>
          Los días que no toques trabajan la jornada de arriba. Solo hace falta decir lo
          que cambia: para terminar antes un día basta con su hora de salida.
        </small>
      </p>
      <table class="schedule-table">
        <thead>
          <tr><th scope="col">Día</th><th scope="col">Cómo es</th><th scope="col">Ese día</th></tr>
        </thead>
        <tbody>
          {#each editing.schedule.days as day (day.weekday)}
            <tr>
              <th scope="row">{capitalise(weekdayName(day.weekday))}</th>
              <td>
                <!-- Etiqueta envolvente y no `for`/`id`: el snippet se puede
                     volver a usar y dos identificadores iguales romperían la
                     asociación. -->
                <label>
                  <span class="sr-only">Cómo es el {weekdayName(day.weekday)}</span>
                  <select name={`schedule.day.${day.weekday}.mode`} bind:value={day.mode}>
                    <option value="tipo">Como la jornada de arriba</option>
                    <option value="distinto">Horario distinto</option>
                    <option value="libra">Libra</option>
                  </select>
                </label>
              </td>
              <td>
                {#if day.mode === 'distinto'}
                  <div class="form-grid compact">
                    <label>Entra
                      <input type="time" name={`schedule.day.${day.weekday}.startsAt`} bind:value={day.startsAt} />
                    </label>
                    <label>Sale
                      <input type="time" name={`schedule.day.${day.weekday}.endsAt`} bind:value={day.endsAt} />
                    </label>
                    <label>Descanso (min)
                      <input
                        type="number"
                        name={`schedule.day.${day.weekday}.longBreakMinutes`}
                        bind:value={day.longBreakMinutes}
                        min="0"
                        max="1439"
                      />
                    </label>
                    <label>Nota
                      <input type="text" name={`schedule.day.${day.weekday}.note`} bind:value={day.note} maxlength="200" />
                    </label>
                  </div>
                {:else if day.mode === 'libra'}
                  <label>Nota
                    <input type="text" name={`schedule.day.${day.weekday}.note`} bind:value={day.note} maxlength="200" />
                  </label>
                {:else}
                  <span class="audit-note">Sin cambios</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      <!--
        La incoherencia se dice ANTES de guardar, que es cuando todavía se puede
        pactar otra cosa. No bloquea el envío: un horario que no cuadra con la
        jornada contratada es un hecho que la casa tiene que ver, no un error de
        tecleo que el programa pueda arreglar solo.
      -->
      {#if preview?.mismatch}
        <p class="form-error" role="status">{preview.mismatch}</p>
      {:else if preview}
        <p class="form-ok" role="status">
          El horario cuadra con la jornada contratada: {Math.trunc(preview.minutes / 60)} h a la semana.
        </p>
      {/if}
    {/if}
  </fieldset>
{/snippet}

<!-- Era la única página del árbol `h/` sin `page-wrap`, y sin él `.card` no
     tiene margen propio: las tarjetas quedaban a cero píxeles unas de otras y la
     última, debajo de la barra inferior. El «todo pegado» era literal. -->
<div class="page-wrap">
  <PageHeader
    eyebrow="Contrato"
    title="Condiciones del contrato"
    description="Lo que rige hoy, cómo se cambia y el historial de lo pactado."
  />

  {#if agreement}
    <EmploymentPersonBar
      householdId={data.householdId}
      employeeLabel={agreement.employeeName}
      active={agreement.status === 'active'}
    />
  {/if}

  <EmploymentTabs householdId={data.householdId} current="contrato" empleada={data.empleada} />

  {#if !data.hayAdministracion}
    <article class="card">
      <p>
        Esta pantalla es de quien administra el hogar. Si administras y la ves vacía,
        es que este entorno no tiene base de datos conectada.
      </p>
    </article>
  {:else if !agreement}
    <article class="card">
      <div class="section-heading">
        <div><p class="eyebrow">Sin contrato</p><h2>Todavía no hay condiciones que enseñar</h2></div>
      </div>
      <p>
        Aquí no hay ningún contrato registrado en esta casa. Los contratos se pactan al
        añadir a una persona, o después desde la lista de personas.
      </p>
      <div class="action-row">
        <a class="button primary" href={`/h/${data.householdId}/employment`}>
          Ir a la lista de personas
        </a>
      </div>
    </article>
  {:else}
    {#if form?.stacked}
      <p class="form-ok" role="status">Versión nueva añadida. La anterior sigue en el historial.</p>
    {/if}

    <!-- ── Lo que rige hoy ──────────────────────────────────────────────── -->
    <article class="card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">
            {current ? `Vigente desde el ${current.effectiveFromLabel}` : 'Sin versiones'}
          </p>
          <h2>Lo que rige hoy</h2>
        </div>
        <span class="status-chip {agreement.status === 'active' ? 'success' : 'warning'}">
          {agreement.status === 'active' ? 'Contrato activo' : 'Contrato finalizado'}
        </span>
      </div>

      <!--
        Lo que el alta deja sin pactar, dicho ARRIBA y no enterrado en su
        sección. El alta pide inicio, salario, jornada y días de vacaciones, y
        nada más: el horario y el catálogo de trabajo extra se pactan luego aquí.
        Ese aplazamiento es deliberado —veintiocho campos en el segundo paso de
        un alta es la forma más segura de que alguien rellene cualquier cosa para
        poder seguir— pero sólo vale si se dice, porque las dos ausencias tienen
        consecuencias que ella nota y quien administra no ve: sin horario no se le
        enseña ninguna sección de horario, y sin catálogo no puede registrar ni
        una jornada extra. Un contrato a medias que nadie anuncia es peor que un
        formulario largo.
      -->
      {#if current && faltaPorPactar.length > 0}
        <p class="a-medias" role="status">
          <strong>Este contrato está a medias.</strong>
          Falta por pactar {faltaPorPactar.join(' y ')}. Se hace aquí abajo, en «Cambiar las
          condiciones»: apilar una versión no reescribe nada de lo ya pactado.
        </p>
      {/if}

      {#if !current}
        <p>Este contrato no tiene ninguna versión visible.</p>
      {:else}
        <div class="ledger-list">
          <div>
            <span><strong>Salario al mes</strong><small>Desde el {agreement.startsOnLabel} en la casa.</small></span>
            <span><strong>{current.salaryLabel}</strong></span>
          </div>
          <div>
            <span><strong>Jornada</strong></span>
            <span><strong>{current.weeklyLabel}</strong></span>
          </div>
          <div>
            <span><strong>Vacaciones al año</strong></span>
            <span><strong>{current.annualVacationDays} días</strong></span>
          </div>
          <div>
            <span>
              <strong>Día de vacaciones no disfrutado</strong>
              <!-- «Sin pactar» y NUNCA «0,00 €»: sin precio no se compensa nada
                   en dinero, y un cero se leería como un precio acordado. -->
              <small>
                {current.unusedVacationDayRateLabel
                  ? 'Es lo que se paga por cada día que se compense en dinero.'
                  : 'Sin pactar: los días sin disfrutar se arrastran o se rechazan, no se pagan.'}
              </small>
            </span>
            <span><strong>{current.unusedVacationDayRateLabel ?? 'Sin pactar'}</strong></span>
          </div>
          <div>
            <span><strong>Los días arrastrados</strong><small>Desde que termina el año de contrato.</small></span>
            <span><strong>{current.vacationCarryoverExpiryLabel}</strong></span>
          </div>
        </div>

        <!-- Sin horario pactado no hay fila en Postgres y aquí se dice tal cual:
             es lo que la empleada NO verá, y hay que saberlo antes de pactar. -->
        <h3>Horario</h3>
        {#if current.schedule}
          <p class="schedule-sentence">{current.schedule.sentence}</p>
          {#if current.schedule.mismatchLabel}
            <p class="audit-note" role="status">⚠ {current.schedule.mismatchLabel}</p>
          {/if}
        {:else}
          <p class="audit-note">
            Sin declarar: a la empleada no se le enseña ninguna sección de horario.
          </p>
        {/if}

        <h3>Trabajo extra</h3>
        {#if current.extraWorkTypes.length === 0}
          <p class="audit-note">
            Este contrato no contempla ningún trabajo extra, así que ella no puede registrar
            ninguno.
          </p>
        {:else}
          <div class="ledger-list">
            {#each current.extraWorkTypes as type (type.id)}
              <div>
                <span>
                  <strong>{type.name}</strong>
                  <small>
                    Se paga {type.unitLabel}{type.referenceLabel ? ` · ${type.referenceLabel}` : ''}
                    {#if !type.active}&nbsp;· desactivado: no lo ve{:else if !type.rateLabel}&nbsp;· sin tarifa: no lo ve{/if}
                  </small>
                </span>
                <span><strong>{type.rateLabel ?? 'Sin tarifa'}</strong></span>
              </div>
            {/each}
          </div>
        {/if}

        <h3>Complementos</h3>
        {#if current.supplements.length === 0}
          <p class="audit-note">Ningún complemento pactado en esta versión.</p>
        {:else}
          <div class="ledger-list">
            {#each current.supplements as supplement (supplement.id)}
              <div>
                <span>
                  <strong>{supplement.name}</strong>
                  <small>
                    {supplement.addsToPay ? 'Suma a su transferencia' : 'Lo paga la casa aparte'}{supplement.validityLabel ? ` · ${supplement.validityLabel}` : ''}{supplement.active ? '' : ' · retirado'}
                  </small>
                </span>
                <span><strong>{supplement.amountLabel ?? 'Sin importe'}</strong></span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </article>

    <!-- ── El único camino de cambio ─────────────────────────────────────── -->
    {#if form?.stackError}
      <p class="form-error" role="alert">{form.stackError}</p>
    {/if}
    <details class="card" bind:open={editorAbierto}>
      <summary>
        <strong>Cambiar las condiciones</strong>
        <small>
          Las condiciones no se corrigen: se apilan. Lo que pactes aquí entra en vigor en
          la fecha que indiques y lo anterior queda como histórico consultable, porque es
          lo que se aplicó a lo ya trabajado.
        </small>
      </summary>

      <form
        class="action-form"
        method="POST"
        action="?/stackVersion"
        use:enhance={() => async ({ result, update }) => {
          await update({ reset: false });
          if (result.type === 'success') editorAbierto = false;
        }}
      >
        <input type="hidden" name="agreementId" value={agreement.id} />

        <fieldset>
          <legend>Lo básico</legend>
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
        </fieldset>

        <fieldset>
          <legend>Vacaciones no disfrutadas</legend>
          <p>
            <small>
              El precio del día no se calcula: se pacta. Déjalo vacío si no se ha pactado
              —entonces los días sin disfrutar se arrastran o se rechazan, y la aplicación no
              estima ningún importe—. Un cero diría que se acordó pagar cero euros por día, y
              eso queda escrito para siempre.
            </small>
          </p>
          <div class="form-grid">
            <label>Precio del día no disfrutado (vacío = sin pactar)
              <input type="text" inputmode="decimal" name="unusedVacationDayRate" bind:value={draft.unusedVacationDayRate} placeholder="sin pactar" />
            </label>
            <label>Los días arrastrados
              <select name="carryoverExpiryMode" bind:value={draft.carryoverExpiryMode}>
                <option value="months">caducan pasados unos meses</option>
                <option value="never">no expiran nunca</option>
              </select>
            </label>
            <!-- El campo se pinta SIEMPRE, aunque hoy rija «nunca expiran».
                 Pintarlo sólo con el modo en «meses» dejaba el HTML servido de
                 un contrato que pactó «nunca» sin este campo, así que sin
                 JavaScript no se podía volver a «caducan pasados unos meses»: el
                 formulario mandaba el `<select>` y nada más, y salía NaN. El
                 servidor lo ignora cuando el modo es «nunca», que es donde esa
                 decisión pertenece. -->
            <label>Meses de margen (si caducan)
              <input type="number" name="carryoverExpiryMonths" bind:value={draft.carryoverExpiryMonths} min="1" max="120" required />
            </label>
          </div>
        </fieldset>

        {@render scheduleFields(draft)}

        <fieldset>
          <legend>Trabajo extra</legend>
          <p><small>Lo que esté desactivado o sin tarifa no lo verá la empleada, ni en sus condiciones ni al registrar trabajo.</small></p>
          {#each draft.types as type, index (index)}
            <!-- Cada fila en su propio marco: son siete campos, y sin borde la
                 fila 1 y la fila 2 eran catorce campos seguidos. -->
            <fieldset class="fila">
              <legend>{type.name || 'Concepto nuevo'}</legend>
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
                  <input type="text" inputmode="decimal" name={`type.${index}.rate`} bind:value={type.rate} placeholder="sin tarifa" />
                </label>
                {#if type.unit !== 'per_hour'}
                  <label>Duración de la jornada (minutos)
                    <input type="number" name={`type.${index}.referenceMinutes`} bind:value={type.referenceMinutes} min="1" max="10080" />
                  </label>
                {:else}
                  <input type="hidden" name={`type.${index}.referenceMinutes`} value="" />
                {/if}
                <label class="inline-check">
                  <input type="checkbox" name={`type.${index}.active`} bind:checked={type.active} />
                  Se lo permito
                </label>
              </div>
              <div class="action-row">
                <button class="button secondary small-button" type="button" onclick={() => removeType(index)}>Quitar</button>
              </div>
            </fieldset>
          {/each}
          <div class="action-row">
            <button class="button secondary small-button" type="button" onclick={addType}>Añadir tipo de trabajo extra</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Complementos</legend>
          <p><small>«Lo paga la casa» consta en sus condiciones pero NO entra en la transferencia del mes.</small></p>
          {#each draft.supplements as supplement, index (index)}
            <fieldset class="fila">
              <legend>{supplement.name || 'Complemento nuevo'}</legend>
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
                    <option value={PAYER_CHOICES.addsToPay}>Suma a su transferencia</option>
                    <option value={PAYER_CHOICES.paidByHousehold}>Lo paga la casa aparte</option>
                  </select>
                </label>
                <label>Desde (opcional)
                  <input type="date" name={`supplement.${index}.startsOn`} bind:value={supplement.startsOn} />
                </label>
                <label>Hasta (opcional)
                  <input type="date" name={`supplement.${index}.endsOn`} bind:value={supplement.endsOn} />
                </label>
                <label class="inline-check">
                  <input type="checkbox" name={`supplement.${index}.active`} bind:checked={supplement.active} />
                  Vigente
                </label>
              </div>
              <div class="action-row">
                <button class="button secondary small-button" type="button" onclick={() => removeSupplement(index)}>Quitar</button>
              </div>
            </fieldset>
          {/each}
          <div class="action-row">
            <button class="button secondary small-button" type="button" onclick={addSupplement}>Añadir complemento</button>
          </div>
        </fieldset>

        {#if form?.stackError && form?.agreementId === agreement.id}
          <p class="form-error" role="alert">{form.stackError}</p>
        {/if}
        <div class="action-row">
          <button class="button primary" type="submit">Guardar como versión nueva</button>
        </div>
      </form>
    </details>

    <!-- ── El historial, plegado ─────────────────────────────────────────── -->
    <details class="card">
      <summary>
        <strong>El contrato, versión a versión</strong>
        <small>Lo ya pactado no se reescribe nunca; queda aquí con su fecha y su motivo.</small>
      </summary>
      <div class="ledger-list">
        {#each agreement.versions as version (version.id)}
          <!-- El ancla la usan las líneas de la cuenta («ver origen»): una
               línea de salario enlaza a la versión que la valoró. -->
          <div id={`version-${version.id}`}>
            <span>
              <strong>v{version.versionNumber} · desde el {version.effectiveFromLabel}</strong>
              <small>{version.reason}</small>
              <small>{version.weeklyLabel} · {version.annualVacationDays} días de vacaciones · {version.vacationCarryoverExpiryLabel} · día no disfrutado: {version.unusedVacationDayRateLabel ?? 'sin pactar'}</small>
              <!-- El separador va ANTES de cada elemento salvo el primero. Antes
                   se emitía DESPUÉS de cada uno, incluido el último, y cada línea
                   del historial terminaba en un « · » colgante. -->
              {#if version.extraWorkTypes.length > 0}
                <small>Trabajo extra: {#each version.extraWorkTypes as type, index (type.id)}{index > 0 ? ' · ' : ''}{type.name}: {type.active ? (type.rateLabel ?? 'sin tarifa · no la ve') : 'desactivado · no lo ve'}{/each}</small>
              {/if}
              {#if version.supplements.length > 0}
                <small>Complementos: {#each version.supplements as supplement, index (supplement.id)}{index > 0 ? ' · ' : ''}{supplement.name}: {supplement.amountLabel ?? 'sin importe'} {supplement.addsToPay ? '(suma al pago)' : '(lo paga la casa)'}{supplement.active ? '' : ' · retirado'}{/each}</small>
              {/if}
              <small>
                {#if version.schedule}
                  Horario: {version.schedule.sentence}
                {:else}
                  Horario: sin declarar · la empleada no ve ninguna sección de horario
                {/if}
              </small>
              {#if version.schedule?.mismatchLabel}
                <small class="schedule-mismatch">⚠ {version.schedule.mismatchLabel}</small>
              {/if}
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
    </details>
  {/if}
</div>

<style>
  /* Tabla estrecha y con scroll propio: siete días con cuatro campos cada uno
     no caben en un móvil, y el remedio nunca es que la página entera se
     desplace de lado (spec mobile-overflow). */
  .schedule-table {
    display: block;
    overflow-x: auto;
    width: 100%;
    border-collapse: collapse;
    margin: var(--space-2) 0;
  }

  .schedule-table th,
  .schedule-table td {
    text-align: left;
    vertical-align: top;
    padding: var(--space-1) var(--space-2) var(--space-1) 0;
  }

  .form-grid.compact {
    gap: var(--space-2);
  }

  .schedule-mismatch {
    font-weight: 500;
  }

  /* Aire entre bloques del formulario: el hueco entre dos secciones no puede
     ser el mismo que entre dos etiquetas, o no se ve dónde acaba una. */
  fieldset {
    border: 0;
    display: grid;
    gap: var(--space-3);
    margin: 0 0 var(--space-5);
    padding: 0;
  }

  fieldset > legend {
    font-size: var(--text-strong);
    font-weight: 700;
    padding: 0;
  }

  fieldset.fila {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    padding: var(--space-3);
  }

  fieldset.fila > legend {
    font-size: var(--text-meta);
    padding: 0 var(--space-1);
  }

  /* El resumen es la diana completa, y con altura de fila de datos para que se
     pueda tocar con el pulgar. */
  details > summary {
    cursor: pointer;
    display: grid;
    gap: var(--space-1);
    min-height: var(--row-data);
    align-content: center;
    touch-action: manipulation;
  }

  details > summary > small {
    color: var(--ink-soft);
    font-size: var(--text-meta);
  }

  details[open] > summary {
    border-bottom: 1px solid var(--line);
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-3);
  }

  .schedule-sentence {
    font-size: var(--text-strong);
    font-weight: 500;
    line-height: var(--lh-base);
  }

  /* El aviso de contrato a medias: se tiene que ver antes que las condiciones,
     no después de bajar hasta su sección. Ámbar, que en esta casa significa
     «esto te espera», y no rojo: no es un error, es trabajo pendiente. */
  .a-medias {
    border-radius: var(--r-md);
    background: var(--warning-soft);
    color: var(--warning);
    margin: 0 0 var(--space-4);
    padding: var(--space-3);
    font-size: var(--text-body);
    line-height: var(--lh-loose);
  }
</style>
