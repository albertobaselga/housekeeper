import { parseCents, type SettlementView } from './model';

/**
 * Pagos como TABLA: una fila por mes, plegada.
 *
 * La pestaña enseñaba los N meses abiertos de par en par, así que para llegar
 * a la cuenta de marzo había que atravesar el detalle entero de abril, mayo y
 * junio. Aquí se decide qué se lee SIN desplegar —mes, estado, importe y la
 * descarga— y qué espera dentro.
 *
 * Este módulo escribe las FRASES y compone las filas; no calcula ni un
 * céntimo. Los importes llegan ya formateados desde `buildSettlementViews`, y
 * lo único que se compara aquí en dinero se compara en `bigint`.
 *
 * Dos reglas de redacción, que vienen del sistema móvil y no son decorativas:
 *
 *  · CADA DATO UNA SOLA VEZ POR PANTALLA. Si la fila cerrada ya dice el total,
 *    el detalle no repite un «Total a pagar»; si ya dice que el cobro está
 *    confirmado, dentro sólo queda la nota que escribió la empleada.
 *  · LA LÍNEA DE APOYO NO REPITE EL CHIP. El chip dice en qué estado está —y
 *    ese vocabulario ya lo fija `paymentStateLabel`—; la línea de apoyo dice
 *    sólo lo que el estado no cuenta: cuándo vence, cuánto queda o qué día se
 *    pagó. Repetirlo, además de ruido, hacía filas de tres renglones que a 320
 *    px dejaban de caber tres en una pantalla.
 */

/** Tonos que ya existen para `.status-chip`; no se inventa ninguno nuevo. */
export type PagoChipTone = 'success' | 'warning';

export interface PagoMesRow {
  /** Clave del `{#each}` y del ancla: el identificador de la liquidación. */
  id: string;
  /** `cuenta-<id>`: a esto enlaza el Resumen un importe ya aplicado. */
  anchorId: string;
  /** La cuenta entera, para el detalle que espera dentro del pliegue. */
  settlement: SettlementView;
  /** «Agosto 2026». */
  periodLabel: string;
  /** El estado, tal y como lo nombra el modelo de lectura. */
  chipLabel: string;
  chipTone: PagoChipTone;
  /**
   * El total del mes, ya formateado. Vacío mientras la cuenta sigue abierta:
   * hasta que se cierra no hay ni una línea congelada, y un «0,00 €» en la
   * columna del dinero se leería como que el mes no vale nada.
   */
  amountLabel: string;
  /** Lo que el chip no dice: vencimiento, resto por pagar o día del pago. */
  supportLine: string;
  /** Documento de pago, o null mientras la cuenta siga abierta. */
  documentHref: string | null;
  /**
   * Nombre accesible del enlace de descarga. En la fila cerrada sólo cabe
   * «PDF», así que el nombre completo viaja en el `aria-label`.
   */
  documentLabel: string | null;
  /**
   * La nota que escribió la empleada al confirmar el cobro, o cadena vacía.
   * Que el cobro esté confirmado ya lo dice la fila cerrada: dentro sólo queda
   * lo que no cabía, que es lo que ella escribió.
   */
  receiptNote: string;
}

function lower(label: string): string {
  return label.toLocaleLowerCase('es');
}

/** El ancla de un mes en la tabla. La construye también quien enlaza aquí. */
export function anclaDeMes(settlementId: string): string {
  return `cuenta-${settlementId}`;
}

/**
 * El ancla de mes que trae el fragmento de la URL, o null si el fragmento va a
 * otra cosa. Existe porque un ancla que cae dentro de un `<details>` plegado no
 * lleva a ninguna parte: hay que abrirlo, y para abrirlo hay que reconocerlo.
 */
export function anclaDeMesEnFragmento(hash: string): string | null {
  const id = hash.startsWith('#') ? hash.slice(1) : hash;
  return /^cuenta-.+/.test(id) ? id : null;
}

/** El último pago por fecha valor, que es el que deja la cuenta saldada. */
function lastPaymentLabel(settlement: SettlementView): string | null {
  const ordered = [...settlement.payments].sort((left, right) =>
    left.valueOn.localeCompare(right.valueOn)
  );
  return ordered.at(-1)?.valueOnLabel ?? null;
}

function supportLine(settlement: SettlementView): string {
  if (settlement.status === 'void') return 'Anulada: ya no cuenta';
  if (settlement.status === 'open') return `Vence el ${settlement.dueOnLabel}`;
  // Un mes cerrado sin nada que transferir no vence ni queda a deber: no hay
  // nada que pagar. Sin esta rama la fila pediría un pago de 0,00 €.
  if (parseCents(settlement.transferTotalCents) === 0n) return 'Cerrada sin importe que pagar';
  if (!settlement.fullyPaid) {
    return settlement.payments.length > 0
      ? `Quedan ${settlement.pendingLabel} · vence el ${settlement.dueOnLabel}`
      : `Vence el ${settlement.dueOnLabel}`;
  }
  const paidOn = lastPaymentLabel(settlement);
  return paidOn === null ? 'Pagada' : `Pagada el ${paidOn}`;
}

/**
 * Las filas de la tabla, en el orden en que llegan del servidor (del mes más
 * reciente al más antiguo, `order by period_start desc`).
 */
export function buildPagoMesRows(input: {
  householdId: string;
  settlements: readonly SettlementView[];
}): PagoMesRow[] {
  return input.settlements.map((settlement) => {
    // Mientras la cuenta sigue abierta no hay ni una línea congelada: ni su
    // total significa nada ni su documento diría ningún importe.
    const congelada = settlement.status !== 'open';
    return {
      id: settlement.id,
      anchorId: anclaDeMes(settlement.id),
      settlement,
      periodLabel: settlement.periodLabel,
      chipLabel: settlement.paymentStateLabel,
      chipTone:
        settlement.fullyPaid && settlement.receiptConfirmed
          ? ('success' as const)
          : ('warning' as const),
      amountLabel: congelada ? settlement.transferTotalLabel : '',
      supportLine: supportLine(settlement),
      documentHref: congelada
        ? `/api/v1/households/${input.householdId}/settlements/${settlement.id}/documento`
        : null,
      documentLabel: congelada
        ? `Descargar el documento de pago de ${lower(settlement.periodLabel)} (PDF)`
        : null,
      receiptNote:
        settlement.receiptConfirmed && settlement.receiptNote ? settlement.receiptNote : ''
    };
  });
}

/**
 * Qué pasa de verdad al empezar la cuenta de un mes.
 *
 * La frase anterior decía que el mes «se cierra a revisión y deja de sumar
 * solo», y era falsa: abrir la cuenta es un `insert` y nada más. El cerrojo del
 * mes lo toma el CIERRE (0022), el devengo se sigue recalculando en vivo, y el
 * vencimiento que se teclea aquí no tiene ningún comando que lo corrija
 * después. Las tres cosas se dicen, en ese orden, porque la irreversible es la
 * del medio.
 */
export function aperturaExplicacion(periodLabel: string): string {
  return (
    `Se crea el borrador de la cuenta de ${lower(periodLabel)} con lo que lleva devengado y se ` +
    'le pone la fecha de vencimiento que elijas, que después ya no se puede cambiar. Abrirla no ' +
    'congela nada: lo que se apunte más tarde sigue entrando en la cuenta hasta que cierres el mes.'
  );
}
