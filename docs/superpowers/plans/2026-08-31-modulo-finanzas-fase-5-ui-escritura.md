# Módulo Finanzas: UI de escritura — Plan de implementación (Fase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todas las escrituras del módulo Finanzas: comandos `finance.*` restantes con acuse veraz, edición en Movimientos, páginas Revisión / Eventos / Importar / Ajustes del módulo y la importación multipart de extractos.

**Architecture:** Los handlers de comandos viven en `packages/server/src/commands/finance.ts` (payloads Zod en `@casa-clara/contracts`, discriminados por `kind`, despachados por el `aggregateType: "finance"` ya registrado en `/api/v1/sync`); la importación es la única escritura REST (multipart, sin estado entre peticiones) y reutiliza los parsers y el pipeline de la fase 2. El cliente encola todo por `queueCommand`/`OptimisticActions` con el token de invalidación `cc:finance`.

**Tech Stack:** SvelteKit + Svelte 5 (runas), Zod 4, pg sobre Postgres 18.4 local con RLS, vitest, Playwright (batería `*.dbe2e.ts`).

**Spec:** `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md` · Interfaces: `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md`

## Global Constraints

- Trabajar SOLO dentro del worktree `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas` (rama `worktree-modulo-finanzas`). El repo `/home/abf/github/home-finance` es solo-lectura (fuente a portar).
- Node 24 obligatorio: prefijo `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"` antes de cualquier `pnpm`/`node`.
- Dinero: céntimos como `bigint` (TS) / `bigint` (SQL), NUNCA `Number`/float; solo EUR.
- Idioma: UI, copy, docs y commits en español (`tipo(ámbito): qué cambia`); identificadores en inglés.
- Solo datos sintéticos en el repo (importes, titulares, extractos de prueba inventados).
- Migraciones append-only `00NN_*.sql`, un solo bloque `BEGIN;…COMMIT;`; jamás editar una aplicada.
- Toda spec nueva (unit/e2e/a11y/dbe2e/SQL) cableada a un job de `.github/workflows/ci.yml` (lo exige `scripts/ci/assert-suite-coverage.py`).
- CSS solo con tokens de `apps/web/src/app.css` (vigila `apps/web/scripts/lint-css-tokens.mjs`); pesos 400/500/700; terracota solo para «ahora».
- Única dependencia nueva permitida: `xlsx` (SheetJS), SOLO en `packages/server` (jamás en cliente).
- La matriz de capacidades NO se reexporta desde la raíz de `@casa-clara/contracts` (vigila `apps/web/scripts/verify-today-bundle.mjs`).
- Escrituras de negocio SOLO como comandos por `POST /api/v1/sync`; REST solo para lecturas y para la importación multipart.
- TDD: test que falla → implementación mínima → verde → commit. Commits frecuentes.
- Suites de BD en secuencia (bases/roles de nombre fijo); Postgres local 18.4 en Docker para db-tests/dbe2e; PRODUCCIÓN (Supabase) prohibida en fases 1–6; en fase 7 solo con confirmación explícita de Alberto.
- Gates de la rama: `pnpm lint`, `pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm test:rls` deben quedar en verde al cerrar cada tarea que los afecte.

**Nota de coexistencia con la fase 1 (aplica a las tareas 1, 2 y 6):** la fase 1 dejó en `packages/contracts` el valor `"finance"` en el enum de `aggregateType`, y en `packages/server/src/commands/finance.ts` el helper `requireFinanceAdmin` y el manejo de `finance.grant.write`/`finance.revoke.write`. Ese código NO se toca: estas tareas AÑADEN kinds nuevos. Donde un paso diga «si ya existe X», compruébalo con el `grep` indicado y aplica solo la rama que corresponda.

**Nota de CI:** ningún fichero de esta fase necesita tocar `.github/workflows/ci.yml`: los tests nuevos caen dentro de globs ya cableados (`packages/contracts` y `apps/web` corren con `pnpm -r test`; `packages/server::src/*.test.ts`, `apps/web::tests/*.test.ts` y `apps/web/e2e::*.dbe2e.ts` están inventariados por `assert-suite-coverage.py`).

---

### Task 1: Contratos — payloads Zod de los 22 comandos de escritura

**Files:**
- Modify: `packages/contracts/src/schemas.ts` (añadir al final, junto a `paymentRecordPayloadSchema`)
- Modify: `packages/contracts/src/index.ts` (tipos `Finance*PayloadV1`)
- Test: `packages/contracts/src/finance-commands.test.ts`

**Interfaces:**
- Consumes: `uuidSchema`, `isoDateSchema`, `moneyCentsSchema` (ya en `schemas.ts`); tipo `UUID`, `MoneyCents`, `ISODate` (ya en `index.ts`); los nombres de `kind` EXACTOS del doc de interfaces.
- Produces (los consumen las tareas 2–13):
  - `financeWritePayloadSchema` — `z.discriminatedUnion("kind", […22 esquemas])`, exportado de `@casa-clara/contracts/schemas`.
  - Un esquema exportado por comando: `financeAccountUpdatePayloadSchema`, `financeCategoryCreatePayloadSchema`, `financeCategoryUpdatePayloadSchema`, `financeCategoryDeletePayloadSchema`, `financeCategoryAssignConceptPayloadSchema`, `financeRuleCreatePayloadSchema`, `financeRuleDeletePayloadSchema`, `financeTransactionUpdatePayloadSchema`, `financeTransactionsBulkPayloadSchema`, `financeAssignConceptRecurrencePayloadSchema`, `financeManualCreatePayloadSchema`, `financeManualDeletePayloadSchema`, `financeTransactionInvestPayloadSchema`, `financeTransfersLinkPayloadSchema`, `financeTransfersUnlinkPayloadSchema`, `financeEventCreatePayloadSchema`, `financeEventUpdatePayloadSchema`, `financeEventDeletePayloadSchema`, `financeEventAssignTransactionsPayloadSchema`, `financeEventAssignConceptPayloadSchema`, `financeAliasUpdatePayloadSchema`, `financeImportUndoPayloadSchema`.
  - Tipos TS: `FinanceWritePayloadV1` (unión) y una interfaz por payload (mismo nombre con sufijo `PayloadV1`), exportados de `@casa-clara/contracts`.

- [ ] **Step 1: Verifica que el enum de `aggregateType` incluye `"finance"`**

```bash
grep -n '"finance"' packages/contracts/src/schemas.ts packages/contracts/src/index.ts
```

Si NO aparece (la fase 1 debería haberlo dejado): añade `"finance",` en orden alfabético (entre `"extra_work"` y `"food"`) tanto en el `z.enum([...])` de `commandEnvelopeSchema` (`schemas.ts`) como en el tipo `AggregateType` (`index.ts`).

- [ ] **Step 2: Escribe el test que falla**

`packages/contracts/src/finance-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  financeManualCreatePayloadSchema,
  financeTransactionUpdatePayloadSchema,
  financeTransfersLinkPayloadSchema,
  financeWritePayloadSchema,
} from "./schemas.js";

const TX = "ab300000-0000-4000-8000-000000000001";
const CAT = "ab200000-0000-4000-8000-000000000001";
const ACC = "ab100000-0000-4000-8000-000000000001";

describe("payloads de escritura de finanzas", () => {
  it("acepta una actualización parcial de transacción y conserva el kind", () => {
    const parsed = financeTransactionUpdatePayloadSchema.parse({
      kind: "finance.transaction.update",
      transactionId: TX,
      categoryId: CAT,
    });
    expect(parsed.kind).toBe("finance.transaction.update");
    expect(parsed.status).toBeUndefined();
  });

  it("acepta confirmar con creación de regla y recorta el concepto", () => {
    const parsed = financeTransactionUpdatePayloadSchema.parse({
      kind: "finance.transaction.update",
      transactionId: TX,
      status: "confirmada",
      createRule: { ruleType: "proveedor_exacto" },
      concept: "  Luz de julio  ",
    });
    expect(parsed.concept).toBe("Luz de julio");
  });

  it("la unión discrimina por kind y rechaza kinds desconocidos", () => {
    expect(
      financeWritePayloadSchema.safeParse({ kind: "finance.transaction.update", transactionId: TX }).success,
    ).toBe(true);
    expect(financeWritePayloadSchema.safeParse({ kind: "finance.inventado", transactionId: TX }).success).toBe(false);
  });

  it("vincular transferencias exige al menos 2 movimientos", () => {
    expect(
      financeTransfersLinkPayloadSchema.safeParse({ kind: "finance.transfers.link", transactionIds: [TX] }).success,
    ).toBe(false);
    expect(
      financeTransfersLinkPayloadSchema.safeParse({
        kind: "finance.transfers.link",
        transactionIds: [TX, "ab300000-0000-4000-8000-000000000002"],
      }).success,
    ).toBe(true);
  });

  it("un manual no puede tener importe 0 y exige concepto de 3+ caracteres", () => {
    const base = {
      kind: "finance.transaction.manual.create",
      accountId: ACC,
      opDate: "2026-08-15",
      concept: "Fruta del mercado",
      amountCents: "-1500",
    };
    expect(financeManualCreatePayloadSchema.safeParse(base).success).toBe(true);
    expect(financeManualCreatePayloadSchema.safeParse({ ...base, amountCents: "0" }).success).toBe(false);
    expect(financeManualCreatePayloadSchema.safeParse({ ...base, concept: "ab" }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Ejecuta y ve el fallo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/contracts test finance-commands
```

Expected: FAIL — error de resolución: `financeTransactionUpdatePayloadSchema` (etc.) no está exportado de `./schemas.js`.

- [ ] **Step 4: Implementación — esquemas en `schemas.ts`**

Añade al final de `packages/contracts/src/schemas.ts` (mismo estilo que `expenseSubmitPayloadSchema`/`paymentRecordPayloadSchema`):

```ts
// --- Finanzas: payloads de escritura (`aggregateType: "finance"`, discriminados por `kind`).
// Los selectores proveedor-o-categoría se validan en el handler (finance_selector_required),
// no con refine: la unión discriminada exige objetos planos.

const financeRecurrenceSchema = z.enum(["recurrente", "extraordinario"]);
const financeTxStatusSchema = z.enum(["pendiente", "sugerida_regla", "sugerida_agente", "confirmada"]);

export const financeAccountUpdatePayloadSchema = z.object({
  kind: z.literal("finance.account.update"),
  accountId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  accountKind: z.enum(["comun", "personal", "inversion"]),
  ownerLabel: z.string().trim().min(1).max(80),
  ownerAliases: z.array(z.string().trim().min(1).max(120)).max(20),
  transferRefs: z.array(z.string().trim().min(1).max(64)).max(20),
});

export const financeCategoryCreatePayloadSchema = z.object({
  kind: z.literal("finance.category.create"),
  name: z.string().trim().min(1).max(80),
  categoryKind: z.enum(["gasto", "ingreso"]),
  parentId: uuidSchema.nullable(),
});

export const financeCategoryUpdatePayloadSchema = z.object({
  kind: z.literal("finance.category.update"),
  categoryId: uuidSchema,
  name: z.string().trim().min(1).max(80),
});

export const financeCategoryDeletePayloadSchema = z.object({
  kind: z.literal("finance.category.delete"),
  categoryId: uuidSchema,
});

export const financeCategoryAssignConceptPayloadSchema = z.object({
  kind: z.literal("finance.category.assignConcept"),
  provider: z.string().trim().min(1).max(200),
  concept: z.string().trim().min(1).max(200).optional(),
  categoryId: uuidSchema,
});

export const financeRuleCreatePayloadSchema = z.object({
  kind: z.literal("finance.rule.create"),
  ruleType: z.enum(["proveedor_exacto", "concepto_contiene", "codigo_norma43"]),
  pattern: z.string().trim().min(1).max(200),
  categoryId: uuidSchema,
  priority: z.number().int().min(0).max(1000).optional(),
});

export const financeRuleDeletePayloadSchema = z.object({
  kind: z.literal("finance.rule.delete"),
  ruleId: uuidSchema,
});

export const financeTransactionUpdatePayloadSchema = z.object({
  kind: z.literal("finance.transaction.update"),
  transactionId: uuidSchema,
  categoryId: uuidSchema.nullable().optional(),
  status: financeTxStatusSchema.optional(),
  createRule: z.object({ ruleType: z.enum(["proveedor_exacto", "concepto_contiene"]) }).optional(),
  concept: z.string().trim().min(3).max(500).optional(),
  recurrence: financeRecurrenceSchema.nullable().optional(),
  eventIds: z.array(uuidSchema).max(50).optional(),
});

export const financeTransactionsBulkPayloadSchema = z.object({
  kind: z.literal("finance.transactions.bulk"),
  transactionIds: z.array(uuidSchema).min(1).max(500),
  categoryId: uuidSchema.optional(),
  status: financeTxStatusSchema,
});

export const financeAssignConceptRecurrencePayloadSchema = z.object({
  kind: z.literal("finance.transactions.assignConceptRecurrence"),
  provider: z.string().trim().min(1).max(200).optional(),
  concept: z.string().trim().min(1).max(200).optional(),
  categoryId: uuidSchema.optional(),
  recurrence: financeRecurrenceSchema,
});

export const financeManualCreatePayloadSchema = z.object({
  kind: z.literal("finance.transaction.manual.create"),
  accountId: uuidSchema,
  opDate: isoDateSchema,
  concept: z.string().trim().min(3).max(200),
  provider: z.string().trim().max(200).optional(),
  amountCents: moneyCentsSchema.refine((value) => BigInt(value) !== 0n, "El importe no puede ser 0"),
  categoryId: uuidSchema.nullable().optional(),
  recurrence: financeRecurrenceSchema.nullable().optional(),
});

export const financeManualDeletePayloadSchema = z.object({
  kind: z.literal("finance.transaction.manual.delete"),
  transactionId: uuidSchema,
});

export const financeTransactionInvestPayloadSchema = z.object({
  kind: z.literal("finance.transaction.invest"),
  transactionId: uuidSchema,
  accountId: uuidSchema,
});

export const financeTransfersLinkPayloadSchema = z.object({
  kind: z.literal("finance.transfers.link"),
  transactionIds: z.array(uuidSchema).min(2).max(20),
});

export const financeTransfersUnlinkPayloadSchema = z.object({
  kind: z.literal("finance.transfers.unlink"),
  transferGroupId: uuidSchema,
});

export const financeEventCreatePayloadSchema = z.object({
  kind: z.literal("finance.event.create"),
  name: z.string().trim().min(1).max(80),
});

export const financeEventUpdatePayloadSchema = z.object({
  kind: z.literal("finance.event.update"),
  eventId: uuidSchema,
  name: z.string().trim().min(1).max(80),
});

export const financeEventDeletePayloadSchema = z.object({
  kind: z.literal("finance.event.delete"),
  eventId: uuidSchema,
});

export const financeEventAssignTransactionsPayloadSchema = z.object({
  kind: z.literal("finance.event.assignTransactions"),
  eventId: uuidSchema,
  transactionIds: z.array(uuidSchema).min(1).max(500),
  action: z.enum(["add", "remove"]),
});

export const financeEventAssignConceptPayloadSchema = z.object({
  kind: z.literal("finance.event.assignConcept"),
  provider: z.string().trim().min(1).max(200).optional(),
  concept: z.string().trim().min(1).max(200).optional(),
  categoryId: uuidSchema.optional(),
  eventId: uuidSchema.nullable().optional(),
  newEventName: z.string().trim().min(1).max(80).optional(),
});

export const financeAliasUpdatePayloadSchema = z.object({
  kind: z.literal("finance.alias.update"),
  provider: z.string().trim().min(1).max(200),
  alias: z.string().trim().max(120),
});

export const financeImportUndoPayloadSchema = z.object({
  kind: z.literal("finance.import.undo"),
  batchId: uuidSchema,
});

export const financeWritePayloadSchema = z.discriminatedUnion("kind", [
  financeAccountUpdatePayloadSchema,
  financeCategoryCreatePayloadSchema,
  financeCategoryUpdatePayloadSchema,
  financeCategoryDeletePayloadSchema,
  financeCategoryAssignConceptPayloadSchema,
  financeRuleCreatePayloadSchema,
  financeRuleDeletePayloadSchema,
  financeTransactionUpdatePayloadSchema,
  financeTransactionsBulkPayloadSchema,
  financeAssignConceptRecurrencePayloadSchema,
  financeManualCreatePayloadSchema,
  financeManualDeletePayloadSchema,
  financeTransactionInvestPayloadSchema,
  financeTransfersLinkPayloadSchema,
  financeTransfersUnlinkPayloadSchema,
  financeEventCreatePayloadSchema,
  financeEventUpdatePayloadSchema,
  financeEventDeletePayloadSchema,
  financeEventAssignTransactionsPayloadSchema,
  financeEventAssignConceptPayloadSchema,
  financeAliasUpdatePayloadSchema,
  financeImportUndoPayloadSchema,
]);
```

- [ ] **Step 5: Implementación — tipos en `index.ts`**

Añade al final de `packages/contracts/src/index.ts` (junto a `PaymentRecordPayloadV1`):

```ts
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
  status: FinanceCommandTxStatus;
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
export interface FinanceEventCreatePayloadV1 { kind: "finance.event.create"; name: string }
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
```

- [ ] **Step 6: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/contracts test finance-commands && pnpm --filter @casa-clara/contracts typecheck
```

Expected: PASS (5 tests) y typecheck sin errores.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/schemas.ts packages/contracts/src/index.ts packages/contracts/src/finance-commands.test.ts
git commit -m "feat(finanzas): payloads de los comandos de escritura en contracts"
```

---

### Task 2: Servidor — dispatcher `financeCommandHandler` y comandos de Revisión (`transaction.update`, `transactions.bulk`, `transactions.assignConceptRecurrence`)

**Files:**
- Modify: `packages/server/src/commands/finance.ts` (existe desde fase 1: conserva `requireFinanceAdmin` y grant/revoke)
- Modify: `packages/server/src/index.ts` (export)
- Modify: `apps/web/src/routes/api/v1/sync/+server.ts` (registro)
- Test: `packages/server/src/finance-review.integration.test.ts`

**Interfaces:**
- Consumes: `financeWritePayloadSchema` y tipos de la Task 1; `requireFinanceAdmin` (fase 1, doc de interfaces: verifica rol admin + concesión viva dentro de la transacción; llámalo con `await requireFinanceAdmin(client, membership)` y, si su firma de fase 1 pide además `envelope.householdId`, pásaselo — el contrato es que LANZA si no procede); `runPostImportPipeline(client: PoolClient, householdId: string): Promise<PipelineReport>` (fase 2, `packages/server/src/finance/pipeline.ts`); `CommandRejectedError`, `CommandHandler` de `../sync.js`.
- Produces:
  - `export const financeCommandHandler: CommandHandler` — despacha por `payload.kind`; los kinds de fase 1 (`finance.grant.write`/`finance.revoke.write`) siguen atendidos por su código de fase 1.
  - `export function financeNormText(value: string): string` y `export function financeNormConcept(value: string): string` (los reutilizan las tareas 4, 5 y 6).
  - Helpers internos del fichero que las tareas 3–5 reutilizan: `requireFinanceTransaction(client, householdId, transactionId): Promise<FinanceTxRow>` (lanza `finance_transaction_not_found`; `FinanceTxRow` = `{ id, account_id, category_id, status, concept, provider, amount_cents (text), transfer_group_id, dedup_hash, batch_id, op_date }`), `requireFinanceCategory(client, householdId, categoryId): Promise<{ id: string; kind: string; parent_id: string | null }>` (lanza `finance_category_not_found`), `transferCategoryId(client, householdId): Promise<string>` (lanza `finance_category_not_found`), `matchingFinanceTxIds(client, householdId, selector: { provider?: string; concept?: string; categoryId?: string }): Promise<string[]>` (lanza `finance_selector_required`).

- [ ] **Step 1: Escribe el test de integración que falla**

`packages/server/src/finance-review.integration.test.ts` (harness calcado de `food.integration.test.ts`; siembra propia con UUIDs `ab…`, colisión-segura con las fixtures `002_finance.sql`):

