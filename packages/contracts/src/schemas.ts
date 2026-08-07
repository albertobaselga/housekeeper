import { z } from "zod";

import {
  API_VERSION,
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
    "leave_request",
    "menu_slot",
    "payment",
    "routine_occurrence",
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
