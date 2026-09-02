/**
 * Contratos de la superficie compartida cliente/servidor.
 *
 * ESTE MÓDULO LO CARGA TODA PANTALLA DEL CLIENTE. `canonicalJson` se usa para
 * verificar la firma del paquete offline durante el arranque, así que el
 * navegador descarga este fichero antes de pintar nada. De aquí solo pueden
 * salir tipos (gratis en tiempo de ejecución) y funciones pequeñas: cualquier
 * TABLA de datos que se exporte o se reexporte desde aquí viaja en el trozo
 * compartido de la pantalla Hoy y se come el presupuesto de arranque.
 *
 * Por eso el modelo de autorización —roles, capacidades y su matriz— vive en
 * `./capabilities.ts`, se importa como `@housekeeper/contracts/capabilities` y NO
 * se reexporta desde aquí ni siquiera con `export { ... } from`: la arista de
 * importación basta para que rolldown lo arrastre. Lo comprueba
 * `apps/web/scripts/verify-today-bundle.mjs`.
 */

// Solo tipos, en las dos líneas: `import type` / `export type` se borran al
// compilar y no crean dependencia de ejecución con `./capabilities.ts`. No los
// conviertas en `import { ... }` ni en `export { ... } from`.
import type { Capability, Role } from "./capabilities.js";
export type { Capability, Role };

export const API_VERSION = 1 as const;
export const CRITICAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;

export type UUID = string;
export type ISODate = string;
export type ISODateTime = string;
export type MoneyCents = string;

export interface AppContextV1 {
  apiVersion: typeof API_VERSION;
  user: {
    id: UUID;
    displayName: string;
    locale: "es";
  };
  household: {
    id: UUID;
    name: string;
  };
  membership: {
    id: UUID;
    role: Role;
    expiresAt: ISODateTime | null;
    revokedAt: ISODateTime | null;
  };
  capabilities: Capability[];
  offlineLeaseExpiresAt: ISODateTime;
}

export type AggregateType =
  | "agreement"
  | "comment"
  | "contact"
  | "diner"
  | "expense"
  | "extra_work"
  | "finance"
  | "food"
  | "ics_feed"
  | "leave_request"
  | "manual_adjustment"
  | "membership"
  | "menu_group"
  | "menu_slot"
  | "menu_template"
  | "payment"
  | "recipe"
  | "routine"
  | "routine_occurrence"
  | "settlement"
  | "shopping_item"
  | "wiki_page"
  | "wiki_space";

export interface CommandEnvelopeV1<TPayload = unknown> {
  apiVersion: typeof API_VERSION;
  operationId: UUID;
  householdId: UUID;
  schemaVersion: 1;
  aggregateType: AggregateType;
  aggregateId: UUID | null;
  baseRevision: number | null;
  occurredAt: ISODateTime;
  payload: TPayload;
}

export type CommandAckStatus =
  | "accepted"
  | "duplicate"
  | "conflict"
  | "rejected"
  | "retryable";

export interface CommandAckV1 {
  operationId: UUID;
  status: CommandAckStatus;
  resourceId?: UUID;
  revision?: number;
  errorCode?: string;
  retryAfterSeconds?: number;
}

export const MAX_SYNC_COMMANDS = 25;

export interface SyncRequestV1 {
  apiVersion: typeof API_VERSION;
  commands: CommandEnvelopeV1[];
}

export interface SyncResultV1 {
  apiVersion: typeof API_VERSION;
  acknowledgements: CommandAckV1[];
  nextCursor: string;
  snapshotVersion: string | null;
}

/** Payload de `aggregateType: "expense"` para registrar un gasto propio. */
export interface ExpenseSubmitPayloadV1 {
  agreementId: UUID;
  incurredOn: ISODate;
  description: string;
  amountCents: MoneyCents;
  /** Objeto ya subido y escaneado (ruta de adjuntos) que actúa de justificante. */
  receiptStorageObjectId?: UUID;
}

