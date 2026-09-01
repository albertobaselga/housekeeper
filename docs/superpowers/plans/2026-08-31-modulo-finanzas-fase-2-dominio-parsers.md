# Dominio puro y parsers bancarios — Plan de implementación (Fase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar con fidelidad la lógica de dominio de home-finance (Python) a `packages/domain/src/finance` (puro, bigint, con tests) y los 4 parsers bancarios + hash de dedup + pipeline post-import de 8 pasos a `packages/server/src/finance`, con muestras de extractos 100 % sintéticas generadas por código.

**Architecture:** El dominio es puro (sin pg, sin fetch, sin reloj, sin `node:crypto`): funciones que reciben vistas (`FinanceTxView`, `FinanceAccountView`…) y devuelven propuestas/veredictos; nunca escriben. El servidor aporta lo impuro: SheetJS para leer extractos, sha256 para el hash, y `pipeline.ts` que carga estado por SQL, ejecuta los 8 pasos puros en orden fijo y persiste los cambios. Las muestras de extracto se fabrican con SheetJS/plantillas HTML dentro de los propios tests.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `verbatimModuleSyntax`), vitest 3, pnpm workspace, SheetJS (`xlsx` 0.18.5, solo `packages/server`), `node:crypto` (solo servidor), dinero en céntimos `bigint`.

**Spec:** /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md (y el doc de interfaces /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md).

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

**Nota de fase:** esta fase no toca la base de datos ni producción: todos los tests son unitarios (vitest) y corren sin Postgres. Los tests de parsers y pipeline NUNCA usan `describe.runIf` ni `skip`. Todos los comandos se ejecutan desde la raíz del worktree: `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas`.

---

### Task 1: Andamiaje del dominio — `types.ts`, `text.ts`, barrel y subpath export

**Files:**
- Create: `packages/domain/src/finance/types.ts`
- Create: `packages/domain/src/finance/text.ts`
- Create: `packages/domain/src/finance/index.ts`
- Modify: `packages/domain/package.json`
- Test: `packages/domain/src/finance/text.test.ts`

**Interfaces:**
- Consumes: nada del repo (tipos canónicos copiados del doc de interfaces §Tipos canónicos).
- Produces:
  - Todos los tipos canónicos (`FinanceBank`, `FinanceAccountKind`, `FinanceCategoryKind`, `FinanceTransactionStatus`, `FinanceRuleType`, `FinanceRecurrence`, `ParsedRow`, `ParsedStatement`, `FinanceTxView`) y los auxiliares (`FinanceAccountView`, `FinanceCategoryView`, `FinanceRuleView`, `FinanceEventRuleView`, `FinanceProviderAliasView`, `TransferProposal`, `InvestmentMirrorProposal`, `CashProposal`, `RecurrenceVerdict`, `EventAssignmentProposal`, `RangeSummary`, `SummaryOptions`).
  - `normText(s: string): string` · `normalizeConcept(concept: string): string` · `dayDiffIso(a: string, b: string): number`.
  - Subpath `@casa-clara/domain/finance` → `packages/domain/src/finance/index.ts`.

Referencia Python: `/home/abf/github/home-finance/backend/app/money.py` (`norm_text`, `normalize_concept`). Imita el estilo de test de `packages/domain/src/money.test.ts` (describe/it en español, `expect` con valores exactos).

Dos extensiones deliberadas sobre el doc de interfaces (añadir campos NO es renombrar; el port fiel los necesita): `FinanceTxView` gana `codeCommon`, `codeOwn` y `categoryKind` (los usan reglas `codigo_norma43`, la señal 03/05 de recurrencia y los filtros por kind de KPIs/transferencias; las fases 4–6 los rellenan desde SQL con un join a `finance_categories`); `ParsedRow` gana `bankCategory` (columna «Categoría» de Amex → columna `bank_category`).

- [ ] **Step 1: Test que falla de `normText`/`normalizeConcept`/`dayDiffIso`.** Escribe `packages/domain/src/finance/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { dayDiffIso, normText, normalizeConcept } from "./index.js";

describe("normText (port de money.py::norm_text)", () => {
  it("quita tildes por NFKD, colapsa espacios y pasa a mayúsculas", () => {
    // valores dorados calculados con la función Python del origen
    expect(normText("  Peluquería   Ñoño  ")).toBe("PELUQUERIA NONO");
    expect(normText("café   con LECHE")).toBe("CAFE CON LECHE");
    expect(normText("ya\u00a0limpio")).toBe("YA LIMPIO");
  });
});

describe("normalizeConcept (port de money.py::normalize_concept)", () => {
  it("colapsa espacios internos y recorta a 80 caracteres", () => {
    expect(normalizeConcept("  RECIBO   LUZ  ")).toBe("RECIBO LUZ");
    expect(normalizeConcept("x".repeat(100))).toBe("x".repeat(80));
  });
  it("devuelve «—» si queda vacío", () => {
    expect(normalizeConcept("   ")).toBe("—");
  });
});

describe("dayDiffIso", () => {
  it("calcula la diferencia en días de calendario", () => {
    expect(dayDiffIso("2026-06-16", "2026-06-15")).toBe(1);
    expect(dayDiffIso("2026-06-01", "2026-05-29")).toBe(3);
    expect(dayDiffIso("2026-05-29", "2026-06-01")).toBe(-3);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/text.test.ts` — salida esperada: `Error: Failed to load ... src/finance/index.js` (el módulo no existe).
- [ ] **Step 3: Implementación.** Crea `packages/domain/src/finance/text.ts`:

```ts
/** Port fiel de backend/app/money.py::norm_text del origen home-finance.
 * NFKD + eliminación de marcas combinantes (Ñ→N, á→a) + colapso de
 * espacios + mayúsculas. Los hashes de dedup dependen de esta función. */
export function normText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Port de money.py::normalize_concept: colapso de espacios + recorte a 80; «—» si vacío. */
export function normalizeConcept(concept: string): string {
  const collapsed = concept
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
  return collapsed.slice(0, 80) || "—";
}

/** Diferencia a−b en días de calendario entre fechas ISO yyyy-mm-dd. Sin reloj. */
export function dayDiffIso(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000,
  );
}
```

Crea `packages/domain/src/finance/types.ts` (tipos canónicos del doc de interfaces + auxiliares + extensiones comentadas):

```ts
export type FinanceBank = "caixabank" | "deutsche_bank" | "openbank" | "amex";
export type FinanceAccountKind = "comun" | "personal" | "inversion";
export type FinanceCategoryKind = "gasto" | "ingreso" | "transferencia";
export type FinanceTransactionStatus =
  | "pendiente"
  | "sugerida_regla"
  | "sugerida_agente"
  | "confirmada";
export type FinanceRuleType = "proveedor_exacto" | "concepto_contiene" | "codigo_norma43";
export type FinanceRecurrence = "recurrente" | "extraordinario" | null;

/** Fila normalizada que producen los parsers (fechas ISO yyyy-mm-dd). */
export interface ParsedRow {
  accountRef: string; // CCC/IBAN/nº de cuenta detectado por fila o cabecera
  bankRef: string; // idéntico a accountRef; entra en el hash de dedup (compatibilidad con el origen)
  opDate: string;
  valueDate: string | null;
  concept: string;
  provider: string | null;
  amountCents: bigint;
  balanceCents: bigint | null;
  codeCommon: string | null;
  codeOwn: string | null;
  dedupRef: string | null; // solo Amex (columna Referencia)
  bankCategory: string | null; // extensión fase 2: columna «Categoría» de Amex → bank_category
  raw: Record<string, string>; // cabecera→valor del fichero original
}

export interface ParsedStatement {
  bank: FinanceBank;
  accountRefs: string[]; // refs únicas detectadas en el fichero
  rows: ParsedRow[];
}

/** Vista de transacción que consumen las heurísticas puras del dominio. */
export interface FinanceTxView {
  id: string;
  accountId: string;
  opDate: string;
  concept: string;
  provider: string | null;
  providerNorm: string | null;
  amountCents: bigint;
  categoryId: string | null;
  status: FinanceTransactionStatus;
  transferGroupId: string | null;
  recurrence: FinanceRecurrence;
  recurrenceManual: boolean;
  dedupHash: string;
  // Extensión fase 2 (port fiel del origen; se rellenan desde SQL con join a categorías):
  codeCommon: string | null;
  codeOwn: string | null;
  categoryKind: FinanceCategoryKind | null;
}

export interface FinanceAccountView {
  id: string;
  name: string;
  bank: string; // caixabank|deutsche_bank|openbank|amex|efectivo|inversion|manual…
  kind: FinanceAccountKind;
  bankRef: string;
  ownerAliases: readonly string[];
  transferRefs: readonly string[];
}

export interface FinanceCategoryView {
  id: string;
  parentId: string | null;
  name: string;
  kind: FinanceCategoryKind;
}

export interface FinanceRuleView {
  id: string;
  ruleType: FinanceRuleType;
  pattern: string;
  categoryId: string;
  priority: number;
}

export interface FinanceEventRuleView {
  id: string;
  providerNorm: string;
  conceptNorm: string | null;
  categoryId: string | null;
  eventId: string;
}

export interface FinanceProviderAliasView {
  providerNorm: string;
  display: string;
}

/** Cruce de dos patas propuesto (transferencias y conciliación Amex). El uuid
 * de grupo lo genera el servidor: el dominio solo reutiliza grupos existentes. */
export interface TransferProposal {
  legIds: readonly [string, string];
  existingGroupId: string | null;
  status: "confirmada" | "sugerida_regla";
}

export interface InvestmentMirrorProposal {
  chargeTxId: string;
  investmentAccountId: string;
  mirrorOpDate: string;
  mirrorConcept: string;
  mirrorProvider: string;
  mirrorAmountCents: bigint; // positivo (abs del cargo)
  mirrorDedupHash: string; // `invmirror-${dedupHash del cargo}`
}

/** Retirada de cajero a recategorizar como gasto «Efectivo» confirmado. */
export interface CashProposal {
  txId: string;
}

export interface RecurrenceVerdict {
  txId: string;
  recurrence: "recurrente" | "extraordinario";
}

export interface EventAssignmentProposal {
  txId: string;
  eventId: string;
}

export interface SummaryOptions {
  from: string;
  to: string;
  accountIds?: readonly string[] | null;
  eventId?: string | null;
  excludeEventIds?: readonly string[];
  accounts: readonly FinanceAccountView[];
  /** eventos asignados por transacción (para filtros ev/exev). */
  eventIdsByTx?: ReadonlyMap<string, readonly string[]>;
}

export interface RangeSummary {
  incomeCents: bigint;
  expenseCents: bigint;
  recurringExpenseCents: bigint;
  extraordinaryExpenseCents: bigint;
  unclassifiedExpenseCents: bigint;
  savingsCents: bigint;
  netSavingsRate: number | null;
  grossSavingsRate: number | null;
  investedCents: bigint;
  investmentRate: number | null;
  freeCashFlowCents: bigint;
  opsCashFlowCents: bigint;
  receivedContributionsCents: bigint;
  outgoingTransfersCents: bigint;
  pendingCount: number;
  prev: RangeSummary | null;
}
```

Crea `packages/domain/src/finance/index.ts`:

```ts
export * from "./types.js";
export * from "./text.js";
```

En `packages/domain/package.json` añade el subpath (mismo patrón que `"./capabilities"` en `packages/contracts/package.json`):

```json
  "exports": {
    ".": "./src/index.ts",
    "./finance": "./src/finance/index.ts"
  },
```

- [ ] **Step 4: Verde.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/text.test.ts && pnpm --filter @casa-clara/domain typecheck`
- [ ] **Step 5: Commit.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && git add packages/domain && git commit -m "feat(finanzas): tipos canónicos del dominio y normalización de texto portada"`

---

### Task 2: `dedup.ts` (dominio) y `dedup-hash.ts` (servidor)

**Files:**
- Create: `packages/domain/src/finance/dedup.ts`
- Create: `packages/server/src/finance/dedup-hash.ts`
- Modify: `packages/domain/src/finance/index.ts`, `packages/server/src/index.ts`
- Test: `packages/domain/src/finance/dedup.test.ts`, `packages/server/src/finance/dedup-hash.test.ts`

**Interfaces:**
- Consumes: `normText(s: string): string` de `packages/domain/src/finance/text.ts`.
- Produces (canónicas):
  - `dedupKey(row: { bankRef: string; opDate: string; amountCents: bigint; concept: string; balanceCents: bigint | null; dedupRef: string | null }): string` (dominio).
  - `computeDedupHash(row: Parameters<typeof dedupKey>[0]): string` (servidor, sha256 hex).

Referencia Python: `/home/abf/github/home-finance/backend/app/money.py::dedup_hash`. Detalle CRÍTICO de compatibilidad: en Python `f"...|{balance_cents}"` con `None` produce el literal `"None"`; los hashes migrados se calcularon así, de modo que un balance null DEBE serializarse como `"None"`.

- [ ] **Step 1: Test que falla (dominio).** `packages/domain/src/finance/dedup.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { dedupKey } from "./index.js";

describe("dedupKey (cadena canónica de money.py::dedup_hash)", () => {
  it("compone bank_ref|fecha|importe|concepto normalizado|saldo", () => {
    expect(
      dedupKey({
        bankRef: "21000000000000001234",
        opDate: "2026-05-04",
        amountCents: -4230n,
        concept: "COMPRA TARJETA | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
        balanceCents: 102345n,
        dedupRef: null,
      }),
    ).toBe(
      "21000000000000001234|2026-05-04|-4230|COMPRA TARJETA | FECHA DE OPERACION: 02-05-2026 PELUQUERIA NONO | 04000174TCR|102345",
    );
  });

  it("serializa el saldo null como el literal Python «None» y añade la ref de Amex al final", () => {
    expect(
      dedupKey({
        bankRef: "XXXX-XXXXX-91009",
        opDate: "2026-05-06",
        amountCents: 1899n,
        concept: "AMAZON ES",
        balanceCents: null,
        dedupRef: "320261250012345678",
      }),
    ).toBe("XXXX-XXXXX-91009|2026-05-06|1899|AMAZON ES|None|320261250012345678");
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/dedup.test.ts` — falla: `dedupKey` no existe.
- [ ] **Step 3: Implementación (dominio).** `packages/domain/src/finance/dedup.ts`:

```ts
import { normText } from "./text.js";

/** Cadena canónica a hashear (port de money.py::dedup_hash SIN el sha256; el
 * sha256 lo aplica packages/server). COMPATIBILIDAD con los datos migrados:
 * un saldo null se serializa como "None" (así lo hacía el f-string de Python). */
export function dedupKey(row: {
  bankRef: string;
  opDate: string;
  amountCents: bigint;
  concept: string;
  balanceCents: bigint | null;
  dedupRef: string | null;
}): string {
  const balance = row.balanceCents === null ? "None" : String(row.balanceCents);
  const base = `${row.bankRef}|${row.opDate}|${String(row.amountCents)}|${normText(row.concept)}|${balance}`;
  return row.dedupRef === null ? base : `${base}|${row.dedupRef}`;
}
```

Añade a `packages/domain/src/finance/index.ts` la línea `export * from "./dedup.js";`.

- [ ] **Step 4: Verde dominio.** Repite el comando del Step 2 (pasa).
- [ ] **Step 5: Test que falla (servidor).** `packages/server/src/finance/dedup-hash.test.ts` — los dos sha256 esperados están calculados ejecutando `app/money.py::dedup_hash` del origen sobre estos mismos datos sintéticos (verificación cruzada Python↔TS):

```ts
import { describe, expect, it } from "vitest";

import { computeDedupHash } from "./dedup-hash.js";

describe("computeDedupHash (sha256 de la cadena canónica)", () => {
  it("reproduce exactamente los hashes del backend Python del origen", () => {
    expect(
      computeDedupHash({
        bankRef: "21000000000000001234",
        opDate: "2026-05-04",
        amountCents: -4230n,
        concept: "COMPRA TARJETA | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
        balanceCents: 102345n,
        dedupRef: null,
      }),
    ).toBe("46766c6626bc6b286b628eff47d396c622da72876c9ef63456d2d428286b09f7");
    expect(
      computeDedupHash({
        bankRef: "XXXX-XXXXX-91009",
        opDate: "2026-05-06",
        amountCents: 1899n,
        concept: "AMAZON ES",
        balanceCents: null,
        dedupRef: "320261250012345678",
      }),
    ).toBe("1037a18289c3589f522a2505a6fbcee2128c7d6c3a17eb0e0ab14200b0e6e78d");
  });
});
```

- [ ] **Step 6: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/server test src/finance/dedup-hash.test.ts` — falla: módulo inexistente.
- [ ] **Step 7: Implementación (servidor).** `packages/server/src/finance/dedup-hash.ts`:

```ts
import { createHash } from "node:crypto";

import { dedupKey } from "@casa-clara/domain/finance";

/** sha256 hex de la cadena canónica del dominio (compatible con los hashes migrados). */
export function computeDedupHash(row: Parameters<typeof dedupKey>[0]): string {
  return createHash("sha256").update(dedupKey(row), "utf8").digest("hex");
}
```

Añade a `packages/server/src/index.ts`, tras la línea `export * from "./database.js";`: `export * from "./finance/dedup-hash.js";`.

- [ ] **Step 8: Verde.** Repite Step 6 y `pnpm --filter @casa-clara/server typecheck`.
- [ ] **Step 9: Commit.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && git add packages/domain packages/server && git commit -m "feat(finanzas): clave de dedup canónica y sha256 compatible con el origen"`

---

### Task 3: `provider-norm.ts` — saneado de proveedores

**Files:**
- Create: `packages/domain/src/finance/provider-norm.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/provider-norm.test.ts`

**Interfaces:**
- Consumes: `normText` (`./text.js`); tipo `FinanceBank` (`./types.js`).
- Produces:
  - Canónicas: `normalizeProvider(concept: string): { provider: string | null; providerNorm: string | null }` · `paypalVendor(provider: string): string | null`.
  - Locales de fase 2 (las consumen los parsers de la Task 13/14): `normalizeBankProvider(input: { provider: string; concept: string; codeCommon: string | null; codeOwn: string | null; bank: FinanceBank }): string` · `CARD_PREFIX_RX: RegExp`.

Referencia Python: `/home/abf/github/home-finance/backend/app/provider_norm.py` — portar las 6 reglas CaixaBank + la regla Deutsche del préstamo + `_clean` + `paypal_vendor` con sus regex EXACTAS. `normalizeProvider(concept)` es la entrada genérica canónica (movimientos manuales, renormalización): primera «part» no vacía del concept limpiada + su `normText`; los parsers usan `normalizeBankProvider` (equivalente fiel del Python, que necesita banco y códigos).

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/provider-norm.test.ts` (valores dorados ejecutados contra el `provider_norm.py` del origen):

```ts
import { describe, expect, it } from "vitest";

import { normalizeBankProvider, normalizeProvider, paypalVendor } from "./index.js";

describe("normalizeBankProvider (port de provider_norm.py)", () => {
  it("tarjeta: el comercio es lo que sigue al prefijo de fecha en ESA celda", () => {
    expect(
      normalizeBankProvider({
        provider: "Fecha de operación: 02-05-2026 Peluquería Ñoño",
        concept:
          "COMPRA TARJETA | 5402XXXX1111 | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
        codeCommon: "11",
        codeOwn: "612",
        bank: "caixabank",
      }),
    ).toBe("Peluquería Ñoño");
  });

  it("recibo SEPA: quita CORE solo si hay celda con identificador de acreedor", () => {
    expect(
      normalizeBankProvider({
        provider: "CORE IBERDROLA CLIENTES",
        concept: "RECIBO LUZ | CORE IBERDROLA CLIENTES  X0001 | ES84002A82018474   X0040",
        codeCommon: "03",
        codeOwn: "230",
        bank: "caixabank",
      }),
    ).toBe("IBERDROLA CLIENTES");
  });

  it("transferencia 04/073 a empresa: prefiere el destinatario con forma societaria", () => {
    expect(
      normalizeBankProvider({
        provider: "ORDENANTE UNO",
        concept:
          "TRANSFERENCIAS | 2860 56 0001234                    IVI MAD | IVI Madrid S.L. | ORDENANTE UNO",
        codeCommon: "04",
        codeOwn: "073",
        bank: "caixabank",
      }),
    ).toBe("IVI Madrid S.L.");
  });

  it("bizum: la persona NOMBRE;APELLIDO;APELLIDO pasa a espacios", () => {
    expect(
      normalizeBankProvider({
        provider: "ENVIO BIZUM",
        concept: "BIZUM | ENVIO BIZUM | MARIA;GARCIA;LOPEZ | Cena viernes",
        codeCommon: "04",
        codeOwn: "002",
        bank: "caixabank",
      }),
    ).toBe("MARIA GARCIA LOPEZ");
  });

  it("MyBox: la fecha de la cuota mensual queda fuera del provider", () => {
    expect(
      normalizeBankProvider({
        provider: "CUOTA AGRUPADA MYBOX 01-05-2026",
        concept: "CUOTA AGRUPADA MYBOX 01-05-2026",
        codeCommon: "05",
        codeOwn: "704",
        bank: "caixabank",
      }),
    ).toBe("CUOTA AGRUPADA MYBOX");
  });

  it("deutsche: contador de cuota del préstamo fuera", () => {
    expect(
      normalizeBankProvider({
        provider: "PRESTAMO       028-20276496",
        concept: "PRESTAMO       028-20276496",
        codeCommon: null,
        codeOwn: null,
        bank: "deutsche_bank",
      }),
    ).toBe("PRESTAMO 20276496");
  });
});

describe("paypalVendor", () => {
  it("extrae el vendor de PAYPAL *X cortando en teléfonos/referencias", () => {
    expect(paypalVendor("PAYPAL *STEAM GAMES 4029357733")).toBe("Steam Games");
    expect(paypalVendor("PAYPAL *KOBO BOOKS")).toBe("Kobo Books");
    expect(paypalVendor("AMAZON ES")).toBeNull();
  });
});

