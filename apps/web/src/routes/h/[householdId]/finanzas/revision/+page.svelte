<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import CategorySelect from '$lib/components/finance/CategorySelect.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import RecurrenceChip from '$lib/components/finance/RecurrenceChip.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { financeCommand } from '$lib/finance/commands';
  import { txTitle } from '$lib/finance/detail';
  import { STATUS_LABEL, formatCents } from '$lib/finance/format';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:finance' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let hidden = $state<string[]>([]);
  let ruleFor = $state<string[]>([]);
  let localCategory = $state<Record<string, string>>({});

  // La página que trajo el servidor (como mucho `REVISION_PAGE_SIZE` filas) y
  // lo que queda visible tras esconder lo ya confirmado. El aviso de «hay más»
  // se calcula sobre la PRIMERA —la foto del servidor—, no sobre la segunda:
  // si no, confirmar una fila de un rango pequeño encendería el aviso solo
  // porque quedan menos filas a la vista que pendientes contados.
  const loaded = $derived(data.revision?.rows ?? []);
  const rows = $derived(loaded.filter((row) => !hidden.includes(row.id)));
  const hayMasPendientes = $derived(data.revision ? data.revision.totalPending > loaded.length : false);
  const suggested = $derived(
    rows.filter((row) => (localCategory[row.id] ?? row.categoryId) && row.status.startsWith('sugerida'))
  );

  function setCategory(rowId: string, categoryId: string): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, categoryId }),
      {
        apply: () => (localCategory = { ...localCategory, [rowId]: categoryId }),
        revert: () => {
          const { [rowId]: _gone, ...rest } = localCategory;
          localCategory = rest;
        }
      }
    );
  }

  // `null` («—» del RecurrenceChip) es un cambio legítimo: devuelve el
  // movimiento a sin clasificar. Se envía siempre, sin guarda muda.
  function setRecurrence(rowId: string, recurrence: 'recurrente' | 'extraordinario' | null): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, recurrence })
    );
  }

  function confirmRow(rowId: string): void {
    const withRule = ruleFor.includes(rowId);
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.transaction.update',
        transactionId: rowId,
        status: 'confirmada',
        ...(withRule ? { createRule: { ruleType: 'proveedor_exacto' as const } } : {})
      }),
      {
        apply: () => (hidden = [...hidden, rowId]),
        revert: () => (hidden = hidden.filter((id) => id !== rowId)),
        settle: () => (hidden = hidden.filter((id) => id !== rowId))
      }
    );
  }

  // [FASE 5 · despacho de cierre, F5-I1] Solo los ids VISIBLES: `suggested`
  // sale de `rows`, que es la página del servidor (≤ REVISION_PAGE_SIZE = 200)
  // menos lo ya escondido. Nunca puede acercarse al tope de 500 de
  // `financeTransactionsBulkPayloadSchema`, que es lo que rechazaba el lote
  // entero con `invalid_payload` en un hogar con 675 pendientes.
  function confirmSuggested(): void {
    const ids = suggested.map((row) => row.id);
    if (ids.length === 0) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transactions.bulk', transactionIds: ids, status: 'confirmada' }),
      {
        apply: () => (hidden = [...hidden, ...ids]),
        revert: () => (hidden = hidden.filter((id) => !ids.includes(id))),
        settle: () => (hidden = hidden.filter((id) => !ids.includes(id)))
      }
    );
  }
</script>

