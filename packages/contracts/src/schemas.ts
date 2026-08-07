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
    "diner",
    "expense",
    "extra_work",
    "food",
    "ics_feed",
    "leave_request",
    "membership",
    "menu_group",
    "menu_slot",
    "payment",
    "recipe",
    "routine",
    "routine_occurrence",
    "settlement",
    "shopping_item",
    "time_entry",
    "wiki_page",
    "wiki_space",
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

export const extraWorkRejectPayloadSchema = z.object({
  action: z.literal("reject"),
  extraWorkEventId: uuidSchema,
  reason: z.string().trim().min(1).max(500),
});

export const extraWorkCancelPayloadSchema = z.object({
  action: z.literal("cancel"),
  extraWorkEventId: uuidSchema,
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
  extraWorkRejectPayloadSchema,
  extraWorkCancelPayloadSchema,
]);

const wikiSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const wikiTermListSchema = z.array(z.string().trim().min(1).max(60)).max(20);

export const wikiSpaceCreatePayloadSchema = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(1).max(120),
  slug: wikiSlugSchema.optional(),
  description: z.string().max(500).optional(),
});

export const wikiPageCreatePayloadSchema = z.object({
  action: z.literal("create"),
  spaceId: uuidSchema,
  parentPageId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().max(200_000),
  tags: wikiTermListSchema.optional(),
  aliases: wikiTermListSchema.optional(),
  publish: z.boolean().optional(),
});

export const wikiPageEditPayloadSchema = z.object({
  action: z.literal("edit"),
  pageId: uuidSchema,
  title: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().max(200_000),
  summary: z.string().max(500).optional(),
  tags: wikiTermListSchema.optional(),
  aliases: wikiTermListSchema.optional(),
});

