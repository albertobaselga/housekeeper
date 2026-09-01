<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import {
    parseEuroInput,
    recordManualAdjustment,
    voidManualAdjustment
  } from '$lib/employment/commands';
  import { formatCents, periodLabel, type ManualAdjustmentView } from '$lib/employment/model';

  let {
    householdId,
    agreementId,
    adjustments,
    currentPeriod,
    canRecord
  }: {
    householdId: string;
    agreementId: string;
    adjustments: ManualAdjustmentView[];
    /** Mes en curso `YYYY-MM`: el valor por defecto del formulario. */
    currentPeriod: string;
    /** Solo la familia administradora apunta y anula; la empleada solo mira. */
    canRecord: boolean;
  } = $props();

  // Patrón wiki (P2-1), igual que vacaciones y gastos: el apunte se pinta al
  // instante, `invalidate('cc:employment')` trae la cuenta recalculada y un
  // rechazo del servidor retira la fila con la causa dicha en castellano.
  // svelte-ignore state_referenced_locally -- el hogar no cambia dentro de la página
  const optimistic = new OptimisticActions({ householdId, invalidateToken: 'cc:employment' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  // svelte-ignore state_referenced_locally -- solo es el valor inicial del campo
  let period = $state(currentPeriod);
  let label = $state('');
  let reason = $state('');
  let amount = $state('');
  let direction = $state<'adds' | 'subtracts'>('adds');
  let addsToPay = $state(true);
  let formError = $state<string | null>(null);

  let voidOpenId = $state<string | null>(null);
  let voidReason = $state('');
  let voided = $state<string[]>([]);

  /**
   * Atajos de precarga, no rutas de escritura nuevas: «Adelanto» y «Ausencia»
   * rellenan ESTE formulario (etiqueta, sentido y motivo orientativo) y acaban
   * en el mismo comando `recordManualAdjustment`. Son acciones de un toque, no
   * conmutadores: no guardan estado propio ni marcan nada como «pulsado». El
   * importe NUNCA se toca —borrar lo tecleado por precargar un texto sería
   * perder trabajo— y todo queda editable: la precarga es un empujón, no una
   * jaula. Los anticipos con cuota (`app.advances`) siguen siendo de solo
   * lectura en los saldos del Resumen; este atajo apunta un descuento del mes.
   */
  const PRESET_TEXTS = [
    'Adelanto entregado',
    'Entregado a cuenta, se descuenta de este mes',
    'Ausencia no retribuida',
    'Día no trabajado sin sueldo, hablado con ella'
  ];

  function applyPreset(choice: 'adelanto' | 'ausencia' | 'otro'): void {
    formError = null;
    if (choice === 'adelanto') {
      label = 'Adelanto entregado';
      reason = 'Entregado a cuenta, se descuenta de este mes';
      direction = 'subtracts';
      addsToPay = true;
    } else if (choice === 'ausencia') {
      label = 'Ausencia no retribuida';
      reason = 'Día no trabajado sin sueldo, hablado con ella';
      direction = 'subtracts';
      addsToPay = true;
    } else {
      // «Otro» limpia SOLO lo que puso un atajo: lo tecleado a mano se queda.
      if (PRESET_TEXTS.includes(label)) label = '';
      if (PRESET_TEXTS.includes(reason)) reason = '';
      direction = 'adds';
      addsToPay = true;
    }
  }

  type Draft = {
    operationId: string;
    periodLabel: string;
    label: string;
    reason: string;
    amountLabel: string;
    transferLabel: string;
  };
  let drafts = $state<Draft[]>([]);
  // El borrador se retira cuando los datos frescos traen un concepto con la
  // misma etiqueta E importe: con los atajos, la etiqueta sola dejó de ser
  // distintiva («Adelanto entregado» dos meses seguidos es el caso normal) y
  // compararla a secas retiraba el borrador nada más crearlo. El MES no entra
  // en la comparación a propósito: si el pedido estaba cerrado, el servidor lo
  // imputa al siguiente y lo dice en la fila que llega.
  const pendingDrafts = $derived(
    drafts.filter(
      (draft) =>
        !adjustments.some((row) => row.label === draft.label && row.amountLabel === draft.amountLabel)
    )
  );

  const MESSAGE_OVERRIDES = {
    adjustment_before_agreement: 'Ese mes es anterior al primer día de trabajo del acuerdo.',
    adjustment_after_agreement: 'Ese mes es posterior al último día de trabajo del acuerdo.',
    adjustment_not_recorded: 'Ese concepto ya no está apuntado: o no existe o ya se anuló.',
    settlement_already_closed:
      'La cuenta de ese mes ya está cerrada y no se reescribe: apunta el concepto contrario en un mes abierto.',
    no_open_month: 'No queda ningún mes sin cerrar donde imputarlo.'
  } as const;

  function record(event: SubmitEvent): void {
    event.preventDefault();
    const magnitude = parseEuroInput(amount);
    if (!magnitude) {
      formError = 'Importe inválido: escribe un número mayor que cero, p. ej. 150 o 12,50';
      return;
    }
    if (!period || !label.trim() || !reason.trim()) return;
    formError = null;

    const trimmedLabel = label.trim();
    const trimmedReason = reason.trim();
    const signed = direction === 'subtracts' ? `-${magnitude}` : magnitude;
    const envelope = recordManualAdjustment({
      householdId,
      agreementId,
      period,
      label: trimmedLabel,
      reason: trimmedReason,
      amountCents: magnitude,
      direction,
      addsToPay
    });
    const removeDraft = () => {
      drafts = drafts.filter((draft) => draft.operationId !== envelope.operationId);
    };

    void optimistic.run(envelope, {
      apply: () => {
        drafts = [
          ...drafts,
          {
            operationId: envelope.operationId,
            periodLabel: periodLabel(period),
            label: trimmedLabel,
            reason: trimmedReason,
            amountLabel: formatCents(signed, { signed: true }),
            transferLabel: addsToPay ? 'Se suma a la transferencia' : 'Consta, no se transfiere'
          }
        ];
        label = '';
        reason = '';
        amount = '';
        // El sentido no se hereda de un apunte al siguiente: tras un adelanto
        // (resta), teclear una gratificación sin tocar el desplegable NO puede
        // enviarla restando.
        direction = 'adds';
        addsToPay = true;
      },
      revert: removeDraft,
      settle: removeDraft,
      messageOverrides: MESSAGE_OVERRIDES
    });
  }

  function annul(adjustmentId: string): void {
    const trimmed = voidReason.trim();
    if (!trimmed) return;
    void optimistic.run(
      voidManualAdjustment({ householdId, manualAdjustmentId: adjustmentId, reason: trimmed }),
      {
        apply: () => {
          voided = [...voided, adjustmentId];
          voidOpenId = null;
          voidReason = '';
        },
        revert: () => {
          voided = voided.filter((candidate) => candidate !== adjustmentId);
        },
        messageOverrides: MESSAGE_OVERRIDES
      }
    );
  }
</script>

<article class="card">
  <div class="section-heading">
    <div>
      <p class="eyebrow">Conceptos a mano</p>
      <h2>Importes sueltos imputados al mes que toque</h2>
    </div>
  </div>

  <p class="audit-note">
    Para lo que no nace de una jornada, un gasto ni el acuerdo: una gratificación, un descuento
    hablado, la parte proporcional de algo. Se apunta con su motivo y cuenta en el mes que elijas.
    Aquí queda lo que aún no ha entrado en ninguna cuenta cerrada; lo ya aplicado se lee en su mes,
    en Pagos.
  </p>

  <div class="ledger-list">
    <!-- Lo que llega ya viene decidido por el servidor: ni lo anulado ni lo que
         una nómina cerrada materializó. Lo único anulado que puede verse aquí
         es lo que se acaba de anular en este dispositivo, hasta que los datos
         frescos lo retiren de la lista. -->
    {#each adjustments as adjustment (adjustment.id)}
      {@const isVoided = voided.includes(adjustment.id)}
      <div id={`concepto-${adjustment.id}`}>
        <span>
          <strong>{adjustment.label}</strong>
          <small>
            {adjustment.periodLabel} · {adjustment.reason}
            {#if isVoided}
              <!-- Sin el motivo: aquí sólo se llega por el camino optimista, y
                   la fila que lo traería ya no existe —el servidor no manda los
                   anulados—. El motivo que se acaba de escribir queda en el
                   expediente; esta línea desaparece en cuanto llegan los datos
                   frescos. -->
              · Anulado · no cuenta en la cuenta del mes
            {:else}
              · {adjustment.transferLabel}
            {/if}
            {#if adjustment.deferralNote}<br />{adjustment.deferralNote}{/if}
          </small>
        </span>
        <span class="inline-actions">
          <strong>{isVoided ? '—' : adjustment.amountLabel}</strong>
          {#if canRecord}
            {#if isVoided}
              <span class="status-chip success">Anulado</span>
            {:else}
              <button
                class="button secondary small-button"
                type="button"
                aria-expanded={voidOpenId === adjustment.id}
                onclick={() => {
                  voidOpenId = voidOpenId === adjustment.id ? null : adjustment.id;
                  voidReason = '';
                }}
              >Anular</button>
            {/if}
          {/if}
        </span>
      </div>
      {#if canRecord && voidOpenId === adjustment.id && !isVoided}
        <form
          class="action-form"
          onsubmit={(event) => {
            event.preventDefault();
            annul(adjustment.id);
          }}
        >
          <label>Por qué se anula
            <input
              type="text"
              autocomplete="off"
              enterkeyhint="done"
              bind:value={voidReason}
              maxlength="500"
              required
              placeholder="Se apuntó dos veces, el importe era otro…"
            />
          </label>
          <p class="audit-note">
            El concepto no se borra: se queda aquí anulado, con quién lo anuló y por qué. Si la
            cuenta de ese mes ya está cerrada no se puede anular; se apunta el contrario en un mes
            abierto.
          </p>
          <div class="action-row">
            <button class="button primary small-button" type="submit" disabled={!voidReason.trim()}>
              Anular el concepto
            </button>
          </div>
        </form>
      {/if}
    {:else}
      {#if pendingDrafts.length === 0}
        <div>
          <span>
            <strong>Todavía no hay conceptos apuntados a mano</strong>
            <p class="audit-note">Cuando se apunte uno, aparecerá aquí y en la cuenta de su mes.</p>
          </span>
        </div>
      {/if}
    {/each}
    {#each pendingDrafts as draft (draft.operationId)}
      <div>
        <span>
          <strong>{draft.label}</strong>
          <small>{draft.periodLabel} · {draft.reason} · {draft.transferLabel}</small>
        </span>
        <span class="inline-actions"><strong>{draft.amountLabel}</strong></span>
      </div>
    {/each}
  </div>

  {#if canRecord}
    <form class="action-form" onsubmit={record}>
      <h3>Apuntar un concepto</h3>
      <!-- Los tres casos de cada mes, a un toque. Son botones de relleno de
           un solo gesto —sin estado «pulsado» que luego mienta cuando se
           edite a mano—: lo que precargan se ve y se corrige antes de enviar. -->
      <div class="action-row" role="group" aria-label="Rellenar el concepto como">
        <button class="button secondary small-button" type="button" onclick={() => applyPreset('adelanto')}>Adelanto</button>
        <button class="button secondary small-button" type="button" onclick={() => applyPreset('ausencia')}>Ausencia</button>
        <button class="button secondary small-button" type="button" onclick={() => applyPreset('otro')}>Otro concepto</button>
      </div>
      <label>Cómo se llama en la cuenta
        <input
          type="text"
          autocomplete="off"
          enterkeyhint="next"
          bind:value={label}
          maxlength="80"
          required
          placeholder="Gratificación de verano, descuento acordado…"
        />
      </label>
      <div class="form-grid">
        <label>Importe (€)
          <input
            type="text"
            inputmode="decimal"
            autocomplete="off"
            enterkeyhint="next"
            bind:value={amount}
            required
            placeholder="150"
          />
        </label>
        <label>Suma o resta
          <select bind:value={direction}>
            <option value="adds">Suma a la cuenta del mes</option>
            <option value="subtracts">Resta de la cuenta del mes</option>
          </select>
        </label>
      </div>
      <div class="form-grid">
        <label>Mes en el que cuenta
          <input type="month" bind:value={period} required />
        </label>
        <!--
          El desplegable liga BOOLEANOS, no cadenas, y el comando los recibe
          tipados: aquí no hay ida y vuelta por un formulario del servidor donde
          `true` se convertiría en «true» y una comparación mal escrita pudiera
          guardar como «no se transfiere» un importe que sí es dinero para ella.
        -->
        <label>Dinero que recibe ella
          <select bind:value={addsToPay}>
            <option value={true}>Sí: cambia la transferencia del mes</option>
            <option value={false}>No: solo consta, el dinero se movió aparte</option>
          </select>
        </label>
      </div>
      <label>Por qué
        <input
          type="text"
          autocomplete="off"
          enterkeyhint="done"
          bind:value={reason}
          maxlength="500"
          required
          placeholder="Acordado el 2 de abril, devolvió el anticipo en mano…"
        />
      </label>
      {#if formError}<p class="queued-note" role="alert">{formError}</p>{/if}
      <p class="audit-note">
        Si la cuenta de ese mes ya está cerrada no se reescribe: el concepto pasa al primer mes
        abierto siguiente y la fila lo dice. Y lo que no cambia la transferencia consta aquí sin
        tocar el total: descontar en la cuenta un anticipo ya devuelto en mano sería cobrárselo dos
        veces.
      </p>
      <div class="action-row">
        <button class="button primary small-button" type="submit">Apuntar el concepto</button>
      </div>
    </form>
  {/if}

  <ActionStatus status={actionStatus} />
</article>