<div class="page-wrap">
  <!--
    [FASE 5, T10 · corrección Minor 1] Con `data.revision === null` (no se
    puede leer) `rows` es `[]`: el rótulo decía «0 movimientos por revisar»
    justo encima del aviso de que no se podía leer nada, una frase que
    afirmaba lo que la siguiente línea desmentía. `undefined` oculta el
    `support` del todo en ese caso (ver `PageHeader.svelte`).
  -->
  <PageHeader
    eyebrow="Finanzas"
    title="Revisión"
    support={data.revision ? `${rows.length} movimientos por revisar` : undefined}
  />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />
  <ActionStatus status={actionStatus} />

  {#if !data.revision}
    <p class="empty-state">Ahora mismo no podemos leer los movimientos.</p>
  {:else if rows.length === 0}
    <p class="empty-state">Nada que revisar en este periodo ✨</p>
  {:else}
    {#if hayMasPendientes}
      <!--
        [FASE 5 · despacho de cierre, F5-I1 / Ruling R37] La bandeja pinta como
        mucho una página; sin este aviso, un hogar con 675 pendientes veía 200
        filas y ninguna señal de que hubiera más. `role="status"` porque
        aparece y desaparece con la navegación y quien usa lector de pantalla
        tiene que enterarse sin perder el foco.
      -->
      <p class="empty-state" role="status">
        Se muestran los {loaded.length} movimientos más recientes de {data.revision.totalPending} pendientes;
        al confirmarlos aparecerán los siguientes.
      </p>
    {/if}
    {#if suggested.length > 0}
      <!--
        [FASE 5, T10 · corrección ronda 2, Minor 2] «1 sugerencias» no
        concuerda en español. El plural solo se usa cuando de verdad hay más
        de una.
      -->
      <button class="button primary" type="button" onclick={confirmSuggested}>
        ✓ Confirmar {suggested.length} {suggested.length === 1 ? 'sugerencia' : 'sugerencias'}
      </button>
    {/if}
    <div class="revision-scroll">
      <table class="wiki-table">
        <thead>
          <tr>
            <th>Fecha</th><th>Cuenta</th><th>Concepto</th><th>Importe</th><th>Estado</th>
            <th>Categoría</th><th>Tipo</th><th title="crear regla al confirmar">Regla</th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <!--
              [FASE 5, T10 · corrección Important 2] Antes la celda
              reimplementaba el título con `??`, que —a diferencia de
              `txTitle` (única definición, `$lib/finance/detail.ts`)— no cae a
              `provider` ante una cadena VACÍA en `providerDisplay` (o a
              `concept` ante una vacía en ambos): un movimiento importado con
              `provider = ''` y sin alias pintaba la celda en blanco aquí
              mientras Movimientos (que sí usa `txTitle` vía LedgerTable)
              mostraba el concepto.
            -->
            {@const title = txTitle(row)}
            <tr>
              <!--
                [FASE 5 · despacho de cierre, T11-R2] En móvil la tabla se
                convierte en fichas y cada celda pinta su rótulo desde
                `data-etiqueta` (app.css:1546). Sin él, la fecha y el importe
                salían como números sueltos sin decir cuál es cuál.
              -->
              <td class="cifra" data-etiqueta="Fecha">{row.opDate}</td>
              <td data-etiqueta="Cuenta">{row.accountName}</td>
              <td title={row.concept} data-etiqueta="Concepto">
                {row.transferGroupId ? '⇄ ' : ''}{title.length > 55 ? `${title.slice(0, 55)}…` : title}
                {#if row.provider}
                  <a href={`/h/${context.household.id}/finanzas/ajustes?prov=${encodeURIComponent(row.provider)}`}
                    title="Editar alias del proveedor">✎</a>
                {/if}
              </td>
              <td class="cifra" data-etiqueta="Importe">{formatCents(row.amountCents)}</td>
              <td data-etiqueta="Estado"><span class="status-chip">{STATUS_LABEL[row.status] ?? row.status}</span></td>
              <td data-etiqueta="Categoría">
                <CategorySelect categories={data.revision.categories}
                  value={localCategory[row.id] ?? row.categoryId}
                  onchange={(categoryId) => setCategory(row.id, categoryId)} />
              </td>
              <td data-etiqueta="Tipo"><RecurrenceChip value={row.recurrence} onchange={(next) => setRecurrence(row.id, next)} /></td>
              <td data-etiqueta="Regla">
                <!--
                  [FASE 5, T10 · corrección ronda 2, Important 1] La marca
                  nativa de una casilla mide 13×13: `mobile-densidad.dbe2e.ts`
                  mide, para checkbox/radio, el `<label>` que la envuelve (es
                  la diana real), y aquí no había ninguno. Se envuelve en un
                  `<label>` con área ≥44×44 (mismo token `--row-data` que el
                  resto del sistema) y el texto accesible se traslada al
                  `<label>` (sr-only), sin duplicar el nombre accesible con un
                  `aria-label` a la vez en el input y en su envoltorio.
                -->
                <!--
                  [FASE 5 · despacho de cierre, F5-I7 (2)] La casilla se
                  ofrecía en TODAS las filas, pero el handler exige proveedor
                  para `ruleType: 'proveedor_exacto'` y rechaza con
                  `invalid_payload` («El movimiento no tiene proveedor para la
                  regla», commands/finance.ts:364): en una fila sin proveedor
                  —un manual, o un importado con el campo vacío— marcarla
                  convertía «Confirmar» en un rechazo silencioso, con la fila
                  reapareciendo por el `revert` y nada confirmado.
                -->
                <label class="rule-toggle" title={row.provider ? 'Crear regla al confirmar' : 'Sin proveedor no se puede crear una regla'}>
                  <input type="checkbox"
                    disabled={!row.provider}
                    checked={ruleFor.includes(row.id)}
                    onchange={(event) => {
                      const on = event.currentTarget.checked;
                      ruleFor = on ? [...ruleFor, row.id] : ruleFor.filter((id) => id !== row.id);
                    }} />
                  <span class="sr-only">Crear regla al confirmar</span>
                </label>
              </td>
              <td>
                <button class="button secondary small-button" type="button"
                  disabled={!(localCategory[row.id] ?? row.categoryId)}
                  onclick={() => confirmRow(row.id)}>Confirmar</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .revision-scroll { overflow-x: auto; }
  .rule-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--row-data);
    min-height: var(--row-data);
  }
</style>