```ts
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandAckV1, type CommandEnvelopeV1 } from "@casa-clara/contracts";

import { financeCommandHandler } from "./commands/finance.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const HH = "10000000-0000-4000-8000-000000000001";
const ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };

const FIN = {
  account: "ab100000-0000-4000-8000-000000000001",
  catRoot: "ab200000-0000-4000-8000-000000000001",
  catSub: "ab200000-0000-4000-8000-000000000002",
  txPend1: "ab300000-0000-4000-8000-000000000001",
  txPend2: "ab300000-0000-4000-8000-000000000002",
  event: "ab400000-0000-4000-8000-000000000001",
} as const;

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${HH}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${HH}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id)
SELECT '${HH}', 'ab200000-0000-4000-8000-00000000000f', 'Transferencias IT', 'transferencia', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_categories
   WHERE household_id = '${HH}' AND kind = 'transferencia' AND parent_id IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id) VALUES
  ('${HH}', '${FIN.catRoot}', 'Casa IT Revision', 'gasto', NULL),
  ('${HH}', '${FIN.catSub}', 'Luz IT Revision', 'gasto', '${FIN.catRoot}');

INSERT INTO app.finance_accounts
  (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('${HH}', '${FIN.account}', 'Cuenta IT Revision', 'openbank', 'comun', 'familia', 'IT-REV-0001', '[]'::jsonb, '[]'::jsonb);

INSERT INTO app.finance_transactions
  (household_id, id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
   amount_cents, balance_cents, category_id, status, transfer_group_id, dedup_hash,
   recurrence, recurrence_manual, raw, currency_code) VALUES
  ('${HH}', '${FIN.txPend1}', '${FIN.account}', NULL, current_date - 20, NULL,
   'RECIBO ACME LUZ IT JULIO', 'ACME LUZ IT', 'acme luz it',
   -4200, NULL, NULL, 'pendiente', NULL, 'it-rev-0001', NULL, false, '{}'::jsonb, 'EUR'),
  ('${HH}', '${FIN.txPend2}', '${FIN.account}', NULL, current_date - 10, NULL,
   'RECIBO ACME LUZ IT AGOSTO', 'ACME LUZ IT', 'acme luz it',
   -4300, NULL, NULL, 'pendiente', NULL, 'it-rev-0002', NULL, false, '{}'::jsonb, 'EUR');

INSERT INTO app.finance_events (household_id, id, name) VALUES
  ('${HH}', '${FIN.event}', 'Evento IT Revision');

COMMIT;
`;

function envelope(payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: HH,
    schemaVersion: 1,
    aggregateType: "finance",
    aggregateId: null,
    baseRevision: null,
    occurredAt: new Date().toISOString(),
    payload,
  } as CommandEnvelopeV1;
}

describe.runIf(Boolean(adminUrl))("comandos de revisión de finanzas sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, payload: unknown): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [envelope(payload)], {
      finance: financeCommandHandler,
    });
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function txRow(id: string): Promise<{ status: string; category_id: string | null; recurrence: string | null; recurrence_manual: boolean }> {
    return withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select status, category_id, recurrence, recurrence_manual
           from app.finance_transactions where household_id = $1 and id = $2`,
        [HH, id],
      );
      return loaded.rows[0];
    });
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await adminPool.query(SEED);
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("un miembro de familia sin rol admin recibe rejected", async () => {
    const ack = await run(FAMILY, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      categoryId: FIN.catSub,
    });
    expect(ack.status).toBe("rejected");
  });

  it("actualiza la categoría de una transacción", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      categoryId: FIN.catSub,
    });
    expect(ack).toMatchObject({ status: "accepted", resourceId: FIN.txPend1 });
    expect((await txRow(FIN.txPend1)).category_id).toBe(FIN.catSub);
  });

  it("confirma con regla: crea la regla y el pipeline sugiere la gemela", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      status: "confirmada",
      createRule: { ruleType: "proveedor_exacto" },
    });
    expect(ack.status).toBe("accepted");
    const rule = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select rule_type, category_id, origin from app.finance_rules
          where household_id = $1 and pattern = 'ACME LUZ IT'`,
        [HH],
      );
      return loaded.rows[0];
    });
    expect(rule).toMatchObject({ rule_type: "proveedor_exacto", category_id: FIN.catSub, origin: "manual" });
    expect((await txRow(FIN.txPend2)).status).toBe("sugerida_regla");
  });

  it("confirma en bloque", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.bulk",
      transactionIds: [FIN.txPend2],
      status: "confirmada",
    });
    expect(ack.status).toBe("accepted");
    expect((await txRow(FIN.txPend2)).status).toBe("confirmada");
  });

  it("fija la naturaleza en bloque por proveedor y marca el override manual", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.assignConceptRecurrence",
      provider: "ACME LUZ IT",
      recurrence: "recurrente",
    });
    expect(ack.status).toBe("accepted");
    const row = await txRow(FIN.txPend1);
    expect(row.recurrence).toBe("recurrente");
    expect(row.recurrence_manual).toBe(true);
  });

  it("asigna eventos por sustitución completa", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      eventIds: [FIN.event],
    });
    expect(ack.status).toBe("accepted");
    const links = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select event_id from app.finance_transaction_events
          where household_id = $1 and transaction_id = $2`,
        [HH, FIN.txPend1],
      );
      return loaded.rows;
    });
    expect(links).toEqual([{ event_id: FIN.event }]);
  });
});
```

- [ ] **Step 2: Ejecuta y ve el fallo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-review
```

Expected: FAIL — o bien `financeCommandHandler` no exportado, o bien los ack llegan `rejected` con `invalid_payload` porque el kind no está manejado.

- [ ] **Step 3: Implementación — helpers y handlers en `commands/finance.ts`**

Comprueba primero cómo dejó la fase 1 el fichero: `grep -n "grant" packages/server/src/commands/finance.ts`. Si ya exporta un `CommandHandler` con `switch` por `kind`, añade dentro los `case` nuevos y estas funciones; si los dos kinds de fase 1 viven en funciones sueltas, crea el `financeCommandHandler` de abajo delegando en ellas para esos dos kinds. Añade (imports arriba, resto al final del fichero):

```ts
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { financeWritePayloadSchema } from "@casa-clara/contracts/schemas";
import type {
  FinanceAssignConceptRecurrencePayloadV1,
  FinanceTransactionUpdatePayloadV1,
  FinanceTransactionsBulkPayloadV1,
} from "@casa-clara/contracts";

import { runPostImportPipeline } from "../finance/pipeline.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";

/** Normalización compartida proveedor/alias (espejo de norm_text del origen). */
export function financeNormText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** El pivot manda conceptos colapsados y truncados a 80: el lado transacción se normaliza igual. */
export function financeNormConcept(value: string): string {
  return financeNormText(value).slice(0, 80);
}

interface FinanceTxRow {
  id: UUID;
  account_id: string;
  category_id: string | null;
  status: string;
  concept: string;
  provider: string | null;
  amount_cents: string;
  transfer_group_id: string | null;
  dedup_hash: string;
  batch_id: string | null;
  op_date: string;
}

async function requireFinanceTransaction(
  client: PoolClient,
  householdId: UUID,
  transactionId: UUID,
): Promise<FinanceTxRow> {
  const result = await client.query<FinanceTxRow>(
    `select id, account_id, category_id, status, concept, provider,
            amount_cents::text as amount_cents, transfer_group_id, dedup_hash, batch_id,
            op_date::text as op_date
       from app.finance_transactions
      where household_id = $1 and id = $2`,
    [householdId, transactionId],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRejectedError("finance_transaction_not_found", "El movimiento no existe en este hogar");
  return row;
}

async function requireFinanceCategory(
  client: PoolClient,
  householdId: UUID,
  categoryId: UUID,
): Promise<{ id: string; kind: string; parent_id: string | null }> {
  const result = await client.query<{ id: string; kind: string; parent_id: string | null }>(
    `select id, kind, parent_id from app.finance_categories where household_id = $1 and id = $2`,
    [householdId, categoryId],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRejectedError("finance_category_not_found", "La categoría no existe en este hogar");
  return row;
}

async function transferCategoryId(client: PoolClient, householdId: UUID): Promise<UUID> {
  const result = await client.query<{ id: string }>(
    `select id from app.finance_categories
      where household_id = $1 and kind = 'transferencia' and parent_id is null`,
    [householdId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new CommandRejectedError("finance_category_not_found", "El hogar no tiene categoría de transferencia");
  return id as UUID;
}

/**
 * Movimientos NO vinculados a transferencia que casan con el selector del
 * pivot/las páginas: por categoría (raíz incluye sus hijas) o por proveedor
 * (aceptando el alias como entrada) y, opcionalmente, concepto normalizado.
 */
async function matchingFinanceTxIds(
  client: PoolClient,
  householdId: UUID,
  selector: { provider?: string | undefined; concept?: string | undefined; categoryId?: string | undefined },
): Promise<string[]> {
  if (selector.categoryId) {
    const result = await client.query<{ id: string }>(
      `select tx.id
         from app.finance_transactions as tx
         join app.finance_categories as cat
           on cat.household_id = tx.household_id and cat.id = tx.category_id
        where tx.household_id = $1 and tx.transfer_group_id is null
          and (tx.category_id = $2 or cat.parent_id = $2)`,
      [householdId, selector.categoryId],
    );
    return result.rows.map((row) => row.id);
  }
  const providerNorm = financeNormText(selector.provider ?? "");
  if (!providerNorm) {
    throw new CommandRejectedError("finance_selector_required", "Se requiere proveedor o categoría");
  }
  const aliases = await client.query<{ provider_norm: string; display: string }>(
    `select provider_norm, display from app.finance_provider_aliases where household_id = $1`,
    [householdId],
  );
  const accepted = new Set([providerNorm]);
  for (const alias of aliases.rows) {
    if (financeNormText(alias.display) === providerNorm) accepted.add(alias.provider_norm);
  }
  const conceptNorm = selector.concept === undefined ? null : financeNormConcept(selector.concept);
  const candidates = await client.query<{ id: string; provider: string | null; concept: string }>(
    `select id, provider, concept from app.finance_transactions
      where household_id = $1 and transfer_group_id is null`,
    [householdId],
  );
  return candidates.rows
    .filter(
      (row) =>
        accepted.has(financeNormText(row.provider ?? "")) &&
        (conceptNorm === null || financeNormConcept(row.concept) === conceptNorm),
    )
    .map((row) => row.id);
}

async function replaceTransactionEvents(
  client: PoolClient,
  householdId: UUID,
  transactionId: UUID,
  eventIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(eventIds)];
  if (wanted.length > 0) {
    const found = await client.query(
      `select id from app.finance_events where household_id = $1 and id = any($2::uuid[])`,
      [householdId, wanted],
    );
    if ((found.rowCount ?? 0) !== wanted.length) {
      throw new CommandRejectedError("finance_event_not_found", "Algún evento ya no existe");
    }
  }
  await client.query(
    `delete from app.finance_transaction_events where household_id = $1 and transaction_id = $2`,
    [householdId, transactionId],
  );
  for (const eventId of wanted) {
    await client.query(
      `insert into app.finance_transaction_events (household_id, transaction_id, event_id) values ($1, $2, $3)`,
      [householdId, transactionId, eventId],
    );
  }
}

async function updateFinanceTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransactionUpdatePayloadV1,
): Promise<{ resourceId: UUID }> {
  const tx = await requireFinanceTransaction(client, householdId, payload.transactionId);
  if (payload.eventIds !== undefined) {
    await replaceTransactionEvents(client, householdId, tx.id, payload.eventIds);
  }
  if (payload.categoryId !== undefined && payload.categoryId !== null) {
    await requireFinanceCategory(client, householdId, payload.categoryId);
  }
  await client.query(
    `update app.finance_transactions
        set category_id = case when $3::boolean then $4::uuid else category_id end,
            status = coalesce($5, status),
            concept = coalesce($6, concept),
            recurrence = case when $7::boolean then $8 else recurrence end,
            recurrence_manual = case when $7::boolean then true else recurrence_manual end
      where household_id = $1 and id = $2`,
    [
      householdId,
      tx.id,
      payload.categoryId !== undefined,
      payload.categoryId ?? null,
      payload.status ?? null,
      payload.concept ?? null,
      payload.recurrence !== undefined,
      payload.recurrence ?? null,
    ],
  );
  if (payload.createRule) {
    const finalCategory = payload.categoryId !== undefined ? payload.categoryId : tx.category_id;
    if (!finalCategory) {
      throw new CommandRejectedError("invalid_payload", "No se puede crear una regla sin categoría");
    }
    const pattern = payload.createRule.ruleType === "proveedor_exacto" ? tx.provider : tx.concept;
    if (!pattern) {
      throw new CommandRejectedError("invalid_payload", "El movimiento no tiene proveedor para la regla");
    }
    await client.query(
      `insert into app.finance_rules (household_id, rule_type, pattern, category_id, priority, origin)
       values ($1, $2, $3, $4, 0, 'manual')`,
      [householdId, payload.createRule.ruleType, pattern, finalCategory],
    );
    await runPostImportPipeline(client, householdId);
  }
  return { resourceId: tx.id };
}

async function bulkUpdateFinanceTransactions(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransactionsBulkPayloadV1,
): Promise<Record<string, never>> {
  if (payload.categoryId) await requireFinanceCategory(client, householdId, payload.categoryId);
  const result = await client.query(
    `update app.finance_transactions
        set status = $3, category_id = coalesce($4::uuid, category_id)
      where household_id = $1 and id = any($2::uuid[])`,
    [householdId, payload.transactionIds, payload.status, payload.categoryId ?? null],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_transaction_not_found", "Ningún movimiento de la selección existe");
  }
  return {};
}

async function assignConceptRecurrence(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceAssignConceptRecurrencePayloadV1,
): Promise<Record<string, never>> {
  const ids = await matchingFinanceTxIds(client, householdId, payload);
  if (ids.length > 0) {
    await client.query(
      `update app.finance_transactions
          set recurrence = $3, recurrence_manual = true
        where household_id = $1 and id = any($2::uuid[])`,
      [householdId, ids, payload.recurrence],
    );
  }
  return {};
}
```

Y el dispatcher (o los `case` añadidos al existente):

```ts
/**
 * `finance`: todas las escrituras del módulo, discriminadas por `payload.kind`.
 * grant/revoke (fase 1) conservan su camino; el resto exige rol admin +
 * concesión viva vía requireFinanceAdmin dentro de la transacción autorizada.
 */
export const financeCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const rawKind = (envelope.payload as { kind?: unknown } | null)?.kind;
  if (rawKind === "finance.grant.write" || rawKind === "finance.revoke.write") {
    // [FASE 1] delega aquí en el manejo existente de concesiones, tal cual lo dejó la fase 1.
    return handleFinanceGrantCommand(client, membership, envelope);
  }
  const parsed = financeWritePayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  await requireFinanceAdmin(client, membership);
  switch (payload.kind) {
    case "finance.transaction.update":
      return updateFinanceTransaction(client, envelope.householdId, payload);
    case "finance.transactions.bulk":
      return bulkUpdateFinanceTransactions(client, envelope.householdId, payload);
    case "finance.transactions.assignConceptRecurrence":
      return assignConceptRecurrence(client, envelope.householdId, payload);
    default:
      throw new CommandRejectedError("invalid_payload", `Comando de finanzas aún no implementado: ${payload.kind}`);
  }
};
```

(`handleFinanceGrantCommand` es el nombre que tenga la lógica de fase 1 en el fichero — localízala con el grep del inicio del paso y usa su nombre real; si la fase 1 ya exportaba el dispatcher, no crees uno nuevo: añade los `case`.)

- [ ] **Step 4: Exporta y registra**

En `packages/server/src/index.ts`, si `grep -n "commands/finance" packages/server/src/index.ts` no da resultado, añade en orden alfabético:

```ts
export * from "./commands/finance.js";
```

En `apps/web/src/routes/api/v1/sync/+server.ts`, si `grep -n "finance" apps/web/src/routes/api/v1/sync/+server.ts` no da resultado: añade `financeCommandHandler` al import de `@casa-clara/server` y la entrada al mapa:

```ts
const handlers: CommandHandlers = {
  ...employmentCommandHandlers,
  ...wikiCommandHandlers,
  ...foodCommandHandlers,
  ...rhythmCommandHandlers,
  ...accessCommandHandlers,
  ...contactCommandHandlers,
  expense: submitExpenseHandler,
  finance: financeCommandHandler
};
```

- [ ] **Step 5: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-review && pnpm --filter @casa-clara/server typecheck
```

Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/commands/finance.ts packages/server/src/index.ts packages/server/src/finance-review.integration.test.ts "apps/web/src/routes/api/v1/sync/+server.ts"
git commit -m "feat(finanzas): dispatcher de comandos y escritura de revisión con acuse"
```

---

### Task 3: Servidor — manuales, inversión y transferencias

**Files:**
- Modify: `packages/server/src/commands/finance.ts`
- Test: `packages/server/src/finance-ledger.integration.test.ts`

**Interfaces:**
- Consumes (Task 2, mismo fichero): `requireFinanceTransaction`, `requireFinanceCategory`, `transferCategoryId`, `financeNormText`, el `switch` de `financeCommandHandler`; `runPostImportPipeline` (fase 2); tipos `FinanceManualCreatePayloadV1`, `FinanceManualDeletePayloadV1`, `FinanceTransactionInvestPayloadV1`, `FinanceTransfersLinkPayloadV1`, `FinanceTransfersUnlinkPayloadV1` (Task 1).
- Produces: los `case` `finance.transaction.manual.create`, `finance.transaction.manual.delete`, `finance.transaction.invest`, `finance.transfers.link`, `finance.transfers.unlink` dentro del dispatcher. Deviación deliberada respecto al origen (documentada en el propio código): el manual exige `accountId` (la UI preselecciona «Efectivo» si existe) y NO existe el lote «manual» — un movimiento manual es `batch_id IS NULL` + prefijo `manual-`.

- [ ] **Step 1: Escribe el test de integración que falla**

`packages/server/src/finance-ledger.integration.test.ts` — mismo harness y helpers `envelope`/`run`/`txRow` que la Task 3 copia de `finance-review.integration.test.ts` (cópialos: el ejecutor de esta tarea no ve aquella), con esta siembra y casos:

```ts
const FIN = {
  accountA: "ac100000-0000-4000-8000-000000000001",
  accountB: "ac100000-0000-4000-8000-000000000002",
  fund: "ac100000-0000-4000-8000-000000000003",
  catGasto: "ac200000-0000-4000-8000-000000000001",
  batch: "ac500000-0000-4000-8000-000000000001",
  txImported: "ac300000-0000-4000-8000-000000000001",
} as const;

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${HH}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${HH}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id)
SELECT '${HH}', 'ac200000-0000-4000-8000-00000000000f', 'Transferencias IT', 'transferencia', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_categories
   WHERE household_id = '${HH}' AND kind = 'transferencia' AND parent_id IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id) VALUES
  ('${HH}', '${FIN.catGasto}', 'Caja IT Ledger', 'gasto', NULL);