/** `aggregateType: "extra_work"` — registro de jornada extra (empleada o familia). */
export interface ExtraWorkRegisterPayloadV1 {
  action: "register";
  agreementId: UUID;
  /**
   * Concepto del catálogo de la versión vigente el día trabajado (0021). Es
   * quien decide la tarifa; `kind` pasa a ser la clasificación gruesa que el
   * servidor deriva de su unidad. Opcional únicamente para los hechos
   * anteriores al catálogo.
   */
  extraWorkTypeId?: UUID;
  kind: "overtime" | "worked_rest_day";
  workedOn: ISODate;
  durationMinutes: number;
  note?: string;
  /**
   * Resolución en el acto (solo administración). Lo normal al apuntar trabajo
   * de otra persona es que ya haya ocurrido: en vez de obligar a un baile de
   * estados que nadie va a hacer, el mismo hecho puede llegar resuelto. El
   * servidor encadena `requested → performed_pending_resolution → resolved`
   * con una transición firmada por quien administra en cada paso.
   */
  resolveNow?: {
    resolution: "money" | "time_off";
    reason: string;
  };
}

/** `aggregateType: "extra_work"` — aceptación previa por la familia. */
export interface ExtraWorkAcceptPayloadV1 {
  action: "accept";
  extraWorkEventId: UUID;
}

/** `aggregateType: "extra_work"` — la empleada marca la jornada como realizada. */
export interface ExtraWorkMarkPerformedPayloadV1 {
  action: "mark_performed";
  extraWorkEventId: UUID;
}

/**
 * `aggregateType: "extra_work"` — resolución del administrador. La tarifa se
 * congela en el servidor desde la versión de acuerdo vigente en `workedOn`.
 */
export interface ExtraWorkResolvePayloadV1 {
  action: "resolve";
  extraWorkEventId: UUID;
  resolution: "money" | "time_off";
  reason: string;
}

/**
 * `aggregateType: "extra_work"` — cierre negativo del administrador: `reject`
 * (no se reconoce el trabajo) o `cancel` (la petición deja de tener sentido).
 * La política RLS impide estos estados a la empleada.
 */
export interface ExtraWorkDismissPayloadV1 {
  action: "reject" | "cancel";
  extraWorkEventId: UUID;
  reason: string;
}

/** `aggregateType: "expense"` — resolución del administrador sobre un gasto pendiente. */
export interface ExpenseResolvePayloadV1 {
  action: "resolve";
  expenseId: UUID;
  resolution: "approved" | "rejected";
  reason: string;
}

/** `aggregateType: "settlement"` — apertura de una liquidación de periodo. */
export interface SettlementOpenPayloadV1 {
  action: "open";
  agreementId: UUID;
  periodStart: ISODate;
  periodEnd: ISODate;
  dueOn: ISODate;
}

/**
 * `aggregateType: "settlement"` — cierre: el servidor materializa las líneas
 * desde los hechos (motor puro de dominio), congela totales, fija el hash del
 * snapshot canónico y encola el render del recibo.
 */
export interface SettlementClosePayloadV1 {
  action: "close";
  settlementId: UUID;
}

/** `aggregateType: "settlement"` — confirmación de cobro por la empleada. */
export interface SettlementReceiptConfirmPayloadV1 {
  action: "confirm_receipt";
  settlementId: UUID;
  note?: string;
}

/**
 * `aggregateType: "agreement"` — cambio del derecho anual de vacaciones.
 *
 * No edita la versión vigente: las versiones del acuerdo son inmutables, así
 * que el servidor APILA una versión nueva que copia el resto de los términos
 * (salario, tarifas, jornada) y solo cambia los días. Es el mismo camino que
 * seguiría una subida de sueldo, y por eso el historial de «Versiones y
 * cambios» explica también por qué cambiaron las vacaciones.
 */
export interface AgreementSetVacationEntitlementPayloadV1 {
  action: "set_vacation_entitlement";
  agreementId: UUID;
  /** Días naturales al año, no laborables. */
  annualVacationDays: number;
  /** Fecha de entrada en vigor; nunca retroactiva. */
  effectiveFrom: ISODate;
  reason: string;
}

/**
 * Catálogo de condiciones de una versión del acuerdo (migración 0021).
 *
 * No es un payload de comando: el alta y la edición del acuerdo NO pasan por la
 * cola offline. Pactar condiciones es un acto administrativo deliberado —se
 * hace contra el servidor o no se hace—, la misma decisión que la pantalla de
 * ajustes toma para el cambio de contraseña. Los tipos viven aquí porque los
 * comparten la form action, su validador zod y la vista de condiciones.
 */
export type ExtraWorkUnitV1 = "per_hour" | "per_shift" | "fixed_amount";