export const wikiPageSetStatePayloadSchema = z
  .object({
    action: z.literal("set_state"),
    pageId: uuidSchema,
    status: z.enum(["draft", "published"]).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => value.status !== undefined || value.pinned !== undefined, {
    message: "set_state requiere status o pinned",
  });

export const wikiSpaceSetTemplatePayloadSchema = z.object({
  action: z.literal("set_template"),
  spaceId: uuidSchema,
  isTemplate: z.boolean(),
});

export const wikiSpaceClonePayloadSchema = z.object({
  action: z.literal("clone_template"),
  templateSpaceId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  slug: wikiSlugSchema.optional(),
});

export const wikiSpaceCommandPayloadSchema = z.discriminatedUnion("action", [
  wikiSpaceCreatePayloadSchema,
  wikiSpaceSetTemplatePayloadSchema,
  wikiSpaceClonePayloadSchema,
]);

export const membershipSetExpiryPayloadSchema = z.object({
  action: z.literal("set_expiry"),
  membershipId: uuidSchema,
  expiresAt: isoDateTimeSchema.nullable(),
});

export const membershipRevokePayloadSchema = z.object({
  action: z.literal("revoke"),
  membershipId: uuidSchema,
});

export const membershipCommandPayloadSchema = z.discriminatedUnion("action", [
  membershipSetExpiryPayloadSchema,
  membershipRevokePayloadSchema,
]);

export const wikiPageCommandPayloadSchema = z.discriminatedUnion("action", [
  wikiPageCreatePayloadSchema,
  wikiPageEditPayloadSchema,
  wikiPageSetStatePayloadSchema,
]);

const allergenCodeSchema = z.string().regex(/^[a-z-]+$/);
const decimalQuantitySchema = z.string().regex(/^\d{1,8}([.,]\d{1,2})?$/);

export const foodUpsertPayloadSchema = z.object({
  action: z.literal("upsert"),
  foodId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(120),
  shoppingSection: z.string().trim().min(1).max(60),
  allergenCodes: z.array(allergenCodeSchema).max(14),
  reviewed: z.boolean(),
});

export const dinerUpsertPayloadSchema = z.object({
  action: z.literal("upsert"),
  dinerId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(500).optional(),
  flags: z
    .array(
      z.object({
        allergenCode: allergenCodeSchema,
        severity: z.enum(["high", "medium"]),
        note: z.string().max(200).optional(),
      }),
    )
    .max(14),
});

export const recipeSetDetailsPayloadSchema = z.object({
  action: z.literal("set_details"),
  pageId: uuidSchema,
  baseServings: z.number().int().min(1).max(50),
  timeMinutes: z.number().int().min(1).max(24 * 60).optional(),
  ingredients: z
    .array(
      z.object({
        foodId: uuidSchema,
        quantity: decimalQuantitySchema,
        unit: z.string().trim().min(1).max(30),
        scaling: z.enum(["linear", "fixed"]),
      }),
    )
    .min(1)
    .max(60),
});

export const menuGroupUpsertPayloadSchema = z.object({
  action: z.literal("upsert"),
  groupId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(120),
  dinerIds: z.array(uuidSchema).max(30),
});

// La regla "receta o texto" la garantizan el handler y el CHECK de la tabla;
// aquí se mantiene el objeto plano para poder entrar en la unión discriminada.
export const menuSlotSetPayloadSchema = z.object({
  action: z.literal("set"),
  groupId: uuidSchema,
  onDate: isoDateSchema,
  meal: z.enum(["desayuno", "almuerzo", "comida", "merienda", "cena"]),
  recipePageId: uuidSchema.optional(),
  freeText: z.string().max(300).optional(),
  notes: z.string().max(500).optional(),
  servingsOverride: z.number().int().min(1).max(50).optional(),
  /** Reconocimiento explícito de una incompatibilidad de alérgenos (AC-21). */
  acknowledgeAllergens: z.boolean().optional(),
});

export const menuSlotClearPayloadSchema = z.object({
  action: z.literal("clear"),
  slotId: uuidSchema,
});

export const menuWeekDuplicatePayloadSchema = z.object({
  action: z.literal("duplicate_week"),
  fromWeekStartsOn: isoDateSchema,
  toWeekStartsOn: isoDateSchema,
});

export const menuConfirmPayloadSchema = z.object({
  action: z.literal("confirm"),
  slotId: uuidSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const menuSlotCommandPayloadSchema = z.discriminatedUnion("action", [
  menuSlotSetPayloadSchema,
  menuSlotClearPayloadSchema,
  menuWeekDuplicatePayloadSchema,
  menuConfirmPayloadSchema,
]);

export const shoppingAddPayloadSchema = z
  .object({
    action: z.literal("add"),
    foodId: uuidSchema.optional(),
    customName: z.string().trim().max(120).optional(),
    quantity: decimalQuantitySchema.optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    section: z.string().trim().min(1).max(60).optional(),
    weekStartsOn: isoDateSchema.optional(),
  })
  .refine((value) => value.foodId !== undefined || (value.customName ?? "").trim().length > 0, {
    message: "Un añadido necesita alimento o nombre libre",
  });

export const shoppingSetCheckedPayloadSchema = z.object({
  action: z.literal("set_checked"),
  itemId: uuidSchema,
  checked: z.boolean(),
});

export const routineUpsertPayloadSchema = z.object({
  action: z.literal("upsert"),
  routineId: uuidSchema.optional(),
  title: z.string().trim().min(1).max(160),
  details: z.string().max(1000).optional(),
  audience: z.enum(["family", "employee", "all"]),
  frequency: z.enum(["daily", "weekly", "monthly", "quarterly"]),
  intervalCount: z.number().int().min(1).max(12),
  nextDueOn: isoDateSchema,
});

export const routineCompletePayloadSchema = z.object({
  action: z.literal("complete"),
  routineId: uuidSchema,
  dueOn: isoDateSchema,
});

export const icsFeedCreatePayloadSchema = z.object({
  action: z.literal("create"),
  audience: z.enum(["family", "employee", "all"]),
});

export const icsFeedRevokePayloadSchema = z.object({
  action: z.literal("revoke"),
  feedId: uuidSchema,
});

export const icsSourceUpsertPayloadSchema = z.object({
  action: z.literal("upsert_source"),
  sourceId: uuidSchema.optional(),
  url: z.string().url().startsWith("https://").max(500),
  label: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
});

export const icsFeedCommandPayloadSchema = z.discriminatedUnion("action", [
  icsFeedCreatePayloadSchema,
  icsFeedRevokePayloadSchema,
  icsSourceUpsertPayloadSchema,
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