INSERT INTO app.finance_accounts
  (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('${HH}', '${FIN.accountA}', 'Cuenta IT Ledger A', 'caixabank', 'comun', 'familia', 'IT-LED-0001', '[]'::jsonb, '[]'::jsonb),
  ('${HH}', '${FIN.accountB}', 'Cuenta IT Ledger B', 'openbank', 'personal', 'padre', 'IT-LED-0002', '[]'::jsonb, '[]'::jsonb),
  ('${HH}', '${FIN.fund}', 'Fondo IT Ledger', 'openbank', 'inversion', 'familia', 'IT-LED-0003', '[]'::jsonb, '[]'::jsonb);

INSERT INTO app.finance_import_batches (household_id, id, filename, bank, new_count, dup_count) VALUES
  ('${HH}', '${FIN.batch}', 'ledger-it.xls', 'caixabank', 1, 0);

INSERT INTO app.finance_transactions
  (household_id, id, account_id, batch_id, op_date, concept, provider, provider_norm,
   amount_cents, category_id, status, transfer_group_id, dedup_hash, recurrence, recurrence_manual, raw, currency_code) VALUES
  ('${HH}', '${FIN.txImported}', '${FIN.accountA}', '${FIN.batch}', current_date - 5,
   'CARGO IMPORTADO IT', 'CARGO IT', 'cargo it', -9900, NULL, 'pendiente', NULL, 'it-led-0001', NULL, false, '{}'::jsonb, 'EUR');

COMMIT;
`;
```

Casos (`it(...)`, en este orden):

```ts
  it("crea un manual, con dedup manual- y estado confirmada", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.manual.create",
      accountId: FIN.accountA,
      opDate: "2026-08-10",
      concept: "Fruta del mercado IT",
      provider: "Mercado IT",
      amountCents: "-1500",
      categoryId: FIN.catGasto,
    });
    expect(ack.status).toBe("accepted");
    manualId = ack.resourceId as string;
    const row = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select status, dedup_hash, batch_id, provider_norm from app.finance_transactions where household_id = $1 and id = $2`,
        [HH, manualId],
      );
      return loaded.rows[0];
    });
    expect(row.status).toBe("confirmada");
    expect(row.batch_id).toBeNull();
    expect(row.dedup_hash.startsWith("manual-")).toBe(true);
    expect(row.provider_norm).toBe("mercado it");
  });

  it("borra un manual; un importado no se puede borrar", async () => {
    expect((await run(ADMIN, { kind: "finance.transaction.manual.delete", transactionId: manualId })).status).toBe("accepted");
    const gone = await run(ADMIN, { kind: "finance.transaction.manual.delete", transactionId: manualId });
    expect(gone).toMatchObject({ status: "rejected", errorCode: "finance_transaction_not_found" });
    const imported = await run(ADMIN, { kind: "finance.transaction.manual.delete", transactionId: FIN.txImported });
    expect(imported).toMatchObject({ status: "rejected", errorCode: "finance_not_manual" });
  });

  it("marca un cargo como inversión creando la pata espejo invmirror-", async () => {
    const ack = await run(ADMIN, { kind: "finance.transaction.invest", transactionId: FIN.txImported, accountId: FIN.fund });
    expect(ack.status).toBe("accepted");
    const legs = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select account_id, amount_cents::text as amount_cents, status, dedup_hash
           from app.finance_transactions
          where household_id = $1 and transfer_group_id = $2 order by amount_cents`,
        [HH, ack.resourceId],
      );
      return loaded.rows;
    });
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ account_id: FIN.accountA, amount_cents: "-9900", status: "confirmada" });
    expect(legs[1]).toMatchObject({ account_id: FIN.fund, amount_cents: "9900" });
    expect(legs[1].dedup_hash).toBe("invmirror-it-led-0001");
    investGroup = ack.resourceId as string;
  });

  it("desvincular un grupo con espejo borra el espejo y devuelve la pata real a pendiente", async () => {
    expect((await run(ADMIN, { kind: "finance.transfers.unlink", transferGroupId: investGroup })).status).toBe("accepted");
    const row = await txRow(FIN.txImported);
    expect(row.status).toBe("pendiente");
    expect(row.category_id).toBeNull();
  });

  it("vincula dos manuales que suman cero y rechaza una selección que no suma cero", async () => {
    const cargo = await run(ADMIN, {
      kind: "finance.transaction.manual.create", accountId: FIN.accountA, opDate: "2026-08-11",
      concept: "Traspaso IT salida", amountCents: "-5000",
    });
    const abono = await run(ADMIN, {
      kind: "finance.transaction.manual.create", accountId: FIN.accountB, opDate: "2026-08-11",
      concept: "Traspaso IT entrada", amountCents: "5000",
    });
    const bad = await run(ADMIN, {
      kind: "finance.transfers.link",
      transactionIds: [cargo.resourceId as string, FIN.txImported],
    });
    expect(bad).toMatchObject({ status: "rejected", errorCode: "finance_transfer_sum_not_zero" });
    const good = await run(ADMIN, {
      kind: "finance.transfers.link",
      transactionIds: [cargo.resourceId as string, abono.resourceId as string],
    });
    expect(good.status).toBe("accepted");
    const unlink = await run(ADMIN, { kind: "finance.transfers.unlink", transferGroupId: good.resourceId as string });
    expect(unlink.status).toBe("accepted");
  });
```

(declara `let manualId: string; let investGroup: string;` junto a los pools).

- [ ] **Step 2: Ejecuta y ve el fallo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-ledger
```

Expected: FAIL — ack `rejected` con `invalid_payload` («Comando de finanzas aún no implementado»).

- [ ] **Step 3: Implementación — funciones y `case` en `commands/finance.ts`**

```ts
async function requireFinanceAccount(
  client: PoolClient,
  householdId: UUID,
  accountId: UUID,
): Promise<{ id: string; kind: string; name: string }> {
  const result = await client.query<{ id: string; kind: string; name: string }>(
    `select id, kind, name from app.finance_accounts where household_id = $1 and id = $2`,
    [householdId, accountId],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRejectedError("finance_account_not_found", "La cuenta no existe en este hogar");
  return row;
}

async function createManualTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceManualCreatePayloadV1,
): Promise<{ resourceId: UUID }> {
  await requireFinanceAccount(client, householdId, payload.accountId);
  if (payload.categoryId) await requireFinanceCategory(client, householdId, payload.categoryId);
  const provider = (payload.provider ?? "").trim();
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_transactions
       (household_id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
        amount_cents, balance_cents, category_id, status, transfer_group_id, dedup_hash,
        recurrence, recurrence_manual, raw, currency_code)
     values ($1, $2, null, $3, null, $4, $5, $6, $7, null, $8, 'confirmada', null, $9,
             $10, $11, '{}'::jsonb, 'EUR')
     returning id`,
    [
      householdId,
      payload.accountId,
      payload.opDate,
      payload.concept,
      provider,
      provider ? financeNormText(provider) : null,
      payload.amountCents,
      payload.categoryId ?? null,
      `manual-${randomUUID().replace(/-/g, "")}`,
      payload.recurrence ?? null,
      payload.recurrence != null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("La inserción del manual no devolvió identificador");
  // Una sola verdad post-escritura: el pipeline crea la contrapartida de
  // efectivo (cashpair-) si toca y reevalúa recurrencia respetando el manual.
  await runPostImportPipeline(client, householdId);
  return { resourceId: id as UUID };
}

async function deleteManualTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceManualDeletePayloadV1,
): Promise<Record<string, never>> {
  const tx = await requireFinanceTransaction(client, householdId, payload.transactionId);
  if (tx.dedup_hash.startsWith("cashpair-")) {
    throw new CommandRejectedError("finance_cashpair_leg", "Es una contrapartida de efectivo: borra su gasto");
  }
  if (tx.batch_id !== null || !tx.dedup_hash.startsWith("manual-")) {
    throw new CommandRejectedError("finance_not_manual", "Solo se pueden borrar movimientos manuales");
  }
  const counter = await client.query<{ id: string }>(
    `select id from app.finance_transactions where household_id = $1 and dedup_hash = $2`,
    [householdId, `cashpair-${tx.dedup_hash}`],
  );
  const ids = [tx.id, ...counter.rows.map((row) => row.id)];
  await client.query(
    `delete from app.finance_transaction_events where household_id = $1 and transaction_id = any($2::uuid[])`,
    [householdId, ids],
  );
  await client.query(`delete from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`, [
    householdId,
    ids,
  ]);
  return {};
}

async function investTransaction(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransactionInvestPayloadV1,
): Promise<{ resourceId: UUID }> {
  const tx = await requireFinanceTransaction(client, householdId, payload.transactionId);
  const account = await requireFinanceAccount(client, householdId, payload.accountId);
  if (account.kind !== "inversion") {
    throw new CommandRejectedError("finance_not_investment_account", "La cuenta destino no es de inversión");
  }
  if (tx.transfer_group_id) {
    throw new CommandRejectedError("finance_already_linked", "El movimiento ya está vinculado a un grupo");
  }
  if (BigInt(tx.amount_cents) >= 0n) {
    throw new CommandRejectedError("finance_invest_needs_charge", "Solo un cargo puede marcarse como inversión");
  }
  const mirrorHash = `invmirror-${tx.dedup_hash}`;
  const existing = await client.query(
    `select 1 from app.finance_transactions where household_id = $1 and dedup_hash = $2`,
    [householdId, mirrorHash],
  );
  if ((existing.rowCount ?? 0) > 0) {
    throw new CommandRejectedError("finance_mirror_exists", "Ya existía un espejo para este movimiento");
  }
  const groupId = randomUUID() as UUID;
  const categoryId = await transferCategoryId(client, householdId);
  await client.query(
    `insert into app.finance_transactions
       (household_id, account_id, batch_id, op_date, concept, provider, provider_norm,
        amount_cents, category_id, status, transfer_group_id, dedup_hash,
        recurrence, recurrence_manual, raw, currency_code)
     values ($1, $2, null, $3, $4, $5, $6, $7, $8, 'confirmada', $9, $10, null, false, '{}'::jsonb, 'EUR')`,
    [
      householdId,
      payload.accountId,
      tx.op_date,
      tx.concept,
      tx.provider,
      tx.provider ? financeNormText(tx.provider) : null,
      (-BigInt(tx.amount_cents)).toString(),
      categoryId,
      groupId,
      mirrorHash,
    ],
  );
  await client.query(
    `update app.finance_transactions
        set transfer_group_id = $3, category_id = $4, status = 'confirmada'
      where household_id = $1 and id = $2`,
    [householdId, tx.id, groupId, categoryId],
  );
  return { resourceId: groupId };
}

async function linkTransfers(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransfersLinkPayloadV1,
): Promise<{ resourceId: UUID }> {
  const ids = [...new Set(payload.transactionIds)];
  const loaded = await client.query<{ id: string; amount_cents: string; transfer_group_id: string | null }>(
    `select id, amount_cents::text as amount_cents, transfer_group_id
       from app.finance_transactions
      where household_id = $1 and id = any($2::uuid[])`,
    [householdId, ids],
  );
  if ((loaded.rowCount ?? 0) !== ids.length) {
    throw new CommandRejectedError("finance_transaction_not_found", "Algún movimiento no existe");
  }
  if (loaded.rows.some((row) => row.transfer_group_id !== null)) {
    throw new CommandRejectedError("finance_already_linked", "Algún movimiento ya pertenece a un grupo");
  }
  const sum = loaded.rows.reduce((total, row) => total + BigInt(row.amount_cents), 0n);
  if (sum !== 0n) {
    throw new CommandRejectedError("finance_transfer_sum_not_zero", "La selección no suma cero");
  }
  const groupId = randomUUID() as UUID;
  const categoryId = await transferCategoryId(client, householdId);
  await client.query(
    `update app.finance_transactions
        set transfer_group_id = $3, category_id = $4, status = 'confirmada'
      where household_id = $1 and id = any($2::uuid[])`,
    [householdId, ids, groupId, categoryId],
  );
  return { resourceId: groupId };
}

async function unlinkTransfers(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceTransfersUnlinkPayloadV1,
): Promise<Record<string, never>> {
  const legs = await client.query<{ id: string; dedup_hash: string }>(
    `select id, dedup_hash from app.finance_transactions
      where household_id = $1 and transfer_group_id = $2`,
    [householdId, payload.transferGroupId],
  );
  if ((legs.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_transfer_group_not_found", "Esa transferencia ya no existe");
  }
  // Grupos con pata espejo (efectivo/inversión): se borra el espejo y las patas
  // reales vuelven a pendiente. Grupos normales: se desagrupan.
  const mirrors = legs.rows.filter((row) => /^(mirror|invmirror)-/.test(row.dedup_hash)).map((row) => row.id);
  const real = legs.rows.filter((row) => !/^(mirror|invmirror)-/.test(row.dedup_hash)).map((row) => row.id);
  if (mirrors.length > 0) {
    await client.query(
      `delete from app.finance_transaction_events where household_id = $1 and transaction_id = any($2::uuid[])`,
      [householdId, mirrors],
    );
    await client.query(`delete from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`, [
      householdId,
      mirrors,
    ]);
  }
  if (real.length > 0) {
    await client.query(
      `update app.finance_transactions
          set transfer_group_id = null, category_id = null, status = 'pendiente'
        where household_id = $1 and id = any($2::uuid[])`,
      [householdId, real],
    );
  }
  return {};
}
```

Y en el `switch` del dispatcher, antes del `default`:

```ts
    case "finance.transaction.manual.create":
      return createManualTransaction(client, envelope.householdId, payload);
    case "finance.transaction.manual.delete":
      return deleteManualTransaction(client, envelope.householdId, payload);
    case "finance.transaction.invest":
      return investTransaction(client, envelope.householdId, payload);
    case "finance.transfers.link":
      return linkTransfers(client, envelope.householdId, payload);
    case "finance.transfers.unlink":
      return unlinkTransfers(client, envelope.householdId, payload);
```

(añade los imports de tipos de estos payloads al import de `@casa-clara/contracts`).

- [ ] **Step 4: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-ledger && pnpm --filter @casa-clara/server typecheck
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/commands/finance.ts packages/server/src/finance-ledger.integration.test.ts
git commit -m "feat(finanzas): manuales, inversión y vinculación de transferencias"
```

---

### Task 4: Servidor — eventos y alias de proveedores

**Files:**
- Modify: `packages/server/src/commands/finance.ts`
- Test: `packages/server/src/finance-events.integration.test.ts`

**Interfaces:**
- Consumes (Task 2, mismo fichero): `matchingFinanceTxIds`, `requireFinanceCategory`, `financeNormText`, `financeNormConcept`, el `switch` del dispatcher; tipos `FinanceEvent*PayloadV1`, `FinanceAliasUpdatePayloadV1` (Task 1). Esquema canónico: `finance_events (name UNIQUE por hogar)`, `finance_transaction_events (transaction_id, event_id, UNIQUE por par)`, `finance_event_rules (provider_norm, concept_norm, category_id, event_id)`, `finance_provider_aliases (provider_norm UNIQUE por hogar, display)`.
- Produces: los `case` `finance.event.create|update|delete|assignTransactions|assignConcept` y `finance.alias.update`.

- [ ] **Step 1: Escribe el test de integración que falla**

`packages/server/src/finance-events.integration.test.ts` — mismo harness (constantes `HH`, `ADMIN_MEMBERSHIP`, `envelope`, `run`, pools; cópialas de nuevo), siembra con UUIDs `ad…`: la concesión (mismo `INSERT … WHERE NOT EXISTS`), una cuenta `'Cuenta IT Eventos'` (`bank_ref 'IT-EVT-0001'`), una categoría gasto `'Viajes IT Eventos'` (`ad200000-…01`) y dos transacciones `pendiente` con `provider 'VIAJES SOL IT'` / `provider_norm 'viajes sol it'`, `dedup 'it-evt-0001'/'it-evt-0002'`, importes `-10000`/`-20000`, `category_id` = la categoría, fechas `current_date - 15` y `current_date - 5` (ids `ad300000-…01/02`). Casos:

```ts
  it("crea, renombra y rechaza nombres duplicados (case-insensitive)", async () => {
    const created = await run(ADMIN, { kind: "finance.event.create", name: "Semana Santa IT" });
    expect(created.status).toBe("accepted");
    eventId = created.resourceId as string;
    const dup = await run(ADMIN, { kind: "finance.event.create", name: "semana santa it" });
    expect(dup).toMatchObject({ status: "rejected", errorCode: "finance_event_name_taken" });
    const renamed = await run(ADMIN, { kind: "finance.event.update", eventId, name: "Semana Santa IT 2026" });
    expect(renamed.status).toBe("accepted");
  });

  it("asigna y quita transacciones en bloque", async () => {
    const add = await run(ADMIN, {
      kind: "finance.event.assignTransactions", eventId, transactionIds: [TX1, TX2], action: "add",
    });
    expect(add.status).toBe("accepted");
    expect(await linkCount(eventId)).toBe(2);
    const remove = await run(ADMIN, {
      kind: "finance.event.assignTransactions", eventId, transactionIds: [TX2], action: "remove",
    });
    expect(remove.status).toBe("accepted");
    expect(await linkCount(eventId)).toBe(1);
  });

  it("assignConcept por proveedor crea la regla y asigna en exclusiva", async () => {
    const other = await run(ADMIN, { kind: "finance.event.create", name: "Otro IT" });
    const ack = await run(ADMIN, {
      kind: "finance.event.assignConcept", provider: "VIAJES SOL IT", eventId: other.resourceId,
    });
    expect(ack.status).toBe("accepted");
    // exclusivo: TX1 estaba en eventId y ahora SOLO está en el otro
    expect(await linkCount(eventId)).toBe(0);
    expect(await linkCount(other.resourceId as string)).toBe(2);
    const rule = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select event_id from app.finance_event_rules where household_id = $1 and provider_norm = 'viajes sol it'`,
        [HH],
      );
      return loaded.rows[0];
    });
    expect(rule).toMatchObject({ event_id: other.resourceId });
    otherId = other.resourceId as string;
  });

  it("assignConcept sin evento borra la regla y los vínculos", async () => {
    const ack = await run(ADMIN, { kind: "finance.event.assignConcept", provider: "VIAJES SOL IT", eventId: null });
    expect(ack.status).toBe("accepted");
    expect(await linkCount(otherId)).toBe(0);
  });

  it("alias: upsert y borrado con alias vacío", async () => {
    expect((await run(ADMIN, { kind: "finance.alias.update", provider: "VIAJES SOL IT", alias: "Sol Viajes" })).status).toBe("accepted");
    const display = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select display from app.finance_provider_aliases where household_id = $1 and provider_norm = 'viajes sol it'`, [HH]);
      return loaded.rows[0]?.display;
    });
    expect(display).toBe("Sol Viajes");
    expect((await run(ADMIN, { kind: "finance.alias.update", provider: "VIAJES SOL IT", alias: "" })).status).toBe("accepted");
  });

  it("borrar un evento desvincula sin borrar movimientos", async () => {
    await run(ADMIN, { kind: "finance.event.assignTransactions", eventId, transactionIds: [TX1], action: "add" });
    const ack = await run(ADMIN, { kind: "finance.event.delete", eventId });
    expect(ack.status).toBe("accepted");
    const tx = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select 1 from app.finance_transactions where household_id = $1 and id = $2`, [HH, TX1]);
      return loaded.rowCount;
    });
    expect(tx).toBe(1);
  });
```

con el helper:

```ts
  async function linkCount(id: string): Promise<number> {
    return withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select count(*)::int as n from app.finance_transaction_events where household_id = $1 and event_id = $2`,
        [HH, id],
      );
      return loaded.rows[0].n as number;
    });
  }
```

- [ ] **Step 2: Rojo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-events
```

Expected: FAIL — ack `rejected`/`invalid_payload` en los kinds de eventos.

- [ ] **Step 3: Implementación**

Añade a `commands/finance.ts`:

```ts
async function cleanEventName(
  client: PoolClient,
  householdId: UUID,
  name: string,
  excludeId: UUID | null,
): Promise<string> {
  const trimmed = name.trim();
  const clash = await client.query(
    `select 1 from app.finance_events
      where household_id = $1 and lower(name) = lower($2) and ($3::uuid is null or id <> $3)`,
    [householdId, trimmed, excludeId],
  );
  if ((clash.rowCount ?? 0) > 0) {
    throw new CommandRejectedError("finance_event_name_taken", `Ya existe un evento llamado «${trimmed}»`);
  }
  return trimmed;
}

async function requireFinanceEvent(client: PoolClient, householdId: UUID, eventId: UUID): Promise<UUID> {
  const result = await client.query(`select id from app.finance_events where household_id = $1 and id = $2`, [
    householdId,
    eventId,
  ]);
  if ((result.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_event_not_found", "El evento no existe en este hogar");
  }
  return eventId;
}

async function createFinanceEvent(client: PoolClient, householdId: UUID, name: string): Promise<{ resourceId: UUID }> {
  const clean = await cleanEventName(client, householdId, name, null);
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_events (household_id, name) values ($1, $2) returning id`,
    [householdId, clean],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("La inserción del evento no devolvió identificador");
  return { resourceId: id as UUID };
}

async function deleteFinanceEvent(client: PoolClient, householdId: UUID, eventId: UUID): Promise<Record<string, never>> {
  await requireFinanceEvent(client, householdId, eventId);
  // Desvincula, no borra movimientos; las reglas de evento que lo apuntaban caen con él.
  await client.query(`delete from app.finance_transaction_events where household_id = $1 and event_id = $2`, [householdId, eventId]);
  await client.query(`delete from app.finance_event_rules where household_id = $1 and event_id = $2`, [householdId, eventId]);
  await client.query(`delete from app.finance_events where household_id = $1 and id = $2`, [householdId, eventId]);
  return {};
}

async function assignEventTransactions(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceEventAssignTransactionsPayloadV1,
): Promise<Record<string, never>> {
  await requireFinanceEvent(client, householdId, payload.eventId);
  if (payload.action === "remove") {
    await client.query(
      `delete from app.finance_transaction_events
        where household_id = $1 and event_id = $2 and transaction_id = any($3::uuid[])`,
      [householdId, payload.eventId, payload.transactionIds],
    );
    return {};
  }
  const existing = await client.query<{ id: string }>(
    `select id from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`,
    [householdId, payload.transactionIds],
  );
  for (const row of existing.rows) {
    await client.query(
      `insert into app.finance_transaction_events (household_id, transaction_id, event_id)
       values ($1, $2, $3) on conflict do nothing`,
      [householdId, row.id, payload.eventId],
    );
  }
  return {};
}

async function resolveTargetEventId(
  client: PoolClient,
  householdId: UUID,
  eventId: UUID | null | undefined,
  newEventName: string | undefined,
): Promise<UUID | null> {
  if (newEventName !== undefined) {
    const name = newEventName.trim();
    const existing = await client.query<{ id: string }>(
      `select id from app.finance_events where household_id = $1 and lower(name) = lower($2)`,
      [householdId, name],
    );
    if (existing.rows[0]) return existing.rows[0].id as UUID;
    return (await createFinanceEvent(client, householdId, name)).resourceId;
  }
  if (eventId != null) return requireFinanceEvent(client, householdId, eventId);
  return null;
}