export interface ExtraWorkTypeInputV1 {
  /** Identidad estable del concepto a través de las versiones. */
  code: string;
  name: string;
  unit: ExtraWorkUnitV1;
  /** null = pactado sin tarifa todavía; la empleada no lo ve. */
  rateCents: MoneyCents | null;
  /** Duración pactada de la jornada; obligatoria en `per_shift`. */
  referenceMinutes: number | null;
  /** El permiso: false = a esta empleada no se le permite este trabajo. */
  active: boolean;
}

export interface RecurringSupplementInputV1 {
  code: string;
  name: string;
  amountCents: MoneyCents | null;
  periodicity: "monthly";
  /** true: suma a la transferencia. false: lo paga la casa aparte y solo consta. */
  addsToPay: boolean;
  startsOn: ISODate | null;
  endsOn: ISODate | null;
  active: boolean;
}

/** ISO-8601: 1 lunes … 7 domingo, el mismo convenio que la columna `weekday`. */
export type WeekdayV1 = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Excepción de un día del horario. `null` en un campo significa «como la
 * jornada tipo», así que terminar antes un día es rellenar `endsAt` y nada más.
 */
export interface ScheduleDayInputV1 {
  weekday: WeekdayV1;
  /** false = libranza; entonces los tres campos de hora van a null. */
  works: boolean;
  startsAt: string | null;
  endsAt: string | null;
  longBreakMinutes: number | null;
  note: string;
}

/** Horario pactado en una versión: la jornada tipo y lo que se desvía de ella. */
export interface AgreementScheduleInputV1 {
  /** «HH:MM». */
  startsAt: string;
  endsAt: string;
  /** Minutos del descanso largo del mediodía. 0 = no se pactó ninguno. */
  longBreakMinutes: number;
  note: string;
  days: ScheduleDayInputV1[];
}

/**
 * Qué pasa con los días de vacaciones que quedan sin disfrutar al cerrar un año
 * de contrato (apartado 4.2 del diseño). Es política PACTADA, así que viaja en
 * los términos de la versión y cambia apilando otra, como todo lo demás.
 *
 * `months` es el margen desde el fin del año de contrato; `never` dice que esos
 * días no caducan nunca y entonces no hay fecha límite ni aviso. Ausente en una
 * versión ya firmada significa seis meses, que es lo que de hecho se les venía
 * aplicando: por eso ningún contrato existente necesita tocarse.
 */
export type VacationCarryoverExpiryV1 =
  | { mode: "months"; months: number }
  | { mode: "never" };

/**
 * Términos completos de UNA versión. Nunca se editan: cada cambio apila una
 * versión nueva con su catálogo entero, y el historial enseña las dos.
 */
export interface AgreementTermsInputV1 {
  effectiveFrom: ISODate;
  monthlySalaryCents: MoneyCents;
  contractedWeeklyMinutes: number;
  annualVacationDays: number;
  /**
   * Importe por día de vacaciones NO disfrutado (apartado 4.4). null = no se
   * pactó, y entonces no hay compensación: la aplicación no estima un precio ni
   * escribe un cero, porque la fila es inmutable y ese cero diría para siempre
   * que se acordó pagar cero euros por día.
   */
  unusedVacationDayRateCents: MoneyCents | null;
  vacationCarryoverExpiry: VacationCarryoverExpiryV1;
  reason: string;
  extraWorkTypes: ExtraWorkTypeInputV1[];
  supplements: RecurringSupplementInputV1[];
  /**
   * null = el contrato no declara horario. No es un hueco por rellenar: es la
   * respuesta que hace que la empleada no vea una sección vacía.
   */
  schedule: AgreementScheduleInputV1 | null;
}

/** Alta del acuerdo: la relación laboral y su primera versión, a la vez. */
export interface AgreementCreateInputV1 {
  employeeMembershipId: UUID;
  startsOn: ISODate;
  terms: AgreementTermsInputV1;
}

/**
 * `aggregateType: "leave_request"` — la familia apunta un periodo de
 * vacaciones YA disfrutado o acordado. No hay solicitud ni aprobación: el
 * hogar decidió que los días los anota quien administra, y la empleada los ve.
 */
export interface VacationRecordPayloadV1 {
  action: "record";
  agreementId: UUID;
  /** Primer día natural, incluido. */
  startsOn: ISODate;
  /** Último día natural, incluido. */
  endsOn: ISODate;
  note?: string;
}

/**
 * `aggregateType: "leave_request"` — corrección de un periodo mal apuntado.
 * Anula, no borra: la fila se queda en el expediente con quién la anuló,
 * cuándo y por qué, y deja de contar en el saldo.
 */