describe("normalizeProvider (entrada genérica canónica)", () => {
  it("toma la primera parte no vacía del concept y su forma normalizada", () => {
    expect(normalizeProvider("RECIBO LUZ | CORE IBERDROLA CLIENTES")).toEqual({
      provider: "RECIBO LUZ",
      providerNorm: "RECIBO LUZ",
    });
    expect(normalizeProvider("  Peluquería   Ñoño  ")).toEqual({
      provider: "Peluquería Ñoño",
      providerNorm: "PELUQUERIA NONO",
    });
    expect(normalizeProvider("   ")).toEqual({ provider: null, providerNorm: null });
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/provider-norm.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/provider-norm.ts`:

```ts
import { normText } from "./text.js";
import type { FinanceBank } from "./types.js";

/** Regex portadas 1:1 de provider_norm.py (no cambiar sin cambiar el origen). */
export const CARD_PREFIX_RX = /Fecha de operaci[oó]n:\s*\d{2}-\d{2}-\d{4}\s*/;
const SEPA_PREFIX_RX = /^(CORE|B2B)/;
const SEPA_CREDITOR_RX = /^ES\d{2}\w+$/;
const TRANSFER_REF_RX = /^2860 56 \d{7}/;
const MYBOX_RX = /^CUOTA AGRUPADA MYBOX \d{2}-\d{2}-\d{4}$/;
const COMPANY_RX = /\b(S\.?L\.?U?|S\.?A\.?U?|S\.?C\.?P?|SLNE)\b\.?$/i;
const DB_LOAN_RX = /^PRESTAMO\s+\d+-(\d+)$/;
const PAYPAL_RX = /^PAYPAL \*(.+)$/;
const DIGITS6_RX = /\d{6,}/;

function clean(provider: string): string {
  return provider.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Port fiel de provider_norm.py::normalize_provider. Trabaja sobre las "parts"
 * del concept (celdas unidas con " | ") buscando PATRONES, nunca índices. */
export function normalizeBankProvider(input: {
  provider: string;
  concept: string;
  codeCommon: string | null;
  codeOwn: string | null;
  bank: FinanceBank;
}): string {
  const { concept, codeCommon, codeOwn, bank } = input;
  let provider = input.provider;
  const parts = concept
    .split(" | ")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (bank === "caixabank") {
    const cardPart = parts.find((p) => CARD_PREFIX_RX.test(p));
    if (cardPart !== undefined) {
      // (1) tarjeta: el comercio es lo que sigue al prefijo EN ESA celda.
      const m = CARD_PREFIX_RX.exec(cardPart) as RegExpExecArray;
      provider = cardPart.slice(m.index + m[0].length);
    } else {
      // (2) recibos SEPA: quitar CORE/B2B solo si hay celda hermana con acreedor SEPA.
      if (
        SEPA_PREFIX_RX.test(provider) &&
        parts.some((p) => p.split(/\s{2,}/).some((piece) => SEPA_CREDITOR_RX.test(piece)))
      ) {
        provider = provider.replace(SEPA_PREFIX_RX, "");
      }
      // (3) transferencia emitida 04/073: beneficiario truncado → nombre completo.
      if (codeCommon === "04" && codeOwn === "073") {
        const refIdx = parts.findIndex((p) => TRANSFER_REF_RX.test(p));
        if (refIdx !== -1) {
          const pieces = (parts[refIdx] as string).split(/\s{2,}/);
          const truncated = pieces[1];
          if (pieces.length > 1 && truncated) {
            const full = parts.find((p, i) => i !== refIdx && p.startsWith(truncated));
            provider = full ?? truncated;
          }
        }
      }
      // (4) Bizum: la persona viene como "NOMBRE;APELLIDO;APELLIDO" en una celda.
      if (codeOwn === "002") {
        const person = parts.find((p) => p.includes(";"));
        if (person !== undefined) provider = person.replace(/;/g, " ");
      }
      // (5) transferencia a una EMPRESA: se prefiere el destinatario con forma societaria.
      if ((codeCommon === "04" || codeCommon === "99") && !provider.includes(";")) {
        const company = parts.find(
          (p) => COMPANY_RX.test(p) && !p.includes("2860 56") && !SEPA_PREFIX_RX.test(p),
        );
        if (company !== undefined) provider = company;
      }
    }
    // (6) MyBox: la fecha de la cuota mensual fuera del provider.
    if (MYBOX_RX.test(clean(provider))) provider = "CUOTA AGRUPADA MYBOX";
  } else if (bank === "deutsche_bank") {
    const m = DB_LOAN_RX.exec(clean(provider));
    if (m !== null) provider = `PRESTAMO ${m[1] as string}`;
  }
  return clean(provider);
}

/** Entrada genérica canónica: deriva provider/provider_norm de un concepto
 * cualquiera (movimientos manuales, renormalización). Los parsers usan
 * normalizeBankProvider, el port fiel con banco y códigos Norma 43. */
export function normalizeProvider(concept: string): {
  provider: string | null;
  providerNorm: string | null;
} {
  const first =
    concept
      .split(" | ")
      .map((p) => p.trim())
      .find((p) => p.length > 0) ?? "";
  const provider = clean(first);
  if (provider === "") return { provider: null, providerNorm: null };
  return { provider, providerNorm: normText(provider) };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/** Port de provider_norm.py::paypal_vendor. */
export function paypalVendor(provider: string): string | null {
  const m = PAYPAL_RX.exec(clean(provider));
  if (m === null) return null;
  const words: string[] = [];
  for (const token of (m[1] as string).split(/\s+/).filter((t) => t.length > 0)) {
    if (DIGITS6_RX.test(token)) break; // teléfono/referencia: corta el vendor
    words.push(token);
  }
  const vendor = words.join(" ");
  return vendor === "" ? null : titleCase(vendor);
}
```

Añade `export * from "./provider-norm.js";` al barrel `packages/domain/src/finance/index.ts`.

- [ ] **Step 4: Verde.** Repite el comando del Step 2.
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): saneado de proveedores portado con sus seis reglas"`

---

### Task 4: `rules.ts` — motor de categorización

**Files:**
- Create: `packages/domain/src/finance/rules.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/rules.test.ts`

**Interfaces:**
- Consumes: `normText`; tipos `FinanceTxView`, `FinanceRuleView`, `FinanceRuleType` (Task 1).
- Produces (canónica): `matchRule(tx: FinanceTxView, rules: readonly FinanceRuleView[]): FinanceRuleView | null`.

Referencia Python: `/home/abf/github/home-finance/backend/app/rules_engine.py` — `SPECIFICITY = {proveedor_exacto: 3, concepto_contiene: 2, codigo_norma43: 1}`; orden por `(priority, specificity)` DESC; primera regla que casa gana. El esquema nuevo no tiene `code_common` en las reglas (ese filtro del origen desaparece); `codigo_norma43` compara `pattern` con `tx.codeCommon`. `matchRule` es por-transacción: filtrar por `status === "pendiente"` es responsabilidad del pipeline (como `apply_rules`).

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/rules.test.ts` (factoría local `tx()` para autocontención):

```ts
import { describe, expect, it } from "vitest";

import { matchRule, type FinanceRuleView, type FinanceTxView } from "./index.js";

function tx(overrides: Partial<FinanceTxView> = {}): FinanceTxView {
  return {
    id: "t1", accountId: "a1", opDate: "2026-06-05",
    concept: "RECIBO LUZ | CORE IBERDROLA CLIENTES", provider: "IBERDROLA CLIENTES",
    providerNorm: "IBERDROLA CLIENTES", amountCents: -5512n, categoryId: null,
    status: "pendiente", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: "h-t1", codeCommon: "03", codeOwn: "230",
    categoryKind: null, ...overrides,
  };
}
const rule = (o: Partial<FinanceRuleView>): FinanceRuleView => ({
  id: "r1", ruleType: "proveedor_exacto", pattern: "IBERDROLA CLIENTES",
  categoryId: "cat-casa", priority: 0, ...o,
});

describe("matchRule (port de rules_engine.py)", () => {
  it("proveedor_exacto compara formas normalizadas (tildes y espacios fuera)", () => {
    expect(matchRule(tx({ provider: "  Iberdrola   Clientes " }), [rule({})])).not.toBeNull();
    expect(matchRule(tx({ provider: null }), [rule({})])).toBeNull();
  });

  it("concepto_contiene busca la subcadena normalizada", () => {
    const r = rule({ id: "r2", ruleType: "concepto_contiene", pattern: "recibo luz" });
    expect(matchRule(tx(), [r])?.id).toBe("r2");
  });

  it("codigo_norma43 compara el código común exacto", () => {
    const r = rule({ id: "r3", ruleType: "codigo_norma43", pattern: "03" });
    expect(matchRule(tx(), [r])?.id).toBe("r3");
    expect(matchRule(tx({ codeCommon: "11" }), [r])).toBeNull();
  });

  it("mayor prioridad gana; a igual prioridad gana la más específica", () => {
    const generic = rule({ id: "gen", ruleType: "codigo_norma43", pattern: "03", priority: 0 });
    const specific = rule({ id: "spec", ruleType: "proveedor_exacto", priority: 0 });
    const priority = rule({ id: "prio", ruleType: "codigo_norma43", pattern: "03", priority: 5 });
    expect(matchRule(tx(), [generic, specific])?.id).toBe("spec");
    expect(matchRule(tx(), [generic, specific, priority])?.id).toBe("prio");
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/rules.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/rules.ts`:

```ts
import { normText } from "./text.js";
import type { FinanceRuleType, FinanceRuleView, FinanceTxView } from "./types.js";

/** Especificidad del origen: proveedor exacto > concepto contiene > código Norma 43. */
const SPECIFICITY: Record<FinanceRuleType, number> = {
  proveedor_exacto: 3,
  concepto_contiene: 2,
  codigo_norma43: 1,
};

function matches(rule: FinanceRuleView, tx: FinanceTxView): boolean {
  if (rule.ruleType === "proveedor_exacto") {
    return tx.provider !== null && normText(tx.provider) === normText(rule.pattern);
  }
  if (rule.ruleType === "concepto_contiene") {
    return normText(tx.concept).includes(normText(rule.pattern));
  }
  return tx.codeCommon === rule.pattern;
}

/** Primera regla que casa, ordenadas por (prioridad, especificidad) descendente
 * (port de rules_engine.apply_rules; el filtro status==="pendiente" lo aplica
 * el pipeline, no esta función). */
export function matchRule(
  tx: FinanceTxView,
  rules: readonly FinanceRuleView[],
): FinanceRuleView | null {
  const ordered = [...rules].sort(
    (a, b) => b.priority - a.priority || SPECIFICITY[b.ruleType] - SPECIFICITY[a.ruleType],
  );
  return ordered.find((r) => matches(r, tx)) ?? null;
}
```

Añade `export * from "./rules.js";` al barrel.

- [ ] **Step 4: Verde.** Repite Step 2.
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): motor de reglas con prioridad y especificidad del origen"`

---

### Task 5: `transfers.ts` — detección de cruces entre cuentas propias

**Files:**
- Create: `packages/domain/src/finance/transfers.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/transfers.test.ts`

**Interfaces:**
- Consumes: `normText`, `dayDiffIso`; tipos `FinanceTxView`, `FinanceAccountView`, `TransferProposal`.
- Produces (canónica): `detectTransferPairs(txs: readonly FinanceTxView[], accounts: readonly FinanceAccountView[]): TransferProposal[]`.

Referencia Python: `/home/abf/github/home-finance/backend/app/transfers.py::detect_transfers`. Fidelidad obligatoria: ventana ≤3 días; importes EXACTAMENTE opuestos; cuentas distintas; keywords `TRANSFERENCIA`/`TRASPASO` + `owner_aliases` normalizados confirman; candidatos = (sin grupo, status pendiente/sugerida_regla, categoría null o transferencia) ∪ (sin grupo, status≠confirmada, keyword en concepto), ordenados por `(opDate, id)`; más patas huérfanas (con grupo pero solas en él) y confirmadas-recuperables (confirmada, sin grupo, categoría kind ingreso, keyword+alias). El dominio NO genera uuids: la propuesta lleva `existingGroupId` (grupo de la pata huérfana) o null.

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/transfers.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  detectTransferPairs,
  type FinanceAccountView,
  type FinanceTxView,
} from "./index.js";

const acc = (id: string, aliases: string[] = []): FinanceAccountView => ({
  id, name: id, bank: "caixabank", kind: "comun", bankRef: `ref-${id}`,
  ownerAliases: aliases, transferRefs: [],
});
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-15", concept: "MOVIMIENTO",
    provider: null, providerNorm: null, amountCents: -1000n, categoryId: null,
    status: "pendiente", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: `h${n}`, codeCommon: null, codeOwn: null,
    categoryKind: null, ...overrides,
  };
}

describe("detectTransferPairs (port de transfers.py::detect_transfers)", () => {
  const accounts = [acc("a1", ["Padre Ejemplo"]), acc("a2")];

  it("cruza importes opuestos en cuentas distintas a ≤3 días; keyword+alias confirma", () => {
    const out = tx({ id: "out", accountId: "a1", amountCents: -30000n, concept: "TRASPASO A CUENTA AZUL Padre Ejemplo" });
    const back = tx({ id: "in", accountId: "a2", amountCents: 30000n, opDate: "2026-06-16", concept: "ABONO RECIBIDO" });
    const [p] = detectTransferPairs([out, back], accounts);
    expect(p).toEqual({ legIds: ["out", "in"], existingGroupId: null, status: "confirmada" });
  });

  it("sin keyword+alias la pareja queda como sugerida_regla", () => {
    const a = tx({ id: "x1", accountId: "a1", amountCents: -5000n });
    const b = tx({ id: "x2", accountId: "a2", amountCents: 5000n });
    expect(detectTransferPairs([a, b], accounts)[0]?.status).toBe("sugerida_regla");
  });

  it("no cruza misma cuenta, importes no opuestos ni más de 3 días", () => {
    const same = [tx({ accountId: "a1", amountCents: -100n }), tx({ accountId: "a1", amountCents: 100n })];
    const far = [
      tx({ accountId: "a1", amountCents: -100n, opDate: "2026-06-01" }),
      tx({ accountId: "a2", amountCents: 100n, opDate: "2026-06-05" }),
    ];
    expect(detectTransferPairs(same, accounts)).toHaveLength(0);
    expect(detectTransferPairs(far, accounts)).toHaveLength(0);
  });

  it("una pata huérfana reutiliza su grupo existente", () => {
    const lone = tx({ id: "lone", accountId: "a1", amountCents: -7000n, transferGroupId: "g-old", status: "confirmada" });
    const mate = tx({ id: "mate", accountId: "a2", amountCents: 7000n });
    const [p] = detectTransferPairs([lone, mate], accounts);
    expect(p?.existingGroupId).toBe("g-old");
  });

  it("recupera una confirmada como ingreso con keyword+alias (Aportaciones)", () => {
    const confirmed = tx({
      id: "conf", accountId: "a2", amountCents: 40000n, status: "confirmada",
      categoryId: "cat-ing", categoryKind: "ingreso",
      concept: "TRANSFERENCIA DE Padre Ejemplo APORTACION",
    });
    const charge = tx({ id: "chg", accountId: "a1", amountCents: -40000n });
    const pairs = detectTransferPairs([confirmed, charge], accounts);
    expect(pairs[0]?.legIds).toContain("conf");
  });

  it("una confirmada sin categoría de ingreso o sin keyword no se toca", () => {
    const confirmed = tx({ id: "c2", accountId: "a2", amountCents: 40000n, status: "confirmada", categoryKind: "gasto" });
    const charge = tx({ id: "c3", accountId: "a1", amountCents: -40000n });
    expect(detectTransferPairs([confirmed, charge], accounts)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/transfers.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/transfers.ts`:

```ts
import { dayDiffIso, normText } from "./text.js";
import type { FinanceAccountView, FinanceTxView, TransferProposal } from "./types.js";

const KEYWORDS = ["TRANSFERENCIA", "TRASPASO"] as const;

function allAliases(accounts: readonly FinanceAccountView[]): Set<string> {
  const aliases = new Set<string>();
  for (const acc of accounts) for (const a of acc.ownerAliases) aliases.add(normText(a));
  return aliases;
}

function isKeywordTransfer(tx: FinanceTxView, aliases: ReadonlySet<string>): boolean {
  const concept = normText(tx.concept);
  return (
    KEYWORDS.some((k) => concept.includes(k)) &&
    [...aliases].some((a) => concept.includes(a))
  );
}

function hasKeyword(tx: FinanceTxView): boolean {
  const concept = normText(tx.concept);
  return KEYWORDS.some((k) => concept.includes(k));
}

/** Patas con transfer_group_id pero solas en su grupo (huérfanas de un traspaso). */
function loneLegs(txs: readonly FinanceTxView[]): FinanceTxView[] {
  const counts = new Map<string, number>();
  for (const t of txs) {
    if (t.transferGroupId !== null) counts.set(t.transferGroupId, (counts.get(t.transferGroupId) ?? 0) + 1);
  }
  return txs.filter((t) => t.transferGroupId !== null && counts.get(t.transferGroupId) === 1);
}

/** Port de transfers.py::detect_transfers como función pura: recibe TODAS las
 * transacciones del hogar y devuelve propuestas de cruce; los uuid de grupo
 * nuevos los pone el servidor (existingGroupId solo si reutiliza una huérfana). */
export function detectTransferPairs(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
): TransferProposal[] {
  const aliases = allAliases(accounts);
  const lone = loneLegs(txs);
  const loneIds = new Set(lone.map((t) => t.id));
  const base = txs.filter(
    (t) =>
      t.transferGroupId === null &&
      (t.status === "pendiente" || t.status === "sugerida_regla") &&
      (t.categoryId === null || t.categoryKind === "transferencia"),
  );
  const extra = txs.filter(
    (t) => t.transferGroupId === null && t.status !== "confirmada" && hasKeyword(t),
  );
  const byId = new Map<string, FinanceTxView>();
  for (const t of [...base, ...extra]) byId.set(t.id, t);
  const sortedBase = [...byId.values()].sort(
    (a, b) => a.opDate.localeCompare(b.opDate) || a.id.localeCompare(b.id),
  );
  const reclaimable = txs.filter(
    (t) =>
      t.transferGroupId === null &&
      t.status === "confirmada" &&
      t.categoryKind === "ingreso" &&
      isKeywordTransfer(t, aliases),
  );
  const candidates = [...sortedBase, ...lone, ...reclaimable];

  const proposals: TransferProposal[] = [];
  const used = new Set<string>();
  for (const tx of candidates) {
    if (used.has(tx.id)) continue;
    for (const other of candidates) {
      if (
        other.id !== tx.id &&
        !used.has(other.id) &&
        other.accountId !== tx.accountId &&
        other.amountCents === -tx.amountCents &&
        Math.abs(dayDiffIso(other.opDate, tx.opDate)) <= 3
      ) {
        const existingGroupId = loneIds.has(tx.id)
          ? tx.transferGroupId
          : loneIds.has(other.id)
            ? other.transferGroupId
            : null;
        const status =
          isKeywordTransfer(tx, aliases) || isKeywordTransfer(other, aliases)
            ? "confirmada"
            : "sugerida_regla";
        proposals.push({ legIds: [tx.id, other.id], existingGroupId, status });
        used.add(tx.id);
        used.add(other.id);
        break;
      }
    }
  }
  return proposals;
}
```

Añade `export * from "./transfers.js";` al barrel.

- [ ] **Step 4: Verde.** Repite Step 2.
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): detección de traspasos con ventana de 3 días y recuperación de patas"`

---

### Task 6: `amex.ts` — conciliación recibo ↔ cargo bancario

**Files:**
- Create: `packages/domain/src/finance/amex.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/amex.test.ts`

**Interfaces:**
- Consumes: `normText`, `dayDiffIso`; tipos `FinanceTxView`, `FinanceAccountView`, `TransferProposal`.
- Produces (canónica): `reconcileAmex(txs: readonly FinanceTxView[], accounts: readonly FinanceAccountView[]): TransferProposal[]`.

Referencia Python: `/home/abf/github/home-finance/backend/app/amex.py::reconcile_amex_payments`. Fidelidad: marcador de recibo `"RECIBO ENVIADO A SU BANCO"` en el concepto normalizado de la cuenta Amex (importe > 0, sin grupo); marcador de cargo `"AMERICAN EXPRESS"` en `normText(provider + " " + concept)` de cuentas NO Amex (importe < 0, sin grupo); importe exacto opuesto; ventana ±10 días; entre varios candidatos gana el de MENOR distancia en días (el primero en orden si empatan); status siempre `confirmada`.

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/amex.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { reconcileAmex, type FinanceAccountView, type FinanceTxView } from "./index.js";

const accounts: FinanceAccountView[] = [
  { id: "amex1", name: "Amex Oro", bank: "amex", kind: "personal", bankRef: "XXXX-XXXXX-91009", ownerAliases: [], transferRefs: [] },
  { id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bankRef: "21000000000000001234", ownerAliases: [], transferRefs: [] },
];
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-10", concept: "X", provider: null,
    providerNorm: null, amountCents: -1000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: null, codeOwn: null, categoryKind: null, ...overrides,
  };
}
const payment = (id: string, cents: bigint, opDate: string) =>
  tx({ id, accountId: "amex1", amountCents: cents, opDate, concept: "Recibo enviado a su banco" });
const charge = (id: string, cents: bigint, opDate: string) =>
  tx({ id, amountCents: cents, opDate, provider: "AMERICAN EXPRESS EUROPE", concept: "ADEUDO SEPA" });

describe("reconcileAmex (port de amex.py::reconcile_amex_payments)", () => {
  it("empareja recibo (+) con cargo (−) exacto a ≤10 días como confirmada", () => {
    const [p] = reconcileAmex([payment("pay", 50000n, "2026-06-10"), charge("chg", -50000n, "2026-06-14")], accounts);
    expect(p).toEqual({ legIds: ["pay", "chg"], existingGroupId: null, status: "confirmada" });
  });

  it("elige el cargo más cercano en fecha y no reutiliza cargos", () => {
    const pairs = reconcileAmex(
      [
        payment("pay", 50000n, "2026-06-10"),
        charge("far", -50000n, "2026-06-19"),
        charge("near", -50000n, "2026-06-11"),
      ],
      accounts,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.legIds).toEqual(["pay", "near"]);
  });

  it("fuera de ventana, importe distinto o sin marcador: nada", () => {
    expect(reconcileAmex([payment("p1", 50000n, "2026-06-01"), charge("c1", -50000n, "2026-06-13")], accounts)).toHaveLength(0);
    expect(reconcileAmex([payment("p2", 50000n, "2026-06-10"), charge("c2", -49999n, "2026-06-11")], accounts)).toHaveLength(0);
    const noMarker = tx({ id: "c3", amountCents: -50000n, provider: "OTRO", concept: "ADEUDO" });
    expect(reconcileAmex([payment("p3", 50000n, "2026-06-10"), noMarker], accounts)).toHaveLength(0);
  });

  it("sin cuenta Amex no hay nada que conciliar", () => {
    const soloCaixa = accounts.filter((a) => a.bank !== "amex");
    expect(reconcileAmex([payment("p4", 50000n, "2026-06-10"), charge("c4", -50000n, "2026-06-11")], soloCaixa)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/amex.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/amex.ts`:

```ts
import { dayDiffIso, normText } from "./text.js";
import type { FinanceAccountView, FinanceTxView, TransferProposal } from "./types.js";

const RECIBO_MARKER = "RECIBO ENVIADO A SU BANCO";
const BANK_SIDE_MARKER = "AMERICAN EXPRESS";
const MATCH_WINDOW_DAYS = 10;

/** Port de amex.py::reconcile_amex_payments: recibo Amex (+) ↔ cargo bancario
 * (−), importe exacto, ±10 días, gana el más cercano; ambas patas confirmadas. */
export function reconcileAmex(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
): TransferProposal[] {
  const amexIds = new Set(accounts.filter((a) => a.bank === "amex").map((a) => a.id));
  if (amexIds.size === 0) return [];
  const payments = txs
    .filter(
      (t) =>
        amexIds.has(t.accountId) &&
        t.amountCents > 0n &&
        t.transferGroupId === null &&
        normText(t.concept).includes(RECIBO_MARKER),
    )
    .sort((a, b) => a.opDate.localeCompare(b.opDate) || a.id.localeCompare(b.id));
  const charges = txs.filter(
    (t) =>
      !amexIds.has(t.accountId) &&
      t.amountCents < 0n &&
      t.transferGroupId === null &&
      normText(`${t.provider ?? ""} ${t.concept}`).includes(BANK_SIDE_MARKER),
  );
  const proposals: TransferProposal[] = [];
  const used = new Set<string>();
  for (const pay of payments) {
    const candidates = charges.filter(
      (c) =>
        !used.has(c.id) &&
        c.amountCents === -pay.amountCents &&
        Math.abs(dayDiffIso(c.opDate, pay.opDate)) <= MATCH_WINDOW_DAYS,
    );
    if (candidates.length === 0) continue;
    const charge = candidates.reduce((best, c) =>
      Math.abs(dayDiffIso(c.opDate, pay.opDate)) < Math.abs(dayDiffIso(best.opDate, pay.opDate)) ? c : best,
    );
    used.add(charge.id);
    proposals.push({ legIds: [pay.id, charge.id], existingGroupId: null, status: "confirmada" });
  }
  return proposals;
}
```

Añade `export * from "./amex.js";` al barrel.

- [ ] **Step 4: Verde.** Repite Step 2.
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): conciliación amex con ventana de diez días"`

---

### Task 7: `investments.ts` y `cash.ts`

**Files:**
- Create: `packages/domain/src/finance/investments.ts`, `packages/domain/src/finance/cash.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/investments.test.ts`, `packages/domain/src/finance/cash.test.ts`

**Interfaces:**
- Consumes: `normText`; tipos `FinanceTxView`, `FinanceAccountView`, `InvestmentMirrorProposal`, `CashProposal`.
- Produces:
  - Canónicas: `detectInvestmentContributions(txs, accounts): InvestmentMirrorProposal[]` · `detectCashMovements(txs, accounts): CashProposal[]`.
  - Local (la consume el comando `finance.transaction.manual.create` de fase 5): `cashCounterlegFor(expense: FinanceTxView, opts: { cashAccountId: string; efectivoCategoryId: string }): CashCounterleg | null` con `interface CashCounterleg { accountId: string; opDate: string; concept: string; provider: string; amountCents: bigint; categoryId: string; dedupHash: string }`.

Referencias Python: `/home/abf/github/home-finance/backend/app/investments.py` y `/home/abf/github/home-finance/backend/app/cash.py`. Fidelidad inversiones: `INVESTMENT_REF_RX = /2860 56 (\d{7})/` SIN ancla, buscada en `concept` (NUNCA en provider: el saneado 04/073 lo reescribe); refs no numéricas → substring de `normText(provider + " " + concept)`; candidatos = importe<0, sin grupo, banco de la cuenta ∉ {efectivo, inversion, amex}; idempotencia por hash `invmirror-`; ref sin mapeo → se queda pendiente, nunca se espeja a ciegas. Los `INVESTMENT_ACCOUNTS` hardcodeados del origen NO se portan: los `transfer_refs` son datos (spec §5). Fidelidad efectivo: `WITHDRAWAL_RX` exacta; retirada = cargo sin grupo, cuenta ≠ Efectivo, status ≠ confirmada; contrapartida de gasto manual con hash `cashpair-`.

- [ ] **Step 1: Test que falla (inversiones).** `packages/domain/src/finance/investments.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  detectInvestmentContributions,
  type FinanceAccountView,
  type FinanceTxView,
} from "./index.js";

const accounts: FinanceAccountView[] = [
  { id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bankRef: "r1", ownerAliases: [], transferRefs: [] },
  { id: "inv1", name: "Fondo Índice Global", bank: "inversion", kind: "inversion", bankRef: "INV-1", ownerAliases: [], transferRefs: ["0001234"] },
  { id: "inv2", name: "Plan Pensiones", bank: "inversion", kind: "inversion", bankRef: "INV-2", ownerAliases: [], transferRefs: ["COREINDEXA"] },
];
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-12", concept: "X", provider: null,
    providerNorm: null, amountCents: -25000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: "04", codeOwn: "073", categoryKind: null, ...overrides,
  };
}

describe("detectInvestmentContributions (port de investments.py)", () => {
  it("ref numérica de 7 dígitos casa contra «2860 56 <ref>» EN EL CONCEPTO", () => {
    const charge = tx({ id: "chg", concept: "TRANSFERENCIAS | 2860 56 0001234 APORTACION", provider: "BENEFICIARIO REESCRITO", dedupHash: "hash-chg" });
    const [p] = detectInvestmentContributions([charge], accounts);
    expect(p).toMatchObject({
      chargeTxId: "chg",
      investmentAccountId: "inv1",
      mirrorAmountCents: 25000n,
      mirrorDedupHash: "invmirror-hash-chg",
      mirrorProvider: "Fondo Índice Global",
    });
    expect(p?.mirrorConcept).toContain("Fondo Índice Global");
  });

  it("ref textual casa por substring sobre provider+concept normalizados", () => {
    const charge = tx({ id: "c2", concept: "RECIBO COREINDEXA PENSIONES", provider: "INDEXA" });
    expect(detectInvestmentContributions([charge], accounts)[0]?.investmentAccountId).toBe("inv2");
  });

  it("ref sin mapeo, cuenta excluida o espejo ya existente: nada", () => {
    const unmapped = tx({ id: "u1", concept: "TRANSFERENCIAS | 2860 56 9999999 X" });
    const amex = tx({ id: "u2", accountId: "amex1", concept: "2860 56 0001234" });
    const accountsConAmex = [...accounts, { id: "amex1", name: "Amex", bank: "amex", kind: "personal" as const, bankRef: "rx", ownerAliases: [], transferRefs: [] }];
    const mirrored = tx({ id: "u3", concept: "2860 56 0001234", dedupHash: "hh" });
    const mirror = tx({ id: "u4", accountId: "inv1", amountCents: 25000n, dedupHash: "invmirror-hh", transferGroupId: "g1" });
    expect(detectInvestmentContributions([unmapped], accounts)).toHaveLength(0);
    expect(detectInvestmentContributions([amex], accountsConAmex)).toHaveLength(0);
    expect(detectInvestmentContributions([mirrored, mirror], accounts)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/investments.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/investments.ts`:

```ts
import { normText } from "./text.js";
import type { FinanceAccountView, FinanceTxView, InvestmentMirrorProposal } from "./types.js";

const INVESTMENT_REF_RX = /2860 56 (\d{7})/; // sin ancla: se busca dentro de concept
const NUMERIC_REF_RX = /^\d{7}$/;
const EXCLUDED_BANKS = new Set(["efectivo", "inversion", "amex"]);

function matchInvestmentAccount(
  tx: FinanceTxView,
  invAccounts: readonly FinanceAccountView[],
): FinanceAccountView | null {
  // La ref numérica se compara con el grupo 1 de INVESTMENT_REF_RX sobre el
  // CONCEPTO (nunca el provider: el saneado 04/073 lo reescribe al beneficiario).
  const refMatch = INVESTMENT_REF_RX.exec(tx.concept);
  const haystack = normText(`${tx.provider ?? ""} ${tx.concept}`);
  for (const acc of invAccounts) {
    for (const ref of acc.transferRefs) {
      if (NUMERIC_REF_RX.test(ref)) {
        if (refMatch !== null && refMatch[1] === ref) return acc;
      } else if (haystack !== "" && haystack.includes(normText(ref))) {
        return acc;
      }
    }
  }
  return null;
}

/** Port de investments.py::detect_investment_contributions como función pura.
 * Idempotente vía hash `invmirror-`; una ref sin mapeo nunca se espeja a ciegas. */
export function detectInvestmentContributions(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
): InvestmentMirrorProposal[] {
  const invAccounts = accounts.filter((a) => a.kind === "inversion");
  const bankOf = new Map(accounts.map((a) => [a.id, a.bank]));
  const existingHashes = new Set(txs.map((t) => t.dedupHash));
  const proposals: InvestmentMirrorProposal[] = [];
  for (const tx of txs) {
    if (tx.amountCents >= 0n || tx.transferGroupId !== null) continue;
    if (EXCLUDED_BANKS.has(bankOf.get(tx.accountId) ?? "")) continue;
    const acc = matchInvestmentAccount(tx, invAccounts);
    if (acc === null) continue;
    const mirrorHash = `invmirror-${tx.dedupHash}`;
    if (existingHashes.has(mirrorHash)) continue;
    existingHashes.add(mirrorHash);
    proposals.push({
      chargeTxId: tx.id,
      investmentAccountId: acc.id,
      mirrorOpDate: tx.opDate,
      mirrorConcept: `Aportación a ${acc.name} — ${tx.provider ?? ""}`,
      mirrorProvider: acc.name,
      mirrorAmountCents: -tx.amountCents,
      mirrorDedupHash: mirrorHash,
    });
  }
  return proposals;
}
```

Añade `export * from "./investments.js";` al barrel y verifica verde con el comando del Step 2.

- [ ] **Step 4: Test que falla (efectivo).** `packages/domain/src/finance/cash.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  cashCounterlegFor,
  detectCashMovements,
  type FinanceAccountView,
  type FinanceTxView,
} from "./index.js";

const accounts: FinanceAccountView[] = [
  { id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bankRef: "r1", ownerAliases: [], transferRefs: [] },
  { id: "cash", name: "Efectivo", bank: "efectivo", kind: "comun", bankRef: "EFECTIVO", ownerAliases: [], transferRefs: [] },
];
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-18", concept: "X", provider: null,
    providerNorm: null, amountCents: -6000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: null, codeOwn: null, categoryKind: null, ...overrides,
  };
}

describe("detectCashMovements (port de cash.py::detect_cash_withdrawals)", () => {
  it("reconoce las variantes de retirada del regex del origen", () => {
    for (const concept of ["REINT. CAJERO 1234", "CAJERO AUTOMATICO", "RETIRADA DE EFECTIVO", "RETIRADA EFECTIVO", "USO ATM"]) {
      expect(detectCashMovements([tx({ concept })], accounts)).toHaveLength(1);
    }
  });
  it("ignora abonos, confirmadas, agrupadas y la propia cuenta Efectivo", () => {
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", amountCents: 6000n })], accounts)).toHaveLength(0);
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", status: "confirmada" })], accounts)).toHaveLength(0);
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", transferGroupId: "g" })], accounts)).toHaveLength(0);
    expect(detectCashMovements([tx({ concept: "REINT. CAJERO", accountId: "cash" })], accounts)).toHaveLength(0);
  });
});

describe("cashCounterlegFor (port de cash.py::create_cash_counterleg)", () => {
  const opts = { cashAccountId: "cash", efectivoCategoryId: "cat-ef" };
  it("crea la contrapartida +Efectivo con hash cashpair- para un gasto en Efectivo", () => {
    const gasto = tx({ accountId: "cash", amountCents: -1500n, categoryId: "cat-ocio", categoryKind: "gasto", concept: "Cañas", dedupHash: "hg" });
    expect(cashCounterlegFor(gasto, opts)).toEqual({
      accountId: "cash", opDate: "2026-06-18", concept: "Contrapartida efectivo — Cañas",
      provider: "EFECTIVO", amountCents: 1500n, categoryId: "cat-ef", dedupHash: "cashpair-hg",
    });
  });
  it("no aplica fuera de Efectivo, a abonos, sin categoría, a la propia Efectivo o a no-gasto", () => {
    expect(cashCounterlegFor(tx({ categoryId: "c", categoryKind: "gasto" }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", amountCents: 100n, categoryId: "c", categoryKind: "gasto" }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", categoryId: null }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", categoryId: "cat-ef", categoryKind: "gasto" }), opts)).toBeNull();
    expect(cashCounterlegFor(tx({ accountId: "cash", categoryId: "c", categoryKind: "ingreso" }), opts)).toBeNull();
  });
});
```

- [ ] **Step 5: Verlo fallar.** `pnpm --filter @casa-clara/domain test src/finance/cash.test.ts` (con el prefijo de PATH y cd habituales).
- [ ] **Step 6: Implementación.** `packages/domain/src/finance/cash.ts`:

```ts
import type { CashProposal, FinanceAccountView, FinanceTxView } from "./types.js";

/** Regex portada 1:1 de cash.py::WITHDRAWAL_RX. */
const WITHDRAWAL_RX = /REINT\.?\s*CAJERO|CAJERO\s+AUTOM|RETIRADA\s+(DE\s+)?EFECTIVO|\bCAJERO\b|\bATM\b/i;

/** Port de cash.py::detect_cash_withdrawals: retiradas de cajero a recategorizar
 * como gasto «Efectivo» confirmado (la categoría la resuelve/crea el pipeline). */
export function detectCashMovements(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
): CashProposal[] {
  const cashAccountIds = new Set(accounts.filter((a) => a.bank === "efectivo").map((a) => a.id));
  return txs
    .filter(
      (t) =>
        t.amountCents < 0n &&
        t.transferGroupId === null &&
        !cashAccountIds.has(t.accountId) &&
        t.status !== "confirmada" &&
        WITHDRAWAL_RX.test(`${t.provider ?? ""} ${t.concept}`),
    )
    .map((t) => ({ txId: t.id }));
}

export interface CashCounterleg {
  accountId: string;
  opDate: string;
  concept: string;
  provider: string;
  amountCents: bigint;
  categoryId: string;
  dedupHash: string;
}

/** Port de cash.py::create_cash_counterleg: contrapartida +Efectivo (confirmada,
 * recurrence_manual=true, hash `cashpair-`) de un gasto manual en la cuenta Efectivo. */
export function cashCounterlegFor(
  expense: FinanceTxView,
  opts: { cashAccountId: string; efectivoCategoryId: string },
): CashCounterleg | null {
  if (
    expense.accountId !== opts.cashAccountId ||
    expense.amountCents >= 0n ||
    expense.categoryId === null ||
    expense.categoryId === opts.efectivoCategoryId ||
    expense.categoryKind !== "gasto"
  ) {
    return null;
  }
  return {
    accountId: opts.cashAccountId,
    opDate: expense.opDate,
    concept: `Contrapartida efectivo — ${expense.concept}`,
    provider: "EFECTIVO",
    amountCents: -expense.amountCents,
    categoryId: opts.efectivoCategoryId,
    dedupHash: `cashpair-${expense.dedupHash}`,
  };
}
```

Añade `export * from "./cash.js";` al barrel.

- [ ] **Step 7: Verde ambos.** `pnpm --filter @casa-clara/domain test src/finance/investments.test.ts src/finance/cash.test.ts`
- [ ] **Step 8: Commit.** `git add packages/domain && git commit -m "feat(finanzas): espejos de inversión y doble entrada de efectivo"`

---

### Task 8: `recurrence.ts` — huella y veredicto de recurrencia

**Files:**
- Create: `packages/domain/src/finance/recurrence.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/recurrence.test.ts`

**Interfaces:**
- Consumes: `normText`; tipos `FinanceTxView`, `RecurrenceVerdict`.
- Produces: canónica `assessRecurrence(txs: readonly FinanceTxView[]): RecurrenceVerdict[]` (devuelve SOLO los veredictos que cambian, de filas sin decisión manual y sin grupo); locales `recurrenceFingerprint(provider: string | null, codeCommon: string | null, amountCents: bigint): string` e `isRecurrentGroup(txs: readonly FinanceTxView[]): boolean`.

Referencia Python: `/home/abf/github/home-finance/backend/app/recurrence.py`. Umbrales EXACTOS: recurrente si ≥3 meses distintos; con exactamente 2 meses hace falta una señal fuerte: mediana estable (desviación absoluta mediana / mediana ≤ 0,35), mismo día ±4 con vuelta de fin de mes (`min+31−max ≤ 4`), o patrón `RECIBO|NOMINA|CUOTA|PRESTAMO` / códigos 03/05. La huella quita referencias (`\d{4,}` y `\d+[-/]\d+`) del provider normalizado; sin letras → `"{code||'??'}|{tramo de 50 €}"`. La evidencia del grupo incluye TODAS las filas (manuales también); el veredicto solo se escribe en las elegibles. La mediana se calcula en bigint exacto trabajando al doble (nunca floats con dinero).

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/recurrence.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  assessRecurrence,
  isRecurrentGroup,
  recurrenceFingerprint,
  type FinanceTxView,
} from "./index.js";

let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-05", concept: "RECIBO LUZ",
    provider: "IBERDROLA CLIENTES 987654", providerNorm: null, amountCents: -5512n,
    categoryId: null, status: "confirmada", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: `h${n}`, codeCommon: "03", codeOwn: null,
    categoryKind: null, ...overrides,
  };
}

describe("recurrenceFingerprint (valores dorados del recurrence.py del origen)", () => {
  it("quita referencias y cae al tramo de 50 € si no quedan letras", () => {
    expect(recurrenceFingerprint("IBERDROLA CLIENTES 987654", "03", -5512n)).toBe("IBERDROLA CLIENTES");
    expect(recurrenceFingerprint("PRESTAMO 20276496", "05", -43512n)).toBe("PRESTAMO");
    expect(recurrenceFingerprint("2860 56 0001234", "04", -25000n)).toBe("04|5");
    expect(recurrenceFingerprint(null, null, -1500n)).toBe("??|0");
  });
});

describe("isRecurrentGroup (umbrales exactos del origen)", () => {
  const at = (opDate: string, cents: bigint, extra: Partial<FinanceTxView> = {}) =>
    tx({ opDate, amountCents: cents, codeCommon: null, concept: "PAGO", ...extra });
  it("≥3 meses distintos: recurrente sin más señales", () => {
    expect(isRecurrentGroup([at("2026-04-06", -100n), at("2026-05-05", -999n), at("2026-06-05", -5n)])).toBe(true);
  });
  it("2 meses: mediana estable ≤35 % o día ±4 (con vuelta de mes) o patrón recibo", () => {
    expect(isRecurrentGroup([at("2026-05-03", -5512n), at("2026-06-04", -5304n)])).toBe(true); // estable y día
    expect(isRecurrentGroup([at("2026-05-02", -1000n), at("2026-06-28", -9000n)])).toBe(false);
    expect(isRecurrentGroup([at("2026-05-30", -1000n), at("2026-06-02", -9000n)])).toBe(true); // wrap fin de mes
    expect(isRecurrentGroup([at("2026-05-02", -1000n), at("2026-06-20", -9000n, { concept: "CUOTA CLUB" })])).toBe(true);
    expect(isRecurrentGroup([at("2026-05-02", -1000n, { codeCommon: "05" }), at("2026-06-20", -9000n, { codeCommon: "05" })])).toBe(true);
  });
  it("1 mes: nunca recurrente", () => {
    expect(isRecurrentGroup([at("2026-06-01", -100n), at("2026-06-20", -100n)])).toBe(false);
  });
});

describe("assessRecurrence", () => {
  it("agrupa por huella+signo, respeta recurrence_manual y las patas de traspaso", () => {
    const a = tx({ id: "a", opDate: "2026-04-06" });
    const b = tx({ id: "b", opDate: "2026-05-05" });
    const c = tx({ id: "c", opDate: "2026-06-05", recurrenceManual: true });
    const d = tx({ id: "d", opDate: "2026-06-06", transferGroupId: "g1" });
    const solo = tx({ id: "solo", provider: "TIENDA UNICA", opDate: "2026-06-10" });
    const verdicts = assessRecurrence([a, b, c, d, solo]);
    expect(verdicts).toContainEqual({ txId: "a", recurrence: "recurrente" });
    expect(verdicts).toContainEqual({ txId: "b", recurrence: "recurrente" });
    expect(verdicts).toContainEqual({ txId: "solo", recurrence: "extraordinario" });
    expect(verdicts.map((v) => v.txId)).not.toContain("c");
    expect(verdicts.map((v) => v.txId)).not.toContain("d");
  });
  it("puede degradar recurrente→extraordinario y no repite veredictos ya escritos", () => {
    const stale = tx({ id: "s", recurrence: "recurrente", provider: "TIENDA X" });
    const done = tx({ id: "ok", recurrence: "extraordinario", provider: "TIENDA Y" });
    const verdicts = assessRecurrence([stale, done]);
    expect(verdicts).toContainEqual({ txId: "s", recurrence: "extraordinario" });
    expect(verdicts.map((v) => v.txId)).not.toContain("ok");
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/domain test src/finance/recurrence.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/recurrence.ts`:

```ts
import { normText } from "./text.js";
import type { FinanceTxView, RecurrenceVerdict } from "./types.js";

const REF_RX = /\d{4,}|\b\d+[-/]\d+\b/g;
const RECEIPT_RX = /\bRECIBO\b|\bNOMINA\b|\bCUOTA\b|\bPRESTAMO\b/;

/** Port de recurrence.py::fingerprint: proveedor normalizado sin referencias;
 * sin letras, cae a "{código o ??}|{tramo de 50 €}". */
export function recurrenceFingerprint(
  provider: string | null,
  codeCommon: string | null,
  amountCents: bigint,
): string {
  const base = normText(provider ?? "")
    .replace(REF_RX, "")
    .trim()
    .replace(/\s{2,}/g, " ");
  if (base !== "" && /[A-Z]/.test(base)) return base;
  const abs = amountCents < 0n ? -amountCents : amountCents;
  return `${codeCommon ?? "??"}|${abs / 5000n}`;
}

/** Mediana ×2 (siempre entera) de una lista de bigints. */
function median2(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? 2n * (sorted[mid] as bigint)
    : (sorted[mid - 1] as bigint) + (sorted[mid] as bigint);
}

/** Port de recurrence.py::is_recurrent_group con mediana exacta en bigint:
 * medAbsDev/med ≤ 0.35  ⇔  median2(|2a−med2|)·100 ≤ med2·70. */
export function isRecurrentGroup(txs: readonly FinanceTxView[]): boolean {
  const months = new Set(txs.map((t) => t.opDate.slice(0, 7)));
  if (months.size >= 3) return true;
  if (months.size < 2) return false;
  const amounts = txs.map((t) => (t.amountCents < 0n ? -t.amountCents : t.amountCents));
  const med2 = median2(amounts);
  const devs = amounts.map((a) => {
    const d = 2n * a - med2;
    return d < 0n ? -d : d;
  });
  const stable = med2 > 0n && median2(devs) * 100n <= med2 * 70n;
  const days = txs.map((t) => Number(t.opDate.slice(8, 10)));
  const maxD = Math.max(...days);
  const minD = Math.min(...days);
  const dayClose = maxD - minD <= 4 || minD + 31 - maxD <= 4; // wrap fin de mes
  const receipt = txs.some(
    (t) => t.codeCommon === "03" || t.codeCommon === "05" || RECEIPT_RX.test(normText(t.concept)),
  );
  return stable || dayClose || receipt;
}

/** Port de recurrence.py::detect_recurrence: agrupa TODAS las no-transferencia
 * por (huella, signo); la evidencia incluye manuales, pero el veredicto solo se
 * devuelve para filas elegibles (sin decisión manual, sin grupo) cuyo valor cambia. */
export function assessRecurrence(txs: readonly FinanceTxView[]): RecurrenceVerdict[] {
  const groups = new Map<string, FinanceTxView[]>();
  for (const t of txs) {
    if (t.transferGroupId !== null) continue;
    const key = `${recurrenceFingerprint(t.provider, t.codeCommon, t.amountCents)}\u0000${t.amountCents > 0n}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  const verdicts: RecurrenceVerdict[] = [];
  for (const groupTxs of groups.values()) {
    const verdict = isRecurrentGroup(groupTxs) ? "recurrente" : "extraordinario";
    for (const t of groupTxs) {
      if (t.recurrenceManual || t.transferGroupId !== null) continue;
      if (t.recurrence !== verdict) verdicts.push({ txId: t.id, recurrence: verdict });
    }
  }
  return verdicts;
}
```

Añade `export * from "./recurrence.js";` al barrel.

- [ ] **Step 4: Verde.** Repite Step 2.
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): recurrencia multi-señal con mediana exacta en bigint"`

---

### Task 9: `event-rules.ts` — reglas de evento

**Files:**
- Create: `packages/domain/src/finance/event-rules.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/event-rules.test.ts`

**Interfaces:**
- Consumes: `normText`, `normalizeConcept`; tipos `FinanceTxView`, `FinanceCategoryView`, `FinanceEventRuleView`, `FinanceProviderAliasView`, `EventAssignmentProposal`.
- Produces: `matchEventRules(txs: readonly FinanceTxView[], rules: readonly FinanceEventRuleView[], opts: { categories: readonly FinanceCategoryView[]; aliases: readonly FinanceProviderAliasView[]; existingAssignments: ReadonlySet<string> }): EventAssignmentProposal[]` — `existingAssignments` con claves `` `${txId}:${eventId}` ``; devuelve solo asignaciones NUEVAS.

Referencia Python: `/home/abf/github/home-finance/backend/app/event_rules.py` (`matching_txs`, `matching_txs_by_category`, `apply_event_rules`). Fidelidad: solo movimientos sin `transferGroupId`; una regla de proveedor acepta también los `provider_norm` cuyos alias normalizan al `providerNorm` de la regla (el frontend puede mandar el alias); el concepto se compara con `normText(normalizeConcept(concept))` (colapsado + 80 chars); una regla de categoría arrastra sus subcategorías DIRECTAS; idempotente por par (tx, evento).

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/event-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  matchEventRules,
  type FinanceCategoryView,
  type FinanceEventRuleView,
  type FinanceTxView,
} from "./index.js";

let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-20", concept: "Cena viernes",
    provider: "MARIA GARCIA LOPEZ", providerNorm: null, amountCents: -1500n,
    categoryId: null, status: "confirmada", transferGroupId: null, recurrence: null,
    recurrenceManual: false, dedupHash: `h${n}`, codeCommon: null, codeOwn: null,
    categoryKind: null, ...overrides,
  };
}
const rule = (o: Partial<FinanceEventRuleView>): FinanceEventRuleView => ({
  id: "er1", providerNorm: "MARIA GARCIA LOPEZ", conceptNorm: null, categoryId: null,
  eventId: "ev1", ...o,
});
const categories: FinanceCategoryView[] = [
  { id: "viajes", parentId: null, name: "Viajes", kind: "gasto" },
  { id: "hoteles", parentId: "viajes", name: "Hoteles", kind: "gasto" },
  { id: "otros", parentId: null, name: "Otros", kind: "gasto" },
];
const base = { categories, aliases: [], existingAssignments: new Set<string>() };

describe("matchEventRules (port de event_rules.py)", () => {
  it("asigna por proveedor normalizado y respeta pares ya existentes", () => {
    const a = tx({ id: "a", provider: "  María García López " });
    expect(matchEventRules([a], [rule({})], base)).toEqual([{ txId: "a", eventId: "ev1" }]);
    expect(
      matchEventRules([a], [rule({})], { ...base, existingAssignments: new Set(["a:ev1"]) }),
    ).toHaveLength(0);
  });

  it("acepta el alias mostrado en lugar del proveedor crudo", () => {
    const a = tx({ id: "a2", provider: "PAYPAL *KOBO BOOKS" });
    const r = rule({ providerNorm: "KOBO BOOKS [PAYPAL]" });
    const aliases = [{ providerNorm: "PAYPAL *KOBO BOOKS", display: "Kobo Books [PayPal]" }];
    expect(matchEventRules([a], [r], { ...base, aliases })).toEqual([{ txId: "a2", eventId: "ev1" }]);
  });

  it("con conceptNorm compara el concepto colapsado y truncado a 80", () => {
    const largo = `Cena   ${"x".repeat(100)}`;
    const a = tx({ id: "a3", concept: largo });
    const conceptNorm = `CENA ${"X".repeat(75)}`; // normText(normalizeConcept(largo))
    expect(matchEventRules([a], [rule({ conceptNorm })], base)).toHaveLength(1);
    expect(matchEventRules([a], [rule({ conceptNorm: "OTRA COSA" })], base)).toHaveLength(0);
  });

  it("una regla de categoría arrastra las subcategorías directas y nunca transferencias", () => {
    const padre = tx({ id: "p", categoryId: "viajes" });
    const hija = tx({ id: "h", categoryId: "hoteles" });
    const ajena = tx({ id: "o", categoryId: "otros" });
    const transfer = tx({ id: "tr", categoryId: "viajes", transferGroupId: "g" });
    const r = rule({ providerNorm: "", categoryId: "viajes" });
    expect(matchEventRules([padre, hija, ajena, transfer], [r], base).map((p) => p.txId)).toEqual(["p", "h"]);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `pnpm --filter @casa-clara/domain test src/finance/event-rules.test.ts` (con cd y PATH habituales).
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/event-rules.ts`:

```ts
import { normText, normalizeConcept } from "./text.js";
import type {
  EventAssignmentProposal,
  FinanceCategoryView,
  FinanceEventRuleView,
  FinanceProviderAliasView,
  FinanceTxView,
} from "./types.js";

function matchByProvider(
  txs: readonly FinanceTxView[],
  aliases: readonly FinanceProviderAliasView[],
  providerNorm: string,
  conceptNorm: string | null,
): FinanceTxView[] {
  const accepted = new Set([providerNorm]);
  for (const alias of aliases) {
    if (normText(alias.display) === providerNorm) accepted.add(alias.providerNorm);
  }
  return txs.filter((t) => {
    if (t.transferGroupId !== null) return false;
    if (!accepted.has(normText(t.provider ?? ""))) return false;
    if (conceptNorm !== null && normText(normalizeConcept(t.concept)) !== conceptNorm) return false;
    return true;
  });
}

function matchByCategory(
  txs: readonly FinanceTxView[],
  categories: readonly FinanceCategoryView[],
  categoryId: string,
): FinanceTxView[] {
  const targets = new Set([categoryId]);
  for (const c of categories) if (c.parentId === categoryId) targets.add(c.id);
  return txs.filter(
    (t) => t.transferGroupId === null && t.categoryId !== null && targets.has(t.categoryId),
  );
}

/** Port de event_rules.py::apply_event_rules como función pura: devuelve solo
 * las asignaciones NUEVAS (idempotente por par transacción-evento). */
export function matchEventRules(
  txs: readonly FinanceTxView[],
  rules: readonly FinanceEventRuleView[],
  opts: {
    categories: readonly FinanceCategoryView[];
    aliases: readonly FinanceProviderAliasView[];
    existingAssignments: ReadonlySet<string>;
  },
): EventAssignmentProposal[] {
  const seen = new Set(opts.existingAssignments);
  const proposals: EventAssignmentProposal[] = [];
  for (const rule of rules) {
    const matched =
      rule.categoryId !== null
        ? matchByCategory(txs, opts.categories, rule.categoryId)
        : matchByProvider(txs, opts.aliases, rule.providerNorm, rule.conceptNorm);
    for (const t of matched) {
      const key = `${t.id}:${rule.eventId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push({ txId: t.id, eventId: rule.eventId });
    }
  }
  return proposals;
}
```

Añade `export * from "./event-rules.js";` al barrel.

- [ ] **Step 4: Verde.** Repite Step 2.
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): reglas de evento con alias y arrastre de subcategorías"`

---

### Task 10: `kpis.ts` — resumen de rango con periodo anterior

**Files:**
- Create: `packages/domain/src/finance/kpis.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/kpis.test.ts`

**Interfaces:**
- Consumes: `dayDiffIso`; tipos `FinanceTxView`, `FinanceAccountView`, `SummaryOptions`, `RangeSummary`.
- Produces: canónica `computeRangeSummary(txs: readonly FinanceTxView[], opts: SummaryOptions): RangeSummary` (recibe TODAS las transacciones del hogar: el filtrado de rango/cuentas/eventos es interno, hace falta para el periodo anterior, los cruces y `pendingCount` global); local `prevRange(from: string, to: string): { from: string; to: string }`.

Referencia Python: `/home/abf/github/home-finance/backend/app/reports.py` (`_txs`, `_kind_for`, `_totals`, `_by_recurrence`, `_investment_legs`, `_crossing_transfer_legs`, `_prev_range`, `range_summary`). Fidelidad: se excluyen las patas con categoría kind `transferencia`; kind por categoría con fallback por signo; las aportaciones recibidas de fuera del filtro suman a ingresos (y los traspasos salientes NO son gasto); inversión = patas positivas en cuentas kind `inversion`, filtradas por la cuenta del CARGO; tasas sobre el ingreso total (neta = ahorro/ingresos; bruta = (ingresos+gastos recurrentes)/ingresos; inversión = inversión/ingresos; a 1 decimal, null si ingresos 0); FCF = ahorro − inversión, ops = FCF + inversión; `pendingCount` global (sin rango) con estados pendiente/sugerida_regla/sugerida_agente; periodo anterior alineado a meses de calendario si el rango es un bloque exacto de meses, si no por número de días. `prev.prev` es null.

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/kpis.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  computeRangeSummary,
  prevRange,
  type FinanceAccountView,
  type FinanceTxView,
  type SummaryOptions,
} from "./index.js";

const accounts: FinanceAccountView[] = [
  { id: "a1", name: "Común", bank: "caixabank", kind: "comun", bankRef: "r1", ownerAliases: [], transferRefs: [] },
  { id: "a2", name: "Personal", bank: "openbank", kind: "personal", bankRef: "r2", ownerAliases: [], transferRefs: [] },
  { id: "inv1", name: "Fondo", bank: "inversion", kind: "inversion", bankRef: "r3", ownerAliases: [], transferRefs: [] },
];
let n = 0;
function tx(overrides: Partial<FinanceTxView>): FinanceTxView {
  n += 1;
  return {
    id: `t${n}`, accountId: "a1", opDate: "2026-06-10", concept: "X", provider: null,
    providerNorm: null, amountCents: -1000n, categoryId: "c", status: "confirmada",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h${n}`, codeCommon: null, codeOwn: null, categoryKind: "gasto", ...overrides,
  };
}
const opts = (o: Partial<SummaryOptions> = {}): SummaryOptions => ({
  from: "2026-06-01", to: "2026-06-30", accounts, ...o,
});

describe("prevRange (port de reports._prev_range)", () => {
  it("bloques de meses de calendario retroceden bloques iguales alineados", () => {
    expect(prevRange("2026-04-01", "2026-06-30")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(prevRange("2026-01-01", "2026-01-31")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("rangos arbitrarios retroceden por número de días", () => {
    expect(prevRange("2026-05-10", "2026-05-19")).toEqual({ from: "2026-04-30", to: "2026-05-09" });
  });
});

describe("computeRangeSummary (port de reports.range_summary)", () => {
  const txs: FinanceTxView[] = [
    tx({ amountCents: 300000n, categoryKind: "ingreso" }),
    tx({ amountCents: -80000n, recurrence: "recurrente" }),
    tx({ amountCents: -30000n, recurrence: "extraordinario" }),
    tx({ amountCents: -10000n }),
    // aportación a inversión: cargo (transferencia) + espejo en cuenta inversión
    tx({ id: "chg", amountCents: -50000n, categoryKind: "transferencia", transferGroupId: "g1" }),
    tx({ id: "mir", accountId: "inv1", amountCents: 50000n, categoryKind: "transferencia", transferGroupId: "g1" }),
    // periodo anterior (mayo)
    tx({ opDate: "2026-05-10", amountCents: 200000n, categoryKind: "ingreso" }),
    tx({ opDate: "2026-05-12", amountCents: -50000n }),
    // pendiente global fuera de rango
    tx({ opDate: "2026-01-05", status: "pendiente", categoryId: null, categoryKind: null }),
  ];

  it("calcula totales, desglose, tasas, inversión y flujos de caja", () => {
    const s = computeRangeSummary(txs, opts());
    expect(s.incomeCents).toBe(300000n);
    expect(s.expenseCents).toBe(-120000n);
    expect(s.recurringExpenseCents).toBe(-80000n);
    expect(s.extraordinaryExpenseCents).toBe(-30000n);
    expect(s.unclassifiedExpenseCents).toBe(-10000n);
    expect(s.savingsCents).toBe(180000n);
    expect(s.netSavingsRate).toBe(60);
    expect(s.grossSavingsRate).toBe(73.3);
    expect(s.investedCents).toBe(50000n);
    expect(s.investmentRate).toBe(16.7);
    expect(s.freeCashFlowCents).toBe(130000n);
    expect(s.opsCashFlowCents).toBe(180000n);
    expect(s.pendingCount).toBe(1);
    expect(s.prev?.savingsCents).toBe(150000n);
    expect(s.prev?.prev).toBeNull();
  });

  it("con filtro de cuentas: las aportaciones que cruzan cuentan como ingreso y los traspasos salientes no son gasto", () => {
    const cruce: FinanceTxView[] = [
      tx({ id: "sal", accountId: "a1", amountCents: -20000n, categoryKind: "transferencia", transferGroupId: "g2" }),
      tx({ id: "ent", accountId: "a2", amountCents: 20000n, categoryKind: "transferencia", transferGroupId: "g2" }),
      tx({ id: "gasto2", accountId: "a2", amountCents: -5000n }),
    ];
    const s = computeRangeSummary(cruce, opts({ accountIds: ["a2"] }));
    expect(s.receivedContributionsCents).toBe(20000n);
    expect(s.incomeCents).toBe(20000n);
    expect(s.expenseCents).toBe(-5000n);
    const vistoDesdeA1 = computeRangeSummary(cruce, opts({ accountIds: ["a1"] }));
    expect(vistoDesdeA1.outgoingTransfersCents).toBe(-20000n);
    expect(vistoDesdeA1.expenseCents).toBe(0n);
    const sinFiltro = computeRangeSummary(cruce, opts());
    expect(sinFiltro.receivedContributionsCents).toBe(0n); // grupo 100% interno
  });

  it("la inversión filtrada por cuentas sigue a la cuenta que aporta el cargo", () => {
    const s = computeRangeSummary(txs, opts({ accountIds: ["a1"] }));
    expect(s.investedCents).toBe(50000n);
    const otra = computeRangeSummary(txs, opts({ accountIds: ["a2"] }));
    expect(otra.investedCents).toBe(0n);
  });

  it("ingresos cero: tasas null", () => {
    const s = computeRangeSummary([tx({ amountCents: -1000n })], opts());
    expect(s.netSavingsRate).toBeNull();
    expect(s.grossSavingsRate).toBeNull();
    expect(s.investmentRate).toBeNull();
  });
});
```

- [ ] **Step 2: Verlo fallar.** `pnpm --filter @casa-clara/domain test src/finance/kpis.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/kpis.ts`:

```ts
import { dayDiffIso } from "./text.js";
import type {
  FinanceAccountView,
  FinanceTxView,
  RangeSummary,
  SummaryOptions,
} from "./types.js";

const PENDING_STATUSES = new Set(["pendiente", "sugerida_regla", "sugerida_agente"]);

function kindFor(t: FinanceTxView): "gasto" | "ingreso" {
  if (t.categoryKind === "gasto" || t.categoryKind === "ingreso") return t.categoryKind;
  return t.amountCents > 0n ? "ingreso" : "gasto";
}

const pad = (v: number, w: number): string => String(v).padStart(w, "0");
const iso = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const lastDayOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addDaysIso(date: string, days: number): string {
  const t = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days),
  );
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Port de reports._prev_range: bloques exactos de meses de calendario retroceden
 * alineados; el resto retrocede por número de días. */
export function prevRange(from: string, to: string): { from: string; to: string } {
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  const isCalendarMonths = from.slice(8, 10) === "01" && addDaysIso(to, 1).slice(8, 10) === "01";
  if (isCalendarMonths) {
    const span = (ty - fy) * 12 + (tm - fm) + 1;
    const endIdx = fy * 12 + (fm - 1) - 1;
    const startIdx = endIdx - span + 1;
    const sy = Math.floor(startIdx / 12);
    const sm = (((startIdx % 12) + 12) % 12) + 1;
    const ey = Math.floor(endIdx / 12);
    const em = (((endIdx % 12) + 12) % 12) + 1;
    return { from: iso(sy, sm, 1), to: iso(ey, em, lastDayOfMonth(ey, em)) };
  }
  const spanDays = dayDiffIso(to, from) + 1;
  return { from: addDaysIso(from, -spanDays), to: addDaysIso(from, -1) };
}

const sum = (xs: readonly FinanceTxView[]): bigint => xs.reduce((s, t) => s + t.amountCents, 0n);

function rate1(num: bigint, den: bigint): number | null {
  if (den === 0n) return null;
  return Math.round((Number(num) * 1000) / Number(den)) / 10;
}

const inRange = (t: FinanceTxView, from: string, to: string): boolean =>
  t.opDate >= from && t.opDate <= to;

function filteredTxs(
  txs: readonly FinanceTxView[],
  opts: SummaryOptions,
  from: string,
  to: string,
): FinanceTxView[] {
  const sel = opts.accountIds && opts.accountIds.length > 0 ? new Set(opts.accountIds) : null;
  const excl =
    opts.excludeEventIds && opts.excludeEventIds.length > 0 ? new Set(opts.excludeEventIds) : null;
  return txs.filter((t) => {
    if (!inRange(t, from, to)) return false;
    if (t.categoryKind === "transferencia") return false;
    if (sel !== null && !sel.has(t.accountId)) return false;
    const events = opts.eventIdsByTx?.get(t.id) ?? [];
    if (opts.eventId != null && !events.includes(opts.eventId)) return false;
    if (excl !== null && events.some((e) => excl.has(e))) return false;
    return true;
  });
}

/** Port de reports._crossing_transfer_legs (solo con filtro de cuentas). */
function crossingTransferLegs(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
  from: string,
  to: string,
  accountIds: readonly string[] | null | undefined,
): { incoming: FinanceTxView[]; outgoing: FinanceTxView[] } {
  if (!accountIds || accountIds.length === 0) return { incoming: [], outgoing: [] };
  const sel = new Set(accountIds);
  const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
  const inLegs = txs.filter(
    (t) =>
      inRange(t, from, to) &&
      sel.has(t.accountId) &&
      t.categoryKind === "transferencia" &&
      t.transferGroupId !== null,
  );
  if (inLegs.length === 0) return { incoming: [], outgoing: [] };
  const gids = new Set(inLegs.map((t) => t.transferGroupId as string));
  const groupAccs = new Map<string, { accountId: string; kind: string }[]>();
  for (const t of txs) {
    if (t.transferGroupId !== null && gids.has(t.transferGroupId)) {
      const list = groupAccs.get(t.transferGroupId) ?? [];
      list.push({ accountId: t.accountId, kind: kinds.get(t.accountId) ?? "" });
      groupAccs.set(t.transferGroupId, list);
    }
  }
  const incoming: FinanceTxView[] = [];
  const outgoing: FinanceTxView[] = [];
  for (const leg of inLegs) {
    const accs = groupAccs.get(leg.transferGroupId as string) ?? [];
    if (accs.every((a) => sel.has(a.accountId))) continue; // 100% interno al filtro
    if (accs.some((a) => a.kind === "inversion" && !sel.has(a.accountId))) continue; // cuenta en `inversion`
    (leg.amountCents > 0n ? incoming : outgoing).push(leg);
  }
  return { incoming, outgoing };
}

/** Port de reports._investment_legs: con filtro, sigue a la cuenta del CARGO. */
function investmentLegs(
  txs: readonly FinanceTxView[],
  accounts: readonly FinanceAccountView[],
  from: string,
  to: string,
  accountIds: readonly string[] | null | undefined,
): FinanceTxView[] {
  const invIds = new Set(accounts.filter((a) => a.kind === "inversion").map((a) => a.id));
  const kinds = new Map(accounts.map((a) => [a.id, a.kind]));
  const legs = txs.filter(
    (t) => invIds.has(t.accountId) && t.amountCents > 0n && inRange(t, from, to),
  );
  if (!accountIds || accountIds.length === 0) return legs;
  const sel = new Set(accountIds);
  const gids = new Set(
    legs.filter((l) => l.transferGroupId !== null).map((l) => l.transferGroupId as string),
  );
  const chargeInSel = new Set<string>();
  for (const t of txs) {
    if (
      t.transferGroupId !== null &&
      gids.has(t.transferGroupId) &&
      t.amountCents < 0n &&
      kinds.get(t.accountId) !== "inversion" &&
      sel.has(t.accountId)
    ) {
      chargeInSel.add(t.transferGroupId);
    }
  }
  return legs.filter(
    (l) =>
      (l.transferGroupId !== null && chargeInSel.has(l.transferGroupId)) ||
      (l.transferGroupId === null && sel.has(l.accountId)),
  );
}

function summarize(
  txs: readonly FinanceTxView[],
  opts: SummaryOptions,
  from: string,
  to: string,
  withPrev: boolean,
): RangeSummary {
  const cur = filteredTxs(txs, opts, from, to);
  const gastos = cur.filter((t) => kindFor(t) === "gasto");
  const ingresos = cur.filter((t) => kindFor(t) === "ingreso");
  const { incoming, outgoing } = crossingTransferLegs(txs, opts.accounts, from, to, opts.accountIds);
  const receivedContributionsCents = sum(incoming);
  const outgoingTransfersCents = sum(outgoing);
  const incomeCents = sum(ingresos) + receivedContributionsCents;
  const expenseCents = sum(gastos);
  const savingsCents = incomeCents + expenseCents;
  const recurringExpenseCents = sum(gastos.filter((t) => t.recurrence === "recurrente"));
  const extraordinaryExpenseCents = sum(gastos.filter((t) => t.recurrence === "extraordinario"));
  const unclassifiedExpenseCents = sum(gastos.filter((t) => t.recurrence === null));
  const investedCents = sum(investmentLegs(txs, opts.accounts, from, to, opts.accountIds));
  const freeCashFlowCents = savingsCents - investedCents;
  const pendingCount = txs.filter(
    (t) =>
      PENDING_STATUSES.has(t.status) &&
      (!opts.accountIds || opts.accountIds.length === 0 || opts.accountIds.includes(t.accountId)),
  ).length;
  let prev: RangeSummary | null = null;
  if (withPrev) {
    const p = prevRange(from, to);
    prev = summarize(txs, opts, p.from, p.to, false);
  }
  return {
    incomeCents,
    expenseCents,
    recurringExpenseCents,
    extraordinaryExpenseCents,
    unclassifiedExpenseCents,
    savingsCents,
    netSavingsRate: rate1(savingsCents, incomeCents),
    grossSavingsRate: rate1(incomeCents + recurringExpenseCents, incomeCents),
    investedCents,
    investmentRate: rate1(investedCents, incomeCents),
    freeCashFlowCents,
    opsCashFlowCents: freeCashFlowCents + investedCents,
    receivedContributionsCents,
    outgoingTransfersCents,
    pendingCount,
    prev,
  };
}

/** Port de reports.range_summary. Recibe TODAS las transacciones del hogar
 * (el filtrado interno hace falta para el periodo anterior, los cruces de
 * transferencias y el contador global de pendientes). */
export function computeRangeSummary(
  txs: readonly FinanceTxView[],
  opts: SummaryOptions,
): RangeSummary {
  return summarize(txs, opts, opts.from, opts.to, true);
}
```

Añade `export * from "./kpis.js";` al barrel.

- [ ] **Step 4: Verde.** Repite Step 2.
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): kpis de rango con cruces, inversión y periodo anterior alineado"`

---

### Task 11: `pivot.ts` — árbol del pivot con secciones

**Files:**
- Create: `packages/domain/src/finance/pivot.ts`
- Modify: `packages/domain/src/finance/index.ts`
- Test: `packages/domain/src/finance/pivot.test.ts`

**Interfaces:**
- Consumes: `divideRoundHalfAwayFromZero`, `formatEuroCents`, `moneyCents` de `packages/domain/src/money.ts` (import relativo `../money.js`); tipos `FinanceRecurrence` (Task 1).
- Produces (canónicas + auxiliares que las fases 4–6 consumen tal cual):
  - `type PivotDimension = "cat" | "sub" | "nat" | "prov" | "concept" | "movement"` · `type PivotSection = "INGRESOS" | "GASTOS" | "EVENTOS" | "INTERNAS" | "INVERSION"`.
  - `buildPivotTree(rows: readonly PivotSourceRow[], dims: readonly PivotDimension[], opts: PivotOptions): PivotTree`.
  - `interface PivotMov { id: string; date: string; cents: bigint }` · `interface PivotSourceRow { cat: string; sub: string | null; catId: string | null; nat: FinanceRecurrence; prov: string; concept: string; event: string | null; eventId: string | null; kind: "gasto" | "ingreso" | "transferencia" | "inversion"; month: string; totalCents: bigint; count: number; movs: readonly PivotMov[] }` · `interface PivotOptions { monthsCount: number; dupEventIds?: ReadonlySet<string> }`.
  - `PivotNode`, `PivotSectionTotal`, `PivotTree` (secciones `gastos/ingresos/internas/inversiones/eventos` + `subtotales` con `totalNeto`), `SortKey`, `sortPivotTree`, `collectNodeMovIds`, `parseDims`, `ALL_DIMS`, `DEFAULT_DIMS`, `INVERSION_DIMS`, `INTERNA_DIMS`.

Referencia: `/home/abf/github/home-finance/frontend/src/features/analytics/pivotTree.ts` — portar 1:1 cambiando `number`→`bigint` en dinero (avg/ticket redondeados a céntimo con `divideRoundHalfAwayFromZero`) e ids numéricos→`string`. Semántica que los tests deben clavar: partición exhaustiva por `kind`; INTERNAS/INVERSIÓN con dims FIJAS hasta la hoja de movimiento; eventos duplicables con `dupEventIds` sin que TOTAL NETO cuente dos veces; TOTAL NETO sin internas ni inversiones; `nat` ordena ♻ → ✦ → sin clasificar; `movement` es hoja terminal.

- [ ] **Step 1: Test que falla.** `packages/domain/src/finance/pivot.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildPivotTree,
  collectNodeMovIds,
  parseDims,
  sortPivotTree,
  type PivotSourceRow,
} from "./index.js";

let m = 0;
function row(overrides: Partial<PivotSourceRow>): PivotSourceRow {
  m += 1;
  return {
    cat: "Casa", sub: null, catId: "c1", nat: null, prov: "PROV", concept: "CONCEPTO",
    event: null, eventId: null, kind: "gasto", month: "2026-06", totalCents: -1000n,
    count: 1, movs: [{ id: `mv${m}`, date: "2026-06-05", cents: -1000n }], ...overrides,
  };
}

describe("buildPivotTree (port de pivotTree.buildPivotSections)", () => {
  it("particiona por kind sin perder filas y calcula subtotales y TOTAL NETO", () => {
    const rows = [
      row({ kind: "gasto", totalCents: -2000n }),
      row({ kind: "ingreso", cat: "Nómina", totalCents: 300000n }),
      row({ kind: "transferencia", cat: "Traspaso X", totalCents: -5000n }),
      row({ kind: "inversion", cat: "Fondo", totalCents: 5000n }),
    ];
    const tree = buildPivotTree(rows, ["cat", "sub"], { monthsCount: 2 });
    expect(tree.gastos).toHaveLength(1);
    expect(tree.ingresos).toHaveLength(1);
    expect(tree.internas).toHaveLength(1);
    expect(tree.inversiones).toHaveLength(1);
    expect(tree.subtotales.totalNeto.totalCents).toBe(298000n); // sin internas ni inversiones
    expect(tree.subtotales.gastos.avgCents).toBe(-1000n); // -2000/2 meses
  });

  it("un evento cuelga de EVENTOS salvo que esté duplicado; TOTAL NETO cuenta una sola vez", () => {
    const rows = [
      row({ eventId: "ev1", event: "Semana Santa", totalCents: -4000n }),
      row({ totalCents: -1000n }),
    ];
    const sinDup = buildPivotTree(rows, ["cat"], { monthsCount: 1 });
    expect(sinDup.gastos[0]?.totalCents).toBe(-1000n);
    expect(sinDup.eventos[0]?.netCents).toBe(-4000n);
    expect(sinDup.subtotales.totalNeto.totalCents).toBe(-5000n);
    const conDup = buildPivotTree(rows, ["cat"], { monthsCount: 1, dupEventIds: new Set(["ev1"]) });
    expect(conDup.gastos[0]?.totalCents).toBe(-5000n); // el evento también bajo su categoría
    expect(conDup.subtotales.totalNeto.totalCents).toBe(-5000n); // pero solo una vez
  });

  it("nat ordena ♻ → ✦ → sin clasificar y movement es hoja terminal", () => {
    const rows = [
      row({ nat: null }),
      row({ nat: "extraordinario" }),
      row({ nat: "recurrente" }),
    ];
    const tree = buildPivotTree(rows, ["nat", "movement"], { monthsCount: 1 });
    expect(tree.gastos.map((n) => n.label)).toEqual(["♻ Recurrente", "✦ Extraordinario", "Sin clasificar"]);
    const leaf = tree.gastos[0]?.children[0];
    expect(leaf?.movs).toHaveLength(1);
    expect(leaf?.children).toHaveLength(0);
    expect(leaf?.label.startsWith("2026-06-05 · ")).toBe(true);
  });

  it("INTERNAS baja grupo→pata→concepto→movimiento ignorando las dims del usuario", () => {
    const rows = [row({ kind: "transferencia", cat: "Traspaso X", prov: "Cuenta Azul" })];
    const tree = buildPivotTree(rows, ["cat"], { monthsCount: 1 });
    const grupo = tree.internas[0];
    expect(grupo?.label).toBe("Traspaso X");
    expect(grupo?.children[0]?.label).toBe("Cuenta Azul");
    expect(grupo?.children[0]?.children[0]?.children[0]?.movs).toHaveLength(1);
  });

  it("sortPivotTree reordena gastos/ingresos/eventos por columna y collectNodeMovIds resuelve ids", () => {
    const rows = [
      row({ cat: "Aaa", totalCents: -1000n }),
      row({ cat: "Zzz", totalCents: -9000n }),
    ];
    const tree = buildPivotTree(rows, ["cat"], { monthsCount: 1 });
    const sorted = sortPivotTree(tree, "total", "asc");
    expect(sorted.gastos.map((n) => n.label)).toEqual(["Zzz", "Aaa"]);
    const ids = collectNodeMovIds(tree);
    expect(ids.get(tree.gastos[0]?.key ?? "")).toHaveLength(1);
  });
});

describe("parseDims", () => {
  it("filtra dims inválidas, deduplica y cae al default", () => {
    expect(parseDims("cat,sub")).toEqual(["cat", "sub"]);
    expect(parseDims("cat,cat,zz")).toEqual(["cat"]);
    expect(parseDims(null)).toEqual(["cat", "sub"]);
    expect(parseDims("zz")).toEqual(["cat", "sub"]);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `pnpm --filter @casa-clara/domain test src/finance/pivot.test.ts`
- [ ] **Step 3: Implementación.** `packages/domain/src/finance/pivot.ts` (port de `pivotTree.ts` a bigint; conserva los comentarios de intención del original):

```ts
import { divideRoundHalfAwayFromZero, formatEuroCents, moneyCents } from "../money.js";
import type { FinanceRecurrence } from "./types.js";

export type PivotDimension = "cat" | "sub" | "nat" | "prov" | "concept" | "movement";
export type PivotSection = "INGRESOS" | "GASTOS" | "EVENTOS" | "INTERNAS" | "INVERSION";

export const ALL_DIMS: readonly PivotDimension[] = ["cat", "sub", "nat", "prov", "concept", "movement"];
export const DEFAULT_DIMS: readonly PivotDimension[] = ["cat", "sub"];
/** Dims FIJAS de INVERSIÓN: cuenta → concepto → movimiento. */
export const INVERSION_DIMS: readonly PivotDimension[] = ["cat", "concept", "movement"];
/** Dims FIJAS de INTERNAS: grupo → cuenta (pata) → concepto → movimiento. */
export const INTERNA_DIMS: readonly PivotDimension[] = ["cat", "prov", "concept", "movement"];

export interface PivotMov {
  id: string;
  date: string;
  cents: bigint;
}

export interface PivotSourceRow {
  cat: string;
  sub: string | null;
  catId: string | null;
  nat: FinanceRecurrence;
  prov: string;
  concept: string;
  event: string | null;
  eventId: string | null;
  kind: "gasto" | "ingreso" | "transferencia" | "inversion";
  month: string;
  totalCents: bigint;
  count: number;
  movs: readonly PivotMov[];
}

export interface PivotOptions {
  monthsCount: number;
  dupEventIds?: ReadonlySet<string>;
}

export interface PivotNode {
  key: string;
  label: string;
  depth: number;
  count: number;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
  catId: string | null;
  nat: FinanceRecurrence;
  provider: string | null;
  concept: string | null;
  concepts: string[];
  movs: PivotMov[];
  children: PivotNode[];
}

export interface PivotSectionTotal {
  count: number;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
}

export interface PivotEventGroup {
  eventId: string;
  name: string;
  count: number;
  netCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
  children: PivotNode[];
}

export interface PivotTree {
  gastos: PivotNode[];
  ingresos: PivotNode[];
  internas: PivotNode[];
  inversiones: PivotNode[];
  eventos: PivotEventGroup[];
  subtotales: {
    gastos: PivotSectionTotal;
    eventos: PivotSectionTotal;
    ingresos: PivotSectionTotal;
    internas: PivotSectionTotal;
    inversiones: PivotSectionTotal;
    totalNeto: PivotSectionTotal;
  };
}

function dimValue(r: PivotSourceRow, dim: Exclude<PivotDimension, "movement">): string {
  switch (dim) {
    case "cat":
      return r.cat;
    case "sub":
      return r.sub ?? "(sin subcategoría)";
    case "nat":
      return r.nat === "recurrente"
        ? "♻ Recurrente"
        : r.nat === "extraordinario"
          ? "✦ Extraordinario"
          : "Sin clasificar";
    case "prov":
      return r.prov;
    case "concept":
      return r.concept;
  }
}

const natSortKey = (label: string): string =>
  label.startsWith("♻") ? "0" : label.startsWith("✦") ? "1" : "2";

function sortLabels(dim: PivotDimension, labels: string[]): string[] {
  if (dim === "nat") return [...labels].sort((a, b) => natSortKey(a).localeCompare(natSortKey(b)));
  return [...labels].sort((a, b) => a.localeCompare(b, "es"));
}

function uniqueOrNull<T>(values: readonly (T | null)[]): T | null {
  const set = new Set(values);
  if (set.size !== 1) return null;
  const [v] = set;
  return v ?? null;
}

const sumCount = (rows: readonly PivotSourceRow[]): number => rows.reduce((s, r) => s + r.count, 0);
const sumTotal = (rows: readonly PivotSourceRow[]): bigint =>
  rows.reduce((s, r) => s + r.totalCents, 0n);
const ticketOf = (total: bigint, count: number): bigint =>
  count === 0 ? 0n : divideRoundHalfAwayFromZero(total, BigInt(count));
const avgOf = (total: bigint, monthsCount: number): bigint =>
  monthsCount === 0 ? 0n : divideRoundHalfAwayFromZero(total, BigInt(monthsCount));

function monthlyOf(rows: readonly PivotSourceRow[]): Record<string, bigint> {
  const monthly: Record<string, bigint> = {};
  for (const r of rows) monthly[r.month] = (monthly[r.month] ?? 0n) + r.totalCents;
  return monthly;
}

function buildLevel(
  rows: readonly PivotSourceRow[],
  dims: readonly PivotDimension[],
  parentKey: string,
  depth: number,
  monthsCount: number,
): PivotNode[] {
  if (dims.length === 0) return [];
  const [dim, ...rest] = dims as [PivotDimension, ...PivotDimension[]];

  // 'movement' es terminal: una hoja por movimiento, no se agrupa por valor.
  if (dim === "movement") {
    return rows
      .flatMap((r) => r.movs)
      .map((mov) => ({
        key: `${parentKey}/movement:${mov.id}`,
        label: `${mov.date} · ${formatEuroCents(moneyCents(mov.cents))}`,
        depth,
        count: 1,
        totalCents: mov.cents,
        avgCents: avgOf(mov.cents, monthsCount),
        ticketCents: ticketOf(mov.cents, 1),
        monthly: { [mov.date.slice(0, 7)]: mov.cents },
        catId: null,
        nat: null,
        provider: null,
        concept: null,
        concepts: [],
        movs: [mov],
        children: [],
      }));
  }

  const groups = new Map<string, PivotSourceRow[]>();
  for (const r of rows) {
    const v = dimValue(r, dim);
    const list = groups.get(v) ?? [];
    list.push(r);
    groups.set(v, list);
  }
  return sortLabels(dim, [...groups.keys()]).map((label) => {
    const groupRows = groups.get(label) as PivotSourceRow[];
    const key = `${parentKey}/${dim}:${label}`;
    const count = sumCount(groupRows);
    const total = sumTotal(groupRows);
    return {
      key,
      label,
      depth,
      count,
      totalCents: total,
      avgCents: avgOf(total, monthsCount),
      ticketCents: ticketOf(total, count),
      monthly: monthlyOf(groupRows),
      catId: uniqueOrNull(groupRows.map((r) => r.catId)),
      nat: uniqueOrNull(groupRows.map((r) => r.nat)),
      provider: uniqueOrNull<string>(groupRows.map((r) => r.prov)),
      concept: uniqueOrNull<string>(groupRows.map((r) => r.concept)),
      concepts: [...new Set(groupRows.map((r) => r.concept))],
      movs: groupRows.flatMap((r) => [...r.movs]),
      children: buildLevel(groupRows, rest, key, depth + 1, monthsCount),
    };
  });
}

function buildTreeNodes(
  rows: readonly PivotSourceRow[],
  dims: readonly PivotDimension[],
  monthsCount: number,
): PivotNode[] {
  if (rows.length === 0 || dims.length === 0) return [];
  return buildLevel(rows, dims, "", 0, monthsCount);
}

function sectionTotal(rows: readonly PivotSourceRow[], monthsCount: number): PivotSectionTotal {
  const count = sumCount(rows);
  const total = sumTotal(rows);
  return {
    count,
    totalCents: total,
    avgCents: avgOf(total, monthsCount),
    ticketCents: ticketOf(total, count),
    monthly: monthlyOf(rows),
  };
}

function mergeMonthly(sections: readonly PivotSectionTotal[]): Record<string, bigint> {
  const monthly: Record<string, bigint> = {};
  for (const s of sections) {
    for (const [k, v] of Object.entries(s.monthly)) monthly[k] = (monthly[k] ?? 0n) + v;
  }
  return monthly;
}

/** Port de pivotTree.buildPivotSections: partición exhaustiva por kind, dims
 * fijas en INTERNAS/INVERSIÓN, eventos duplicables con `dupEventIds` y TOTAL
 * NETO contando cada movimiento UNA sola vez (sin internas ni inversiones). */
export function buildPivotTree(
  rows: readonly PivotSourceRow[],
  dims: readonly PivotDimension[],
  opts: PivotOptions,
): PivotTree {
  const { monthsCount } = opts;
  const dupEventIds = opts.dupEventIds ?? new Set<string>();
  const internaRows = rows.filter((r) => r.kind === "transferencia");
  const inversionRows = rows.filter((r) => r.kind === "inversion");
  const cashflowRows = rows.filter((r) => r.kind === "gasto" || r.kind === "ingreso");
  const eventRows = cashflowRows.filter((r) => r.eventId !== null);
  const isDup = (r: PivotSourceRow): boolean => r.eventId !== null && dupEventIds.has(r.eventId);
  const inFlow = (r: PivotSourceRow): boolean => r.eventId === null || isDup(r);
  const gastoRows = cashflowRows.filter((r) => r.kind === "gasto" && inFlow(r));
  const ingresoRows = cashflowRows.filter((r) => r.kind === "ingreso" && inFlow(r));

  const eventGroups = new Map<string, PivotSourceRow[]>();
  for (const r of eventRows) {
    const list = eventGroups.get(r.eventId as string) ?? [];
    list.push(r);
    eventGroups.set(r.eventId as string, list);
  }
  const eventos = [...eventGroups.entries()]
    .map(([eventId, groupRows]) => {
      const count = sumCount(groupRows);
      const net = sumTotal(groupRows);
      return {
        eventId,
        name: groupRows[0]?.event ?? "",
        count,
        netCents: net,
        avgCents: avgOf(net, monthsCount),
        ticketCents: ticketOf(net, count),
        monthly: monthlyOf(groupRows),
        children: buildTreeNodes(groupRows, dims, monthsCount),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  const gastosTotal = sectionTotal(gastoRows, monthsCount);
  const eventosTotal = sectionTotal(eventRows, monthsCount);
  const ingresosTotal = sectionTotal(ingresoRows, monthsCount);
  const eventNet = sectionTotal(eventRows.filter((r) => !isDup(r)), monthsCount);
  const totalNetoCount = gastosTotal.count + eventNet.count + ingresosTotal.count;
  const totalNetoTotal = gastosTotal.totalCents + eventNet.totalCents + ingresosTotal.totalCents;

  return {
    gastos: buildTreeNodes(gastoRows, dims, monthsCount),
    ingresos: buildTreeNodes(ingresoRows, dims, monthsCount),
    internas: buildTreeNodes(internaRows, INTERNA_DIMS, monthsCount),
    inversiones: buildTreeNodes(inversionRows, INVERSION_DIMS, monthsCount),
    eventos,
    subtotales: {
      gastos: gastosTotal,
      eventos: eventosTotal,
      ingresos: ingresosTotal,
      internas: sectionTotal(internaRows, monthsCount),
      inversiones: sectionTotal(inversionRows, monthsCount),
      totalNeto: {
        count: totalNetoCount,
        totalCents: totalNetoTotal,
        avgCents: avgOf(totalNetoTotal, monthsCount),
        ticketCents: ticketOf(totalNetoTotal, totalNetoCount),
        monthly: mergeMonthly([gastosTotal, eventNet, ingresosTotal]),
      },
    },
  };
}

/** Mapa key → ids de movimiento de todos los nodos (recursivo, eventos incluidos). */
export function collectNodeMovIds(tree: PivotTree): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const walk = (n: PivotNode): void => {
    map.set(n.key, n.movs.map((mv) => mv.id));
    n.children.forEach(walk);
  };
  tree.gastos.forEach(walk);
  tree.ingresos.forEach(walk);
  tree.internas.forEach(walk);
  tree.inversiones.forEach(walk);
  tree.eventos.forEach((ev) => ev.children.forEach(walk));
  return map;
}

export type SortKey = "label" | "total" | "avg" | "ticket" | { month: string };

interface Sortable {
  label: string;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
}

function sortValue(key: SortKey, item: Sortable): bigint | string {
  if (key === "label") return item.label;
  if (key === "total") return item.totalCents;
  if (key === "avg") return item.avgCents;
  if (key === "ticket") return item.ticketCents;
  return item.monthly[key.month] ?? 0n;
}

function compareValues(a: bigint | string, b: bigint | string, dir: "asc" | "desc"): number {
  const cmp =
    typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b, "es")
      : a < b
        ? -1
        : a > b
          ? 1
          : 0;
  return dir === "asc" ? cmp : -cmp;
}

function sortNodes(nodes: PivotNode[], key: SortKey, dir: "asc" | "desc"): PivotNode[] {
  return nodes
    .map((n) => ({ ...n, children: sortNodes(n.children, key, dir) }))
    .sort((a, b) => compareValues(sortValue(key, a), sortValue(key, b), dir));
}

/** Reordena gastos/ingresos/eventos; internas e inversiones conservan su orden fijo. */
export function sortPivotTree(tree: PivotTree, key: SortKey, dir: "asc" | "desc"): PivotTree {
  return {
    ...tree,
    gastos: sortNodes(tree.gastos, key, dir),
    ingresos: sortNodes(tree.ingresos, key, dir),
    eventos: tree.eventos
      .map((e) => ({ ...e, children: sortNodes(e.children, key, dir) }))
      .sort((a, b) =>
        compareValues(
          sortValue(key, { label: a.name, totalCents: a.netCents, avgCents: a.avgCents, ticketCents: a.ticketCents, monthly: a.monthly }),
          sortValue(key, { label: b.name, totalCents: b.netCents, avgCents: b.avgCents, ticketCents: b.ticketCents, monthly: b.monthly }),
          dir,
        ),
      ),
  };
}

export function parseDims(raw: string | null): PivotDimension[] {
  if (raw === null || raw === "") return [...DEFAULT_DIMS];
  const parsed = raw.split(",").filter((d): d is PivotDimension => (ALL_DIMS as string[]).includes(d));
  const deduped = [...new Set(parsed)];
  return deduped.length > 0 ? deduped : [...DEFAULT_DIMS];
}
```

Añade `export * from "./pivot.js";` al barrel.

- [ ] **Step 4: Verde + typecheck.** `pnpm --filter @casa-clara/domain test src/finance/pivot.test.ts && pnpm --filter @casa-clara/domain typecheck`
- [ ] **Step 5: Commit.** `git add packages/domain && git commit -m "feat(finanzas): árbol del pivot con secciones y dupev portado a bigint"`

---

### Task 12: SheetJS, muestras sintéticas, `detectBank` y cableado CI

**Files:**
- Modify: `packages/server/package.json` (dependencia `xlsx`), `.github/workflows/ci.yml`
- Create: `packages/server/src/finance/parsers/shared.ts`, `packages/server/src/finance/parsers/synthetic-samples.ts`, `packages/server/src/finance/parsers/index.ts`
- Test: `packages/server/src/finance/parsers/detect.test.ts`, `packages/server/src/finance/parsers/shared.test.ts`

**Interfaces:**
- Consumes: tipo `FinanceBank` de `@casa-clara/domain/finance`.
- Produces:
  - Canónica: `detectBank(bytes: Uint8Array, filename: string): FinanceBank | null` (en `parsers/index.ts`).
  - Locales: `FinanceParserError` (clase con `row: number`, mensaje `Fila N: …`), `toCents(value: unknown): bigint | null`, `parseDateEs(s: string, row: number): string` (ISO), `buildRaw(headers: readonly unknown[], values: readonly unknown[]): Record<string, string>` (en `shared.ts`); builders `caixabankSampleXls()`, `deutscheSampleXls()`, `openbankSampleHtml()`, `amexSampleXlsx()`, `amexSampleXlsxSinHoja()` → `Uint8Array` (en `synthetic-samples.ts`).

Referencia Python: `/home/abf/github/home-finance/backend/app/importer.py::detect_bank` y `/home/abf/github/home-finance/backend/app/parsers/base.py`. Las muestras son SIEMPRE sintéticas y se GENERAN por código (nunca ficheros binarios en git): CaixaBank/Deutsche como `.xls` BIFF8 con `XLSX.write({ bookType: "biff8" })`, Amex como `.xlsx`, OpenBank como plantilla HTML codificada iso-8859-1. Los tests NUNCA hacen skip (sin `describe.runIf`).

- [ ] **Step 1: Dependencia.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/server add xlsx@0.18.5` (verifica que SOLO cambia `packages/server/package.json` y el lockfile).
- [ ] **Step 2: Test que falla (helpers).** `packages/server/src/finance/parsers/shared.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FinanceParserError, buildRaw, parseDateEs, toCents } from "./shared.js";

describe("toCents (port de money.py::to_cents)", () => {
  it("entiende formato es-ES en texto y números de celda", () => {
    expect(toCents("1.023,45")).toBe(102345n);
    expect(toCents("-55,12")).toBe(-5512n);
    expect(toCents("2.500,00")).toBe(250000n);
    expect(toCents(18.99)).toBe(1899n);
    expect(toCents("")).toBeNull();
    expect(toCents(null)).toBeNull();
  });
});

describe("parseDateEs", () => {
  it("dd/mm/yyyy → ISO; inválida lanza FinanceParserError con la fila", () => {
    expect(parseDateEs("04/05/2026", 7)).toBe("2026-05-04");
    expect(() => parseDateEs("30/02/2026", 7)).toThrow(FinanceParserError);
    expect(() => parseDateEs("no-fecha", 3)).toThrow(/Fila 3/);
  });
});

describe("buildRaw (port de base.py::build_raw)", () => {
  it("cabecera→valor con claves únicas, colN si falta cabecera, descarta pares vacíos", () => {
    expect(buildRaw(["A", "", "A"], ["1", "2", "3", "4"])).toEqual({
      A: "1", col1: "2", "A 2": "3", col3: "4",
    });
    expect(buildRaw(["A"], [""])).toEqual({});
  });
});
```

- [ ] **Step 3: Verlo fallar y implementar `shared.ts`.** Corre `pnpm --filter @casa-clara/server test src/finance/parsers/shared.test.ts` (falla) y crea `packages/server/src/finance/parsers/shared.ts`:

```ts
/** Error de parser con número de fila, como base.py::ParseError del origen. */
export class FinanceParserError extends Error {
  readonly row: number;
  constructor(msg: string, row: number) {
    super(`Fila ${row}: ${msg}`);
    this.name = "FinanceParserError";
    this.row = row;
  }
}

/** Port de money.py::to_cents: texto es-ES ("1.234,56") o número de celda → céntimos. */
export function toCents(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.round(value * 100)) : null;
  }
  const text = String(value).trim().replace(/\./g, "").replace(/,/g, ".");
  if (text === "") return null;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return null; // el llamador lo convierte en FinanceParserError
  const sign = m[1] === "-" ? -1n : 1n;
  const frac = (m[3] ?? "").padEnd(2, "0");
  let cents = BigInt(m[2] as string) * 100n + BigInt(frac.slice(0, 2) || "0");
  if (frac.length > 2 && Number(frac.charAt(2)) >= 5) cents += 1n; // no ocurre en extractos reales
  return sign * cents;
}

const DATE_ES_RX = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** dd/mm/yyyy → yyyy-mm-dd validando que la fecha exista (como strptime). */
export function parseDateEs(s: string, row: number): string {
  const m = DATE_ES_RX.exec(s.trim());
  if (m !== null) {
    const [, d, mo, y] = m as unknown as [string, string, string, string];
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (
      dt.getUTCFullYear() === Number(y) &&
      dt.getUTCMonth() + 1 === Number(mo) &&
      dt.getUTCDate() === Number(d)
    ) {
      return `${y}-${mo}-${d}`;
    }
  }
  throw new FinanceParserError(`fecha inválida ${JSON.stringify(s)}`, row);
}

/** Port de base.py::build_raw: dict cabecera→valor con claves únicas. */
export function buildRaw(
  headers: readonly unknown[],
  values: readonly unknown[],
): Record<string, string> {
  const raw: Record<string, string> = {};
  values.forEach((v, i) => {
    const h = i < headers.length ? String(headers[i] ?? "").trim() : "";
    const val = v === null || v === undefined ? "" : String(v).trim();
    if (h === "" && val === "") return;
    let key = h === "" ? `col${i}` : h;
    if (key in raw) key = `${key} ${i}`;
    raw[key] = val;
  });
  return raw;
}
```

Verifica verde con el mismo comando.

- [ ] **Step 4: Builders de muestras sintéticas.** Crea `packages/server/src/finance/parsers/synthetic-samples.ts` (importes y titulares INVENTADOS; formato idéntico al real):

```ts
/** Muestras SINTÉTICAS de extractos, generadas por código (jamás ficheros
 * reales): titulares, cuentas e importes inventados con el formato del banco. */
import * as XLSX from "xlsx";

function writeWorkbook(grid: string[][], bookType: "biff8" | "xlsx", sheet: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), sheet);
  return new Uint8Array(XLSX.write(wb, { bookType, type: "buffer" }) as Buffer);
}

const CAIXA_HEADER = [
  "", "Número de cuenta", "Oficina", "Referencia", "Fecha operación", "Fecha valor",
  "Ingreso (+)", "Gasto (-)", "Saldo (+)", "Saldo (-)", "Código común", "Código propio",
  "Concepto común", "Concepto propio", "Concepto complementario", "Concepto complementario",
  "Concepto complementario", "Concepto complementario", "Concepto complementario",
  "Concepto complementario", "Concepto complementario", "Concepto complementario",
  "Concepto complementario", "Concepto complementario",
];

export function caixabankSampleXls(): Uint8Array {
  const grid: string[][] = [
    ["CaixaBank — Movimientos (muestra sintética)"],
    [],
    CAIXA_HEADER,
    ["", "2100 0000 0000 0000 1234", "", "", "04/05/2026", "05/05/2026", "", "42,30",
      "1.023,45", "", "11", "612", "COMPRA TARJETA", "5402XXXX1111",
      "Fecha de operación: 02-05-2026 Peluquería Ñoño", "04000174TCR"],
    ["", "2100 0000 0000 0000 1234", "", "", "12/05/2026", "", "", "55,12",
      "", "", "03", "230", "RECIBO LUZ", "",
      "CORE IBERDROLA CLIENTES  X0001", "ES84002A82018474   X0040"],
    [],
    CAIXA_HEADER,
    ["", "2100 0000 0000 0000 5678", "", "", "20/05/2026", "20/05/2026", "25,00", "",
      "125,00", "", "04", "002", "BIZUM", "", "MARIA;GARCIA;LOPEZ", "Cena viernes"],
  ];
  return writeWorkbook(grid, "biff8", "Movimientos");
}

export function deutscheSampleXls(): Uint8Array {
  const grid: string[][] = [
    ["", "Deutsche Bank (muestra sintética)"],
    ["", "Cuenta:", "ES4400190000000000000001"],
    [],
    ["", "date", "valuedate", "concept", "", "", "", "", "amount", "balance"],
    ["", "05/05/2026", "05/05/2026", "RECIBO  IBERDROLA CLIENTES SAU", "", "", "", "", "-55,12", "1.200,00"],
    ["", "07/05/2026", "", "TRANSFERENCIA A FAVOR DE JUAN EJEMPLO", "", "", "", "", "-250,00", "950,00"],
    ["", "28/05/2026", "28/05/2026", "NOM.EX-4 A EMPRESA EJEMPLO SL", "", "", "", "", "2.500,00", "3.450,00"],
  ];
  return writeWorkbook(grid, "biff8", "Hoja1");
}

export function openbankSampleHtml(): Uint8Array {
  const html = `<html><head><title>OPENBANK - Cuentas - Movimientos</title></head><body>
<table><tr><td>N\u00famero de Cuenta:</td><td>0073 0100 5100 0000 0001</td></tr></table>
<table>
<tr><td>Fecha Operaci\u00f3n</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>06/05/2026</td><td>06/05/2026</td><td>TRANSFERENCIA DE CARLOS EJEMPLO, CONCEPTO Aportaci\u00f3n mayo</td><td>300,00</td><td>1.300,00</td></tr>
<tr><td>31/05/2026</td><td></td><td>LIQUIDACION CUENTA ABIERTA</td><td>1,23</td><td>1.301,23</td></tr>
</table></body></html>`;
  return new Uint8Array(Buffer.from(html, "latin1"));
}

const AMEX_SHEET = "Detalles de la operación";

export function amexSampleXlsx(): Uint8Array {
  const grid: string[][] = [
    ["Titular", "SR EJEMPLO"],
    ["Número de Cuenta"],
    ["XXXX-XXXXX-91009"],
    [],
    ["Fecha", "Descripción", "Importe", "Categoría", "Referencia"],
    ["06/05/2026", "AMAZON ES", "18,99", "Compras", "320261250012345678"],
    ["10/05/2026", "RECIBO ENVIADO A SU BANCO", "-500,00", "", "320261250099999999"],
  ];
  return writeWorkbook(grid, "xlsx", AMEX_SHEET);
}

export function amexSampleXlsxSinHoja(): Uint8Array {
  return writeWorkbook([["Fecha", "Importe"]], "xlsx", "Otra hoja");
}
```

- [ ] **Step 5: Test que falla (`detectBank`).** `packages/server/src/finance/parsers/detect.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { detectBank } from "./index.js";
import {
  amexSampleXlsx,
  amexSampleXlsxSinHoja,
  caixabankSampleXls,
  deutscheSampleXls,
  openbankSampleHtml,
} from "./synthetic-samples.js";

describe("detectBank (port de importer.detect_bank, siempre por contenido)", () => {
  it("reconoce los cuatro bancos por sus marcas", () => {
    expect(detectBank(caixabankSampleXls(), "mov.xls")).toBe("caixabank");
    expect(detectBank(deutscheSampleXls(), "mov.xls")).toBe("deutsche_bank");
    expect(detectBank(openbankSampleHtml(), "mov.xls")).toBe("openbank");
    expect(detectBank(amexSampleXlsx(), "mov.xlsx")).toBe("amex");
  });
  it("devuelve null ante contenido no reconocido", () => {
    expect(detectBank(new Uint8Array(Buffer.from("cualquier cosa")), "x.xls")).toBeNull();
    expect(detectBank(amexSampleXlsxSinHoja(), "x.xlsx")).toBeNull();
    expect(detectBank(new Uint8Array(Buffer.from("<html><body>hola</body></html>", "latin1")), "x.xls")).toBeNull();
  });
});
```

- [ ] **Step 6: Verlo fallar e implementar `parsers/index.ts`.** Corre `pnpm --filter @casa-clara/server test src/finance/parsers/detect.test.ts` (falla) y crea `packages/server/src/finance/parsers/index.ts`:

```ts
import * as XLSX from "xlsx";

import type { FinanceBank } from "@casa-clara/domain/finance";

export { FinanceParserError } from "./shared.js";

export const AMEX_SHEET = "Detalles de la operación";

function tryRead(bytes: Uint8Array): XLSX.WorkBook | null {
  try {
    return XLSX.read(bytes, { type: "array" });
  } catch {
    return null;
  }
}

/** Port de importer.detect_bank: SIEMPRE por contenido, nunca por extensión. */
export function detectBank(bytes: Uint8Array, filename: string): FinanceBank | null {
  void filename;
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // zip ⇒ .xlsx: solo Amex exporta xlsx
    const wb = tryRead(bytes);
    return wb !== null && wb.SheetNames.includes(AMEX_SHEET) ? "amex" : null;
  }
  const head = new TextDecoder("iso-8859-1").decode(bytes.slice(0, 4096));
  const stripped = head.replace(/^\s+/, "").toLowerCase();
  if (stripped.startsWith("<!doctype") || stripped.startsWith("<html")) {
    // OpenBank exporta HTML disfrazado de .xls
    return head.toUpperCase().includes("OPENBANK") ? "openbank" : null;
  }
  const wb = tryRead(bytes); // binario BIFF (.xls de verdad)
  if (wb === null) return null;
  const first = wb.SheetNames[0];
  if (first === undefined) return null;
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[first] as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  for (const row of grid.slice(0, 15)) {
    for (const cell of row) {
      const v = String(cell).trim();
      if (v === "Número de cuenta") return "caixabank";
      if (v === "Cuenta:") return "deutsche_bank";
    }
  }
  return null;
}
```

Verifica verde.

- [ ] **Step 7: Cableado CI.** En `.github/workflows/ci.yml`, en el paso «Every Vitest file of web, server and worker must have run», añade tras la línea `--specs 'packages/server::src/*.test.ts'` esta línea: `          --specs 'packages/server::src/finance/**/*.test.ts'`.
- [ ] **Step 8: Commit.** `git add packages/server .github/workflows/ci.yml pnpm-lock.yaml && git commit -m "feat(finanzas): sheetjs solo-servidor, muestras sintéticas y detección de banco"`

---

### Task 13: Parser de CaixaBank

**Files:**
- Create: `packages/server/src/finance/parsers/caixabank.ts`
- Test: `packages/server/src/finance/parsers/caixabank.test.ts`

**Interfaces:**
- Consumes: `toCents`, `parseDateEs`, `buildRaw`, `FinanceParserError` (`./shared.js`); `normalizeBankProvider`, `CARD_PREFIX_RX` (`@casa-clara/domain/finance`); tipo `ParsedRow`; builder `caixabankSampleXls()` (`./synthetic-samples.js`).
- Produces: `parseCaixabank(bytes: Uint8Array): ParsedRow[]`.

Referencia Python: `/home/abf/github/home-finance/backend/app/parsers/caixabank.py`. Fidelidad: la tabla empieza donde la col 1 vale «Número de cuenta» y termina en la primera fila con col 1 en blanco (puede empezar OTRA tabla después); CCC de 20 dígitos por fila (espacios fuera, si no `FinanceParserError`); importe = ingreso (col 6) o −gasto (col 7), error si ambos vacíos; saldo = col 8 o −col 9; códigos en cols 10/11; concepto = cols 12,13 + complementarios 14..23 no vacíos unidos con « | »; provider extraído de los complementarios (regla tarjeta 11/12 con `CARD_PREFIX_RX`, corte en doble espacio) y saneado con `normalizeBankProvider`.

- [ ] **Step 1: Test que falla.**

```ts
import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseCaixabank } from "./caixabank.js";
import { caixabankSampleXls, deutscheSampleXls } from "./synthetic-samples.js";

describe("parseCaixabank (muestra sintética, sin skip)", () => {
  const rows = parseCaixabank(caixabankSampleXls());

  it("lee las dos tablas y sus dos cuentas", () => {
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.accountRef))).toEqual(
      new Set(["21000000000000001234", "21000000000000005678"]),
    );
    expect(rows[0]?.bankRef).toBe(rows[0]?.accountRef);
  });

  it("tarjeta: importe negativo, saldo, códigos, provider del comercio", () => {
    const r = rows[0]!;
    expect(r.opDate).toBe("2026-05-04");
    expect(r.valueDate).toBe("2026-05-05");
    expect(r.amountCents).toBe(-4230n);
    expect(r.balanceCents).toBe(102345n);
    expect(r.codeCommon).toBe("11");
    expect(r.codeOwn).toBe("612");
    expect(r.provider).toBe("Peluquería Ñoño");
    expect(r.concept).toBe(
      "COMPRA TARJETA | 5402XXXX1111 | Fecha de operación: 02-05-2026 Peluquería Ñoño | 04000174TCR",
    );
    expect(r.raw["Número de cuenta"]).toBe("2100 0000 0000 0000 1234");
  });

  it("recibo SEPA sin saldo ni fecha valor; bizum con persona como provider", () => {
    expect(rows[1]).toMatchObject({ amountCents: -5512n, balanceCents: null, valueDate: null, provider: "IBERDROLA CLIENTES" });
    expect(rows[2]).toMatchObject({ amountCents: 2500n, provider: "MARIA GARCIA LOPEZ" });
  });

  it("un fichero sin tabla CaixaBank lanza FinanceParserError", () => {
    expect(() => parseCaixabank(deutscheSampleXls())).toThrow(FinanceParserError);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `pnpm --filter @casa-clara/server test src/finance/parsers/caixabank.test.ts`
- [ ] **Step 3: Implementación.** `packages/server/src/finance/parsers/caixabank.ts`:

```ts
import * as XLSX from "xlsx";

import { CARD_PREFIX_RX, normalizeBankProvider, type ParsedRow } from "@casa-clara/domain/finance";

import { FinanceParserError, buildRaw, parseDateEs, toCents } from "./shared.js";

const HEADER_MARK = "Número de cuenta";

/** Port de parsers/caixabank.py::_extract_provider. */
function extractProvider(codeCommon: string, complementarios: readonly string[]): string {
  const joined = complementarios.map((c) => c.trim()).filter((c) => c !== "").join(" ");
  if (codeCommon === "11" || codeCommon === "12") {
    const m = CARD_PREFIX_RX.exec(joined);
    if (m !== null) {
      return (joined.slice(m.index + m[0].length).split("  ")[0] as string).trim().slice(0, 200);
    }
  }
  const first = complementarios.map((c) => c.trim()).find((c) => c !== "") ?? "";
  return first.replace(/\s{2,}.*$/, "").slice(0, 200);
}

/** Port de parsers/caixabank.py::parse sobre SheetJS. */
export function parseCaixabank(bytes: Uint8Array): ParsedRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const first = wb.SheetNames[0];
  if (first === undefined) throw new FinanceParserError("libro sin hojas", 0);
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[first] as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  const text = (row: unknown[], i: number): string => String(row[i] ?? "").trim();
  const rows: ParsedRow[] = [];
  let inTable = false;
  let headers: string[] = [];
  grid.forEach((cells, r) => {
    if (text(cells, 1) === HEADER_MARK) {
      headers = cells.map((c) => String(c ?? "").trim());
      inTable = true;
      return;
    }
    if (!inTable) return;
    const rawRef = text(cells, 1);
    if (rawRef === "") {
      inTable = false; // fila en blanco: fin de tabla (puede empezar otra)
      return;
    }
    const bankRef = rawRef.replace(/ /g, "");
    if (!/^\d{20}$/.test(bankRef)) {
      throw new FinanceParserError(`número de cuenta inesperado ${JSON.stringify(rawRef)}`, r);
    }
    const ingreso = toCents(cells[6]);
    const gasto = toCents(cells[7]);
    if (ingreso === null && gasto === null) {
      throw new FinanceParserError("sin importe de ingreso ni gasto", r);
    }
    const amount = ingreso !== null ? ingreso : -(gasto as bigint);
    const saldoPos = toCents(cells[8]);
    const saldoNeg = toCents(cells[9]);
    const balance = saldoPos !== null ? saldoPos : saldoNeg !== null ? -saldoNeg : null;
    const codeCommon = text(cells, 10) || null;
    const codeOwn = text(cells, 11) || null;
    const complementarios = cells.slice(14, 24).map((c) => String(c ?? ""));
    const concept = [text(cells, 12), text(cells, 13), ...complementarios.map((c) => c.trim())]
      .filter((c) => c !== "")
      .join(" | ");
    rows.push({
      accountRef: bankRef,
      bankRef,
      opDate: parseDateEs(text(cells, 4), r),
      valueDate: text(cells, 5) !== "" ? parseDateEs(text(cells, 5), r) : null,
      concept,
      provider: normalizeBankProvider({
        provider: extractProvider(codeCommon ?? "", complementarios),
        concept,
        codeCommon,
        codeOwn,
        bank: "caixabank",
      }),
      amountCents: amount,
      balanceCents: balance,
      codeCommon,
      codeOwn,
      dedupRef: null,
      bankCategory: null,
      raw: buildRaw(headers, cells),
    });
  });
  if (rows.length === 0) {
    throw new FinanceParserError("no se encontró ninguna tabla de movimientos de CaixaBank", 0);
  }
  return rows;
}
```

- [ ] **Step 4: Verde.** Repite Step 2.
- [ ] **Step 5: Commit.** `git add packages/server && git commit -m "feat(finanzas): parser de caixabank con multitabla y ccc por fila"`

---

### Task 14: Parsers de Deutsche Bank y OpenBank

**Files:**
- Create: `packages/server/src/finance/parsers/deutschebank.ts`, `packages/server/src/finance/parsers/openbank.ts`
- Test: `packages/server/src/finance/parsers/deutschebank.test.ts`, `packages/server/src/finance/parsers/openbank.test.ts`

**Interfaces:**
- Consumes: helpers de `./shared.js`; `normalizeBankProvider` (`@casa-clara/domain/finance`); builders `deutscheSampleXls()`, `openbankSampleHtml()`, `caixabankSampleXls()`.
- Produces: `parseDeutsche(bytes: Uint8Array): ParsedRow[]` · `parseOpenbank(bytes: Uint8Array): ParsedRow[]`.

Referencias Python: `parsers/deutschebank.py` (IBAN en la fila «Cuenta:», cabecera con col 1 = `date` y `amount` presente; prefijos `RECIBO\s+`→"", `NOM\.EX-\d+\s+A\s+`→"NOMINA ", `TRANSFERENCIA\s+(A FAVOR DE\s+|DE\s+)?`→"") y `parsers/openbank.py` (HTML iso-8859-1 aplanado a filas de celdas de texto; `<br>`→espacio; celdas separadoras vacías fuera; cuenta en la fila «Número de Cuenta»; filas de datos = ≥5 celdas con fecha dd/mm/yyyy; provider de `TRANSFERENCIA [INMEDIATA] A FAVOR DE|DE …` cortado en «, CONCEPTO», «Openbank» para `LIQUIDACION…`; el saneado por banco NO se aplica en OpenBank, igual que en el origen).

- [ ] **Step 1: Tests que fallan.** `deutschebank.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseDeutsche } from "./deutschebank.js";
import { caixabankSampleXls, deutscheSampleXls } from "./synthetic-samples.js";

describe("parseDeutsche (muestra sintética, sin skip)", () => {
  const rows = parseDeutsche(deutscheSampleXls());
  it("toma el IBAN de la cabecera y lee las tres filas", () => {
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.accountRef === "ES4400190000000000000001")).toBe(true);
  });
  it("aplica los prefijos del origen al provider", () => {
    expect(rows.map((r) => r.provider)).toEqual([
      "IBERDROLA CLIENTES SAU", "JUAN EJEMPLO", "NOMINA EMPRESA EJEMPLO SL",
    ]);
    expect(rows[0]).toMatchObject({ opDate: "2026-05-05", amountCents: -5512n, balanceCents: 120000n });
    expect(rows[1]?.valueDate).toBeNull();
    expect(rows[2]?.amountCents).toBe(250000n);
  });
  it("sin IBAN ni cabecera lanza FinanceParserError", () => {
    expect(() => parseDeutsche(caixabankSampleXls())).toThrow(FinanceParserError);
  });
});
```

`openbank.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseOpenbank } from "./openbank.js";
import { openbankSampleHtml } from "./synthetic-samples.js";

describe("parseOpenbank (HTML iso-8859-1 sintético, sin skip)", () => {
  const rows = parseOpenbank(openbankSampleHtml());
  it("lee la cuenta sin espacios y las dos filas con acentos intactos", () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]?.accountRef).toBe("0073010051000000000001");
    expect(rows[0]?.concept).toBe("TRANSFERENCIA DE CARLOS EJEMPLO, CONCEPTO Aportación mayo");
  });
  it("deriva el provider de transferencias y liquidaciones", () => {
    expect(rows[0]).toMatchObject({ provider: "CARLOS EJEMPLO", amountCents: 30000n, balanceCents: 130000n });
    expect(rows[1]).toMatchObject({ provider: "Openbank", amountCents: 123n, valueDate: null });
  });
  it("un HTML sin cuenta lanza FinanceParserError", () => {
    expect(() =>
      parseOpenbank(new Uint8Array(Buffer.from("<html><body><table></table></body></html>", "latin1"))),
    ).toThrow(FinanceParserError);
  });
});
```

- [ ] **Step 2: Verlos fallar.** `pnpm --filter @casa-clara/server test src/finance/parsers/deutschebank.test.ts src/finance/parsers/openbank.test.ts`
- [ ] **Step 3: Implementación Deutsche.** `packages/server/src/finance/parsers/deutschebank.ts`:

```ts
import * as XLSX from "xlsx";

import { normalizeBankProvider, type ParsedRow } from "@casa-clara/domain/finance";

import { FinanceParserError, buildRaw, parseDateEs, toCents } from "./shared.js";

const PREFIXES: readonly [RegExp, string][] = [
  [/^RECIBO\s+/, ""],
  [/^NOM\.EX-\d+\s+A\s+/, "NOMINA "],
  [/^TRANSFERENCIA\s+(A FAVOR DE\s+|DE\s+)?/, ""],
];

function dbProvider(concept: string): string {
  for (const [rx, prefix] of PREFIXES) {
    const m = rx.exec(concept);
    if (m !== null) return (prefix + concept.slice(m[0].length)).trim().slice(0, 200);
  }
  return concept.trim().slice(0, 200);
}

/** Port de parsers/deutschebank.py::parse sobre SheetJS. */
export function parseDeutsche(bytes: Uint8Array): ParsedRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const first = wb.SheetNames[0];
  if (first === undefined) throw new FinanceParserError("libro sin hojas", 0);
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[first] as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  const text = (row: unknown[], i: number): string => String(row[i] ?? "").trim();
  let iban: string | null = null;
  let headerRow: number | null = null;
  let headers: string[] = [];
  for (let r = 0; r < grid.length; r += 1) {
    const cells = (grid[r] as unknown[]).map((c) => String(c ?? "").trim());
    if (cells[1] === "Cuenta:") iban = cells[2] ?? null;
    if (cells[1] === "date" && cells.includes("amount")) {
      headerRow = r;
      headers = cells;
      break;
    }
  }
  if (iban === null || headerRow === null) {
    throw new FinanceParserError("no se encontró el IBAN o la cabecera de la tabla", 0);
  }
  const rows: ParsedRow[] = [];
  for (let r = headerRow + 1; r < grid.length; r += 1) {
    const cells = grid[r] as unknown[];
    if (text(cells, 1) === "") continue;
    const concept = text(cells, 3);
    const amount = toCents(cells[8]);
    if (amount === null) throw new FinanceParserError(`importe vacío en ${JSON.stringify(concept)}`, r);
    rows.push({
      accountRef: iban,
      bankRef: iban,
      opDate: parseDateEs(text(cells, 1), r),
      valueDate: text(cells, 2) !== "" ? parseDateEs(text(cells, 2), r) : null,
      concept,
      provider: normalizeBankProvider({
        provider: dbProvider(concept),
        concept,
        codeCommon: null,
        codeOwn: null,
        bank: "deutsche_bank",
      }),
      amountCents: amount,
      balanceCents: toCents(cells[9]),
      codeCommon: null,
      codeOwn: null,
      dedupRef: null,
      bankCategory: null,
      raw: buildRaw(headers, cells),
    });
  }
  if (rows.length === 0) {
    throw new FinanceParserError("fichero de Deutsche Bank sin movimientos", headerRow);
  }
  return rows;
}
```

- [ ] **Step 4: Implementación OpenBank.** `packages/server/src/finance/parsers/openbank.ts`:

```ts
import type { ParsedRow } from "@casa-clara/domain/finance";

import { FinanceParserError, buildRaw, parseDateEs, toCents } from "./shared.js";

const DATE_RX = /^\d{2}\/\d{2}\/\d{4}$/;
const TRANSFER_RX = /^TRANSFERENCIA(?:\s+INMEDIATA)?\s+(?:A\s+FAVOR\s+DE|DE)\s+(.*)/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** Aplana el HTML de OpenBank a filas de celdas de texto (una lista por <tr>). */
function htmlTableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const td of (tr[1] as string).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      const inner = (td[1] as string).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
      cells.push(decodeEntities(inner).trim());
    }
    rows.push(cells);
  }
  return rows;
}

function obProvider(concept: string): string {
  const m = TRANSFER_RX.exec(concept);
  if (m !== null) {
    return ((m[1] as string).split(/,?\s*CONCEPTO\b/i)[0] as string).trim().slice(0, 200);
  }
  if (concept.toUpperCase().startsWith("LIQUIDACION")) return "Openbank";
  return concept.trim().slice(0, 200);
}

/** Port de parsers/openbank.py::parse (HTML disfrazado de .xls, iso-8859-1). */
export function parseOpenbank(bytes: Uint8Array): ParsedRow[] {
  const html = new TextDecoder("iso-8859-1").decode(bytes);
  const cellRows = htmlTableRows(html)
    .map((row) => row.filter((c) => c.trim() !== ""))
    .filter((row) => row.length > 0);

  let bankRef: string | null = null;
  for (const row of cellRows) {
    const head = (row[0] as string).trim().replace(/:+$/, "").toLowerCase();
    if (head.startsWith("número de cuenta") && row.length >= 2) {
      bankRef = (row[1] as string).replace(/ /g, "");
      break;
    }
  }
  if (bankRef === null) {
    throw new FinanceParserError("no se encontró el número de cuenta de OpenBank", 0);
  }
  const headers = cellRows.find((row) => row[0] === "Fecha Operación") ?? [];

  const rows: ParsedRow[] = [];
  cellRows.forEach((row, i) => {
    if (row.length < 5 || !DATE_RX.test(row[0] as string)) return;
    const [opRaw, valRaw, concept, importe, saldo] = row as [string, string, string, string, string];
    const amount = toCents(importe);
    if (amount === null) throw new FinanceParserError(`importe vacío en ${JSON.stringify(concept)}`, i);
    rows.push({
      accountRef: bankRef as string,
      bankRef: bankRef as string,
      opDate: parseDateEs(opRaw, i),
      valueDate: DATE_RX.test(valRaw) ? parseDateEs(valRaw, i) : null,
      concept,
      provider: obProvider(concept),
      amountCents: amount,
      balanceCents: toCents(saldo),
      codeCommon: null,
      codeOwn: null,
      dedupRef: null,
      bankCategory: null,
      raw: buildRaw(headers, row),
    });
  });
  if (rows.length === 0) throw new FinanceParserError("fichero de OpenBank sin movimientos", 0);
  return rows;
}
```

- [ ] **Step 5: Verde.** Repite el comando del Step 2.
- [ ] **Step 6: Commit.** `git add packages/server && git commit -m "feat(finanzas): parsers de deutsche bank y openbank"`

---

### Task 15: Parser de Amex, `parseStatement` y export del paquete

**Files:**
- Create: `packages/server/src/finance/parsers/amex.ts`
- Modify: `packages/server/src/finance/parsers/index.ts`, `packages/server/src/index.ts`
- Test: `packages/server/src/finance/parsers/amex.test.ts`, `packages/server/src/finance/parsers/statement.test.ts`

**Interfaces:**
- Consumes: helpers de `./shared.js`; builders de `./synthetic-samples.js`; tipos `ParsedRow`, `ParsedStatement`.
- Produces: `parseAmex(bytes: Uint8Array): ParsedRow[]`; canónica `parseStatement(bytes: Uint8Array, filename: string): ParsedStatement` (lanza `FinanceParserError` si el banco no se reconoce).

Referencia Python: `parsers/amex.py`. Fidelidad: hoja «Detalles de la operación»; nº de cuenta = primera celda no vacía tras la fila «Número de Cuenta»; cabecera = fila cuyo primer valor es «Fecha» y contiene «Importe», columnas resueltas POR NOMBRE; signo INVERTIDO (`amountCents = -toCents(Importe)`); columna «Referencia» obligatoria por fila → `dedupRef`; «Categoría» → `bankCategory`; sin fecha valor ni saldo.

- [ ] **Step 1: Tests que fallan.** `amex.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FinanceParserError } from "./shared.js";
import { parseAmex } from "./amex.js";
import { amexSampleXlsx, amexSampleXlsxSinHoja } from "./synthetic-samples.js";

describe("parseAmex (muestra sintética, sin skip)", () => {
  const rows = parseAmex(amexSampleXlsx());
  it("invierte el signo y arrastra referencia y categoría del banco", () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      accountRef: "XXXX-XXXXX-91009", opDate: "2026-05-06", amountCents: -1899n,
      dedupRef: "320261250012345678", bankCategory: "Compras", provider: "AMAZON ES",
      valueDate: null, balanceCents: null,
    });
    expect(rows[1]).toMatchObject({ amountCents: 50000n, bankCategory: null });
  });
  it("sin la hoja de detalles lanza FinanceParserError", () => {
    expect(() => parseAmex(amexSampleXlsxSinHoja())).toThrow(FinanceParserError);
  });
});
```

`statement.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FinanceParserError, parseStatement } from "./index.js";
import { caixabankSampleXls, openbankSampleHtml } from "./synthetic-samples.js";

describe("parseStatement (despacho por banco detectado)", () => {
  it("devuelve banco, refs únicas y filas", () => {
    const st = parseStatement(caixabankSampleXls(), "mov.xls");
    expect(st.bank).toBe("caixabank");
    expect(st.accountRefs).toEqual(["21000000000000001234", "21000000000000005678"]);
    expect(st.rows).toHaveLength(3);
    expect(parseStatement(openbankSampleHtml(), "mov.xls").bank).toBe("openbank");
  });
  it("contenido no reconocido lanza FinanceParserError con el nombre del fichero", () => {
    expect(() => parseStatement(new Uint8Array(Buffer.from("nada")), "raro.xls")).toThrow(/raro\.xls/);
    expect(() => parseStatement(new Uint8Array(Buffer.from("nada")), "raro.xls")).toThrow(FinanceParserError);
  });
});
```

- [ ] **Step 2: Verlos fallar.** `pnpm --filter @casa-clara/server test src/finance/parsers/amex.test.ts src/finance/parsers/statement.test.ts`
- [ ] **Step 3: Implementación Amex.** `packages/server/src/finance/parsers/amex.ts`:

```ts
import * as XLSX from "xlsx";

import type { ParsedRow } from "@casa-clara/domain/finance";

import { FinanceParserError, buildRaw, parseDateEs, toCents } from "./shared.js";
import { AMEX_SHEET } from "./index.js";

const compact = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Port de parsers/amex.py::parse sobre SheetJS (signo invertido, ref obligatoria). */
export function parseAmex(bytes: Uint8Array): ParsedRow[] {
  const wb = XLSX.read(bytes, { type: "array" });
  if (!wb.SheetNames.includes(AMEX_SHEET)) {
    throw new FinanceParserError("no se encontró la hoja 'Detalles de la operación'", 0);
  }
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[AMEX_SHEET] as XLSX.WorkSheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  let bankRef: string | null = null;
  let headerIdx: number | null = null;
  let cols: Record<string, number> = {};
  let headers: string[] = [];
  let expectRef = false;
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i] as unknown[];
    const first = String(row[0] ?? "").trim();
    if (expectRef && first !== "") {
      bankRef = first;
      expectRef = false;
    }
    if (first === "Número de Cuenta") expectRef = true;
    if (first === "Fecha") {
      const names = row.map((c) => String(c ?? "").trim());
      if (names.includes("Importe")) {
        cols = Object.fromEntries(names.map((nm, j) => [nm, j]).filter(([nm]) => nm !== ""));
        headers = names;
        headerIdx = i;
        break;
      }
    }
  }
  if (bankRef === null || headerIdx === null || !("Descripción" in cols)) {
    throw new FinanceParserError("no se encontró el número de cuenta o la cabecera de la tabla", 0);
  }
  const out: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const row = grid[i] as unknown[];
    const cell = (name: string): string =>
      name in cols ? String(row[cols[name] as number] ?? "").trim() : "";
    if (cell("Fecha") === "") continue;
    const concept = cell("Descripción");
    const amount = toCents(row[cols["Importe"] as number]);
    if (amount === null) throw new FinanceParserError(`importe vacío en ${JSON.stringify(concept)}`, i);
    const ref = cell("Referencia");
    if (ref === "") throw new FinanceParserError(`referencia vacía en ${JSON.stringify(concept)}`, i);
    const categoria = cell("Categoría");
    out.push({
      accountRef: bankRef,
      bankRef,
      opDate: parseDateEs(cell("Fecha"), i),
      valueDate: null,
      concept,
      provider: compact(concept).slice(0, 200),
      amountCents: -amount, // convención Amex invertida: cargo positivo en fichero
      balanceCents: null,
      codeCommon: null,
      codeOwn: null,
      dedupRef: ref,
      bankCategory: categoria === "" ? null : categoria,
      raw: buildRaw(headers, row),
    });
  }
  if (out.length === 0) throw new FinanceParserError("fichero de Amex sin movimientos", headerIdx);
  return out;
}
```

- [ ] **Step 4: `parseStatement` y export.** En `packages/server/src/finance/parsers/index.ts` añade al final:

```ts
import type { ParsedRow, ParsedStatement } from "@casa-clara/domain/finance";

import { FinanceParserError } from "./shared.js";
import { parseAmex } from "./amex.js";
import { parseCaixabank } from "./caixabank.js";
import { parseDeutsche } from "./deutschebank.js";
import { parseOpenbank } from "./openbank.js";

const PARSERS: Record<FinanceBank, (bytes: Uint8Array) => ParsedRow[]> = {
  caixabank: parseCaixabank,
  deutsche_bank: parseDeutsche,
  openbank: parseOpenbank,
  amex: parseAmex,
};

/** Detecta el banco y parsea el extracto completo. Lanza FinanceParserError. */
export function parseStatement(bytes: Uint8Array, filename: string): ParsedStatement {
  const bank = detectBank(bytes, filename);
  if (bank === null) {
    throw new FinanceParserError(
      `formato de ${filename} no reconocido (ni CaixaBank ni Deutsche Bank ni Amex ni OpenBank)`,
      0,
    );
  }
  const rows = PARSERS[bank](bytes);
  return { bank, accountRefs: [...new Set(rows.map((r) => r.accountRef))], rows };
}
```

(Mueve los `import` junto a los existentes de la cabecera del fichero para cumplir el lint.) En `packages/server/src/index.ts` añade, junto al export de dedup-hash: `export * from "./finance/parsers/index.js";`.

- [ ] **Step 5: Verde + typecheck.** `pnpm --filter @casa-clara/server test src/finance/parsers && pnpm --filter @casa-clara/server typecheck`
- [ ] **Step 6: Commit.** `git add packages/server && git commit -m "feat(finanzas): parser de amex y despacho parseStatement por contenido"`

---

### Task 16: `pipeline.ts` — 8 pasos en orden fijo, test integral y gates

**Files:**
- Create: `packages/server/src/finance/pipeline.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/finance/pipeline.test.ts`

**Interfaces:**
- Consumes (del dominio, `@casa-clara/domain/finance`): `matchRule`, `paypalVendor`, `normText`, `reconcileAmex`, `detectInvestmentContributions`, `detectTransferPairs`, `detectCashMovements`, `assessRecurrence`, `matchEventRules` y los tipos `FinanceTxView`, `FinanceAccountView`, `FinanceCategoryView`, `FinanceRuleView`, `FinanceEventRuleView`, `FinanceProviderAliasView`, `TransferProposal`; `PoolClient` de `pg`; `randomUUID` de `node:crypto`. Columnas SQL según el doc de interfaces §Esquema.
- Produces:
  - Canónica: `runPostImportPipeline(client: PoolClient, householdId: string): Promise<PipelineReport>` — orden FIJO: reglas → alias PayPal → Amex → inversiones → transferencias → efectivo → recurrencia → reglas de evento.
  - Locales (testables sin BD; el test dbe2e real llega en fases 5/7): `PIPELINE_ORDER: readonly PipelineStepName[]`, `type PipelineStepName`, `interface PipelineReport { steps: { name: PipelineStepName; affected: number }[] }`, `interface PipelineState { txs: FinanceTxView[]; accounts: FinanceAccountView[]; categories: FinanceCategoryView[]; rules: FinanceRuleView[]; eventRules: FinanceEventRuleView[]; aliases: FinanceProviderAliasView[]; txEvents: { txId: string; eventId: string }[] }`, `interface PipelineChanges { updatedTxs: Map<string, { categoryId: string | null; status: FinanceTxView["status"]; transferGroupId: string | null; recurrence: FinanceTxView["recurrence"] }>; insertedTxs: NewPipelineTx[]; insertedAliases: FinanceProviderAliasView[]; insertedCategories: FinanceCategoryView[]; insertedTxEvents: { txId: string; eventId: string }[] }`, `interface NewPipelineTx { id: string; accountId: string; sourceTxId: string; opDate: string; concept: string; provider: string; providerNorm: string; amountCents: bigint; categoryId: string; status: "confirmada"; transferGroupId: string; dedupHash: string }`, `runPipelineSteps(state: PipelineState, newId: () => string): { report: PipelineReport; changes: PipelineChanges }`.

Referencia Python del ORDEN (semántica crítica, spec §13): `/home/abf/github/home-finance/backend/app/api.py` líneas 337–345 (`apply_rules` → `renormalize.create_paypal_aliases` → `reconcile_amex_payments` → `detect_investment_contributions` → `detect_transfers` → `detect_cash_withdrawals` → `detect_recurrence` → `apply_event_rules`); alias PayPal: `renormalize.py::create_paypal_aliases` (alias `"<Vendor> [PayPal]"`, nunca pisa alias existentes); categoría «Efectivo»: `cash.py::efectivo_category_id` (se crea si falta). En el origen este orden estaba duplicado en `api.py` y `cli.py`; aquí UNA sola verdad. Los espejos heredan el `batch_id` de su cargo (para que deshacer el lote los arrastre, como en el origen). No se portan `ensure_investment_accounts` ni `ensure_amex_account`/`ensure_cash_account`: las cuentas son datos (seed/Ajustes/confirm de importación), spec §5-6.

- [ ] **Step 1: Test integral que falla.** `packages/server/src/finance/pipeline.test.ts` (unit puro, sin BD, sin skip):

```ts
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import type {
  FinanceAccountView,
  FinanceCategoryView,
  FinanceTxView,
} from "@casa-clara/domain/finance";

import {
  PIPELINE_ORDER,
  runPipelineSteps,
  runPostImportPipeline,
  type PipelineState,
} from "./pipeline.js";

const acc = (id: string, bank: string, kind: FinanceAccountView["kind"], extra: Partial<FinanceAccountView> = {}): FinanceAccountView =>
  ({ id, name: id, bank, kind, bankRef: `ref-${id}`, ownerAliases: [], transferRefs: [], ...extra });
function tx(id: string, overrides: Partial<FinanceTxView>): FinanceTxView {
  return {
    id, accountId: "a1", opDate: "2026-06-10", concept: "X", provider: null,
    providerNorm: null, amountCents: -1000n, categoryId: null, status: "pendiente",
    transferGroupId: null, recurrence: null, recurrenceManual: false,
    dedupHash: `h-${id}`, codeCommon: null, codeOwn: null, categoryKind: null, ...overrides,
  };
}
const categories: FinanceCategoryView[] = [
  { id: "cat-tr", parentId: null, name: "Transferencias internas", kind: "transferencia" },
  { id: "cat-casa", parentId: null, name: "Casa", kind: "gasto" },
];

function buildState(): PipelineState {
  return {
    accounts: [
      acc("a1", "caixabank", "comun", { ownerAliases: ["Padre Ejemplo"] }),
      acc("a2", "openbank", "personal"),
      acc("amex1", "amex", "personal"),
      acc("inv1", "inversion", "inversion", { transferRefs: ["0001234"] }),
    ],
    categories: [...categories],
    rules: [{ id: "r1", ruleType: "proveedor_exacto", pattern: "IBERDROLA CLIENTES", categoryId: "cat-casa", priority: 0 }],
    eventRules: [{ id: "er1", providerNorm: "MARIA GARCIA LOPEZ", conceptNorm: null, categoryId: null, eventId: "ev1" }],
    aliases: [],
    txEvents: [],
    txs: [
      tx("iber1", { provider: "IBERDROLA CLIENTES", codeCommon: "03", concept: "RECIBO LUZ", amountCents: -5512n }),
      tx("iber2", { provider: "IBERDROLA CLIENTES", codeCommon: "03", concept: "RECIBO LUZ", amountCents: -5498n, opDate: "2026-05-05", status: "confirmada", categoryId: "cat-casa", categoryKind: "gasto" }),
      tx("iber3", { provider: "IBERDROLA CLIENTES", codeCommon: "03", concept: "RECIBO LUZ", amountCents: -5601n, opDate: "2026-04-06", status: "confirmada", categoryId: "cat-casa", categoryKind: "gasto" }),
      tx("pp", { provider: "PAYPAL *STEAM GAMES 4029357733", amountCents: -1999n, status: "confirmada" }),
      tx("amexPay", { accountId: "amex1", amountCents: 50000n, concept: "Recibo enviado a su banco", opDate: "2026-06-10" }),
      tx("amexChg", { amountCents: -50000n, provider: "AMERICAN EXPRESS EUROPE", concept: "ADEUDO SEPA", opDate: "2026-06-11" }),
      tx("invChg", { amountCents: -25000n, concept: "TRANSFERENCIAS | 2860 56 0001234 APORTACION", provider: "BENEFICIARIO", codeCommon: "04", codeOwn: "073", opDate: "2026-06-12" }),
      tx("trOut", { amountCents: -30000n, concept: "TRASPASO A CUENTA AZUL Padre Ejemplo", opDate: "2026-06-15" }),
      tx("trIn", { accountId: "a2", amountCents: 30000n, concept: "ABONO RECIBIDO", opDate: "2026-06-16" }),
      tx("cash", { amountCents: -6000n, concept: "REINT. CAJERO 1234", opDate: "2026-06-18" }),
      tx("bizum", { amountCents: -1500n, provider: "MARIA GARCIA LOPEZ", concept: "BIZUM | Cena viernes", status: "confirmada", opDate: "2026-06-20" }),
    ],
  };
}

describe("runPipelineSteps: los 8 pasos en el orden del origen", () => {
  it("fija el orden canónico", () => {
    expect([...PIPELINE_ORDER]).toEqual([
      "reglas", "alias_paypal", "amex", "inversiones",
      "transferencias", "efectivo", "recurrencia", "reglas_evento",
    ]);
  });

  it("caso integral: cada paso actúa sobre el resultado del anterior", () => {
    const state = buildState();
    let seq = 0;
    const { report, changes } = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    const byId = new Map(state.txs.map((t) => [t.id, t]));

    expect(report.steps.map((s) => s.name)).toEqual([...PIPELINE_ORDER]);
    expect(report.steps.map((s) => s.affected)).toEqual([1, 1, 1, 1, 2, 1, 6, 1]);

    // 1. reglas: solo la pendiente
    expect(byId.get("iber1")).toMatchObject({ status: "sugerida_regla", categoryId: "cat-casa" });
    // 2. alias PayPal
    expect(changes.insertedAliases).toEqual([
      { providerNorm: "PAYPAL *STEAM GAMES 4029357733", display: "Steam Games [PayPal]" },
    ]);
    // 3. Amex ANTES que transferencias: el par queda conciliado, no «robado»
    expect(byId.get("amexPay")?.transferGroupId).toBe(byId.get("amexChg")?.transferGroupId);
    expect(byId.get("amexChg")).toMatchObject({ status: "confirmada", categoryId: "cat-tr" });
    // 4. inversión: espejo insertado con hash invmirror- y cargo agrupado
    expect(changes.insertedTxs).toHaveLength(1);
    expect(changes.insertedTxs[0]).toMatchObject({
      accountId: "inv1", sourceTxId: "invChg", amountCents: 25000n,
      dedupHash: "invmirror-h-invChg", status: "confirmada",
    });
    expect(byId.get("invChg")).toMatchObject({ status: "confirmada", categoryId: "cat-tr" });
    // 5. transferencias: el traspaso con alias queda confirmado
    expect(byId.get("trOut")?.transferGroupId).toBe(byId.get("trIn")?.transferGroupId);
    expect(byId.get("trOut")?.status).toBe("confirmada");
    // 6. efectivo: crea la categoría «Efectivo» y confirma la retirada
    expect(changes.insertedCategories).toEqual([
      { id: expect.any(String), parentId: null, name: "Efectivo", kind: "gasto" },
    ]);
    expect(byId.get("cash")?.status).toBe("confirmada");
    // 7. recurrencia: 3 meses de Iberdrola ⇒ recurrente; sueltas ⇒ extraordinario
    expect(byId.get("iber1")?.recurrence).toBe("recurrente");
    expect(byId.get("cash")?.recurrence).toBe("extraordinario");
    // 8. reglas de evento al final, sobre el estado ya agrupado
    expect(changes.insertedTxEvents).toEqual([{ txId: "bizum", eventId: "ev1" }]);
  });

  it("es idempotente: una segunda pasada no propone nada nuevo", () => {
    const state = buildState();
    let seq = 0;
    runPipelineSteps(state, () => `id-${(seq += 1)}`);
    const second = runPipelineSteps(state, () => `id-${(seq += 1)}`);
    expect(second.changes.insertedTxs).toHaveLength(0);
    expect(second.changes.insertedAliases).toHaveLength(0);
    expect(second.changes.insertedTxEvents).toHaveLength(0);
    expect(second.report.steps.map((s) => s.affected)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("runPostImportPipeline: carga y persistencia SQL (cliente simulado)", () => {
  it("carga el estado, ejecuta los pasos y emite los UPDATE", async () => {
    const writes: { sql: string; params: unknown[] }[] = [];
    const txRow = {
      id: "iber1", account_id: "a1", op_date: "2026-06-10", concept: "RECIBO LUZ",
      provider: "IBERDROLA CLIENTES", provider_norm: "IBERDROLA CLIENTES",
      amount_cents: "-5512", category_id: null, status: "pendiente",
      transfer_group_id: null, recurrence: null, recurrence_manual: false,
      dedup_hash: "h1", code_common: "03", code_own: null, category_kind: null,
    };
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const s = sql.trim().toLowerCase();
        if (s.startsWith("select")) {
          if (s.includes("from app.finance_transactions")) return { rows: [txRow] };
          if (s.includes("from app.finance_accounts"))
            return { rows: [{ id: "a1", name: "Caixa", bank: "caixabank", kind: "comun", bank_ref: "r1", owner_aliases: [], transfer_refs: [] }] };
          if (s.includes("from app.finance_categories"))
            return { rows: [{ id: "cat-casa", parent_id: null, name: "Casa", kind: "gasto" }, { id: "cat-tr", parent_id: null, name: "Transferencias internas", kind: "transferencia" }] };
          if (s.includes("from app.finance_rules"))
            return { rows: [{ id: "r1", rule_type: "proveedor_exacto", pattern: "IBERDROLA CLIENTES", category_id: "cat-casa", priority: 0 }] };
          if (s.includes("from app.finance_event_rules")) return { rows: [] };
          if (s.includes("from app.finance_provider_aliases")) return { rows: [] };
          if (s.includes("from app.finance_transaction_events")) return { rows: [] };
        }
        writes.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;

    const report = await runPostImportPipeline(client, "hh-1");
    expect(report.steps[0]).toEqual({ name: "reglas", affected: 1 });
    const update = writes.find((w) => w.sql.includes("update app.finance_transactions"));
    expect(update?.params).toEqual(["hh-1", "iber1", "cat-casa", "sugerida_regla", null, "extraordinario"]);
  });
});
```

- [ ] **Step 2: Verlo fallar.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm --filter @casa-clara/server test src/finance/pipeline.test.ts`
- [ ] **Step 3: Implementación.** `packages/server/src/finance/pipeline.ts`:

```ts
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  assessRecurrence,
  detectCashMovements,
  detectInvestmentContributions,
  detectTransferPairs,
  matchEventRules,
  matchRule,
  normText,
  paypalVendor,
  reconcileAmex,
  type FinanceAccountView,
  type FinanceCategoryView,
  type FinanceEventRuleView,
  type FinanceProviderAliasView,
  type FinanceRecurrence,
  type FinanceRuleView,
  type FinanceTransactionStatus,
  type FinanceTxView,
  type TransferProposal,
} from "@casa-clara/domain/finance";

/** Orden FIJO del pipeline post-import (api.py:337-345 del origen; spec §6/§13).
 * En el origen estaba duplicado en api.py y cli.py: aquí una sola verdad. */
export const PIPELINE_ORDER = [
  "reglas",
  "alias_paypal",
  "amex",
  "inversiones",
  "transferencias",
  "efectivo",
  "recurrencia",
  "reglas_evento",
] as const;
export type PipelineStepName = (typeof PIPELINE_ORDER)[number];

export interface PipelineReport {
  steps: { name: PipelineStepName; affected: number }[];
}

export interface PipelineState {
  txs: FinanceTxView[];
  accounts: FinanceAccountView[];
  categories: FinanceCategoryView[];
  rules: FinanceRuleView[];
  eventRules: FinanceEventRuleView[];
  aliases: FinanceProviderAliasView[];
  txEvents: { txId: string; eventId: string }[];
}

export interface NewPipelineTx {
  id: string;
  accountId: string;
  sourceTxId: string; // hereda el batch_id de su cargo (deshacer el lote lo arrastra)
  opDate: string;
  concept: string;
  provider: string;
  providerNorm: string;
  amountCents: bigint;
  categoryId: string;
  status: "confirmada";
  transferGroupId: string;
  dedupHash: string;
}

export interface PipelineChanges {
  updatedTxs: Map<
    string,
    {
      categoryId: string | null;
      status: FinanceTransactionStatus;
      transferGroupId: string | null;
      recurrence: FinanceRecurrence;
    }
  >;
  insertedTxs: NewPipelineTx[];
  insertedAliases: FinanceProviderAliasView[];
  insertedCategories: FinanceCategoryView[];
  insertedTxEvents: { txId: string; eventId: string }[];
}

/** Núcleo PURO del pipeline: muta `state` en memoria y acumula los cambios a
 * persistir. Testeable sin base de datos (caso integral en pipeline.test.ts). */
export function runPipelineSteps(
  state: PipelineState,
  newId: () => string,
): { report: PipelineReport; changes: PipelineChanges } {
  const changes: PipelineChanges = {
    updatedTxs: new Map(),
    insertedTxs: [],
    insertedAliases: [],
    insertedCategories: [],
    insertedTxEvents: [],
  };
  const report: PipelineReport = { steps: [] };
  const byId = new Map(state.txs.map((t) => [t.id, t]));
  const kindOf = new Map(state.categories.map((c) => [c.id, c.kind]));
  const touch = (t: FinanceTxView): void => {
    changes.updatedTxs.set(t.id, {
      categoryId: t.categoryId,
      status: t.status,
      transferGroupId: t.transferGroupId,
      recurrence: t.recurrence,
    });
  };
  const setCategory = (t: FinanceTxView, categoryId: string): void => {
    t.categoryId = categoryId;
    t.categoryKind = kindOf.get(categoryId) ?? t.categoryKind;
  };
  const transferCatId = (): string => {
    const cat = state.categories.find((c) => c.kind === "transferencia" && c.parentId === null);
    if (cat === undefined) {
      throw new Error("El hogar no tiene categoría raíz de transferencia (invariante del esquema)");
    }
    return cat.id;
  };
  /** Aplica un cruce; devuelve cuántas patas quedan RECIÉN agrupadas (una
   * huérfana que conserva su grupo no cuenta, como en transfers.py). */
  const applyPair = (p: TransferProposal): number => {
    const group = p.existingGroupId ?? newId();
    let newly = 0;
    for (const legId of p.legIds) {
      const leg = byId.get(legId);
      if (leg === undefined) continue;
      if (leg.transferGroupId !== group) newly += 1;
      leg.transferGroupId = group;
      setCategory(leg, transferCatId());
      leg.status = p.status;
      touch(leg);
    }
    return newly;
  };

  // 1. reglas (rules_engine.apply_rules: solo pendientes)
  let affected = 0;
  for (const t of state.txs) {
    if (t.status !== "pendiente") continue;
    const rule = matchRule(t, state.rules);
    if (rule === null) continue;
    setCategory(t, rule.categoryId);
    t.status = "sugerida_regla";
    touch(t);
    affected += 1;
  }
  report.steps.push({ name: "reglas", affected });

  // 2. alias PayPal (renormalize.create_paypal_aliases: nunca pisa alias existentes)
  affected = 0;
  const existingAliases = new Set(state.aliases.map((a) => a.providerNorm));
  const seenProviders = new Set<string>();
  for (const t of state.txs) {
    if (t.provider === null || !t.provider.startsWith("PAYPAL ")) continue;
    const vendor = paypalVendor(t.provider);
    const pn = normText(t.provider);
    if (vendor === null || seenProviders.has(pn) || existingAliases.has(pn)) continue;
    seenProviders.add(pn);
    const alias = { providerNorm: pn, display: `${vendor} [PayPal]` };
    state.aliases.push(alias);
    changes.insertedAliases.push(alias);
    affected += 1;
  }
  report.steps.push({ name: "alias_paypal", affected });

  // 3. conciliación Amex (antes que transferencias: el cargo no debe ser «robado»)
  affected = 0;
  for (const p of reconcileAmex(state.txs, state.accounts)) {
    applyPair(p);
    affected += 1;
  }
  report.steps.push({ name: "amex", affected });

  // 4. inversiones: espejo confirmado agrupado con el cargo (hash invmirror-)
  affected = 0;
  for (const p of detectInvestmentContributions(state.txs, state.accounts)) {
    const charge = byId.get(p.chargeTxId);
    if (charge === undefined) continue;
    const group = newId();
    const catId = transferCatId();
    const mirror: FinanceTxView = {
      id: newId(),
      accountId: p.investmentAccountId,
      opDate: p.mirrorOpDate,
      concept: p.mirrorConcept,
      provider: p.mirrorProvider,
      providerNorm: normText(p.mirrorProvider),
      amountCents: p.mirrorAmountCents,
      categoryId: catId,
      status: "confirmada",
      transferGroupId: group,
      recurrence: null,
      recurrenceManual: false,
      dedupHash: p.mirrorDedupHash,
      codeCommon: null,
      codeOwn: null,
      categoryKind: "transferencia",
    };
    state.txs.push(mirror);
    byId.set(mirror.id, mirror);
    changes.insertedTxs.push({
      id: mirror.id,
      accountId: mirror.accountId,
      sourceTxId: p.chargeTxId,
      opDate: mirror.opDate,
      concept: mirror.concept,
      provider: p.mirrorProvider,
      providerNorm: normText(p.mirrorProvider),
      amountCents: mirror.amountCents,
      categoryId: catId,
      status: "confirmada",
      transferGroupId: group,
      dedupHash: mirror.dedupHash,
    });
    charge.transferGroupId = group;
    setCategory(charge, catId);
    charge.status = "confirmada";
    touch(charge);
    affected += 1;
  }
  report.steps.push({ name: "inversiones", affected });

  // 5. transferencias
  affected = 0;
  for (const p of detectTransferPairs(state.txs, state.accounts)) affected += applyPair(p);
  report.steps.push({ name: "transferencias", affected });

  // 6. efectivo (cash.detect_cash_withdrawals + efectivo_category_id: crea la categoría si falta)
  affected = 0;
  const cashProposals = detectCashMovements(state.txs, state.accounts);
  if (cashProposals.length > 0) {
    let efectivo = state.categories.find((c) => c.kind === "gasto" && c.name === "Efectivo");
    if (efectivo === undefined) {
      efectivo = { id: newId(), parentId: null, name: "Efectivo", kind: "gasto" };
      state.categories.push(efectivo);
      kindOf.set(efectivo.id, "gasto");
      changes.insertedCategories.push(efectivo);
    }
    for (const p of cashProposals) {
      const t = byId.get(p.txId);
      if (t === undefined) continue;
      setCategory(t, efectivo.id);
      t.status = "confirmada";
      touch(t);
      affected += 1;
    }
  }
  report.steps.push({ name: "efectivo", affected });

  // 7. recurrencia (respeta recurrence_manual y las patas agrupadas)
  affected = 0;
  for (const v of assessRecurrence(state.txs)) {
    const t = byId.get(v.txId);
    if (t === undefined) continue;
    t.recurrence = v.recurrence;
    touch(t);
    affected += 1;
  }
  report.steps.push({ name: "recurrencia", affected });

  // 8. reglas de evento (asignación idempotente por par)
  affected = 0;
  const existing = new Set(state.txEvents.map((te) => `${te.txId}:${te.eventId}`));
  for (const p of matchEventRules(state.txs, state.eventRules, {
    categories: state.categories,
    aliases: state.aliases,
    existingAssignments: existing,
  })) {
    state.txEvents.push(p);
    changes.insertedTxEvents.push(p);
    affected += 1;
  }
  report.steps.push({ name: "reglas_evento", affected });

  return { report, changes };
}

interface TxRow {
  id: string; account_id: string; op_date: string; concept: string;
  provider: string | null; provider_norm: string | null; amount_cents: string;
  category_id: string | null; status: FinanceTransactionStatus;
  transfer_group_id: string | null; recurrence: FinanceRecurrence;
  recurrence_manual: boolean; dedup_hash: string; code_common: string | null;
  code_own: string | null; category_kind: FinanceCategoryView["kind"] | null;
}

async function loadPipelineState(client: PoolClient, householdId: string): Promise<PipelineState> {
  const txRes = await client.query<TxRow>(
    `select t.id, t.account_id, t.op_date::text as op_date, t.concept, t.provider,
            t.provider_norm, t.amount_cents::text as amount_cents, t.category_id,
            t.status, t.transfer_group_id, t.recurrence, t.recurrence_manual,
            t.dedup_hash, t.code_common, t.code_own, c.kind as category_kind
       from app.finance_transactions t
       left join app.finance_categories c
         on c.household_id = t.household_id and c.id = t.category_id
      where t.household_id = $1`,
    [householdId],
  );
  const accRes = await client.query<{
    id: string; name: string; bank: string; kind: FinanceAccountView["kind"];
    bank_ref: string; owner_aliases: string[] | null; transfer_refs: string[] | null;
  }>(
    `select id, name, bank, kind, bank_ref, owner_aliases, transfer_refs
       from app.finance_accounts where household_id = $1`,
    [householdId],
  );
  const catRes = await client.query<{ id: string; parent_id: string | null; name: string; kind: FinanceCategoryView["kind"] }>(
    `select id, parent_id, name, kind from app.finance_categories where household_id = $1`,
    [householdId],
  );
  const ruleRes = await client.query<{ id: string; rule_type: FinanceRuleView["ruleType"]; pattern: string; category_id: string; priority: number }>(
    `select id, rule_type, pattern, category_id, priority
       from app.finance_rules where household_id = $1`,
    [householdId],
  );
  const evRuleRes = await client.query<{ id: string; provider_norm: string; concept_norm: string | null; category_id: string | null; event_id: string }>(
    `select id, provider_norm, concept_norm, category_id, event_id
       from app.finance_event_rules where household_id = $1`,
    [householdId],
  );
  const aliasRes = await client.query<{ provider_norm: string; display: string }>(
    `select provider_norm, display from app.finance_provider_aliases where household_id = $1`,
    [householdId],
  );
  const teRes = await client.query<{ transaction_id: string; event_id: string }>(
    `select transaction_id, event_id from app.finance_transaction_events where household_id = $1`,
    [householdId],
  );
  return {
    txs: txRes.rows.map((r) => ({
      id: r.id, accountId: r.account_id, opDate: r.op_date, concept: r.concept,
      provider: r.provider, providerNorm: r.provider_norm,
      amountCents: BigInt(r.amount_cents), categoryId: r.category_id, status: r.status,
      transferGroupId: r.transfer_group_id, recurrence: r.recurrence,
      recurrenceManual: r.recurrence_manual, dedupHash: r.dedup_hash,
      codeCommon: r.code_common, codeOwn: r.code_own, categoryKind: r.category_kind,
    })),
    accounts: accRes.rows.map((r) => ({
      id: r.id, name: r.name, bank: r.bank, kind: r.kind, bankRef: r.bank_ref,
      ownerAliases: r.owner_aliases ?? [], transferRefs: r.transfer_refs ?? [],
    })),
    categories: catRes.rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, kind: r.kind })),
    rules: ruleRes.rows.map((r) => ({ id: r.id, ruleType: r.rule_type, pattern: r.pattern, categoryId: r.category_id, priority: r.priority })),
    eventRules: evRuleRes.rows.map((r) => ({ id: r.id, providerNorm: r.provider_norm, conceptNorm: r.concept_norm, categoryId: r.category_id, eventId: r.event_id })),
    aliases: aliasRes.rows.map((r) => ({ providerNorm: r.provider_norm, display: r.display })),
    txEvents: teRes.rows.map((r) => ({ txId: r.transaction_id, eventId: r.event_id })),
  };
}

async function persistPipelineChanges(
  client: PoolClient,
  householdId: string,
  changes: PipelineChanges,
): Promise<void> {
  for (const cat of changes.insertedCategories) {
    await client.query(
      `insert into app.finance_categories (household_id, id, parent_id, name, kind)
       values ($1, $2, $3, $4, $5)`,
      [householdId, cat.id, cat.parentId, cat.name, cat.kind],
    );
  }
  for (const [id, u] of changes.updatedTxs) {
    await client.query(
      `update app.finance_transactions
          set category_id = $3, status = $4, transfer_group_id = $5, recurrence = $6
        where household_id = $1 and id = $2`,
      [householdId, id, u.categoryId, u.status, u.transferGroupId, u.recurrence],
    );
  }
  for (const t of changes.insertedTxs) {
    await client.query(
      `insert into app.finance_transactions
         (household_id, id, account_id, batch_id, op_date, concept, provider,
          provider_norm, amount_cents, category_id, status, transfer_group_id,
          dedup_hash, recurrence_manual, raw)
       select $1, $2, $3, src.batch_id, $4::date, $5, $6, $7, $8::bigint, $9, $10,
              $11, $12, false, '{}'::jsonb
         from app.finance_transactions src
        where src.household_id = $1 and src.id = $13`,
      [householdId, t.id, t.accountId, t.opDate, t.concept, t.provider, t.providerNorm,
        String(t.amountCents), t.categoryId, t.status, t.transferGroupId, t.dedupHash,
        t.sourceTxId],
    );
  }
  for (const a of changes.insertedAliases) {
    await client.query(
      `insert into app.finance_provider_aliases (household_id, provider_norm, display)
       values ($1, $2, $3) on conflict do nothing`,
      [householdId, a.providerNorm, a.display],
    );
  }
  for (const te of changes.insertedTxEvents) {
    await client.query(
      `insert into app.finance_transaction_events (household_id, transaction_id, event_id)
       values ($1, $2, $3) on conflict do nothing`,
      [householdId, te.txId, te.eventId],
    );
  }
}

/** Pipeline post-import unificado. Se ejecuta DENTRO de la transacción
 * autorizada (withAuthorizedTransaction) tras insertar un lote. */
export async function runPostImportPipeline(
  client: PoolClient,
  householdId: string,
): Promise<PipelineReport> {
  const state = await loadPipelineState(client, householdId);
  const { report, changes } = runPipelineSteps(state, () => randomUUID());
  await persistPipelineChanges(client, householdId, changes);
  return report;
}
```

Añade a `packages/server/src/index.ts`: `export * from "./finance/pipeline.js";` (junto a los otros exports de finance).

- [ ] **Step 4: Verde.** `pnpm --filter @casa-clara/server test src/finance/pipeline.test.ts && pnpm --filter @casa-clara/server typecheck`
- [ ] **Step 5: Gates completos de la fase.** `cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas && export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" && pnpm lint && pnpm typecheck && pnpm test` — todo verde; si algo falla, corrige antes de commitear.
- [ ] **Step 6: Commit.** `git add packages/server && git commit -m "feat(finanzas): pipeline post-import unificado con orden fijo de ocho pasos"`