async function assignConceptToEvent(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceEventAssignConceptPayloadV1,
): Promise<{ resourceId?: UUID }> {
  const targetEventId = await resolveTargetEventId(client, householdId, payload.eventId, payload.newEventName);
  const txIds = await matchingFinanceTxIds(client, householdId, payload);
  const providerNorm = payload.provider ? financeNormText(payload.provider) : null;
  const conceptNorm = payload.concept === undefined ? null : financeNormConcept(payload.concept);

  if (targetEventId === null) {
    // Caso de borrado: cae la regla y caen TODOS los vínculos de los movimientos que casan.
    if (payload.categoryId) {
      await client.query(`delete from app.finance_event_rules where household_id = $1 and category_id = $2`, [
        householdId,
        payload.categoryId,
      ]);
    } else {
      await client.query(
        `delete from app.finance_event_rules
          where household_id = $1 and provider_norm = $2 and concept_norm is not distinct from $3`,
        [householdId, providerNorm, conceptNorm],
      );
    }
    if (txIds.length > 0) {
      await client.query(
        `delete from app.finance_transaction_events where household_id = $1 and transaction_id = any($2::uuid[])`,
        [householdId, txIds],
      );
    }
    return {};
  }

  if (payload.categoryId) {
    await requireFinanceCategory(client, householdId, payload.categoryId);
    await client.query(`delete from app.finance_event_rules where household_id = $1 and category_id = $2`, [
      householdId,
      payload.categoryId,
    ]);
    await client.query(
      `insert into app.finance_event_rules (household_id, category_id, event_id) values ($1, $2, $3)`,
      [householdId, payload.categoryId, targetEventId],
    );
  } else {
    await client.query(
      `delete from app.finance_event_rules
        where household_id = $1 and provider_norm = $2 and concept_norm is not distinct from $3`,
      [householdId, providerNorm, conceptNorm],
    );
    await client.query(
      `insert into app.finance_event_rules (household_id, provider_norm, concept_norm, event_id)
       values ($1, $2, $3, $4)`,
      [householdId, providerNorm, conceptNorm, targetEventId],
    );
  }
  if (txIds.length > 0) {
    // Mover a un evento es EXCLUSIVO: el pivot agrupa por el primer evento asignado.
    await client.query(
      `delete from app.finance_transaction_events
        where household_id = $1 and transaction_id = any($2::uuid[]) and event_id <> $3`,
      [householdId, txIds, targetEventId],
    );
    for (const txId of txIds) {
      await client.query(
        `insert into app.finance_transaction_events (household_id, transaction_id, event_id)
         values ($1, $2, $3) on conflict do nothing`,
        [householdId, txId, targetEventId],
      );
    }
  }
  return { resourceId: targetEventId };
}

async function updateProviderAlias(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceAliasUpdatePayloadV1,
): Promise<Record<string, never>> {
  const providerNorm = financeNormText(payload.provider);
  if (!providerNorm) throw new CommandRejectedError("invalid_payload", "El proveedor no puede estar vacío");
  const display = payload.alias.trim();
  if (!display) {
    await client.query(`delete from app.finance_provider_aliases where household_id = $1 and provider_norm = $2`, [
      householdId,
      providerNorm,
    ]);
    return {};
  }
  await client.query(
    `insert into app.finance_provider_aliases (household_id, provider_norm, display)
     values ($1, $2, $3)
     on conflict (household_id, provider_norm) do update set display = excluded.display`,
    [householdId, providerNorm, display],
  );
  return {};
}
```

`case` nuevos en el dispatcher:

```ts
    case "finance.event.create":
      return createFinanceEvent(client, envelope.householdId, payload.name);
    case "finance.event.update": {
      await requireFinanceEvent(client, envelope.householdId, payload.eventId);
      const clean = await cleanEventName(client, envelope.householdId, payload.name, payload.eventId);
      await client.query(`update app.finance_events set name = $3 where household_id = $1 and id = $2`, [
        envelope.householdId,
        payload.eventId,
        clean,
      ]);
      return { resourceId: payload.eventId };
    }
    case "finance.event.delete":
      return deleteFinanceEvent(client, envelope.householdId, payload.eventId);
    case "finance.event.assignTransactions":
      return assignEventTransactions(client, envelope.householdId, payload);
    case "finance.event.assignConcept":
      return assignConceptToEvent(client, envelope.householdId, payload);
    case "finance.alias.update":
      return updateProviderAlias(client, envelope.householdId, payload);
```

(añade los imports de tipos correspondientes). Nota: si la migración 0034 no llamó `event_id` a la columna de `finance_event_rules`, ajusta el nombre al de `packages/db/migrations/0034_finance.sql` (compruébalo con `grep -n "finance_event_rules" -A 12 packages/db/migrations/0034_finance.sql`).

- [ ] **Step 4: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-events && pnpm --filter @casa-clara/server typecheck
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/commands/finance.ts packages/server/src/finance-events.integration.test.ts
git commit -m "feat(finanzas): eventos, reglas de evento y alias de proveedores"
```

---

### Task 5: Servidor — ajustes del módulo (cuentas, categorías, reglas) e `import.undo`

**Files:**
- Modify: `packages/server/src/commands/finance.ts`
- Test: `packages/server/src/finance-settings.integration.test.ts`

**Interfaces:**
- Consumes (mismo fichero): `requireFinanceAccount` (Task 3), `requireFinanceCategory`, `matchingFinanceTxIds` (Task 2); tipos `FinanceAccountUpdatePayloadV1`, `FinanceCategory*PayloadV1`, `FinanceRule*PayloadV1`, `FinanceImportUndoPayloadV1` (Task 1).
- Produces: los `case` `finance.account.update`, `finance.category.create|update|delete|assignConcept`, `finance.rule.create|delete`, `finance.import.undo`. Códigos nuevos: `finance_category_in_use`, `finance_category_is_transfer`, `finance_rule_not_found`, `finance_batch_not_found`.

- [ ] **Step 1: Escribe el test de integración que falla**

`packages/server/src/finance-settings.integration.test.ts` — mismo harness, siembra `ae…`: concesión, garantía de categoría `transferencia` (patrón `WHERE NOT EXISTS`), cuenta `'Cuenta IT Ajustes'` (`ae100000-…01`, `bank_ref 'IT-AJU-0001'`), categoría raíz gasto `'Hogar IT Ajustes'` (`ae200000-…01`), un lote `'ajustes-it.xls'` (`ae500000-…01`, bank `'openbank'`, new_count 2) con dos transacciones suyas (`ae300000-…01/02`, dedup `'it-aju-0001/2'`, provider `'TIENDA NORTE IT'`/`provider_norm 'tienda norte it'`, pendientes, sin categoría). Casos:

```ts
  it("actualiza una cuenta entera (nombre, tipo, titular, aliases, refs)", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.account.update", accountId: ACCOUNT, name: "Cuenta IT Renombrada",
      accountKind: "inversion", ownerLabel: "madre", ownerAliases: ["M. Demo IT"], transferRefs: ["REF-IT-1"],
    });
    expect(ack.status).toBe("accepted");
    const row = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select name, kind, owner_label, owner_aliases, transfer_refs
           from app.finance_accounts where household_id = $1 and id = $2`, [HH, ACCOUNT]);
      return loaded.rows[0];
    });
    expect(row).toMatchObject({ name: "Cuenta IT Renombrada", kind: "inversion", owner_label: "madre" });
    expect(row.owner_aliases).toEqual(["M. Demo IT"]);
    expect(row.transfer_refs).toEqual(["REF-IT-1"]);
  });

  it("crea una subcategoría heredando el kind del padre y la borra si está libre", async () => {
    const created = await run(ADMIN, {
      kind: "finance.category.create", name: "Menaje IT", categoryKind: "ingreso", parentId: CAT_ROOT,
    });
    expect(created.status).toBe("accepted");
    const kind = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select kind from app.finance_categories where household_id = $1 and id = $2`, [HH, created.resourceId]);
      return loaded.rows[0]?.kind;
    });
    expect(kind).toBe("gasto"); // hereda del padre aunque el payload dijera ingreso
    expect((await run(ADMIN, { kind: "finance.category.update", categoryId: created.resourceId, name: "Menaje IT 2" })).status).toBe("accepted");
    expect((await run(ADMIN, { kind: "finance.category.delete", categoryId: created.resourceId })).status).toBe("accepted");
  });

  it("no deja borrar una categoría en uso", async () => {
    await run(ADMIN, { kind: "finance.transaction.update", transactionId: TX1, categoryId: CAT_ROOT });
    const ack = await run(ADMIN, { kind: "finance.category.delete", categoryId: CAT_ROOT });
    expect(ack).toMatchObject({ status: "rejected", errorCode: "finance_category_in_use" });
  });

  it("category.assignConcept recategoriza en bloque, confirma y crea la regla", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.category.assignConcept", provider: "TIENDA NORTE IT", categoryId: CAT_ROOT,
    });
    expect(ack.status).toBe("accepted");
    const rows = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select category_id, status from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`,
        [HH, [TX1, TX2]]);
      return loaded.rows;
    });
    for (const row of rows) expect(row).toMatchObject({ category_id: CAT_ROOT, status: "confirmada" });
  });

  it("crea y borra reglas sueltas", async () => {
    const created = await run(ADMIN, {
      kind: "finance.rule.create", ruleType: "concepto_contiene", pattern: "PARKING IT", categoryId: CAT_ROOT,
    });
    expect(created.status).toBe("accepted");
    expect((await run(ADMIN, { kind: "finance.rule.delete", ruleId: created.resourceId })).status).toBe("accepted");
    expect((await run(ADMIN, { kind: "finance.rule.delete", ruleId: created.resourceId }))).toMatchObject({
      status: "rejected", errorCode: "finance_rule_not_found",
    });
  });

  it("import.undo borra el lote y sus transacciones en cascada", async () => {
    const ack = await run(ADMIN, { kind: "finance.import.undo", batchId: BATCH });
    expect(ack.status).toBe("accepted");
    const left = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select count(*)::int as n from app.finance_transactions where household_id = $1 and batch_id = $2`, [HH, BATCH]);
      return loaded.rows[0].n;
    });
    expect(left).toBe(0);
    expect((await run(ADMIN, { kind: "finance.import.undo", batchId: BATCH }))).toMatchObject({
      status: "rejected", errorCode: "finance_batch_not_found",
    });
  });
```

- [ ] **Step 2: Rojo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-settings
```

Expected: FAIL — `invalid_payload` («aún no implementado») en los kinds de ajustes.

- [ ] **Step 3: Implementación**

```ts
async function updateFinanceAccount(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceAccountUpdatePayloadV1,
): Promise<{ resourceId: UUID }> {
  await requireFinanceAccount(client, householdId, payload.accountId);
  await client.query(
    `update app.finance_accounts
        set name = $3, kind = $4, owner_label = $5,
            owner_aliases = $6::jsonb, transfer_refs = $7::jsonb
      where household_id = $1 and id = $2`,
    [
      householdId,
      payload.accountId,
      payload.name,
      payload.accountKind,
      payload.ownerLabel,
      JSON.stringify(payload.ownerAliases),
      JSON.stringify(payload.transferRefs),
    ],
  );
  return { resourceId: payload.accountId };
}

async function createFinanceCategory(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceCategoryCreatePayloadV1,
): Promise<{ resourceId: UUID }> {
  let kind: string = payload.categoryKind;
  if (payload.parentId) {
    const parent = await requireFinanceCategory(client, householdId, payload.parentId);
    if (parent.parent_id !== null) {
      throw new CommandRejectedError("invalid_payload", "El árbol de categorías es de dos niveles");
    }
    if (parent.kind === "transferencia") {
      throw new CommandRejectedError("finance_category_is_transfer", "La categoría de transferencias no tiene hijas");
    }
    kind = parent.kind; // la subcategoría hereda la naturaleza del padre
  }
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_categories (household_id, name, kind, parent_id)
     values ($1, $2, $3, $4) returning id`,
    [householdId, payload.name, kind, payload.parentId],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("La inserción de la categoría no devolvió identificador");
  return { resourceId: id as UUID };
}

async function deleteFinanceCategory(
  client: PoolClient,
  householdId: UUID,
  categoryId: UUID,
): Promise<Record<string, never>> {
  const category = await requireFinanceCategory(client, householdId, categoryId);
  if (category.kind === "transferencia") {
    throw new CommandRejectedError("finance_category_is_transfer", "La categoría de transferencias no se borra");
  }
  const usage = await client.query<{ txs: number; children: number; rules: number; event_rules: number }>(
    `select
       (select count(*)::int from app.finance_transactions where household_id = $1 and category_id = $2) as txs,
       (select count(*)::int from app.finance_categories where household_id = $1 and parent_id = $2) as children,
       (select count(*)::int from app.finance_rules where household_id = $1 and category_id = $2) as rules,
       (select count(*)::int from app.finance_event_rules where household_id = $1 and category_id = $2) as event_rules`,
    [householdId, categoryId],
  );
  const counts = usage.rows[0];
  if (counts && (counts.txs > 0 || counts.children > 0 || counts.rules > 0 || counts.event_rules > 0)) {
    throw new CommandRejectedError(
      "finance_category_in_use",
      `Categoría en uso: ${counts.txs} movimientos, ${counts.children} subcategorías, ${counts.rules} reglas, ${counts.event_rules} eventos`,
    );
  }
  await client.query(`delete from app.finance_categories where household_id = $1 and id = $2`, [householdId, categoryId]);
  return {};
}

async function assignConceptToCategory(
  client: PoolClient,
  householdId: UUID,
  payload: FinanceCategoryAssignConceptPayloadV1,
): Promise<{ resourceId: UUID }> {
  const target = await requireFinanceCategory(client, householdId, payload.categoryId);
  if (target.kind === "transferencia") {
    throw new CommandRejectedError("finance_category_is_transfer", "No se puede recategorizar a transferencia");
  }
  const ids = await matchingFinanceTxIds(client, householdId, payload);
  if (ids.length > 0) {
    // Los movimientos ya categorizados como transferencia no se tocan.
    await client.query(
      `update app.finance_transactions as tx
          set category_id = $3, status = 'confirmada'
        where tx.household_id = $1 and tx.id = any($2::uuid[])
          and not exists (
            select 1 from app.finance_categories as cat
             where cat.household_id = tx.household_id and cat.id = tx.category_id
               and cat.kind = 'transferencia')`,
      [householdId, ids, payload.categoryId],
    );
  }
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_rules (household_id, rule_type, pattern, category_id, priority, origin)
     values ($1, $2, $3, $4, 0, 'manual') returning id`,
    [
      householdId,
      payload.concept === undefined ? "proveedor_exacto" : "concepto_contiene",
      payload.concept === undefined ? payload.provider : payload.concept,
      payload.categoryId,
    ],
  );
  return { resourceId: inserted.rows[0]?.id as UUID };
}

async function undoImport(client: PoolClient, householdId: UUID, batchId: UUID): Promise<Record<string, never>> {
  const batch = await client.query(`select id from app.finance_import_batches where household_id = $1 and id = $2`, [
    householdId,
    batchId,
  ]);
  if ((batch.rowCount ?? 0) === 0) {
    throw new CommandRejectedError("finance_batch_not_found", "Esa importación ya no existe");
  }
  await client.query(
    `delete from app.finance_transaction_events
      where household_id = $1 and transaction_id in (
        select id from app.finance_transactions where household_id = $1 and batch_id = $2)`,
    [householdId, batchId],
  );
  // ON DELETE CASCADE del esquema: borrar el lote borra sus transacciones.
  await client.query(`delete from app.finance_import_batches where household_id = $1 and id = $2`, [householdId, batchId]);
  return {};
}
```

`case` nuevos:

```ts
    case "finance.account.update":
      return updateFinanceAccount(client, envelope.householdId, payload);
    case "finance.category.create":
      return createFinanceCategory(client, envelope.householdId, payload);
    case "finance.category.update": {
      await requireFinanceCategory(client, envelope.householdId, payload.categoryId);
      await client.query(`update app.finance_categories set name = $3 where household_id = $1 and id = $2`, [
        envelope.householdId,
        payload.categoryId,
        payload.name,
      ]);
      return { resourceId: payload.categoryId };
    }
    case "finance.category.delete":
      return deleteFinanceCategory(client, envelope.householdId, payload.categoryId);
    case "finance.category.assignConcept":
      return assignConceptToCategory(client, envelope.householdId, payload);
    case "finance.rule.create": {
      const target = await requireFinanceCategory(client, envelope.householdId, payload.categoryId);
      if (target.kind === "transferencia") {
        throw new CommandRejectedError("finance_category_is_transfer", "Las reglas no apuntan a transferencia");
      }
      const inserted = await client.query<{ id: string }>(
        `insert into app.finance_rules (household_id, rule_type, pattern, category_id, priority, origin)
         values ($1, $2, $3, $4, $5, 'manual') returning id`,
        [envelope.householdId, payload.ruleType, payload.pattern, payload.categoryId, payload.priority ?? 0],
      );
      return { resourceId: inserted.rows[0]?.id as UUID };
    }
    case "finance.rule.delete": {
      const deleted = await client.query(`delete from app.finance_rules where household_id = $1 and id = $2`, [
        envelope.householdId,
        payload.ruleId,
      ]);
      if ((deleted.rowCount ?? 0) === 0) {
        throw new CommandRejectedError("finance_rule_not_found", "La regla ya no existe");
      }
      return {};
    }
    case "finance.import.undo":
      return undoImport(client, envelope.householdId, payload.batchId);
```

Tras esto el `default` del switch queda inalcanzable para kinds válidos: déjalo como red de seguridad.

- [ ] **Step 4: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/server test finance-settings && pnpm --filter @casa-clara/server typecheck && pnpm --filter @casa-clara/server test finance
```

Expected: PASS — la última orden ejecuta las cuatro suites `finance-*` juntas y todas quedan verdes.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/commands/finance.ts packages/server/src/finance-settings.integration.test.ts
git commit -m "feat(finanzas): comandos de ajustes del módulo y deshacer importación"
```

---

### Task 6: Importación multipart — `imports/preview` y `imports/confirm` + ciclo íntegro contra Postgres

**Files:**
- Create: `apps/web/src/lib/server/finance-imports.server.ts`
- Create: `apps/web/src/routes/api/v1/finance/imports/preview/+server.ts`
- Create: `apps/web/src/routes/api/v1/finance/imports/confirm/+server.ts`
- Test: `apps/web/tests/finance-imports.integration.test.ts`

**Interfaces:**
- Consumes: `parseStatement(bytes: Uint8Array, filename: string): ParsedStatement` y `FinanceParserError` (fase 2, exportados de `@casa-clara/server`; si `grep -n "finance/parsers" packages/server/src/index.ts` no muestra el export, añade `export * from "./finance/parsers/index.js";` y `export * from "./finance/dedup-hash.js";` y `export * from "./finance/pipeline.js";`); `computeDedupHash(row): string` (fase 2); `runPostImportPipeline` (fase 2); `requireFinanceAdmin`, `financeNormText`, `withAuthorizedTransaction`, `AuthorizationError`, `CommandRejectedError` de `@casa-clara/server`; tipos `ParsedStatement`/`ParsedRow`/`FinanceBank` de `@casa-clara/domain` (doc de interfaces).
- Produces (los consume la Task 12):
  - `previewImport(user: { id: string }, householdId: string, bytes: Uint8Array, filename: string, pool?: Pool | null): Promise<ImportPreviewResult>` con `ImportPreviewResult = { bank: FinanceBank; newCount: number; dupCount: number; unknownRefs: string[]; sample: Array<{ opDate: string; concept: string; provider: string | null; amountCents: string }> }`.
  - `confirmImport(user: { id: string }, householdId: string, bytes: Uint8Array, filename: string, newAccounts: NewAccountInput[], pool?: Pool | null): Promise<ImportConfirmResult>` con `NewAccountInput = { bankRef: string; name: string; kind: "comun" | "personal" | "inversion"; ownerLabel: string }` e `ImportConfirmResult = { batchId: string | null; newCount: number; dupCount: number }`.
  - `POST /api/v1/finance/imports/preview?household=<uuid>` (multipart `file`) → `{ apiVersion: 1, ...ImportPreviewResult }`; `POST /api/v1/finance/imports/confirm?household=<uuid>` (multipart `file` + campo `payload` JSON `{ newAccounts: NewAccountInput[] }`) → `{ apiVersion: 1, ...ImportConfirmResult }`. Errores: 401 sin sesión, 403 origen/membresía/concesión, 422 parser o cuentas sin cubrir, 503 sin pool.

- [ ] **Step 1: Escribe el test de integración que falla**

`apps/web/tests/finance-imports.integration.test.ts` (patrón de base de datos PROPIA calcado de `apps/web/tests/contacts.integration.test.ts` — cópiale el `beforeAll` de creación de base `casaclara_finance_it`, migraciones + fixtures + rol `it_casa_clara_finance_login`):

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { API_VERSION, type CommandEnvelopeV1 } from '@casa-clara/contracts';
import { financeCommandHandler, processSyncBatch, withAuthorizedTransaction } from '@casa-clara/server';

import { confirmImport, previewImport } from '../src/lib/server/finance-imports.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgres://prueba/afirmada' } }));

const APP_LOGIN = 'it_casa_clara_finance_login';
const FINANCE_DB = 'casaclara_finance_it';
const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const ADMIN = { id: 'fixture:roble:admin' };

// Extracto SINTÉTICO de OpenBank: HTML disfrazado de .xls, importes es-ES.
const OPENBANK_HTML = `<html>
<head><title>OPENBANK - Cuentas - Movimientos</title></head>
<body><table>
<tr><td>N\u00famero de cuenta:</td><td>ES21 0073 0100 5500 1234 5678</td></tr>
<tr><td>Fecha Operaci\u00f3n</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>05/07/2026</td><td>05/07/2026</td><td>TRANSFERENCIA A FAVOR DE CLARA DEMO, CONCEPTO ALQUILER JULIO</td><td>-850,00</td><td>1.150,00</td></tr>
<tr><td>03/07/2026</td><td>03/07/2026</td><td>LIQUIDACION CUENTA INTERESES</td><td>1,23</td><td>2.000,00</td></tr>
</table></body></html>`;
const BYTES = new Uint8Array(Buffer.from(OPENBANK_HTML, 'latin1'));
const REF = 'ES2100730100550012345678';

const GRANT_SEED = `
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${FIXTURE_HOUSEHOLD}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${FIXTURE_HOUSEHOLD}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);
COMMIT;
`;

describe.runIf(Boolean(adminUrl))('ciclo importar → confirmar → deshacer sobre Postgres real', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    // [copia aquí el beforeAll de contacts.integration.test.ts sustituyendo
    //  CONTACTS_DB→FINANCE_DB, APP_LOGIN y CONTACTS_SEED→GRANT_SEED]
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it('previsualiza: banco detectado, 2 nuevas, cuenta desconocida', async () => {
    const preview = await previewImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', appPool);
    expect(preview.bank).toBe('openbank');
    expect(preview.newCount).toBe(2);
    expect(preview.dupCount).toBe(0);
    expect(preview.unknownRefs).toEqual([REF]);
    expect(preview.sample[0]?.amountCents).toBe('-85000');
  });

  it('confirma: crea la cuenta, el lote y las transacciones, y ejecuta el pipeline', async () => {
    const confirmed = await confirmImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', [
      { bankRef: REF, name: 'OpenBank IT', kind: 'comun', ownerLabel: 'familia' },
    ], appPool);
    expect(confirmed.newCount).toBe(2);
    expect(confirmed.batchId).not.toBeNull();
    const state = await withAuthorizedTransaction(appPool, { userId: ADMIN.id }, FIXTURE_HOUSEHOLD, async (client) => {
      const txs = await client.query(
        `select count(*)::int as n from app.finance_transactions where household_id = $1 and batch_id = $2`,
        [FIXTURE_HOUSEHOLD, confirmed.batchId],
      );
      return txs.rows[0].n as number;
    });
    expect(state).toBe(2);
    batchId = confirmed.batchId as string;
  });

  it('re-confirmar el mismo fichero es determinista: todo duplicado, sin lote nuevo', async () => {
    const again = await confirmImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', [], appPool);
    expect(again).toMatchObject({ batchId: null, newCount: 0, dupCount: 2 });
  });

  it('deshacer por comando con acuse deja la base como estaba', async () => {
    const envelope: CommandEnvelopeV1 = {
      apiVersion: API_VERSION, operationId: crypto.randomUUID(), householdId: FIXTURE_HOUSEHOLD,
      schemaVersion: 1, aggregateType: 'finance', aggregateId: null, baseRevision: null,
      occurredAt: new Date().toISOString(),
      payload: { kind: 'finance.import.undo', batchId },
    } as CommandEnvelopeV1;
    const result = await processSyncBatch(appPool, { userId: ADMIN.id }, [envelope], { finance: financeCommandHandler });
    expect(result.acknowledgements[0]).toMatchObject({ status: 'accepted' });
    const after = await previewImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', appPool);
    expect(after.newCount).toBe(2); // vuelven a ser nuevas
  });
});
```