export interface VacationVoidPayloadV1 {
  action: "void";
  vacationPeriodId: UUID;
  reason: string;
}

/**
 * `aggregateType: "leave_request"` — qué se hace con los días que quedaron sin
 * disfrutar al cerrarse un año de CONTRATO (migración 0037).
 *
 * Las tres salidas nombran el año por su ordinal y nada más: los días, la
 * versión del acuerdo y el importe los recalcula el servidor al decidir y los
 * congela en la fila. Mandarlos desde el cliente sería dejar que quien fabrique
 * la petición elija cuánto se le paga.
 */
export interface VacationCarryOverPayloadV1 {
  action: "carry_over";
  agreementId: UUID;
  /** Año de contrato que se cierra: 1 el primero. No es un año natural. */
  sourceYearIndex: number;
}

/**
 * `aggregateType: "leave_request"` — pagar los días sin disfrutar. Crea, en la
 * MISMA transacción, el concepto a mano que los materializa, con el importe y
 * la frase congelados. Sin tarifa pactada en el contrato no hay compensación
 * posible y el comando lo rechaza diciéndolo: no se estima ningún importe.
 */
export interface VacationCompensateCarryoverPayloadV1 {
  action: "compensate_carryover";
  agreementId: UUID;
  sourceYearIndex: number;
  /** Mes al que se pide imputar el concepto, `YYYY-MM`. */
  period: string;
}

/**
 * `aggregateType: "leave_request"` — los días se pierden, y queda escrito quién
 * lo decidió y por qué. El motivo es obligatorio: perder días en silencio es
 * exactamente lo que esta tabla existe para impedir.
 */
export interface VacationRejectCarryoverPayloadV1 {
  action: "reject_carryover";
  agreementId: UUID;
  sourceYearIndex: number;
  reason: string;
}

/**
 * `aggregateType: "manual_adjustment"` — un importe suelto que no nace de
 * ningún hecho del sistema (una gratificación, un descuento acordado, la parte
 * proporcional de algo) y que se imputa a la cuenta de un mes concreto.
 *
 * `period` es el mes ELEGIDO por quien lo apunta. Puede ser el mes en curso,
 * aunque su liquidación ya esté abierta. Si ese mes ya está CERRADO el servidor
 * no reescribe la cuenta: imputa el concepto al primer mes posterior que siga
 * abierto y lo deja dicho en la propia fila.
 */
export interface ManualAdjustmentRecordPayloadV1 {
  action: "record";
  agreementId: UUID;
  /** Mes al que se pide imputar, `YYYY-MM`. */
  period: string;
  /** Cómo se llama el concepto en la cuenta. */
  label: string;
  /** Por qué existe. Obligatorio: un importe suelto sin motivo es una discusión. */
  reason: string;
  /** Con signo: positivo suma a la cuenta del mes, negativo resta. Nunca cero. */
  amountCents: MoneyCents;
  /**
   * `true`: el importe mueve la transferencia del mes. `false`: consta y no la
   * toca, porque ese dinero se movió por otro sitio (un anticipo devuelto en
   * mano). Misma semántica que `adds_to_pay` en los complementos recurrentes.
   */
  addsToPay: boolean;
}

/**
 * `aggregateType: "manual_adjustment"` — corrección de un concepto mal
 * apuntado. Anula, no borra. No se puede anular lo que ya entró en una cuenta
 * cerrada: para eso se apunta el contrario en un mes abierto.
 */
export interface ManualAdjustmentVoidPayloadV1 {
  action: "void";
  manualAdjustmentId: UUID;
  reason: string;
}

/** `aggregateType: "wiki_space"` — creación de un espacio (solo familia). */
export interface WikiSpaceCreatePayloadV1 {
  action: "create";
  name: string;
  slug?: string;
  description?: string;
}

/** `aggregateType: "wiki_page"` — creación con su primera revisión Markdown. */
export interface WikiPageCreatePayloadV1 {
  action: "create";
  /** Apartado existente; alternativa a `spaceSlug`. Uno de los dos es obligatorio. */
  spaceId?: UUID;
  /**
   * Apartado por slug con alta implícita si falta (solo familia). Es lo que
   * permite escribir la primera instrucción de la Guía SIN conexión: el
   * cliente no necesita el identificador que antes llegaba con el ACK.
   */
  spaceSlug?: string;
  /** Nombre legible del apartado cuando hay que crearlo; por defecto, el slug. */
  spaceName?: string;
  parentPageId?: UUID | null;
  title: string;
  bodyMarkdown: string;
  tags?: string[];
  aliases?: string[];
  publish?: boolean;
}

