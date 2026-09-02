<script lang="ts">
  import { invalidate } from '$app/navigation';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import FinanceNav from '$lib/components/finance/FinanceNav.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { financeCommand } from '$lib/finance/commands';
  import { formatCents } from '$lib/finance/format';
  import { OptimisticActions } from '$lib/offline/optimistic';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();

  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:finance' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  const BANK_LABELS: Record<string, string> = {
    caixabank: 'CaixaBank', deutsche_bank: 'Deutsche Bank', openbank: 'OpenBank', amex: 'American Express'
  };

  interface Preview {
    bank: string; newCount: number; dupCount: number; unknownRefs: string[];
    sample: Array<{ opDate: string; concept: string; provider: string | null; amountCents: string }>;
  }
  // Misma unión que `NewAccountInput` (finance-imports.server.ts): escrita a
  // mano porque ese tipo vive en el paquete servidor y no puede importarse
  // en el navegador. [Corrección revisión #5] Antes era `string`: los tres
  // `<option>` la mantenían correcta por accidente, y una cuarta opción mal
  // escrita solo habría fallado en tiempo de ejecución con un 422.
  type AccountKind = 'comun' | 'personal' | 'inversion';
  interface NewAccountDraft { bankRef: string; name: string; kind: AccountKind; ownerLabel: string }

  function isAccountKind(value: string): value is AccountKind {
    return value === 'comun' || value === 'personal' || value === 'inversion';
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * [Corrección revisión #2] Una ruta `/api` de SvelteKit serializa
   * `error(status, message)` como JSON `{ message }`: sin este parseo el
   * texto en pantalla era el copy en español con el blob JSON pegado detrás
   * («…: {"message":"El extracto supera…"}»). Mismo criterio que `getJson`
   * en `lib/finance/api.ts`: si el cuerpo no es JSON legible, se usa tal
   * cual, y si viene vacío, el status ya es información suficiente.
   */
  async function readErrorMessage(response: Response): Promise<string> {
    const body = await response.text().catch(() => '');
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message) return parsed.message;
    } catch {
      // Cuerpo no-JSON: se usa el texto crudo si no viene vacío.
    }
    return body || `Error ${response.status}`;
  }

  let file = $state<File | null>(null);
  let preview = $state<Preview | null>(null);
  let newAccounts = $state<NewAccountDraft[]>([]);
  let busy = $state(false);
  let importError = $state<string | null>(null);

  // [Corrección revisión #4] El servidor exige además `ownerLabel` de 1 a 80
  // caracteres (`isNewAccountInput`, imports/confirm/+server.ts): vaciar el
  // campo «Titular» dejaba el botón habilitado y devolvía un 422 que, por el
  // Issue #2, se leía como JSON crudo.
  const confirmDisabled = $derived(
    busy || newAccounts.some((draft) => !draft.name.trim() || !draft.ownerLabel.trim())
  );

  function patchDraft(index: number, patch: Partial<NewAccountDraft>): void {
    newAccounts = newAccounts.map((entry, at) => (at === index ? { ...entry, ...patch } : entry));
  }

  async function doPreview(chosen: File): Promise<void> {
    busy = true;
    importError = null;
    try {
      const form = new FormData();
      form.append('file', chosen);
      const response = await fetch(`/api/v1/finance/imports/preview?household=${context.household.id}`, {
        method: 'POST',
        body: form
      });
      if (!response.ok) {
        importError = `No se pudo analizar el fichero: ${await readErrorMessage(response)}`;
        // [Corrección revisión #8] Sin este reset, la previsualización del
        // fichero ANTERIOR se quedaba en pantalla junto al error del nuevo.
        preview = null;
        file = null;
        return;
      }
      const result = (await response.json()) as Preview;
      file = chosen;
      preview = result;
      newAccounts = result.unknownRefs.map((bankRef) => ({ bankRef, name: '', kind: 'personal', ownerLabel: 'familia' }));
    } catch {
      // [Corrección revisión #2] Sin conexión, DNS o servidor caído, `fetch`
      // RECHAZA en vez de resolver con `ok: false`. Sin este catch la promesa
      // moría como unhandled rejection: «Analizando…» desaparecía y no
      // aparecía ningún aviso, dejando al usuario sin saber si se importó.
      importError = 'No hemos podido analizar el fichero. Comprueba tu conexión y vuelve a intentarlo.';
      preview = null;
      file = null;
    } finally {
      busy = false;
    }
  }

  async function doConfirm(): Promise<void> {
    if (!file || !preview) return;
    busy = true;
    importError = null;
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('payload', JSON.stringify({
        newAccounts: newAccounts.map((draft) => ({
          bankRef: draft.bankRef, name: draft.name.trim(), kind: draft.kind, ownerLabel: draft.ownerLabel.trim()
        }))
      }));
      const response = await fetch(`/api/v1/finance/imports/confirm?household=${context.household.id}`, {
        method: 'POST',
        body: form
      });
      if (!response.ok) {
        importError = `No se pudo confirmar la importación: ${await readErrorMessage(response)}`;
        return;
      }
      const result = (await response.json()) as { newCount: number; dupCount: number };
      // [Corrección revisión #3] Antes: `importSuccess`, una `.success-message`
      // paralela que no caducaba nunca y podía pintarse a la vez que la nota
      // unificada de `ActionStatus` (p. ej. al confirmar e inmediatamente
      // deshacer OTRO lote). Ahora usa el mismo canal: una sola nota, efímera.
      actionStatus.set({ tone: 'success', text: `Importadas ${result.newCount} nuevas (${result.dupCount} duplicadas).` });
      file = null;
      preview = null;
      newAccounts = [];
      await invalidate('cc:finance');
    } catch {
      // [Corrección revisión #2] Mismo motivo que en `doPreview`: un fallo de
      // red a mitad de la subida no debe dejar la pantalla en silencio.
      importError = 'No hemos podido confirmar la importación. Comprueba tu conexión y vuelve a intentarlo.';
    } finally {
      busy = false;
    }
  }

  function undoBatch(batch: { id: string; filename: string }): void {
    if (!window.confirm(`¿Deshacer la importación de ${batch.filename}?`)) return;
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.import.undo', batchId: batch.id }));
  }
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="Importar" support="CaixaBank, Deutsche Bank, OpenBank o Amex" />
  <FinanceNav pendingReviewCount={data.pendingReviewCount} />
  <ActionStatus status={actionStatus} />
  {#if importError}<p class="form-error" role="alert">{importError}</p>{/if}

  <label class="button primary importar-boton">
    Elegir fichero (.xls/.xlsx)
    <!--
      [Corrección revisión #1] `hidden` (=`display:none`) sacaba el input del
      orden de tabulación y del árbol de accesibilidad: sin ratón ni pantalla
      táctil no había forma de abrir el selector, y un lector de pantalla
      anunciaba el texto del `<label>` como texto suelto, no como control.
      Se mantiene el aspecto de botón y el input focusable y anunciado; el
      foco se ve con `:focus-within` en el label. `disabled={busy}` de paso
      impide elegir un segundo fichero mientras el primero se analiza
      (revisión #8: dos previsualizaciones ya no pueden pisarse).

      [FASE 5, T13] `.sr-only` (ocultamiento por *clip*, 1×1 px) es la marca
      de esta corrección, pero encoge el propio input a una diana de 1×1: es
      el input, no el `<label>` que lo rodea, quien cuenta como control ante
      `document.querySelectorAll('input')` (mobile-densidad.dbe2e.ts, A3), así
      que el truco reservado a checkbox/radio (medir el `<label>` que envuelve)
      no lo cubre. Se sustituye por el patrón estándar de «input de fichero
      invisible superpuesto al botón visible»: `opacity: 0` en vez de *clip*,
      del tamaño exacto del label (`inset: 0`) — sigue sin verse, sigue
      anunciado igual por el lector de pantalla, y ahora su diana real mide lo
      que mide el botón.
    -->
    <input type="file" accept=".xls,.xlsx" class="importar-input" disabled={busy}
      onchange={(event) => {
        const chosen = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (chosen) void doPreview(chosen);
      }} />
  </label>
  {#if busy}<p role="status">Analizando…</p>{/if}

  {#if preview}
    <section>
      <h2>Previsualización — {BANK_LABELS[preview.bank] ?? preview.bank}</h2>
      <p><span class="status-chip">{preview.newCount} nuevas</span> <span class="status-chip">{preview.dupCount} duplicadas</span></p>
      {#each newAccounts as draft, index (draft.bankRef)}
        <fieldset class="cuenta-nueva">
          <legend>Cuenta nueva detectada: <span class="cifra">{draft.bankRef}</span></legend>
          <label>Nombre de la cuenta nueva
            <input value={draft.name} placeholder="p. ej. Cuenta común OpenBank" maxlength="120"
              oninput={(event) => patchDraft(index, { name: event.currentTarget.value })} />
          </label>
          <label>Tipo
            <select value={draft.kind}
              onchange={(event) => {
                const { value } = event.currentTarget;
                if (isAccountKind(value)) patchDraft(index, { kind: value });
              }}>
              <option value="comun">común</option><option value="personal">personal</option><option value="inversion">inversión</option>
            </select>
          </label>
          <label>Titular
            <input value={draft.ownerLabel} maxlength="80"
              oninput={(event) => patchDraft(index, { ownerLabel: event.currentTarget.value })} />
          </label>
        </fieldset>
      {/each}
      <div class="importar-scroll">
        <table class="wiki-table">
          <thead><tr><th>Fecha</th><th>Concepto</th><th>Importe</th></tr></thead>
          <tbody>
            {#each preview.sample as row, index (index)}
              <tr>
                <td class="cifra">{row.opDate}</td>
                <td title={row.concept}>{row.provider ?? row.concept}</td>
                <td class="cifra">{formatCents(row.amountCents)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <button class="button primary" type="button" disabled={confirmDisabled} onclick={() => void doConfirm()}>
        Confirmar importación
      </button>
    </section>
  {/if}

  <section>
    <h2>Historial de importaciones</h2>
    {#if data.importar.batches.length === 0}
      <p class="empty-state">Aún no se ha importado ningún extracto.</p>
    {:else}
      <div class="importar-scroll">
        <table class="wiki-table">
          <thead><tr><th>Fecha</th><th>Fichero</th><th>Banco</th><th>Nuevas</th><th>Duplicados</th><th></th></tr></thead>
          <tbody>
            {#each data.importar.batches as batch (batch.id)}
              <tr>
                <td class="cifra">{batch.importedAt}</td>
                <td>{batch.filename}</td>
                <td>{BANK_LABELS[batch.bank] ?? batch.bank}</td>
                <td class="cifra">{batch.newCount}</td>
                <td class="cifra">{batch.dupCount}</td>
                <td><button class="button secondary small-button" type="button" onclick={() => undoBatch(batch)}>Deshacer</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>

<style>
  .importar-boton { display: inline-block; position: relative; }
  .importar-boton:focus-within { outline: .2rem solid var(--primary); outline-offset: .2rem; }
  /*
    [FASE 5, T13] `inset: -1px`, no `0`: la caja de posicionamiento de un
    absoluto es el borde de PADDING del ancestro posicionado (aquí,
    `.importar-boton`), no su borde exterior — con `inset: 0` el input
    quedaba 2 px más bajo y 2 px más estrecho que el propio botón (el borde
    de 1 px por lado de `.button`, transparente pero real), justo por debajo
    del piso de 44 px de mobile-densidad.dbe2e.ts (A3). `-1px` compensa
    exactamente ese borde y el input vuelve a medir lo mismo que el botón.
  */
  .importar-input { position: absolute; inset: -1px; opacity: 0; cursor: pointer; }
  .importar-scroll { overflow-x: auto; }
  .cuenta-nueva { display: grid; gap: var(--space-2); }
</style>
