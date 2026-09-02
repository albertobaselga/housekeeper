<script lang="ts">
  import { page } from '$app/state';
  import type { FinanceTxDto } from '@housekeeper/server';
  import { isManualTransaction, ledgerRowMeta, txTitle } from '$lib/finance/detail';
  import { formatCents } from '$lib/finance/format';
  import type { FinanceCategoryOptionSource } from '$lib/finance/category-options';
  import CategorySelect from './CategorySelect.svelte';
  import EventPicker from './EventPicker.svelte';
  import RecurrenceChip from './RecurrenceChip.svelte';

  // [FASE 5] Todo lo de edición es OPCIONAL: quien no lo pasa (Dashboard,
  // Analítica) recibe exactamente la lista de solo lectura de la fase 4.
  let {
    rows,
    eventNameById,
    onOpen,
    selectedIds,
    onToggleSelect,
    categories,
    events,
    onSetCategory,
    onToggleEvent,
    onCreateEvent,
    onSetRecurrence,
    onDeleteManual,
    onUnlink
  }: {
    rows: FinanceTxDto[];
    eventNameById: Record<string, string>;
    onOpen: (tx: FinanceTxDto) => void;
    selectedIds?: ReadonlySet<string>;
    onToggleSelect?: (id: string, on: boolean) => void;
    categories?: readonly FinanceCategoryOptionSource[];
    events?: ReadonlyArray<{ id: string; name: string }>;
    onSetCategory?: (id: string, categoryId: string) => void;
    onToggleEvent?: (tx: FinanceTxDto, eventId: string, add: boolean) => void;
    onCreateEvent?: (name: string) => void;
    onSetRecurrence?: (id: string, next: 'recurrente' | 'extraordinario' | null) => void;
    onDeleteManual?: (id: string) => void;
    onUnlink?: (transferGroupId: string) => void;
  } = $props();

  // [FASE 5, T9 · corrección Minor 6] Con CUALQUIER callback de edición se
  // pinta el envoltorio de herramientas: un consumidor futuro que solo pase
  // `onDeleteManual` o solo `onUnlink` no debe quedarse sin controles y sin
  // aviso alguno.
  const editable = $derived(
    Boolean(onSetCategory || onToggleSelect || onSetRecurrence || onToggleEvent || onDeleteManual || onUnlink)
  );
</script>

<div class="ledger-list finance-ledger" data-lista="principal">
  {#each rows as tx (tx.id)}
    <div class="finance-row-wrap">
      <button type="button" class="finance-row" onclick={() => onOpen(tx)}>
        <span>
          <strong>{tx.transferGroupId ? '⇄ ' : ''}{txTitle(tx)}</strong>
          <small>{ledgerRowMeta(tx, eventNameById)}</small>
        </span>
        <strong class="cifra pequena" class:positivo={BigInt(tx.amountCents) > 0n}>
          {formatCents(tx.amountCents, { signed: true })}
        </strong>
      </button>
      {#if editable}
        <div class="finance-row-tools">
          {#if onToggleSelect}
            <!--
              [FASE 5, T13 · R33] La marca nativa de una casilla mide 13×13:
              mobile-densidad.dbe2e.ts mide, para checkbox/radio, el <label>
              que la envuelve (es la diana real). Mismo patrón que
              revision/+page.svelte (.rule-toggle): se envuelve en un
              <label> con área ≥44×44 y el nombre accesible se traslada al
              <label>, sin duplicarlo con un aria-label a la vez en el input.
            -->
            <label class="select-toggle">
              <input
                type="checkbox"
                checked={selectedIds?.has(tx.id) ?? false}
                onchange={(event) => onToggleSelect(tx.id, event.currentTarget.checked)}
              />
              <span class="sr-only">Seleccionar {txTitle(tx)}</span>
            </label>
          {/if}
          {#if categories && onSetCategory}
            <CategorySelect {categories} value={tx.categoryId} onchange={(categoryId) => onSetCategory(tx.id, categoryId)} />
          {/if}
          {#if events && onToggleEvent && onCreateEvent}
            <EventPicker
              {events}
              selectedIds={tx.eventIds}
              ontoggle={(eventId, add) => onToggleEvent(tx, eventId, add)}
              oncreate={onCreateEvent}
            />
          {/if}
          {#if onSetRecurrence}
            <RecurrenceChip value={tx.recurrence} onchange={(next) => onSetRecurrence(tx.id, next)} />
          {/if}
          {#if onUnlink && tx.transferGroupId}
            {@const groupId = tx.transferGroupId}
            <button class="button secondary small-button" type="button" title="Desvincular transferencia"
              onclick={() => onUnlink(groupId)}>⇄</button>
          {/if}
          {#if tx.provider}
            <!--
              [F5-M7, despacho de cierre] Ruta ABSOLUTA, como el mismo enlace
              en `revision/+page.svelte:140`: la relativa (`ajustes?prov=…`)
              solo resolvía bien desde `/h/<id>/finanzas/movimientos` — el
              único sitio que hoy monta este componente — y rompía desde
              cualquier ruta con barra final o subruta. `page.params` (no un
              prop nuevo): el componente no recibe `householdId` y las tres
              pantallas que lo montan (`revision`/`movimientos`/`eventos`)
              están fuera de los ficheros que esta tarea puede tocar.
            -->
            <a class="button secondary small-button" title="Editar alias del proveedor"
              href={`/h/${page.params.householdId}/finanzas/ajustes?prov=${encodeURIComponent(tx.provider)}`}>✎</a>
          {/if}
          {#if onDeleteManual && isManualTransaction(tx)}
            <button class="button danger small-button" type="button" onclick={() => onDeleteManual(tx.id)}>Borrar</button>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div><span><strong>Sin movimientos</strong><small>No hay movimientos con estos filtros.</small></span></div>
  {/each}
</div>

<style>
  .finance-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
    min-height: var(--row-action); width: 100%;
    border: 0; padding: var(--space-2) 0;
    background: none; text-align: left;
  }
  .finance-row > span { display: grid; min-width: 0; }
  .finance-row small { overflow: hidden; color: var(--ink-faint); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
  .positivo { color: var(--success); }
  /*
    [FASE 5, T13] `.ledger-list > div` (app.css) da grid de dos columnas
    (importe a la derecha) a cualquier hijo DIRECTO de `.ledger-list` — pensado
    para la fila simple de esa clase compartida (un `<span>` + un `<strong
    class="cifra">`, p. ej. Top proveedores del Dashboard). Aquí el hijo
    directo es ESTE envoltorio, con dos hijos PROPIOS distintos
    (`.finance-row` y, si hay edición, `.finance-row-tools`): sin este
    `display: block`, esos dos hijos heredaban ese grid de la clase
    compartida y cayan en sus dos columnas —las herramientas de edición AL
    LADO del importe, no debajo— con un ancho de columna que variaba según
    cuántos controles trajera cada fila, desplazando la cifra a una posición
    distinta por fila (A7 de mobile-densidad.dbe2e.ts: «cifras en varias
    posiciones»). `.finance-row` ya es su propio grid de dos columnas (arriba)
    y sigue pintándose igual; solo cambia el CONTENEDOR que lo envuelve.
  */
  .finance-row-wrap { display: block; border-top: 1px solid var(--line); }
  .finance-row-wrap:first-child { border-top: 0; }
  .finance-row-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding-bottom: var(--space-2); }
  .select-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--row-data);
    min-height: var(--row-data);
  }
</style>
