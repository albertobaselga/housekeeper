import { z } from "zod";

import {
  API_VERSION,
  MAX_SYNC_COMMANDS,
  capabilities,
  roles,
} from "./index.js";

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const isoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value),
  "Debe ser una fecha ISO-8601 con zona horaria",
);
export const moneyCentsSchema = z.string().regex(/^-?(0|[1-9]\d*)$/);
export const roleSchema = z.enum(roles);
export const capabilitySchema = z.enum(capabilities);

export const appContextSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  user: z.object({ id: uuidSchema, displayName: z.string().min(1).max(120), locale: z.literal("es") }),
  household: z.object({ id: uuidSchema, name: z.string().min(1).max(120) }),
  membership: z.object({
    id: uuidSchema,
    role: roleSchema,
    expiresAt: isoDateTimeSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
  }),
  capabilities: z.array(capabilitySchema),
  offlineLeaseExpiresAt: isoDateTimeSchema,
});

export const commandEnvelopeSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  operationId: uuidSchema,
  householdId: uuidSchema,
  schemaVersion: z.literal(1),
  aggregateType: z.enum([
    "agreement",
    "comment",
    "expense",
    "extra_work",
    "leave_request",
    "menu_slot",
    "payment",
    "routine_occurrence",
    "settlement",
    "time_entry",
    "wiki_page",
  ]),
  aggregateId: uuidSchema.nullable(),
  baseRevision: z.number().int().nonnegative().nullable(),
  occurredAt: isoDateTimeSchema,
  payload: z.unknown(),
});

const commandAckSchema = z.object({
  operationId: uuidSchema,
  status: z.enum(["accepted", "duplicate", "conflict", "rejected", "retryable"]),
  resourceId: uuidSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  errorCode: z.string().max(100).optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
});

export const syncRequestSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  commands: z.array(commandEnvelopeSchema).min(1).max(MAX_SYNC_COMMANDS),
});

export const expenseSubmitPayloadSchema = z.object({
  agreementId: uuidSchema,
  incurredOn: isoDateSchema,
  description: z.string().trim().min(1).max(500),
  amountCents: moneyCentsSchema.refine((value) => BigInt(value) > 0n, "El importe debe ser positivo"),
});

const isoTimeSchema = z.string().regex(/^\d{2}:\d{2}$/);

export const weeklyReportSubmitPayloadSchema = z.object({
  action: z.literal("submit_week"),
  agreementId: uuidSchema,
  weekStartsOn: isoDateSchema,
  entries: z
    .array(
      z.object({
        workedOn: isoDateSchema,
        startedAt: isoTimeSchema.optional(),
        endedAt: isoTimeSchema.optional(),
        regularMinutes: z.number().int().min(0).max(24 * 60),
        note: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(31),
});

export const extraWorkRegisterPayloadSchema = z.object({
  action: z.literal("register"),
  agreementId: uuidSchema,
  kind: z.enum(["overtime", "worked_rest_day"]),
  workedOn: isoDateSchema,
  durationMinutes: z.number().int().min(1).max(24 * 60),
  note: z.string().max(500).optional(),
});

export const extraWorkAcceptPayloadSchema = z.object({
  action: z.literal("accept"),
  extraWorkEventId: uuidSchema,
});

export const extraWorkMarkPerformedPayloadSchema = z.object({
  action: z.literal("mark_performed"),
  extraWorkEventId: uuidSchema,
});

export const extraWorkResolvePayloadSchema = z.object({
  action: z.literal("resolve"),
  extraWorkEventId: uuidSchema,
  resolution: z.enum(["money", "time_off"]),
  reason: z.string().trim().min(1).max(500),
});

export const expenseResolvePayloadSchema = z.object({
  action: z.literal("resolve"),
  expenseId: uuidSchema,
  resolution: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(500),
});

export const settlementOpenPayloadSchema = z.object({
  action: z.literal("open"),
  agreementId: uuidSchema,
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  dueOn: isoDateSchema,
});

export const settlementClosePayloadSchema = z.object({
  action: z.literal("close"),
  settlementId: uuidSchema,
});

export const settlementReceiptConfirmPayloadSchema = z.object({
  action: z.literal("confirm_receipt"),
  settlementId: uuidSchema,
  note: z.string().max(500).optional(),
});

export const settlementCommandPayloadSchema = z.discriminatedUnion("action", [
  settlementOpenPayloadSchema,
  settlementClosePayloadSchema,
  settlementReceiptConfirmPayloadSchema,
]);

export const extraWorkCommandPayloadSchema = z.discriminatedUnion("action", [
  extraWorkRegisterPayloadSchema,
  extraWorkAcceptPayloadSchema,
  extraWorkMarkPerformedPayloadSchema,
  extraWorkResolvePayloadSchema,
]);

export const paymentRecordPayloadSchema = z.object({
  settlementId: uuidSchema,
  amountCents: moneyCentsSchema.refine((value) => BigInt(value) > 0n, "El importe debe ser positivo"),
  method: z.enum(["bank_transfer", "cash", "bizum", "mixed", "other"]),
  valueOn: isoDateSchema,
  reference: z.string().max(200).optional(),
});

export const syncResultSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  acknowledgements: z.array(commandAckSchema),
  nextCursor: z.string(),
  snapshotVersion: z.string().nullable(),
});

export const criticalSnapshotSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  schemaVersion: z.literal(1),
  householdId: uuidSchema,
  membershipId: uuidSchema,
  version: z.string().min(1),
  etag: z.string().min(1),
  cursor: z.string(),
  generatedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  signature: z.string().min(1),
  payload: z.object({
    emergency: z.array(z.unknown()).readonly(),
    contacts: z.array(z.unknown()).readonly(),
    dietaryFlags: z.array(z.unknown()).readonly(),
    today: z.record(z.string(), z.unknown()).readonly(),
    wikiPages: z.array(z.unknown()).readonly(),
  }),
});

const searchResultSchema = z.object({
  id: uuidSchema,
  kind: z.enum(["contact", "menu", "recipe", "wiki"]),
  title: z.string().min(1),
  excerpt: z.string(),
  href: z.string().startsWith("/"),
  score: z.number().finite(),
  actions: z.array(z.object({
    kind: z.enum(["call", "open", "whatsapp"]),
    href: z.string().min(1),
    label: z.string().min(1),
  })),
});

export const searchResponseSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  queryId: uuidSchema.nullable(),
  mode: z.enum(["offline", "online"]),
  elapsedMs: z.number().nonnegative(),
  groups: z.object({
    contact: z.array(searchResultSchema).optional(),
    menu: z.array(searchResultSchema).optional(),
    recipe: z.array(searchResultSchema).optional(),
    wiki: z.array(searchResultSchema).optional(),
  }),
});