/**
 * `aggregateType: "wiki_page"` — nueva revisión. `envelope.baseRevision` debe
 * ser la revisión sobre la que se editó: si el servidor tiene otra más nueva,
 * responde conflict y la resolución es humana (sin merges automáticos).
 */
export interface WikiPageEditPayloadV1 {
  action: "edit";
  pageId: UUID;
  title: string;
  bodyMarkdown: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
}

/** `aggregateType: "wiki_page"` — publicar/despublicar o fijar en portada. */
export interface WikiPageSetStatePayloadV1 {
  action: "set_state";
  pageId: UUID;
  status?: "draft" | "published";
  pinned?: boolean;
}

/** `aggregateType: "payment"` — pago parcial o total registrado por la familia. */
export interface PaymentRecordPayloadV1 {
  settlementId: UUID;
  amountCents: MoneyCents;
  method: "bank_transfer" | "cash" | "bizum" | "mixed" | "other";
  valueOn: ISODate;
  reference?: string;
}

/** `aggregateType: "finance"` — payloads de escritura del módulo Finanzas (discriminados por `kind`). */
export type FinanceCommandRecurrence = "recurrente" | "extraordinario";
export type FinanceCommandTxStatus = "pendiente" | "sugerida_regla" | "sugerida_agente" | "confirmada";

export interface FinanceAccountUpdatePayloadV1 {
  kind: "finance.account.update";
  accountId: UUID;
  name: string;
  accountKind: "comun" | "personal" | "inversion";
  ownerLabel: string;
  ownerAliases: string[];
  transferRefs: string[];
}
export interface FinanceCategoryCreatePayloadV1 {
  kind: "finance.category.create";
  name: string;
  categoryKind: "gasto" | "ingreso";
  parentId: UUID | null;
}
export interface FinanceCategoryUpdatePayloadV1 { kind: "finance.category.update"; categoryId: UUID; name: string }
export interface FinanceCategoryDeletePayloadV1 { kind: "finance.category.delete"; categoryId: UUID }
export interface FinanceCategoryAssignConceptPayloadV1 {
  kind: "finance.category.assignConcept";
  provider: string;
  concept?: string;
  categoryId: UUID;
}
export interface FinanceRuleCreatePayloadV1 {
  kind: "finance.rule.create";
  ruleType: "proveedor_exacto" | "concepto_contiene" | "codigo_norma43";
  pattern: string;
  categoryId: UUID;
  priority?: number;
}
export interface FinanceRuleDeletePayloadV1 { kind: "finance.rule.delete"; ruleId: UUID }
export interface FinanceTransactionUpdatePayloadV1 {
  kind: "finance.transaction.update";
  transactionId: UUID;
  categoryId?: UUID | null;
  status?: FinanceCommandTxStatus;
  createRule?: { ruleType: "proveedor_exacto" | "concepto_contiene" };
  concept?: string;
  recurrence?: FinanceCommandRecurrence | null;
  eventIds?: UUID[];
}
export interface FinanceTransactionsBulkPayloadV1 {
  kind: "finance.transactions.bulk";
  transactionIds: UUID[];
  categoryId?: UUID;
  status?: FinanceCommandTxStatus;
}
export interface FinanceAssignConceptRecurrencePayloadV1 {
  kind: "finance.transactions.assignConceptRecurrence";
  provider?: string;
  concept?: string;
  categoryId?: UUID;
  recurrence: FinanceCommandRecurrence;
}
export interface FinanceManualCreatePayloadV1 {
  kind: "finance.transaction.manual.create";
  accountId: UUID;
  opDate: ISODate;
  concept: string;
  provider?: string;
  amountCents: MoneyCents;
  categoryId?: UUID | null;
  recurrence?: FinanceCommandRecurrence | null;
}
export interface FinanceManualDeletePayloadV1 { kind: "finance.transaction.manual.delete"; transactionId: UUID }
export interface FinanceTransactionInvestPayloadV1 {
  kind: "finance.transaction.invest";
  transactionId: UUID;
  accountId: UUID;
}
export interface FinanceTransfersLinkPayloadV1 { kind: "finance.transfers.link"; transactionIds: UUID[] }
export interface FinanceTransfersUnlinkPayloadV1 { kind: "finance.transfers.unlink"; transferGroupId: UUID }
export interface FinanceEventCreatePayloadV1 { kind: "finance.event.create"; id?: UUID; name: string }
export interface FinanceEventUpdatePayloadV1 { kind: "finance.event.update"; eventId: UUID; name: string }
export interface FinanceEventDeletePayloadV1 { kind: "finance.event.delete"; eventId: UUID }
export interface FinanceEventAssignTransactionsPayloadV1 {
  kind: "finance.event.assignTransactions";
  eventId: UUID;
  transactionIds: UUID[];
  action: "add" | "remove";
}
export interface FinanceEventAssignConceptPayloadV1 {
  kind: "finance.event.assignConcept";
  provider?: string;
  concept?: string;
  categoryId?: UUID;
  eventId?: UUID | null;
  newEventName?: string;
}
export interface FinanceAliasUpdatePayloadV1 { kind: "finance.alias.update"; provider: string; alias: string }
export interface FinanceImportUndoPayloadV1 { kind: "finance.import.undo"; batchId: UUID }