(declara `let batchId: string;` arriba).

- [ ] **Step 2: Rojo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/web test finance-imports
```

Expected: FAIL — `finance-imports.server` no existe.

- [ ] **Step 3: Implementación — `finance-imports.server.ts`**

```ts
import type { Pool } from 'pg';

import type { FinanceBank, ParsedRow } from '@casa-clara/domain';
import {
  computeDedupHash,
  financeNormText,
  parseStatement,
  requireFinanceAdmin,
  runPostImportPipeline,
  withAuthorizedTransaction
} from '@casa-clara/server';

import { getDatabasePool } from './db.server';

export interface ImportPreviewResult {
  bank: FinanceBank;
  newCount: number;
  dupCount: number;
  unknownRefs: string[];
  sample: Array<{ opDate: string; concept: string; provider: string | null; amountCents: string }>;
}

export interface NewAccountInput {
  bankRef: string;
  name: string;
  kind: 'comun' | 'personal' | 'inversion';
  ownerLabel: string;
}

export interface ImportConfirmResult {
  batchId: string | null;
  newCount: number;
  dupCount: number;
}

export class ImportUncoveredAccountsError extends Error {
  override readonly name = 'ImportUncoveredAccountsError';
  constructor(readonly refs: string[]) {
    super(`Cuentas sin dar de alta: ${refs.join(', ')}`);
  }
}

function hashOf(row: ParsedRow): string {
  return computeDedupHash({
    bankRef: row.bankRef,
    opDate: row.opDate,
    amountCents: row.amountCents,
    concept: row.concept,
    balanceCents: row.balanceCents,
    dedupRef: row.dedupRef
  });
}

/**
 * Previsualización sin estado: el fichero se parsea en memoria y solo se
 * consulta qué hashes ya existen y qué refs de cuenta faltan. Nada se persiste.
 */
export async function previewImport(
  user: { id: string },
  householdId: string,
  bytes: Uint8Array,
  filename: string,
  pool: Pool | null = getDatabasePool()
): Promise<ImportPreviewResult> {
  if (!pool) throw new Error('La importación requiere la base de datos del hogar');
  const statement = parseStatement(bytes, filename);
  const hashes = statement.rows.map(hashOf);
  return withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
    await requireFinanceAdmin(client, membership);
    const existing = await client.query<{ dedup_hash: string }>(
      `select dedup_hash from app.finance_transactions
        where household_id = $1 and dedup_hash = any($2::text[])`,
      [householdId, hashes]
    );
    const known = new Set(existing.rows.map((row) => row.dedup_hash));
    const accounts = await client.query<{ bank_ref: string }>(
      `select bank_ref from app.finance_accounts where household_id = $1`,
      [householdId]
    );
    const knownRefs = new Set(accounts.rows.map((row) => row.bank_ref));
    const dupCount = hashes.filter((hash) => known.has(hash)).length;
    return {
      bank: statement.bank,
      newCount: hashes.length - dupCount,
      dupCount,
      unknownRefs: statement.accountRefs.filter((ref) => !knownRefs.has(ref)),
      sample: statement.rows.slice(0, 20).map((row) => ({
        opDate: row.opDate,
        concept: row.concept.slice(0, 120),
        provider: row.provider,
        amountCents: row.amountCents.toString()
      }))
    };
  });
}

/**
 * Confirmación sin estado (Vercel es efímero): el cliente reenvía el fichero y
 * el resultado es determinista por dedup_hash. Crea las cuentas nuevas del
 * payload, el lote y las transacciones, y ejecuta el pipeline unificado.
 * El extracto NO se persiste en ningún almacenamiento.
 */
export async function confirmImport(
  user: { id: string },
  householdId: string,
  bytes: Uint8Array,
  filename: string,
  newAccounts: NewAccountInput[],
  pool: Pool | null = getDatabasePool()
): Promise<ImportConfirmResult> {
  if (!pool) throw new Error('La importación requiere la base de datos del hogar');
  const statement = parseStatement(bytes, filename);
  return withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
    await requireFinanceAdmin(client, membership);
    for (const account of newAccounts) {
      await client.query(
        `insert into app.finance_accounts
           (household_id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs)
         values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, '[]'::jsonb)`,
        [householdId, account.name, statement.bank, account.kind, account.ownerLabel, account.bankRef]
      );
    }
    const accounts = await client.query<{ id: string; bank_ref: string }>(
      `select id, bank_ref from app.finance_accounts where household_id = $1`,
      [householdId]
    );
    const accountByRef = new Map(accounts.rows.map((row) => [row.bank_ref, row.id]));
    const uncovered = statement.accountRefs.filter((ref) => !accountByRef.has(ref));
    if (uncovered.length > 0) throw new ImportUncoveredAccountsError(uncovered);

    const hashes = statement.rows.map(hashOf);
    const existing = await client.query<{ dedup_hash: string }>(
      `select dedup_hash from app.finance_transactions
        where household_id = $1 and dedup_hash = any($2::text[])`,
      [householdId, hashes]
    );
    const known = new Set(existing.rows.map((row) => row.dedup_hash));
    const fresh = statement.rows.filter((_, index) => !known.has(hashes[index]!));
    const dupCount = statement.rows.length - fresh.length;
    if (fresh.length === 0) return { batchId: null, newCount: 0, dupCount };

    const batch = await client.query<{ id: string }>(
      `insert into app.finance_import_batches (household_id, filename, bank, new_count, dup_count)
       values ($1, $2, $3, $4, $5) returning id`,
      [householdId, filename, statement.bank, fresh.length, dupCount]
    );
    const batchId = batch.rows[0]?.id;
    if (!batchId) throw new Error('La inserción del lote no devolvió identificador');

    for (const row of fresh) {
      await client.query(
        `insert into app.finance_transactions
           (household_id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
            amount_cents, balance_cents, code_common, code_own, category_id, status, transfer_group_id,
            dedup_hash, recurrence, recurrence_manual, raw, currency_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, null, 'pendiente', null,
                 $13, null, false, $14::jsonb, 'EUR')`,
        [
          householdId,
          accountByRef.get(row.accountRef),
          batchId,
          row.opDate,
          row.valueDate,
          row.concept,
          row.provider,
          row.provider ? financeNormText(row.provider) : null,
          row.amountCents.toString(),
          row.balanceCents === null ? null : row.balanceCents.toString(),
          row.codeCommon,
          row.codeOwn,
          hashOf(row),
          JSON.stringify(row.raw)
        ]
      );
    }
    await runPostImportPipeline(client, householdId);
    return { batchId, newCount: fresh.length, dupCount };
  });
}
```

- [ ] **Step 4: Implementación — endpoints**

`apps/web/src/routes/api/v1/finance/imports/preview/+server.ts`:

```ts
import { error, json } from '@sveltejs/kit';

import { AuthorizationError, CommandRejectedError, FinanceParserError } from '@casa-clara/server';

import { previewImport } from '$lib/server/finance-imports.server';
import { getDatabasePool } from '$lib/server/db.server';
import type { RequestHandler } from './$types';

