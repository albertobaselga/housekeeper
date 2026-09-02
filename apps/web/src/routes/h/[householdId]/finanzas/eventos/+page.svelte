<script lang="ts">
  import { page } from '$app/state';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { financeCommand } from '$lib/finance/commands';
  import { mergeParams } from '$lib/finance/filters';
  import { formatCents } from '$lib/finance/format';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:finance' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let newName = $state('');
  let editId = $state<string | null>(null);
  let editName = $state('');

  /*
   * [FASE 5 · despacho de cierre, M8 · regla única de foco de la fase] Al abrir
   * un editor el foco entra en su primer control; al cerrarlo vuelve al control
   * que lo abrió. El editor de renombrar aparecía sin foco: quien navega con
   * teclado o lector de pantalla pulsaba «✎» y no pasaba nada perceptible.
   */
  let editInput = $state<HTMLInputElement | null>(null);
  let opener = $state<HTMLElement | null>(null);

  $effect(() => {
    if (editId && editInput) editInput.focus();
  });

  function abrirEdicion(entry: { id: string; name: string }, boton: HTMLElement): void {
    opener = boton;
    editId = entry.id;
    editName = entry.name;
  }

  function cerrarEdicion(): void {
    editId = null;
    opener?.focus();
    opener = null;
  }

  const summary = $derived(data.eventos?.summary ?? []);
  const base = $derived(`/h/${context.household.id}/finanzas`);

  function create(event: SubmitEvent): void {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.event.create', name }),
      { settle: () => (newName = '') }
    );
  }

  function rename(eventId: string): void {
    const name = editName.trim();
    if (!name) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.event.update', eventId, name }),
      { settle: () => cerrarEdicion() }
    );
  }

  function remove(entry: { id: string; name: string; totalCount: number }): void {
    const message = entry.totalCount
      ? `«${entry.name}» tiene ${entry.totalCount} movimientos asignados. Se desvincularán (los movimientos no se borran). ¿Continuar?`
      : `¿Borrar el evento «${entry.name}»?`;
    if (!window.confirm(message)) return;
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.event.delete', eventId: entry.id }));
  }
</script>

