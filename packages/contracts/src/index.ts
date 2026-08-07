export const API_VERSION = 1 as const;
export const CRITICAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;

export const roles = [
  "family_admin",
  "family_member",
  "employee_live_in",
  "helper",
  "viewer",
] as const;

export type Role = (typeof roles)[number];

export const capabilities = [
  "access.manage",
  "agreement.read",
  "agreement.write",
  "calendar.read",
  "calendar.write",
  "comment.create",
  "contact.read",
  "contact.write",
  "content.read",
  "content.write",
  "content.publish",
  "emergency.read",
  "expense.create.self",
  "export.employment.self",
  "leave.approve",
  "leave.request.self",
  "menu.read",
  "menu.write",
  "payment.confirm.self",
  "payment.register",
  "routine.read",
  "routine.toggle",
  "search.use",
  "settlement.close",
  "settlement.read",
  "work.confirm",
  "work.register.self",
] as const;

export type Capability = (typeof capabilities)[number];

const allCapabilities = [...capabilities];

export const roleCapabilities: Readonly<Record<Role, readonly Capability[]>> = {
  family_admin: allCapabilities,
  family_member: [
    "agreement.read",
    "calendar.read",
    "calendar.write",
    "comment.create",
    "contact.read",
    "contact.write",
    "content.publish",
    "content.read",
    "content.write",
    "emergency.read",
    "menu.read",
    "menu.write",
    "routine.read",
    "routine.toggle",
    "search.use",
    "settlement.read",
  ],
  employee_live_in: [
    "agreement.read",
    "calendar.read",
    "comment.create",
    "contact.read",
    "content.read",
    "emergency.read",
    "expense.create.self",
    "export.employment.self",
    "leave.request.self",
    "menu.read",
    "payment.confirm.self",
    "routine.read",
    "routine.toggle",
    "search.use",
    "settlement.read",
    "work.register.self",
  ],
  helper: [
    "comment.create",
    "contact.read",
    "content.read",
    "emergency.read",
    "menu.read",
    "routine.read",
    "routine.toggle",
    "search.use",
  ],
  viewer: ["calendar.read", "contact.read", "emergency.read"],
};
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
  | "food"
  | "ics_feed"
  | "leave_request"
  | "membership"
  | "menu_group"
  | "menu_slot"
  | "payment"
  | "recipe"
  | "routine"
  | "routine_occurrence"
  | "settlement"
  | "shopping_item"
  | "time_entry"
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

/** `aggregateType: "time_entry"` — la empleada envía su semana con sus entradas. */
export interface WeeklyReportSubmitPayloadV1 {
  action: "submit_week";
  agreementId: UUID;
  weekStartsOn: ISODate;
  entries: Array<{
    workedOn: ISODate;
    startedAt?: string;
    endedAt?: string;
    regularMinutes: number;
    note?: string;
  }>;
}

/** `aggregateType: "extra_work"` — registro de jornada extra (empleada o familia). */
export interface ExtraWorkRegisterPayloadV1 {
  action: "register";
  agreementId: UUID;
  kind: "overtime" | "worked_rest_day";
  workedOn: ISODate;
  durationMinutes: number;
  note?: string;
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
  spaceId: UUID;
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

export function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value);
}

export function isMoneyCents(value: string): value is MoneyCents {
  return /^-?(0|[1-9]\d*)$/.test(value);
}

export function hasCapability(role: Role, capability: Capability): boolean {
  return roleCapabilities[role].includes(capability);
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