/** El guard del hook no cubre /api: sesión + membresía + concesión, explícitos. */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para importar');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) error(403, 'Origen no permitido');
  const householdId = url.searchParams.get('household');
  if (!householdId) error(422, 'Falta el hogar');
  const pool = getDatabasePool();
  if (!pool) error(503, 'La importación requiere la base de datos del hogar');

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    error(400, 'No se pudo leer el fichero');
  }
  if (!(file instanceof File)) error(422, 'No llegó ningún fichero');
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const preview = await previewImport(locals.user, householdId, bytes, file.name, pool);
    return json({ apiVersion: 1, ...preview }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof FinanceParserError) error(422, cause.message);
    if (cause instanceof AuthorizationError) error(403, 'No perteneces a este hogar');
    if (cause instanceof CommandRejectedError) error(403, 'Finanzas no está activado para tu cuenta');
    throw cause;
  }
};
```

`apps/web/src/routes/api/v1/finance/imports/confirm/+server.ts` — igual que el anterior con este cuerpo tras leer el form:

```ts
  const form = await request.formData().catch(() => null);
  if (!form) error(400, 'No se pudo leer el fichero');
  const file = form.get('file');
  if (!(file instanceof File)) error(422, 'No llegó ningún fichero');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const rawPayload = form.get('payload');
  const parsed = confirmPayloadSchema.safeParse(
    typeof rawPayload === 'string' && rawPayload ? JSON.parse(rawPayload) : { newAccounts: [] }
  );
  if (!parsed.success) error(422, 'Cuentas nuevas inválidas');

  try {
    const result = await confirmImport(locals.user, householdId, bytes, file.name, parsed.data.newAccounts, pool);
    return json({ apiVersion: 1, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof FinanceParserError) error(422, cause.message);
    if (cause instanceof ImportUncoveredAccountsError) error(422, cause.message);
    if (cause instanceof AuthorizationError) error(403, 'No perteneces a este hogar');
    if (cause instanceof CommandRejectedError) error(403, 'Finanzas no está activado para tu cuenta');
    throw cause;
  }
```

con el esquema local (zod ya es dependencia de web vía contracts; impórtalo de `zod`):

```ts
const confirmPayloadSchema = z.object({
  newAccounts: z
    .array(
      z.object({
        bankRef: z.string().trim().min(1).max(64),
        name: z.string().trim().min(1).max(120),
        kind: z.enum(['comun', 'personal', 'inversion']),
        ownerLabel: z.string().trim().min(1).max(80)
      })
    )
    .max(10)
});
```

- [ ] **Step 5: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm --filter @casa-clara/web test finance-imports && pnpm --filter @casa-clara/web check
```

Expected: PASS (4 tests) y `svelte-check` sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/finance-imports.server.ts "apps/web/src/routes/api/v1/finance/imports" apps/web/tests/finance-imports.integration.test.ts
git commit -m "feat(finanzas): importación multipart sin estado con ciclo probado contra Postgres"
```

---

### Task 7: Cliente — `financeCommand`, validaciones puras y diccionario de errores

**Files:**
- Create: `apps/web/src/lib/finance/commands.ts`
- Create: `apps/web/src/lib/finance/link-transfers.ts`
- Create: `apps/web/src/lib/finance/manual-form.ts`
- Modify: `apps/web/src/lib/offline/error-codes.ts`
- Test: `apps/web/tests/finance-commands.test.ts`

**Interfaces:**
- Consumes: `createCommandEnvelope` de `$lib/offline/schema` (firma: `{ householdId, aggregateType, payload, operationId?, aggregateId?, baseRevision?, occurredAt? } → CommandEnvelopeV1`); `parseEuroInput(value: string): string | null` de `$lib/employment/commands`; tipos `FinanceWritePayloadV1`, `CommandEnvelopeV1` (Task 1); esquemas de Task 1 (solo en el test — zod jamás en el bundle del navegador).
- Produces (los consumen las tareas 8–13):
  - `financeCommand<TPayload extends FinanceWritePayloadV1>(householdId: string, payload: TPayload, options?: { operationId?: string; occurredAt?: string }): CommandEnvelopeV1<TPayload>`
  - `canLinkSelection(rows: ReadonlyArray<{ id: string; amountCents: string; transferGroupId: string | null }>, selected: ReadonlySet<string>): { enabled: boolean; reason: string | null }`
  - `manualAmountCents(raw: string, kind: 'gasto' | 'ingreso'): string | null`

- [ ] **Step 1: Escribe el test que falla**

`apps/web/tests/finance-commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { commandEnvelopeSchema, financeWritePayloadSchema } from '@casa-clara/contracts/schemas';

import { financeCommand } from '../src/lib/finance/commands';
import { canLinkSelection } from '../src/lib/finance/link-transfers';
import { manualAmountCents } from '../src/lib/finance/manual-form';

const HH = '10000000-0000-4000-8000-000000000001';
const TX1 = 'ab300000-0000-4000-8000-000000000001';
const TX2 = 'ab300000-0000-4000-8000-000000000002';
const OPTIONS = { operationId: '99999999-0000-4000-8000-000000000031', occurredAt: '2026-08-07T10:00:00.000Z' };

describe('constructor de envelopes de finanzas', () => {
  it('produce envelopes válidos contra el contrato, con el kind congelado', () => {
    const envelope = financeCommand(HH, { kind: 'finance.transaction.update', transactionId: TX1, status: 'confirmada' }, OPTIONS);
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('finance');
    expect(financeWritePayloadSchema.parse(envelope.payload)).toMatchObject({ kind: 'finance.transaction.update' });
  });
});

describe('canLinkSelection (réplica cliente de finance.transfers.link)', () => {
  const rows = [
    { id: TX1, amountCents: '-5000', transferGroupId: null },
    { id: TX2, amountCents: '5000', transferGroupId: null }
  ];
  it('exige 2+, sin grupo previo y suma cero en bigint', () => {
    expect(canLinkSelection(rows, new Set([TX1]))).toMatchObject({ enabled: false });
    expect(canLinkSelection(rows, new Set([TX1, TX2]))).toEqual({ enabled: true, reason: null });
    expect(
      canLinkSelection([{ ...rows[0]!, transferGroupId: 'g' }, rows[1]!], new Set([TX1, TX2])).reason
    ).toBe('algún movimiento ya pertenece a un grupo');
    expect(
      canLinkSelection([rows[0]!, { ...rows[1]!, amountCents: '4999' }], new Set([TX1, TX2])).reason
    ).toBe('la selección no suma cero');
  });
});

describe('manualAmountCents', () => {
  it('firma el importe según el tipo y rechaza basura', () => {
    expect(manualAmountCents('12,50', 'gasto')).toBe('-1250');
    expect(manualAmountCents('12,50', 'ingreso')).toBe('1250');
    expect(manualAmountCents('0', 'gasto')).toBeNull();
    expect(manualAmountCents('abc', 'gasto')).toBeNull();
  });
});
```

- [ ] **Step 2: Rojo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test finance-commands
```

Expected: FAIL — módulos `$lib/finance/commands` etc. inexistentes.

- [ ] **Step 3: Implementación**

`apps/web/src/lib/finance/commands.ts`:

```ts
import type { CommandEnvelopeV1, FinanceWritePayloadV1 } from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';

export interface FinanceEnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

/**
 * Constructor ÚNICO de envelopes de Finanzas: el payload discriminado por
 * `kind` viaja congelado; la validación zod vive en los tests y en el
 * servidor, nunca en el bundle del navegador.
 */
export function financeCommand<TPayload extends FinanceWritePayloadV1>(
  householdId: string,
  payload: TPayload,
  options: FinanceEnvelopeOptions = {}
): CommandEnvelopeV1<TPayload> {
  return createCommandEnvelope({
    householdId,
    aggregateType: 'finance',
    payload,
    ...options
  }) as CommandEnvelopeV1<TPayload>;
}
```

`apps/web/src/lib/finance/link-transfers.ts`:

```ts
export interface LinkCheck {
  enabled: boolean;
  reason: string | null;
}

/**
 * Réplica cliente de las validaciones de `finance.transfers.link`, para
 * deshabilitar el botón con el motivo exacto en vez de esperar al rechazo.
 */
export function canLinkSelection(
  rows: ReadonlyArray<{ id: string; amountCents: string; transferGroupId: string | null }>,
  selected: ReadonlySet<string>
): LinkCheck {
  const chosen = rows.filter((row) => selected.has(row.id));
  if (chosen.length < 2) return { enabled: false, reason: 'se necesitan al menos 2 movimientos' };
  if (chosen.some((row) => row.transferGroupId !== null)) {
    return { enabled: false, reason: 'algún movimiento ya pertenece a un grupo' };
  }
  if (chosen.reduce((sum, row) => sum + BigInt(row.amountCents), 0n) !== 0n) {
    return { enabled: false, reason: 'la selección no suma cero' };
  }
  return { enabled: true, reason: null };
}
```

`apps/web/src/lib/finance/manual-form.ts`:

```ts
import { parseEuroInput } from '$lib/employment/commands';

/** Importe firmado en céntimos para el manual: gasto negativo, ingreso positivo. */
export function manualAmountCents(raw: string, kind: 'gasto' | 'ingreso'): string | null {
  const cents = parseEuroInput(raw);
  if (!cents) return null;
  return kind === 'gasto' ? `-${cents}` : cents;
}
```

En `apps/web/src/lib/offline/error-codes.ts`, añade un bloque al diccionario (tras el de menú/compra):

```ts
  // Finanzas
  finance_not_enabled: 'Finanzas no está activado para tu cuenta',
  finance_account_not_found: 'La cuenta ya no existe',
  finance_category_not_found: 'La categoría ya no existe',
  finance_category_in_use: 'La categoría sigue en uso: vacíala antes de borrarla',
  finance_category_is_transfer: 'La categoría de transferencias no admite esa operación',
  finance_rule_not_found: 'La regla ya no existe',
  finance_transaction_not_found: 'El movimiento ya no existe',
  finance_not_manual: 'Solo se pueden borrar movimientos manuales',
  finance_cashpair_leg: 'Es una contrapartida de efectivo: borra su gasto original',
  finance_event_not_found: 'El evento ya no existe',
  finance_event_name_taken: 'Ya existe un evento con ese nombre',
  finance_batch_not_found: 'Esa importación ya no existe',
  finance_transfer_sum_not_zero: 'La selección no suma cero',
  finance_already_linked: 'Algún movimiento ya pertenece a una transferencia',
  finance_transfer_group_not_found: 'Esa transferencia ya no existe',
  finance_not_investment_account: 'La cuenta destino no es de inversión',
  finance_invest_needs_charge: 'Solo un cargo puede marcarse como inversión',
  finance_mirror_exists: 'Ese movimiento ya tiene su espejo de inversión',
  finance_selector_required: 'Se necesita un proveedor o una categoría',
```

(si la fase 1 ya añadió `finance_not_enabled` u otro código, no lo dupliques).

- [ ] **Step 4: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test finance-commands && pnpm --filter @casa-clara/web test error-codes
```

Expected: PASS ambos (el segundo confirma que el diccionario sigue bien formado).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/finance/commands.ts apps/web/src/lib/finance/link-transfers.ts apps/web/src/lib/finance/manual-form.ts apps/web/src/lib/offline/error-codes.ts apps/web/tests/finance-commands.test.ts
git commit -m "feat(finanzas): constructor de envelopes, validaciones puras y causas traducidas"
```

---### Task 8: Componentes de edición — `CategorySelect`, `EventPicker`, `RecurrenceChip`, `ManualForm`

**Files:**
- Create: `apps/web/src/lib/finance/category-options.ts`
- Create: `apps/web/src/lib/components/finance/CategorySelect.svelte`
- Create: `apps/web/src/lib/components/finance/EventPicker.svelte`
- Create: `apps/web/src/lib/components/finance/RecurrenceChip.svelte`
- Create: `apps/web/src/lib/components/finance/ManualForm.svelte`
- Test: `apps/web/tests/finance-category-options.test.ts`

**Interfaces:**
- Consumes: `manualAmountCents` (Task 7).
- Produces (props exactas; las consumen las tareas 9–13):
  - `categoryOptionGroups(categories: readonly { id: string; name: string; parentId: string | null; kind: string }[]): Array<{ parentId: string; label: string; options: Array<{ id: string; label: string }> }>` — excluye `transferencia`; raíz sin hijas → una opción con su nombre; con hijas → `«Padre / (general)»` + `«Padre / Hija»`.
  - `CategorySelect.svelte` props: `{ categories: readonly FinanceCategoryOptionSource[]; value: string | null; onchange: (categoryId: string) => void; label?: string }` (el `select` lleva `aria-label` con `label`, por defecto `'Categoría'`).
  - `EventPicker.svelte` props: `{ events: ReadonlyArray<{ id: string; name: string }>; selectedIds: readonly string[]; ontoggle: (eventId: string, add: boolean) => void; oncreate: (name: string) => void }`.
  - `RecurrenceChip.svelte` props: `{ value: 'recurrente' | 'extraordinario' | null; onchange: (next: 'recurrente' | 'extraordinario' | null) => void }` (`aria-label="Tipo de gasto"`).
  - `ManualForm.svelte` props: `{ accounts: ReadonlyArray<{ id: string; name: string; kind: string }>; categories: readonly FinanceCategoryOptionSource[]; onsubmit: (input: { accountId: string; opDate: string; concept: string; provider: string; amountCents: string; categoryId: string | null; recurrence: 'recurrente' | 'extraordinario' | null }) => void; oncancel: () => void }` — filtra cuentas `inversion`, preselecciona la llamada «Efectivo» si existe.

- [ ] **Step 1: Test que falla** — `apps/web/tests/finance-category-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { categoryOptionGroups } from '../src/lib/finance/category-options';

describe('categoryOptionGroups', () => {
  const cats = [
    { id: 'r1', name: 'Casa', parentId: null, kind: 'gasto' },
    { id: 'r1a', name: 'Luz', parentId: 'r1', kind: 'gasto' },
    { id: 'r2', name: 'Nómina', parentId: null, kind: 'ingreso' },
    { id: 'rt', name: 'Transferencias', parentId: null, kind: 'transferencia' }
  ];
  it('agrupa dos niveles, con (general) y sin transferencia', () => {
    const groups = categoryOptionGroups(cats);
    expect(groups.map((group) => group.label)).toEqual(['Casa', 'Nómina']);
    expect(groups[0]!.options).toEqual([
      { id: 'r1', label: 'Casa / (general)' },
      { id: 'r1a', label: 'Casa / Luz' }
    ]);
    expect(groups[1]!.options).toEqual([{ id: 'r2', label: 'Nómina' }]);
  });
});
```

- [ ] **Step 2: Rojo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test finance-category-options
```

Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementación — `category-options.ts`**

```ts
export interface FinanceCategoryOptionSource {
  id: string;
  name: string;
  parentId: string | null;
  kind: string;
}

export interface CategoryOptionGroup {
  parentId: string;
  label: string;
  options: Array<{ id: string; label: string }>;
}

/** Réplica del CategorySelect del origen: dos niveles, «(general)» para la raíz con hijas. */
export function categoryOptionGroups(categories: readonly FinanceCategoryOptionSource[]): CategoryOptionGroup[] {
  const roots = categories.filter((category) => category.parentId === null && category.kind !== 'transferencia');
  return roots.map((root) => {
    const children = categories.filter((category) => category.parentId === root.id);
    return {
      parentId: root.id,
      label: root.name,
      options:
        children.length === 0
          ? [{ id: root.id, label: root.name }]
          : [
              { id: root.id, label: `${root.name} / (general)` },
              ...children.map((child) => ({ id: child.id, label: `${root.name} / ${child.name}` }))
            ]
    };
  });
}
```

- [ ] **Step 4: Verde del unit y componentes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test finance-category-options
```

Expected: PASS. Ahora crea los cuatro componentes (Svelte 5 con runas, patrón de props de `PageHeader.svelte`):

`CategorySelect.svelte`:

```svelte
<script lang="ts">
  import { categoryOptionGroups, type FinanceCategoryOptionSource } from '$lib/finance/category-options';

  let {
    categories,
    value,
    onchange,
    label = 'Categoría'
  }: {
    categories: readonly FinanceCategoryOptionSource[];
    value: string | null;
    onchange: (categoryId: string) => void;
    label?: string;
  } = $props();

  const groups = $derived(categoryOptionGroups(categories));
</script>

<select
  aria-label={label}
  value={value ?? ''}
  onchange={(event) => {
    const next = event.currentTarget.value;
    if (next) onchange(next);
  }}
>
  <option value="" disabled>— categoría —</option>
  {#each groups as group (group.parentId)}
    {#if group.options.length === 1}
      <option value={group.options[0]!.id}>{group.options[0]!.label}</option>
    {:else}
      <optgroup label={group.label}>
        {#each group.options as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </optgroup>
    {/if}
  {/each}
</select>
```

`RecurrenceChip.svelte`:

```svelte
<script lang="ts">
  let {
    value,
    onchange
  }: {
    value: 'recurrente' | 'extraordinario' | null;
    onchange: (next: 'recurrente' | 'extraordinario' | null) => void;
  } = $props();
</script>

<select
  aria-label="Tipo de gasto"
  value={value ?? ''}
  onchange={(event) => {
    const next = event.currentTarget.value;
    onchange(next === '' ? null : (next as 'recurrente' | 'extraordinario'));
  }}
>
  <option value="">—</option>
  <option value="recurrente">♻ Recurrente</option>
  <option value="extraordinario">✦ Extraordinario</option>
</select>
```

`EventPicker.svelte`:

```svelte
<script lang="ts">
  let {
    events,
    selectedIds,
    ontoggle,
    oncreate
  }: {
    events: ReadonlyArray<{ id: string; name: string }>;
    selectedIds: readonly string[];
    ontoggle: (eventId: string, add: boolean) => void;
    oncreate: (name: string) => void;
  } = $props();

  let open = $state(false);
  let newName = $state('');

  const names = $derived(
    events.filter((entry) => selectedIds.includes(entry.id)).map((entry) => entry.name).join(', ')
  );
</script>

<span class="event-picker">
  <button
    type="button"
    class="button secondary small-button"
    aria-expanded={open}
    title={names || 'Asignar a eventos'}
    onclick={() => (open = !open)}
  >◈{selectedIds.length ? ` ${selectedIds.length}` : ''}</button>
  {#if open}
    <div class="event-picker-panel" role="dialog" aria-label="Eventos del movimiento">
      {#each events as entry (entry.id)}
        <label class="check-row">
          <input
            type="checkbox"
            checked={selectedIds.includes(entry.id)}
            onchange={(event) => ontoggle(entry.id, event.currentTarget.checked)}
          />
          {entry.name}
        </label>
      {/each}
      {#if events.length === 0}<p>Sin eventos aún</p>{/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          const name = newName.trim();
          if (name) {
            oncreate(name);
            newName = '';
          }
        }}
      >
        <input aria-label="Nuevo evento" placeholder="Nuevo evento…" bind:value={newName} />
        <button class="button secondary small-button" type="submit">+</button>
      </form>
      <button class="button secondary small-button" type="button" onclick={() => (open = false)}>Cerrar</button>
    </div>
  {/if}
</span>

<style>
  .event-picker {
    position: relative;
    display: inline-block;
  }
  .event-picker-panel {
    position: absolute;
    z-index: 30;
    top: 110%;
    right: 0;
    min-width: 14rem;
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--canvas);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
  }
</style>
```

`ManualForm.svelte`:

```svelte
<script lang="ts">
  import CategorySelect from './CategorySelect.svelte';
  import { manualAmountCents } from '$lib/finance/manual-form';
  import type { FinanceCategoryOptionSource } from '$lib/finance/category-options';

  let {
    accounts,
    categories,
    onsubmit,
    oncancel
  }: {
    accounts: ReadonlyArray<{ id: string; name: string; kind: string }>;
    categories: readonly FinanceCategoryOptionSource[];
    onsubmit: (input: {
      accountId: string;
      opDate: string;
      concept: string;
      provider: string;
      amountCents: string;
      categoryId: string | null;
      recurrence: 'recurrente' | 'extraordinario' | null;
    }) => void;
    oncancel: () => void;
  } = $props();

  const selectable = $derived(accounts.filter((account) => account.kind !== 'inversion'));

  let movementKind = $state<'gasto' | 'ingreso'>('gasto');
  let amount = $state('');
  let opDate = $state(new Date().toISOString().slice(0, 10));
  let concept = $state('');
  let provider = $state('');
  // svelte-ignore state_referenced_locally -- solo es el valor inicial del campo
  let accountId = $state(
    accounts.find((account) => account.name.toLowerCase() === 'efectivo')?.id ?? accounts[0]?.id ?? ''
  );
  let categoryId = $state<string | null>(null);
  let recurrence = $state<'recurrente' | 'extraordinario' | null>(null);
  let formError = $state<string | null>(null);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const amountCents = manualAmountCents(amount, movementKind);
    if (!amountCents) {
      formError = 'Importe inválido: escribe un número mayor que cero, p. ej. 12,50';
      return;
    }
    if (concept.trim().length < 3 || !accountId) {
      formError = 'Faltan datos: concepto (mínimo 3 letras) y cuenta';
      return;
    }
    formError = null;
    onsubmit({
      accountId,
      opDate,
      concept: concept.trim(),
      provider: provider.trim(),
      amountCents,
      categoryId,
      recurrence
    });
  }
</script>

<form class="action-form" onsubmit={submit}>
  <fieldset>
    <legend>Añadir movimiento manual</legend>
    <label>Tipo
      <select bind:value={movementKind}>
        <option value="gasto">Gasto</option>
        <option value="ingreso">Ingreso</option>
      </select>
    </label>
    <label>Importe (€)<input inputmode="decimal" placeholder="0,00" bind:value={amount} /></label>
    <label>Fecha<input type="date" bind:value={opDate} /></label>
    <label>Concepto<input bind:value={concept} placeholder="Descripción…" /></label>
    <label>Proveedor<input bind:value={provider} placeholder="Beneficiario (opcional)" /></label>
    <label>Cuenta
      <select bind:value={accountId}>
        {#each selectable as account (account.id)}<option value={account.id}>{account.name}</option>{/each}
      </select>
    </label>
    <label>Categoría
      <CategorySelect {categories} value={categoryId} onchange={(id) => (categoryId = id)} />
    </label>
    <label>Recurrencia
      <select
        value={recurrence ?? ''}
        onchange={(event) => {
          const next = event.currentTarget.value;
          recurrence = next === '' ? null : (next as 'recurrente' | 'extraordinario');
        }}
      >
        <option value="">— sin clasificar —</option>
        <option value="recurrente">♻ Recurrente</option>
        <option value="extraordinario">✦ Extraordinario</option>
      </select>
    </label>
    {#if formError}<p class="form-error" role="alert">{formError}</p>{/if}
    <div>
      <button class="button primary" type="submit">Guardar</button>
      <button class="button secondary" type="button" onclick={oncancel}>Cancelar</button>
    </div>
  </fieldset>
</form>
```

- [ ] **Step 5: Comprobación estática y lint de tokens**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && node apps/web/scripts/lint-css-tokens.mjs
```

Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/finance/category-options.ts apps/web/src/lib/components/finance/CategorySelect.svelte apps/web/src/lib/components/finance/EventPicker.svelte apps/web/src/lib/components/finance/RecurrenceChip.svelte apps/web/src/lib/components/finance/ManualForm.svelte apps/web/tests/finance-category-options.test.ts
git commit -m "feat(finanzas): componentes de edición reutilizables del módulo"
```

---

### Task 9: Movimientos — edición inline, manuales y transferencias

**Files:**
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/movimientos/+page.server.ts` (creado en fase 4)
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/movimientos/+page.svelte` (creado en fase 4)

**Interfaces:**
- Consumes: `financeCommand`, `canLinkSelection` (Task 7); `CategorySelect`/`EventPicker`/`RecurrenceChip`/`ManualForm` (Task 8, props exactas de esa tarea); `OptimisticActions` (`new OptimisticActions({ householdId, invalidateToken: 'cc:finance' })`, métodos `run(envelope, hooks)`, `status`, `start()`); `ActionStatus.svelte` (`{ status: Writable<ActionFeedback | null> }`); kinds `finance.transaction.update`, `finance.transaction.manual.create`, `finance.transaction.manual.delete`, `finance.transfers.link`, `finance.transfers.unlink`, `finance.event.create`, `finance.event.assignTransactions` (Task 1).
- Produces: la página de Movimientos con escritura completa. No introduce nombres nuevos para otras tareas.

- [ ] **Step 1: Amplía el load de fase 4**

Abre `movimientos/+page.server.ts` y comprueba que su `load` ya llama `depends('cc:finance')` (añádelo si falta) y que cada fila devuelta incluye TODOS estos campos (añade al `select` los que falten, con estos alias exactos): `id`, `opDate` (`op_date::text`), `accountName`, `accountId`, `concept`, `provider`, `providerNorm` (`provider_norm`), `providerDisplay` (join a `finance_provider_aliases`), `amountCents` (`amount_cents::text`), `categoryId`, `status`, `recurrence`, `transferGroupId` (`transfer_group_id`), `dedupHash` (`dedup_hash`), `batchId` (`batch_id`), `eventIds` (agregado: `coalesce((select json_agg(te.event_id order by te.event_id) from app.finance_transaction_events as te where te.household_id = tx.household_id and te.transaction_id = tx.id), '[]'::json)`). Añade también al objeto devuelto, si fase 4 no los cargaba ya: `accounts` (`select id, name, kind from app.finance_accounts where household_id = $1 and archived_at is null order by name`), `categories` (`select id, name, parent_id as "parentId", kind from app.finance_categories where household_id = $1 order by name`) y `events` (`select id, name from app.finance_events where household_id = $1 order by lower(name)`).

- [ ] **Step 2: Comprueba que sigue compilando**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check
```

Expected: sin errores.

- [ ] **Step 3: Añade la maquinaria de escritura a `+page.svelte`**

En el `<script>` de la página (respetando lo que dejó la fase 4), añade:

```ts
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import CategorySelect from '$lib/components/finance/CategorySelect.svelte';
  import EventPicker from '$lib/components/finance/EventPicker.svelte';
  import ManualForm from '$lib/components/finance/ManualForm.svelte';
  import RecurrenceChip from '$lib/components/finance/RecurrenceChip.svelte';
  import { useAppContext } from '$lib/auth/context';
  import { financeCommand } from '$lib/finance/commands';
  import { canLinkSelection } from '$lib/finance/link-transfers';
  import { OptimisticActions } from '$lib/offline/optimistic';

  const context = useAppContext();
  const optimistic = new OptimisticActions({ householdId: context.household.id, invalidateToken: 'cc:finance' });
  const actionStatus = optimistic.status;
  $effect(() => optimistic.start());

  let selected = $state<string[]>([]);
  let manualOpen = $state(false);

  const selectedSet = $derived(new Set(selected));
  const linkCheck = $derived(
    canLinkSelection(
      rows.map((row) => ({ id: row.id, amountCents: row.amountCents, transferGroupId: row.transferGroupId })),
      selectedSet
    )
  );

  function toggleSelected(rowId: string, on: boolean): void {
    selected = on ? [...selected, rowId] : selected.filter((id) => id !== rowId);
  }

  function setCategory(rowId: string, categoryId: string): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, categoryId })
    );
  }

  function setRecurrence(rowId: string, recurrence: 'recurrente' | 'extraordinario' | null): void {
    if (recurrence === null) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, recurrence })
    );
  }

  function toggleEvent(row: { id: string; eventIds: string[] }, eventId: string, add: boolean): void {
    const eventIds = add ? [...row.eventIds, eventId] : row.eventIds.filter((id) => id !== eventId);
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: row.id, eventIds })
    );
  }

  function createEventFor(row: { id: string; eventIds: string[] }, name: string): void {
    void (async () => {
      const outcome = await optimistic.run(
        financeCommand(context.household.id, { kind: 'finance.event.create', name })
      );
      if (outcome === 'synced') {
        // el invalidate de cc:finance ya trajo el evento; asignarlo pide otra pasada del usuario
      }
    })();
  }

  function assignEventToSelection(eventId: string): void {
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.event.assignTransactions',
        eventId,
        transactionIds: selected,
        action: 'add'
      }),
      { settle: () => (selected = []) }
    );
  }

  function linkSelection(): void {
    if (!linkCheck.enabled) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transfers.link', transactionIds: selected }),
      { settle: () => (selected = []) }
    );
  }

  function unlinkGroup(transferGroupId: string): void {
    if (!window.confirm('¿Desvincular esta transferencia? Las patas volverán a pendiente.')) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transfers.unlink', transferGroupId })
    );
  }

  function deleteManual(rowId: string): void {
    if (!window.confirm('¿Borrar este movimiento manual?')) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.manual.delete', transactionId: rowId })
    );
  }

  function createManual(input: {
    accountId: string; opDate: string; concept: string; provider: string;
    amountCents: string; categoryId: string | null; recurrence: 'recurrente' | 'extraordinario' | null;
  }): void {
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.transaction.manual.create',
        accountId: input.accountId,
        opDate: input.opDate,
        concept: input.concept,
        provider: input.provider,
        amountCents: input.amountCents,
        categoryId: input.categoryId,
        recurrence: input.recurrence
      }),
      { settle: () => (manualOpen = false) }
    );
  }