<div class="page-wrap">
  <PageHeader
    eyebrow="Finanzas"
    title="Eventos"
    support={data.eventos ? `${data.eventos.from} → ${data.eventos.to}` : undefined}
  />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />
  <ActionStatus status={actionStatus} />

  {#if !data.eventos}
    <p class="empty-state">Ahora mismo no podemos leer los eventos.</p>
  {:else}
    <form class="action-form" onsubmit={create}>
      <label>Nuevo evento
        <input placeholder="p. ej. Semana Santa 2026" bind:value={newName} />
      </label>
      <button class="button primary" type="submit">+ Crear</button>
    </form>

    <div class="eventos-scroll">
      <table class="wiki-table">
        <thead>
          <tr><th>Evento</th><th>Movimientos</th><th>Gasto</th><th>Ingreso</th><th>Neto</th><th></th></tr>
        </thead>
        <tbody>
          {#each summary as entry (entry.id)}
            <tr>
              <td>
                {#if editId === entry.id}
                  <form onsubmit={(event) => { event.preventDefault(); rename(entry.id); }}>
                    <!-- T11-R7: sin `min-height` el campo medía su propia línea
                         de texto, por debajo del piso táctil de 44 px que exige
                         la regla A3 de mobile-densidad.dbe2e.ts. -->
                    <input class="evento-editar" aria-label="Nuevo nombre del evento"
                      bind:this={editInput} bind:value={editName}
                      onkeydown={(event) => { if (event.key === 'Escape') cerrarEdicion(); }} />
                  </form>
                {:else}<span aria-hidden="true">◈</span> {entry.name}{/if}
              </td>
              <!--
                [FASE 5 · despacho de cierre, T11-R4] `txCount` es del RANGO y
                `totalCount` es el histórico completo del evento (el que avisa
                de cuántos se van a desvincular al borrarlo): la celda decía
                solo el primero y el número del aviso de borrado parecía salir
                de la nada. T11-R2: `data-etiqueta` es lo que el sistema pinta
                como rótulo de cada celda cuando la tabla se convierte en ficha
                en móvil (app.css:1546); sin él, las tres cifras de dinero
                quedaban sin decir cuál es cuál.
              -->
              <td class="cifra" data-etiqueta="Movimientos">
                {entry.txCount} en el periodo{entry.totalCount !== entry.txCount ? ` · ${entry.totalCount} en total` : ''}
              </td>
              <td class="cifra" data-etiqueta="Gasto">{formatCents(entry.expenseCents)}</td>
              <td class="cifra" data-etiqueta="Ingreso">{formatCents(entry.incomeCents)}</td>
              <td class="cifra" data-etiqueta="Neto">{formatCents(entry.netCents)}</td>
              <td>
                <!--
                  [FASE 5, T11 · revisión ronda 1]
                  Important 2: los cuatro controles iban sueltos en la celda,
                  separados solo por el espacio en blanco del marcado (~4 px):
                  la regla A3 de mobile-densidad.dbe2e.ts exige 8 px entre
                  dianas contiguas, y una de ellas es destructiva. Se envuelven
                  en el mismo patrón que `.finance-row-tools`
                  (LedgerTable.svelte) en vez de reinventarlo.
                  Minor 3: `?ev=`/`?open=` sustituían TODA la query; con
                  `mergeParams` el rango (`from`/`to`) vivo en la URL viaja con
                  el enlace en vez de caer al valor por omisión.
                  Minor 6: los glifos `≡ ▾ ✎` solo llevaban `title`, que no es
                  nombre accesible fiable; ahora cada uno declara `aria-label`.
                -->
                <div class="eventos-row-tools">
                  <!--
                    [FASE 5 · despacho de cierre, T11-R5] El enlace a
                    Movimientos arrastraba el `open=` de esta pantalla, que allí
                    no significa nada y volvía con el desglose abierto al usar
                    «atrás». Se borra explícitamente, como ya se hacía con el
                    resto de claves ajenas.
                  -->
                  <a
                    class="button secondary small-button"
                    href={`${base}/movimientos?${mergeParams(page.url.searchParams, { ev: entry.id, open: null })}`}
                    title="Ver movimientos"
                    aria-label={`Ver movimientos de ${entry.name}`}
                  >≡</a>
                  <!--
                    [FASE 5 · despacho de cierre, T11-R4] El desglose se abría y
                    no había forma de cerrarlo: el mismo control lo alterna
                    (`open: null` cuando ya está abierto) y `aria-expanded` dice
                    en qué estado está.
                  -->
                  <a
                    class="button secondary small-button"
                    href={`?${mergeParams(page.url.searchParams, { open: data.eventos?.openId === entry.id ? null : entry.id })}`}
                    title={data.eventos?.openId === entry.id ? 'Cerrar el desglose' : 'Desglose por categoría'}
                    aria-expanded={data.eventos?.openId === entry.id}
                    aria-label={`Desglose por categoría de ${entry.name}`}
                  >{data.eventos?.openId === entry.id ? '▴' : '▾'}</a>
                  <!-- T11-M1: el botón abre un editor en la propia fila, así
                       que declara si está abierto o cerrado. -->
                  <button
                    class="button secondary small-button"
                    type="button"
                    title="Renombrar"
                    aria-label={`Renombrar ${entry.name}`}
                    aria-expanded={editId === entry.id}
                    onclick={(event) => abrirEdicion(entry, event.currentTarget)}
                  >✎</button>
                  <button class="button danger small-button" type="button" title="Borrar"
                    onclick={() => remove(entry)}>Borrar</button>
                </div>
              </td>
            </tr>
          {/each}
          {#if summary.length === 0}
            <tr><td colspan="6">
              <p class="empty-state">Sin eventos todavía. Crea uno y asigna movimientos desde Movimientos.</p>
            </td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    {#if data.eventos.openId && data.eventos.detail}
      <section>
        <div class="section-heading">
          <h2>Desglose por categoría</h2>
          <!-- T11-R4: la salida del desglose, además del conmutador de la fila. -->
          <a href={`?${mergeParams(page.url.searchParams, { open: null })}`}>Cerrar</a>
        </div>
        {#if data.eventos.detail.length === 0}
          <!-- Minor 2: `[]` es truthy; sin esta guarda el encabezado se
               pintaba sobre una tabla vacía cuando el evento abierto no tiene
               movimientos en el rango. -->
          <p class="empty-state">Este evento no tiene movimientos en el rango visible.</p>
        {:else}
          <table class="wiki-table">
            <thead><tr><th>Categoría</th><th>Movimientos</th><th>Total</th></tr></thead>
            <tbody>
              <!--
                Important 1: `readFinanceBreakdown` agrupa por
                `(category_id, name, parent_id)`, y el esquema solo garantiza
                nombre único por `(household_id, parent_id, name)` — dos
                subcategorías homónimas bajo padres distintos son legales.
                Keyear por `name` hacía que Svelte 5 lanzara
                `each_key_duplicate` EN PRODUCCIÓN al abrir un evento con ese
                choque. `categoryId` sí es único por fila (o `null`, una sola
                vez: "Sin categorizar").
              -->
              {#each data.eventos.detail as line (String(line.categoryId))}
                <tr>
                  <td>{line.name}</td>
                  <td class="cifra" data-etiqueta="Movimientos">{line.count}</td>
                  <td class="cifra" data-etiqueta="Total">{formatCents(line.totalCents)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .eventos-scroll { overflow-x: auto; }
  /* Mismo patrón que `.finance-row-tools` (LedgerTable.svelte): 8 px entre
     dianas contiguas, una de ellas destructiva (regla A3 de
     mobile-densidad.dbe2e.ts). */
  .eventos-row-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  /* T11-R7: el campo de renombrar vive en una celda, fuera de `.action-form`,
     así que no heredaba el piso táctil de 44 px del sistema. */
  .evento-editar { min-height: var(--row-data); width: 100%; min-width: 0; }
</style>
