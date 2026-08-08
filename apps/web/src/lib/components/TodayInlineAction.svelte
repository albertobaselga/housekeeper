<script module lang="ts">
  export type InlineAction =
    | { kind: 'confirm_menu'; slotId: string; contentHash: string }
    | { kind: 'accept_extra'; id: string };
</script>

<script lang="ts">
  import { acceptExtra } from '$lib/employment/commands';
  import { confirmMenuSlot } from '$lib/food/commands';
  import type { OptimisticActions } from '$lib/offline/optimistic';

  /**
   * Atajo para resolver un asunto SIN salir de Hoy (Ola D-5): confirmar la
   * comida del día y aceptar una jornada extra. Vive en un chunk aparte —igual
   * que el triaje del outbox y la agenda— porque arrastra los constructores de
   * comandos de comida y de empleo, que Hoy no carga de otro modo.
   *
   * El resultado usa la misma nota unificada que el resto de la app: el
   * pintado optimista lo pone la página (apply/revert) y el mensaje veraz sale
   * de `optimistic.run`. El enlace a la pantalla completa nunca desaparece.
   */
  let {
    householdId,
    action,
    label,
    optimistic,
    onApply,
    onRevert
  }: {
    householdId: string;
    action: InlineAction;
    label: string;
    optimistic: OptimisticActions;
    onApply: () => void;
    onRevert: () => void;
  } = $props();

  let busy = $state(false);

  function envelope() {
    return action.kind === 'confirm_menu'
      ? confirmMenuSlot({ householdId, slotId: action.slotId, contentHash: action.contentHash })
      : acceptExtra({ householdId, extraWorkEventId: action.id });
  }

  async function run(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await optimistic.run(envelope(), { apply: onApply, revert: onRevert });
    } finally {
      busy = false;
    }
  }
</script>

<button class="button secondary small-button" type="button" disabled={busy} onclick={() => void run()}>
  {label}
</button>