```

(`rows` es la lista de filas que ya pinta la fase 4 — usa el nombre real que tenga en la página; cada fila es un objeto con los campos del Step 1.)

- [ ] **Step 4: Añade los controles al marcado**

Sobre la tabla ledger que dejó la fase 4, aplica estos cambios concretos (los puntos de anclaje son semánticos; conserva todo lo demás):

1. `<ActionStatus status={actionStatus} />` justo bajo el `PageHeader`.
2. Botón «+ Añadir manual» junto a los filtros: `<button class="button secondary" type="button" onclick={() => (manualOpen = !manualOpen)}>+ Añadir manual</button>`, y debajo `{#if manualOpen}<ManualForm accounts={data.movimientos.accounts} categories={data.movimientos.categories} onsubmit={createManual} oncancel={() => (manualOpen = false)} />{/if}` (ajusta `data.movimientos` al nombre real del objeto del load).
3. Primera celda de cada fila: `<td><input type="checkbox" aria-label="Seleccionar movimiento" checked={selectedSet.has(row.id)} onchange={(event) => toggleSelected(row.id, event.currentTarget.checked)} /></td>` (y un `<th></th>` en la cabecera).
4. En la celda del concepto, tras el texto: si `row.transferGroupId`, `<button class="button secondary small-button" type="button" title="Desvincular transferencia" onclick={() => unlinkGroup(row.transferGroupId)}>⇄</button>`; si `row.provider`, el enlace de alias `<a href={`/h/${context.household.id}/finanzas/ajustes?prov=${encodeURIComponent(row.provider)}`} title="Editar alias del proveedor">✎</a>`.
5. Celda de categoría: `<CategorySelect categories={data.movimientos.categories} value={row.categoryId} onchange={(categoryId) => setCategory(row.id, categoryId)} />`.
6. Celda de eventos: `<EventPicker events={data.movimientos.events} selectedIds={row.eventIds} ontoggle={(eventId, add) => toggleEvent(row, eventId, add)} oncreate={(name) => createEventFor(row, name)} />`.
7. Celda de tipo: `<RecurrenceChip value={row.recurrence} onchange={(next) => setRecurrence(row.id, next)} />`.
8. Última celda: si `row.batchId === null && row.dedupHash.startsWith('manual-')`, `<button class="button danger small-button" type="button" onclick={() => deleteManual(row.id)}>Borrar</button>`.
9. Barra de selección sobre la tabla:

```svelte
{#if selected.length > 0}
  <div class="seleccion-bar">
    <span>{selected.length} seleccionados</span>
    <button class="button secondary small-button" type="button" disabled={!linkCheck.enabled}
      title={linkCheck.reason ?? 'Vincular como transferencia'} onclick={linkSelection}>⇄ Vincular transferencia</button>
    {#each data.movimientos.events as entry (entry.id)}
      <button class="button secondary small-button" type="button" onclick={() => assignEventToSelection(entry.id)}>◈ {entry.name}</button>
    {/each}
    <button class="button secondary small-button" type="button" onclick={() => (selected = [])}>Quitar selección</button>
  </div>
{/if}
```

con estilo local `.seleccion-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2); }`.

- [ ] **Step 5: Verde estático**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && node apps/web/scripts/lint-css-tokens.mjs && pnpm lint
```

Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/routes/h/[householdId]/finanzas/movimientos"
git commit -m "feat(finanzas): edición inline, manuales y transferencias en Movimientos"
```

---

### Task 10: Revisión completa + badge de pendientes (dbe2e primero)

**Files:**
- Modify: `apps/web/e2e/helpers.ts` (constantes de semilla de finanzas)
- Modify: `apps/web/e2e/db-global-setup.ts` (semilla de finanzas)
- Create: `apps/web/e2e/finanzas-revision.dbe2e.ts`
- Create/Modify: `apps/web/src/routes/h/[householdId]/finanzas/+layout.server.ts` (badge)
- Modify: `apps/web/src/routes/h/[householdId]/finanzas/+layout.svelte` (chip del badge; si la fase 4 no lo creó, créalo)
- Create/Modify: `apps/web/src/routes/h/[householdId]/finanzas/revision/+page.server.ts` y `+page.svelte` (sustituyen al esqueleto de fase 1/4)

**Interfaces:**
- Consumes: `financeCommand` (Task 7), `CategorySelect`/`RecurrenceChip` (Task 8), `OptimisticActions`/`ActionStatus`, `withAuthorizedTransaction`/`createLogger` de `@casa-clara/server`, `demoOrUnavailable`/`unreadable` de `$lib/server/data-source.server`, `getDatabasePool` de `$lib/server/db.server`, `formatCents(value: string | bigint, options?: { signed?: boolean }): string` de `$lib/finance/format` (fase 4), `useAppContext` de `$lib/auth/context`; kinds `finance.transaction.update`, `finance.transactions.bulk`.
- Produces: `data.pendingReviewCount: number` en el layout de finanzas (badge `.revision-badge`); página Revisión completa.

- [ ] **Step 1: Semilla e2e de finanzas**

En `apps/web/e2e/helpers.ts`, añade a `E2E_SEED`:

```ts
  finanzas: {
    account: 'ab910000-0000-4000-8000-000000000001',
    catCasa: 'ab900000-0000-4000-8000-000000000002',
    txSuper: 'ab920000-0000-4000-8000-000000000001',
    txLuz: 'ab920000-0000-4000-8000-000000000002'
  }
```

En `apps/web/e2e/db-global-setup.ts`, define `FINANCE_SEED` (junto a `WIKI_SEED`) y ejecútalo tras `E2E_BATTERY_SEED` (`await admin.query(FINANCE_SEED);`):

```ts
const FINANCE_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${HOUSEHOLD}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${HOUSEHOLD}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id)
SELECT '${HOUSEHOLD}', 'ab900000-0000-4000-8000-000000000001', 'Transferencias E2E', 'transferencia', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_categories
   WHERE household_id = '${HOUSEHOLD}' AND kind = 'transferencia' AND parent_id IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id) VALUES
  ('${HOUSEHOLD}', 'ab900000-0000-4000-8000-000000000002', 'Casa E2E', 'gasto', NULL);

INSERT INTO app.finance_accounts
  (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('${HOUSEHOLD}', 'ab910000-0000-4000-8000-000000000001', 'Cuenta E2E', 'caixabank', 'comun', 'familia', 'E2E-0001', '[]'::jsonb, '[]'::jsonb);

INSERT INTO app.finance_transactions
  (household_id, id, account_id, batch_id, op_date, concept, provider, provider_norm,
   amount_cents, category_id, status, transfer_group_id, dedup_hash, recurrence, recurrence_manual, raw, currency_code) VALUES
  ('${HOUSEHOLD}', 'ab920000-0000-4000-8000-000000000001', 'ab910000-0000-4000-8000-000000000001', NULL,
   current_date - 3, 'COMPRA SUPERMERCADO RIO E2E', 'SUPERMERCADO RIO E2E', 'supermercado rio e2e',
   -4321, NULL, 'pendiente', NULL, 'e2e-fin-0001', NULL, false, '{}'::jsonb, 'EUR'),
  ('${HOUSEHOLD}', 'ab920000-0000-4000-8000-000000000002', 'ab910000-0000-4000-8000-000000000001', NULL,
   current_date - 2, 'RECIBO LUZ NORTE E2E', 'LUZ NORTE E2E', 'luz norte e2e',
   -6600, NULL, 'pendiente', NULL, 'e2e-fin-0002', NULL, false, '{}'::jsonb, 'EUR');

COMMIT;
`;
```

- [ ] **Step 2: Escribe el dbe2e que falla**

`apps/web/e2e/finanzas-revision.dbe2e.ts`:

```ts
import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

test('el admin con concesión confirma un pendiente desde Revisión', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/revision`);

  // Badge de pendientes visible en la navegación del módulo.
  await expect(page.locator('.revision-badge')).toBeVisible();

  const fila = page.locator('tr', { hasText: 'SUPERMERCADO RIO E2E' });
  await expect(fila).toBeVisible();
  await fila.getByRole('combobox', { name: 'Categoría' }).selectOption({ label: 'Casa E2E' });
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await fila.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await expect(page.locator('tr', { hasText: 'SUPERMERCADO RIO E2E' })).toHaveCount(0);
});
```

- [ ] **Step 3: Rojo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test:e2e:db finanzas-revision.dbe2e.ts
```

Expected: FAIL — la página esqueleto no tiene tabla ni badge.

- [ ] **Step 4: Implementa el badge**

`+layout.server.ts` del módulo (si la fase 4 ya lo creó, AÑADE `pendingReviewCount` a su retorno con esta misma consulta):

```ts
import { createLogger, withAuthorizedTransaction } from '@casa-clara/server';

import { unreadable } from '$lib/server/data-source.server';
import { getDatabasePool } from '$lib/server/db.server';
import type { LayoutServerLoad } from './$types';

const log = createLogger('web:finanzas:layout');

export const load: LayoutServerLoad = async ({ depends, locals, params }) => {
  depends('cc:finance');
  const pool = getDatabasePool();
  if (!pool || !locals.user) return { pendingReviewCount: 0 };
  try {
    const pendingReviewCount = await withAuthorizedTransaction(
      pool,
      { userId: locals.user.id },
      params.householdId,
      async (client) => {
        const result = await client.query<{ pending: number }>(
          `select count(*)::int as pending
             from app.finance_transactions
            where household_id = $1 and status <> 'confirmada'`,
          [params.householdId]
        );
        return result.rows[0]?.pending ?? 0;
      }
    );
    return { pendingReviewCount };
  } catch (cause) {
    unreadable(log, 'finanzas:badge', cause);
    return { pendingReviewCount: 0 };
  }
};
```

En `+layout.svelte`: si la fase 4 dejó una navegación del módulo, añade dentro del enlace de Revisión `{#if data.pendingReviewCount > 0}<span class="status-chip revision-badge">{data.pendingReviewCount}</span>{/if}` (y `let { data, children } = $props();`). Si no existe, créalo:

```svelte
<script lang="ts">
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const SECTIONS = [
    ['', 'Dashboard'], ['analitica', 'Analítica'], ['movimientos', 'Movimientos'],
    ['revision', 'Revisión'], ['eventos', 'Eventos'], ['importar', 'Importar'], ['ajustes', 'Ajustes']
  ] as const;

  const base = $derived(`/h/${page.params.householdId}/finanzas`);
</script>

<nav class="finance-nav" aria-label="Secciones de Finanzas">
  {#each SECTIONS as [slug, label] (slug)}
    {@const href = slug ? `${base}/${slug}` : base}
    <a {href} aria-current={page.url.pathname === href ? 'page' : undefined}>
      {label}{#if slug === 'revision' && data.pendingReviewCount > 0}<span class="status-chip revision-badge">{data.pendingReviewCount}</span>{/if}
    </a>
  {/each}
</nav>

{@render children()}

<style>
  .finance-nav { display: flex; flex-wrap: wrap; gap: var(--space-2); overflow-x: auto; }
  .revision-badge { margin-inline-start: var(--space-1); }
</style>
```

- [ ] **Step 5: Implementa la página Revisión**

`revision/+page.server.ts`:

```ts
import { createLogger, withAuthorizedTransaction } from '@casa-clara/server';

import { demoOrUnavailable, unreadable } from '$lib/server/data-source.server';
import { getDatabasePool } from '$lib/server/db.server';
import type { PageServerLoad } from './$types';

const log = createLogger('web:finanzas:revision');

function monthsAgoISO(months: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  depends('cc:finance');
  const from = url.searchParams.get('from') ?? monthsAgoISO(6);
  const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
  const pool = getDatabasePool();
  if (pool && locals.user) {
    try {
      const revision = await withAuthorizedTransaction(pool, { userId: locals.user.id }, params.householdId, async (client) => {
        const rows = await client.query(
          `select tx.id, tx.op_date::text as "opDate", acc.name as "accountName", tx.concept,
                  tx.provider, alias.display as "providerDisplay", tx.amount_cents::text as "amountCents",
                  tx.status, tx.category_id as "categoryId", tx.recurrence,
                  tx.transfer_group_id as "transferGroupId"
             from app.finance_transactions as tx
             join app.finance_accounts as acc
               on acc.household_id = tx.household_id and acc.id = tx.account_id
             left join app.finance_provider_aliases as alias
               on alias.household_id = tx.household_id and alias.provider_norm = tx.provider_norm
            where tx.household_id = $1 and tx.status <> 'confirmada'
              and tx.op_date between $2 and $3
            order by tx.op_date desc, tx.id desc`,
          [params.householdId, from, to]
        );
        const categories = await client.query(
          `select id, name, parent_id as "parentId", kind
             from app.finance_categories where household_id = $1 order by name`,
          [params.householdId]
        );
        return { from, to, rows: rows.rows, categories: categories.rows };
      });
      return { revision };
    } catch (cause) {
      unreadable(log, 'finanzas:revision', cause);
      return { revision: null };
    }
  }
  return demoOrUnavailable(() => ({
    revision: {
      from,
      to,
      rows: [{
        id: 'demo-1', opDate: from, accountName: 'Cuenta demo', concept: 'COMPRA SUPERMERCADO DEMO',
        provider: 'SUPERMERCADO DEMO', providerDisplay: null, amountCents: '-2350',
        status: 'pendiente', categoryId: null, recurrence: null, transferGroupId: null
      }],
      categories: [{ id: 'demo-cat', name: 'Casa', parentId: null, kind: 'gasto' }]
    }
  }));
};
```

`revision/+page.svelte`:

```svelte
<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import CategorySelect from '$lib/components/finance/CategorySelect.svelte';
  import RecurrenceChip from '$lib/components/finance/RecurrenceChip.svelte';
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

  let hidden = $state<string[]>([]);
  let ruleFor = $state<string[]>([]);
  let localCategory = $state<Record<string, string>>({});

  const rows = $derived((data.revision?.rows ?? []).filter((row) => !hidden.includes(row.id)));
  const suggested = $derived(
    rows.filter((row) => (localCategory[row.id] ?? row.categoryId) && row.status.startsWith('sugerida'))
  );

  const STATUS_LABEL: Record<string, string> = {
    pendiente: 'pendiente', sugerida_regla: 'regla', sugerida_agente: 'agente'
  };

  function setCategory(rowId: string, categoryId: string): void {
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, categoryId }),
      {
        apply: () => (localCategory = { ...localCategory, [rowId]: categoryId }),
        revert: () => {
          const { [rowId]: _gone, ...rest } = localCategory;
          localCategory = rest;
        }
      }
    );
  }

  function setRecurrence(rowId: string, recurrence: 'recurrente' | 'extraordinario' | null): void {
    if (recurrence === null) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transaction.update', transactionId: rowId, recurrence })
    );
  }

  function confirmRow(rowId: string): void {
    const withRule = ruleFor.includes(rowId);
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.transaction.update',
        transactionId: rowId,
        status: 'confirmada',
        ...(withRule ? { createRule: { ruleType: 'proveedor_exacto' as const } } : {})
      }),
      {
        apply: () => (hidden = [...hidden, rowId]),
        revert: () => (hidden = hidden.filter((id) => id !== rowId)),
        settle: () => (hidden = hidden.filter((id) => id !== rowId))
      }
    );
  }

  function confirmSuggested(): void {
    const ids = suggested.map((row) => row.id);
    if (ids.length === 0) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.transactions.bulk', transactionIds: ids, status: 'confirmada' }),
      {
        apply: () => (hidden = [...hidden, ...ids]),
        revert: () => (hidden = hidden.filter((id) => !ids.includes(id))),
        settle: () => (hidden = hidden.filter((id) => !ids.includes(id)))
      }
    );
  }
</script>

<PageHeader eyebrow="Finanzas" title="Revisión" support={`${rows.length} movimientos por revisar`} />
<ActionStatus status={actionStatus} />

{#if !data.revision}
  <p class="empty-state">Ahora mismo no podemos leer los movimientos.</p>
{:else if rows.length === 0}
  <p class="empty-state">Nada que revisar en este periodo ✨</p>
{:else}
  {#if suggested.length > 0}
    <button class="button primary" type="button" onclick={confirmSuggested}>
      ✓ Confirmar {suggested.length} sugerencias
    </button>
  {/if}
  <div class="revision-scroll">
    <table class="wiki-table">
      <thead>
        <tr>
          <th>Fecha</th><th>Cuenta</th><th>Concepto</th><th>Importe</th><th>Estado</th>
          <th>Categoría</th><th>Tipo</th><th title="crear regla al confirmar">Regla</th><th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr>
            <td class="cifra">{row.opDate}</td>
            <td>{row.accountName}</td>
            <td title={row.concept}>
              {row.transferGroupId ? '⇄ ' : ''}{row.providerDisplay ?? row.provider ?? row.concept.slice(0, 55)}
              {#if row.provider}
                <a href={`/h/${context.household.id}/finanzas/ajustes?prov=${encodeURIComponent(row.provider)}`}
                  title="Editar alias del proveedor">✎</a>
              {/if}
            </td>
            <td class="cifra">{formatCents(row.amountCents)}</td>
            <td><span class="status-chip">{STATUS_LABEL[row.status] ?? row.status}</span></td>
            <td>
              <CategorySelect categories={data.revision.categories}
                value={localCategory[row.id] ?? row.categoryId}
                onchange={(categoryId) => setCategory(row.id, categoryId)} />
            </td>
            <td><RecurrenceChip value={row.recurrence} onchange={(next) => setRecurrence(row.id, next)} /></td>
            <td>
              <input type="checkbox" aria-label="Crear regla al confirmar"
                checked={ruleFor.includes(row.id)}
                onchange={(event) => {
                  const on = event.currentTarget.checked;
                  ruleFor = on ? [...ruleFor, row.id] : ruleFor.filter((id) => id !== row.id);
                }} />
            </td>
            <td>
              <button class="button secondary small-button" type="button"
                disabled={!(localCategory[row.id] ?? row.categoryId)}
                onclick={() => confirmRow(row.id)}>Confirmar</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .revision-scroll { overflow-x: auto; }
</style>
```

- [ ] **Step 6: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && pnpm --filter @casa-clara/web test:e2e:db finanzas-revision.dbe2e.ts
```

Expected: check sin errores y el dbe2e PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/helpers.ts apps/web/e2e/db-global-setup.ts apps/web/e2e/finanzas-revision.dbe2e.ts "apps/web/src/routes/h/[householdId]/finanzas/+layout.server.ts" "apps/web/src/routes/h/[householdId]/finanzas/+layout.svelte" "apps/web/src/routes/h/[householdId]/finanzas/revision"
git commit -m "feat(finanzas): página de Revisión completa con badge de pendientes"
```

---

### Task 11: Página Eventos completa

**Files:**
- Create/Modify: `apps/web/src/routes/h/[householdId]/finanzas/eventos/+page.server.ts` y `+page.svelte` (sustituyen al esqueleto)

**Interfaces:**
- Consumes: `financeCommand` (Task 7), kinds `finance.event.create|update|delete` (Task 1); `OptimisticActions`/`ActionStatus`; `formatCents` de `$lib/finance/format`; `withAuthorizedTransaction`, `demoOrUnavailable`/`unreadable`, `getDatabasePool`; claves de URL canónicas `from`/`to`/`ev` (doc de interfaces).
- Produces: página Eventos. Parámetro local `open=<eventId>` para el desglose (decisión local de esta fase).

- [ ] **Step 1: Load**

`eventos/+page.server.ts` (misma cabecera, `monthsAgoISO` y estructura demo/unreadable que `revision/+page.server.ts` — cópialas; logger `web:finanzas:eventos`):

```ts
export const load: PageServerLoad = async ({ depends, locals, params, url }) => {
  depends('cc:finance');
  const from = url.searchParams.get('from') ?? monthsAgoISO(6);
  const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
  const openId = url.searchParams.get('open');
  const pool = getDatabasePool();
  if (pool && locals.user) {
    try {
      const eventos = await withAuthorizedTransaction(pool, { userId: locals.user.id }, params.householdId, async (client) => {
        const summary = await client.query(
          `select ev.id, ev.name,
                  count(tx.id)::int as "txCount",
                  coalesce(sum(case when tx.amount_cents < 0 then tx.amount_cents else 0 end), 0)::text as "expenseCents",
                  coalesce(sum(case when tx.amount_cents > 0 then tx.amount_cents else 0 end), 0)::text as "incomeCents",
                  coalesce(sum(tx.amount_cents), 0)::text as "netCents",
                  (select count(*)::int from app.finance_transaction_events as total
                    where total.household_id = ev.household_id and total.event_id = ev.id) as "totalCount"
             from app.finance_events as ev
             left join app.finance_transaction_events as te
               on te.household_id = ev.household_id and te.event_id = ev.id
             left join app.finance_transactions as tx
               on tx.household_id = te.household_id and tx.id = te.transaction_id
              and tx.op_date between $2 and $3
            where ev.household_id = $1
            group by ev.household_id, ev.id, ev.name
            order by lower(ev.name)`,
          [params.householdId, from, to]
        );
        const detail = openId
          ? (
              await client.query(
                `select coalesce(cat.name, '(sin categoría)') as name, count(*)::int as count,
                        sum(tx.amount_cents)::text as "totalCents"
                   from app.finance_transaction_events as te
                   join app.finance_transactions as tx
                     on tx.household_id = te.household_id and tx.id = te.transaction_id
                   left join app.finance_categories as cat
                     on cat.household_id = tx.household_id and cat.id = tx.category_id
                  where te.household_id = $1 and te.event_id = $2 and tx.op_date between $3 and $4
                  group by cat.name
                  order by sum(tx.amount_cents)`,
                [params.householdId, openId, from, to]
              )
            ).rows
          : null;
        return { from, to, openId, summary: summary.rows, detail };
      });
      return { eventos };
    } catch (cause) {
      unreadable(log, 'finanzas:eventos', cause);
      return { eventos: null };
    }
  }
  return demoOrUnavailable(() => ({
    eventos: {
      from, to, openId: null, detail: null,
      summary: [{ id: 'demo-ev', name: 'Semana Santa (demo)', txCount: 3, expenseCents: '-42000', incomeCents: '0', netCents: '-42000', totalCount: 3 }]
    }
  }));
};
```

- [ ] **Step 2: Página**

`eventos/+page.svelte`:

```svelte
<script lang="ts">
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
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

  let newName = $state('');
  let editId = $state<string | null>(null);
  let editName = $state('');

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
      { settle: () => (editId = null) }
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

<PageHeader eyebrow="Finanzas" title="Eventos" support={data.eventos ? `${data.eventos.from} → ${data.eventos.to}` : ''} />
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
        <tr><th>Evento</th><th>Movs.</th><th>Gasto</th><th>Ingreso</th><th>Neto</th><th></th></tr>
      </thead>
      <tbody>
        {#each summary as entry (entry.id)}
          <tr>
            <td>
              {#if editId === entry.id}
                <form onsubmit={(event) => { event.preventDefault(); rename(entry.id); }}>
                  <input aria-label="Nuevo nombre del evento" bind:value={editName}
                    onkeydown={(event) => { if (event.key === 'Escape') editId = null; }} />
                </form>
              {:else}◈ {entry.name}{/if}
            </td>
            <td class="cifra">{entry.txCount}</td>
            <td class="cifra">{formatCents(entry.expenseCents)}</td>
            <td class="cifra">{formatCents(entry.incomeCents)}</td>
            <td class="cifra">{formatCents(entry.netCents)}</td>
            <td>
              <a class="button secondary small-button" href={`${base}/movimientos?ev=${entry.id}`} title="Ver movimientos">≡</a>
              <a class="button secondary small-button" href={`?open=${entry.id}`} title="Desglose por categoría">▾</a>
              <button class="button secondary small-button" type="button" title="Renombrar"
                onclick={() => { editId = entry.id; editName = entry.name; }}>✎</button>
              <button class="button danger small-button" type="button" title="Borrar"
                onclick={() => remove(entry)}>Borrar</button>
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
      <h2>Desglose por categoría</h2>
      <table class="wiki-table">
        <thead><tr><th>Categoría</th><th>Movs.</th><th>Total</th></tr></thead>
        <tbody>
          {#each data.eventos.detail as line (line.name)}
            <tr>
              <td>{line.name}</td>
              <td class="cifra">{line.count}</td>
              <td class="cifra">{formatCents(line.totalCents)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
{/if}

<style>
  .eventos-scroll { overflow-x: auto; }
</style>
```

- [ ] **Step 3: Verde estático**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && node apps/web/scripts/lint-css-tokens.mjs
```

Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/routes/h/[householdId]/finanzas/eventos"
git commit -m "feat(finanzas): página de Eventos con totales, renombrado y borrado que desvincula"
```

---

### Task 12: Página Importar completa (dbe2e primero)

**Files:**
- Create: `apps/web/e2e/finanzas-importar.dbe2e.ts`
- Create/Modify: `apps/web/src/routes/h/[householdId]/finanzas/importar/+page.server.ts` y `+page.svelte`

**Interfaces:**
- Consumes: endpoints y formas de respuesta de la Task 6 (`POST /api/v1/finance/imports/preview?household=…` → `{ apiVersion, bank, newCount, dupCount, unknownRefs, sample }`; `POST …/confirm?household=…` con `file` + `payload` JSON `{ newAccounts: Array<{ bankRef, name, kind, ownerLabel }> }` → `{ apiVersion, batchId, newCount, dupCount }`); `financeCommand` + kind `finance.import.undo`; `OptimisticActions`/`ActionStatus`; `formatCents`; `invalidate` de `$app/navigation`.
- Produces: página Importar (fichero → previsualización → confirmar → historial con deshacer).

- [ ] **Step 1: Escribe el dbe2e que falla**

`apps/web/e2e/finanzas-importar.dbe2e.ts` (el extracto sintético de OpenBank es el mismo formato que el de la Task 6):

```ts
import { expect, test } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

const OPENBANK_HTML = `<html>
<head><title>OPENBANK - Cuentas - Movimientos</title></head>
<body><table>
<tr><td>N\u00famero de cuenta:</td><td>ES21 0073 0100 5500 9876 5432</td></tr>
<tr><td>Fecha Operaci\u00f3n</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>05/07/2026</td><td>05/07/2026</td><td>TRANSFERENCIA A FAVOR DE CLARA DEMO, CONCEPTO ALQUILER JULIO</td><td>-850,00</td><td>1.150,00</td></tr>
<tr><td>03/07/2026</td><td>03/07/2026</td><td>LIQUIDACION CUENTA INTERESES</td><td>1,23</td><td>2.000,00</td></tr>
</table></body></html>`;

test('importar: previsualizar, dar de alta la cuenta, confirmar y deshacer', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);

  await page.setInputFiles('input[type="file"]', {
    name: 'movimientos-e2e.xls',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from(OPENBANK_HTML, 'latin1')
  });

  await expect(page.locator('body')).toContainText('2 nuevas');
  await page.getByLabel('Nombre de la cuenta nueva').fill('OpenBank E2E');
  await page.getByRole('button', { name: 'Confirmar importación' }).click();

  await expect(page.locator('.success-message')).toContainText('Importadas 2');
  const fila = page.locator('tr', { hasText: 'movimientos-e2e.xls' });
  await expect(fila).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await fila.getByRole('button', { name: 'Deshacer' }).click();
  await expect(page.locator('.success-message')).toContainText('Guardado ✓');
  await expect(page.locator('tr', { hasText: 'movimientos-e2e.xls' })).toHaveCount(0);
});
```

- [ ] **Step 2: Rojo**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web test:e2e:db finanzas-importar.dbe2e.ts
```

Expected: FAIL — la página esqueleto no tiene `input[type="file"]`.

- [ ] **Step 3: Load del historial**

`importar/+page.server.ts` (misma estructura demo/unreadable; logger `web:finanzas:importar`):

```ts
export const load: PageServerLoad = async ({ depends, locals, params }) => {
  depends('cc:finance');
  const pool = getDatabasePool();
  if (pool && locals.user) {
    try {
      const batches = await withAuthorizedTransaction(pool, { userId: locals.user.id }, params.householdId, async (client) => {
        const result = await client.query(
          `select id, filename, bank, imported_at::text as "importedAt",
                  new_count as "newCount", dup_count as "dupCount"
             from app.finance_import_batches
            where household_id = $1
            order by imported_at desc`,
          [params.householdId]
        );
        return result.rows;
      });
      return { importar: { batches } };
    } catch (cause) {
      unreadable(log, 'finanzas:importar', cause);
      return { importar: null };
    }
  }
  return demoOrUnavailable(() => ({
    importar: { batches: [{ id: 'demo-b', filename: 'demo.xls', bank: 'openbank', importedAt: '2026-08-01T10:00:00', newCount: 12, dupCount: 0 }] }
  }));
};
```

- [ ] **Step 4: Página**

`importar/+page.svelte`:

```svelte
<script lang="ts">
  import { invalidate } from '$app/navigation';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
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
  interface NewAccountDraft { bankRef: string; name: string; kind: string; ownerLabel: string }

  let file = $state<File | null>(null);
  let preview = $state<Preview | null>(null);
  let newAccounts = $state<NewAccountDraft[]>([]);
  let busy = $state(false);
  let importError = $state<string | null>(null);
  let importSuccess = $state<string | null>(null);

  const confirmDisabled = $derived(busy || newAccounts.some((draft) => !draft.name.trim()));

  async function doPreview(chosen: File): Promise<void> {
    busy = true;
    importError = null;
    importSuccess = null;
    try {
      const form = new FormData();
      form.append('file', chosen);
      const response = await fetch(`/api/v1/finance/imports/preview?household=${context.household.id}`, {
        method: 'POST',
        body: form
      });
      if (!response.ok) {
        importError = `No se pudo analizar el fichero: ${await response.text()}`;
        return;
      }
      const result = (await response.json()) as Preview;
      file = chosen;
      preview = result;
      newAccounts = result.unknownRefs.map((bankRef) => ({ bankRef, name: '', kind: 'personal', ownerLabel: 'familia' }));
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
          bankRef: draft.bankRef, name: draft.name.trim(), kind: draft.kind, ownerLabel: draft.ownerLabel
        }))
      }));
      const response = await fetch(`/api/v1/finance/imports/confirm?household=${context.household.id}`, {
        method: 'POST',
        body: form
      });
      if (!response.ok) {
        importError = `No se pudo confirmar la importación: ${await response.text()}`;
        return;
      }
      const result = (await response.json()) as { newCount: number; dupCount: number };
      importSuccess = `Importadas ${result.newCount} nuevas (${result.dupCount} duplicadas).`;
      file = null;
      preview = null;
      newAccounts = [];
      await invalidate('cc:finance');
    } finally {
      busy = false;
    }
  }

  function undoBatch(batch: { id: string; filename: string }): void {
    if (!window.confirm(`¿Deshacer la importación de ${batch.filename}?`)) return;
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.import.undo', batchId: batch.id }));
  }