export type FinanceWritePayloadV1 =
  | FinanceAccountUpdatePayloadV1
  | FinanceCategoryCreatePayloadV1
  | FinanceCategoryUpdatePayloadV1
  | FinanceCategoryDeletePayloadV1
  | FinanceCategoryAssignConceptPayloadV1
  | FinanceRuleCreatePayloadV1
  | FinanceRuleDeletePayloadV1
  | FinanceTransactionUpdatePayloadV1
  | FinanceTransactionsBulkPayloadV1
  | FinanceAssignConceptRecurrencePayloadV1
  | FinanceManualCreatePayloadV1
  | FinanceManualDeletePayloadV1
  | FinanceTransactionInvestPayloadV1
  | FinanceTransfersLinkPayloadV1
  | FinanceTransfersUnlinkPayloadV1
  | FinanceEventCreatePayloadV1
  | FinanceEventUpdatePayloadV1
  | FinanceEventDeletePayloadV1
  | FinanceEventAssignTransactionsPayloadV1
  | FinanceEventAssignConceptPayloadV1
  | FinanceAliasUpdatePayloadV1
  | FinanceImportUndoPayloadV1;

export interface CriticalSnapshotV1 {
  apiVersion: typeof API_VERSION;
  schemaVersion: 1;
  householdId: UUID;
  membershipId: UUID;
  version: string;
  etag: string;
  cursor: string;
  generatedAt: ISODateTime;
  expiresAt: ISODateTime;
  signature: string;
  payload: {
    emergency: readonly unknown[];
    contacts: readonly unknown[];
    dietaryFlags: readonly unknown[];
    today: Readonly<Record<string, unknown>>;
    wikiPages: readonly unknown[];
  };
}

export type SearchResultKind = "contact" | "menu" | "recipe" | "wiki";

export interface SearchResultV1 {
  id: UUID;
  kind: SearchResultKind;
  title: string;
  excerpt: string;
  href: string;
  score: number;
  actions: Array<{
    kind: "call" | "open" | "whatsapp";
    href: string;
    label: string;
  }>;
}

export interface SearchResponseV1 {
  apiVersion: typeof API_VERSION;
  queryId: UUID | null;
  mode: "offline" | "online";
  elapsedMs: number;
  groups: Partial<Record<SearchResultKind, SearchResultV1[]>>;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON canónico no admite números no finitos");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`JSON canónico no admite ${typeof value}`);
}

/**
 * Serialización canónica compartida por firma y hashing en cliente y servidor.
 * Vive en contracts porque no depende de Node y ambos lados deben producir
 * exactamente los mismos bytes.
 */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function isMoneyCents(value: string): value is MoneyCents {
  return /^-?(0|[1-9]\d*)$/.test(value);
}

export function assertSnapshotFresh(
  snapshot: CriticalSnapshotV1,
  now = Date.now(),
): void {
  const generatedAt = Date.parse(snapshot.generatedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)) {
    throw new TypeError("El snapshot contiene fechas inválidas");
  }
  if (expiresAt <= now || expiresAt - generatedAt > CRITICAL_SNAPSHOT_TTL_MS) {
    throw new RangeError("El snapshot crítico ha caducado o supera 24 horas");
  }
}
