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
  | "expense"
  | "leave_request"
  | "menu_slot"
  | "payment"
  | "routine_occurrence"
  | "time_entry"
  | "wiki_page";

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

export interface SyncResultV1 {
  apiVersion: typeof API_VERSION;
  acknowledgements: CommandAckV1[];
  nextCursor: string;
  snapshotVersion: string | null;
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