</script>

<PageHeader eyebrow="Finanzas" title="Importar" support="CaixaBank, Deutsche Bank, OpenBank o Amex" />
<ActionStatus status={actionStatus} />
{#if importSuccess}<p class="success-message" role="status">{importSuccess}</p>{/if}
{#if importError}<p class="form-error" role="alert">{importError}</p>{/if}

<label class="button primary importar-boton">
  Elegir fichero (.xls/.xlsx)
  <input type="file" accept=".xls,.xlsx" hidden
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
          <input value={draft.name} placeholder="p. ej. Cuenta común OpenBank"
            oninput={(event) => (newAccounts = newAccounts.map((entry, at) => (at === index ? { ...entry, name: event.currentTarget.value } : entry)))} />
        </label>
        <label>Tipo
          <select value={draft.kind}
            onchange={(event) => (newAccounts = newAccounts.map((entry, at) => (at === index ? { ...entry, kind: event.currentTarget.value } : entry)))}>
            <option value="comun">común</option><option value="personal">personal</option><option value="inversion">inversión</option>
          </select>
        </label>
        <label>Titular
          <input value={draft.ownerLabel}
            oninput={(event) => (newAccounts = newAccounts.map((entry, at) => (at === index ? { ...entry, ownerLabel: event.currentTarget.value } : entry)))} />
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
  {#if !data.importar}
    <p class="empty-state">Ahora mismo no podemos leer el historial.</p>
  {:else if data.importar.batches.length === 0}
    <p class="empty-state">Aún no se ha importado ningún extracto.</p>
  {:else}
    <div class="importar-scroll">
      <table class="wiki-table">
        <thead><tr><th>Fecha</th><th>Fichero</th><th>Banco</th><th>Nuevas</th><th>Dup.</th><th></th></tr></thead>
        <tbody>
          {#each data.importar.batches as batch (batch.id)}
            <tr>
              <td class="cifra">{batch.importedAt.slice(0, 16).replace('T', ' ')}</td>
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

<style>
  .importar-boton { display: inline-block; }
  .importar-scroll { overflow-x: auto; }
  .cuenta-nueva { display: grid; gap: var(--space-2); }
</style>
```

- [ ] **Step 5: Verde**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && pnpm --filter @casa-clara/web test:e2e:db finanzas-importar.dbe2e.ts
```

Expected: check sin errores y el dbe2e PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/finanzas-importar.dbe2e.ts "apps/web/src/routes/h/[householdId]/finanzas/importar"
git commit -m "feat(finanzas): página Importar con previsualización, cuentas nuevas e historial con deshacer"
```

---

### Task 13: Página Ajustes del módulo (cuentas, categorías, reglas, alias)

**Files:**
- Create/Modify: `apps/web/src/routes/h/[householdId]/finanzas/ajustes/+page.server.ts` y `+page.svelte`

**Interfaces:**
- Consumes: `financeCommand` + kinds `finance.account.update`, `finance.category.create|delete`, `finance.rule.delete`, `finance.alias.update` (Task 1); `OptimisticActions`/`ActionStatus`; `formatCents`; parámetro de URL `prov` (lo enlazan Revisión y Movimientos, tareas 9–10). La concesión por admin NO vive aquí (Ajustes generales, fase 1).
- Produces: página Ajustes del módulo.

- [ ] **Step 1: Load**

`ajustes/+page.server.ts` (misma estructura; logger `web:finanzas:ajustes`); dentro de la transacción:

```ts
        const accounts = await client.query(
          `select id, name, bank, kind, owner_label as "ownerLabel", bank_ref as "bankRef",
                  owner_aliases as "ownerAliases", transfer_refs as "transferRefs"
             from app.finance_accounts
            where household_id = $1 and archived_at is null
            order by name`,
          [params.householdId]
        );
        const categories = await client.query(
          `select id, name, parent_id as "parentId", kind
             from app.finance_categories where household_id = $1 order by name`,
          [params.householdId]
        );
        const rules = await client.query(
          `select rule.id, rule.rule_type as "ruleType", rule.pattern, rule.origin,
                  cat.name as "categoryName"
             from app.finance_rules as rule
             left join app.finance_categories as cat
               on cat.household_id = rule.household_id and cat.id = rule.category_id
            where rule.household_id = $1
            order by rule.pattern`,
          [params.householdId]
        );
        const providers = await client.query(
          `select tx.provider_norm as "providerNorm", max(tx.provider) as provider,
                  max(alias.display) as alias, count(*)::int as count,
                  sum(tx.amount_cents)::text as "totalCents"
             from app.finance_transactions as tx
             left join app.finance_provider_aliases as alias
               on alias.household_id = tx.household_id and alias.provider_norm = tx.provider_norm
            where tx.household_id = $1 and tx.provider_norm is not null
            group by tx.provider_norm
            order by count(*) desc
            limit 500`,
          [params.householdId]
        );
        return { accounts: accounts.rows, categories: categories.rows, rules: rules.rows, providers: providers.rows };
```

devuelto como `{ ajustes: … }`, con rama demo `demoOrUnavailable(() => ({ ajustes: { accounts: [], categories: [], rules: [], providers: [] } }))`.

- [ ] **Step 2: Página**

`ajustes/+page.svelte`:

```svelte
<script lang="ts">
  import { page } from '$app/state';
  import ActionStatus from '$lib/components/ActionStatus.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
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

  // svelte-ignore state_referenced_locally -- valor inicial del filtro (enlace ✎ de otras páginas)
  let providerFilter = $state(page.url.searchParams.get('prov') ?? '');
  let newSub = $state<{ parentId: string; name: string } | null>(null);

  interface AccountRow {
    id: string; name: string; bank: string; kind: string; ownerLabel: string;
    bankRef: string; ownerAliases: string[]; transferRefs: string[];
  }

  const accounts = $derived((data.ajustes?.accounts ?? []) as AccountRow[]);
  const categories = $derived(data.ajustes?.categories ?? []);
  const parents = $derived(categories.filter((cat) => cat.parentId === null));
  const providerRows = $derived(
    (data.ajustes?.providers ?? []).filter((row) =>
      (row.provider ?? '').toLowerCase().includes(providerFilter.toLowerCase())
    )
  );

  function saveAccount(account: AccountRow, patch: Partial<AccountRow>): void {
    const next = { ...account, ...patch };
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.account.update',
        accountId: next.id,
        name: next.name,
        accountKind: next.kind as 'comun' | 'personal' | 'inversion',
        ownerLabel: next.ownerLabel,
        ownerAliases: next.ownerAliases,
        transferRefs: next.transferRefs
      })
    );
  }

  function addSubcategory(parent: { id: string; kind: string }, name: string): void {
    void optimistic.run(
      financeCommand(context.household.id, {
        kind: 'finance.category.create',
        name,
        categoryKind: parent.kind as 'gasto' | 'ingreso',
        parentId: parent.id
      }),
      { settle: () => (newSub = null) }
    );
  }

  function deleteCategory(categoryId: string): void {
    if (!window.confirm('¿Borrar esta categoría?')) return;
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.category.delete', categoryId }));
  }

  function deleteRule(ruleId: string): void {
    void optimistic.run(financeCommand(context.household.id, { kind: 'finance.rule.delete', ruleId }));
  }

  function saveAlias(provider: string, current: string | null, next: string): void {
    if (next.trim() === (current ?? '')) return;
    void optimistic.run(
      financeCommand(context.household.id, { kind: 'finance.alias.update', provider, alias: next.trim() })
    );
  }

  function parseList(value: string, separator: string): string[] {
    return value.split(separator).map((part) => part.trim()).filter(Boolean);
  }
</script>

<PageHeader eyebrow="Finanzas" title="Ajustes del módulo" support="Cuentas, categorías, reglas y alias" />
<ActionStatus status={actionStatus} />

{#if !data.ajustes}
  <p class="empty-state">Ahora mismo no podemos leer los ajustes.</p>
{:else}
  <section>
    <h2>Cuentas</h2>
    <div class="ajustes-scroll">
      <table class="wiki-table">
        <thead><tr><th>Nombre</th><th>Banco</th><th>Ref.</th><th>Tipo</th><th>Titular</th><th>Alias de titulares (;)</th><th>Refs. transferencia (,)</th></tr></thead>
        <tbody>
          {#each accounts as account (account.id)}
            <tr>
              <td><input aria-label={`Nombre de ${account.name}`} value={account.name}
                onblur={(event) => event.currentTarget.value !== account.name && saveAccount(account, { name: event.currentTarget.value })} /></td>
              <td>{account.bank}</td>
              <td class="cifra">…{account.bankRef.slice(-4)}</td>
              <td>
                <select value={account.kind} onchange={(event) => saveAccount(account, { kind: event.currentTarget.value })}>
                  <option value="comun">común</option><option value="personal">personal</option><option value="inversion">inversión</option>
                </select>
              </td>
              <td><input value={account.ownerLabel}
                onblur={(event) => event.currentTarget.value !== account.ownerLabel && saveAccount(account, { ownerLabel: event.currentTarget.value })} /></td>
              <td><input value={account.ownerAliases.join('; ')}
                onblur={(event) => saveAccount(account, { ownerAliases: parseList(event.currentTarget.value, ';') })} /></td>
              <td>
                {#if account.kind === 'inversion'}
                  <input value={account.transferRefs.join(', ')}
                    onblur={(event) => saveAccount(account, { transferRefs: parseList(event.currentTarget.value, ',') })} />
                {:else}—{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Categorías</h2>
    {#each parents as parent (parent.id)}
      <div class="categoria-fila">
        <strong>{parent.name}</strong> <span class="status-chip">{parent.kind}</span>
        {#if parent.kind !== 'transferencia'}
          <button class="button secondary small-button" type="button"
            onclick={() => (newSub = { parentId: parent.id, name: '' })}>+ sub</button>
          <button class="button danger small-button" type="button" onclick={() => deleteCategory(parent.id)}>Borrar</button>
        {/if}
        <div class="subcategorias">
          {#each categories.filter((cat) => cat.parentId === parent.id) as child (child.id)}
            <span class="status-chip">{child.name}
              <button class="button secondary small-button" type="button" title={`Borrar ${child.name}`}
                onclick={() => deleteCategory(child.id)}>×</button>
            </span>
          {/each}
          {#if newSub?.parentId === parent.id}
            <form onsubmit={(event) => { event.preventDefault(); if (newSub?.name.trim()) addSubcategory(parent, newSub.name.trim()); }}>
              <input aria-label="Nueva subcategoría" placeholder="nueva subcategoría ⏎" value={newSub.name}
                oninput={(event) => (newSub = { parentId: parent.id, name: event.currentTarget.value })}
                onkeydown={(event) => { if (event.key === 'Escape') newSub = null; }} />
            </form>
          {/if}
        </div>
      </div>
    {/each}
  </section>

  <section>
    <h2>Reglas de categorización</h2>
    <div class="ajustes-scroll">
      <table class="wiki-table">
        <thead><tr><th>Patrón</th><th>Tipo</th><th>Categoría</th><th>Origen</th><th></th></tr></thead>
        <tbody>
          {#each data.ajustes.rules as rule (rule.id)}
            <tr>
              <td class="cifra">{rule.pattern}</td>
              <td>{rule.ruleType}</td>
              <td>{rule.categoryName ?? '—'}</td>
              <td><span class="status-chip">{rule.origin}</span></td>
              <td><button class="button danger small-button" type="button" onclick={() => deleteRule(rule.id)}>Borrar</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Alias de proveedores</h2>
    <label>Filtrar proveedor
      <input bind:value={providerFilter} placeholder="Filtrar proveedor…" />
    </label>
    <div class="ajustes-scroll">
      <table class="wiki-table">
        <thead><tr><th>Proveedor</th><th>Alias</th><th>Nº mov.</th><th>Total</th></tr></thead>
        <tbody>
          {#each providerRows as row (row.providerNorm)}
            <tr>
              <td class="cifra">{row.provider}</td>
              <td><input aria-label={`Alias de ${row.provider}`} value={row.alias ?? ''} placeholder="— sin alias —"
                onblur={(event) => saveAlias(row.provider, row.alias, event.currentTarget.value)} /></td>
              <td class="cifra">{row.count}</td>
              <td class="cifra">{formatCents(row.totalCents)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<style>
  .ajustes-scroll { overflow-x: auto; }
  .categoria-fila { display: grid; gap: var(--space-1); padding: var(--space-2) 0; border-bottom: 1px solid var(--line); }
  .subcategorias { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
```

- [ ] **Step 3: Verde estático y gates de cierre de fase**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/web check && node apps/web/scripts/lint-css-tokens.mjs && node apps/web/scripts/verify-today-bundle.mjs
```

Expected: sin errores (finanzas no toca el grafo inicial de Hoy). Después, los gates completos de la rama:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm lint && pnpm typecheck && pnpm check && pnpm test && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm test:db && TEST_DATABASE_URL="postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_dev" pnpm test:rls && pnpm --filter @casa-clara/web test:e2e:db
```

Expected: todo verde.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/routes/h/[householdId]/finanzas/ajustes"
git commit -m "feat(finanzas): página de Ajustes del módulo (cuentas, categorías, reglas y alias)"
```
