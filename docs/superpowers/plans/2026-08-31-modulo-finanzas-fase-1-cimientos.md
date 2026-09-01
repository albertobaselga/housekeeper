# Finanzas — Cimientos — Plan de implementación (Fase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar vivo el doble cerrojo del módulo Finanzas: capacidad `finance.access`, esquema `0034_finance.sql` con RLS, fixtures y matriz negativa `030`, `requireFinanceAdmin`, comandos de concesión, routing + navegación + 7 páginas esqueleto y la tarjeta «Finanzas» en Ajustes.

**Architecture:** El acceso a finanzas exige dos requisitos simultáneos: rol `family_admin` (capacidad en la matriz de contracts) Y concesión viva en `app.finance_module_grants`, impuestos en la base por `app.finance_enabled()` dentro de TODAS las políticas RLS de `finance_*`. El servidor replica el cerrojo con `requireFinanceAdmin` y el layout de SvelteKit retira `finance.access` de las capacidades entregadas cuando no hay concesión, de modo que guard de rutas, AppShell y UI funcionan sin mecanismos nuevos.

**Tech Stack:** PostgreSQL 18.4 (RLS, triggers plpgsql), Node 24, pnpm workspaces, zod 4, `pg`, SvelteKit 2 + Svelte 5 (runas), vitest 3, suites SQL TAP propias (`run-sql-tests.mjs`).

**Spec:** /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md — y el doc de interfaces: /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md

## Global Constraints

- Trabajar SOLO dentro del worktree `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas` (rama `worktree-modulo-finanzas`). El repo `/home/abf/github/home-finance` es solo-lectura (fuente a portar).
- Node 24 obligatorio: prefijo `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"` antes de cualquier `pnpm`/`node`.
- Dinero: céntimos como `bigint` (TS) / `bigint` (SQL), NUNCA `Number`/float; solo EUR.
- Idioma: UI, copy, docs y commits en español (`tipo(ámbito): qué cambia`); identificadores en inglés.
- Solo datos sintéticos en el repo (importes, titulares, extractos de prueba inventados).
- Migraciones append-only `00NN_*.sql`, un solo bloque `BEGIN;…COMMIT;`; jamás editar una aplicada.
- Toda spec nueva (unit/e2e/a11y/dbe2e/SQL) cableada a un job de `.github/workflows/ci.yml` (lo exige `scripts/ci/assert-suite-coverage.py`).
- CSS solo con tokens de `apps/web/src/app.css` (vigila `apps/web/scripts/lint-css-tokens.mjs`); pesos 400/500/700; terracota solo para «ahora».
- Única dependencia nueva permitida: `xlsx` (SheetJS), SOLO en `packages/server` (jamás en cliente). Esta fase NO la necesita.
- La matriz de capacidades NO se reexporta desde la raíz de `@casa-clara/contracts` (vigila `apps/web/scripts/verify-today-bundle.mjs`).
- Escrituras de negocio SOLO como comandos por `POST /api/v1/sync`; REST solo para lecturas y para la importación multipart.
- TDD: test que falla → implementación mínima → verde → commit. Commits frecuentes.
- Suites de BD en secuencia (bases/roles de nombre fijo); Postgres local 18.4 para db-tests/dbe2e; PRODUCCIÓN (Supabase) prohibida en fases 1–6.
- Gates de la rama: `pnpm lint`, `pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm test:rls` deben quedar en verde al cerrar cada tarea que los afecte.

**Entorno de base de datos local (todas las tareas con BD):** el clúster local del repo escucha en `127.0.0.1:54329` con superusuario `casa_admin` (ver `.claude/skills/operar-la-casa/referencia-instalacion.md` si no responde: `"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p 54329 -k /tmp/ccpg-socket" -l "$PGDATA/log" start`). Antes de cualquier suite con BD:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
```

---

### Task 1: Capacidad `finance.access` en contracts

La matriz de capacidades vive en `packages/contracts/src/capabilities.ts` (submódulo `/capabilities`, NUNCA reexportado desde la raíz — lee la cabecera del fichero antes de tocarlo). `family_admin` recibe todas las capacidades vía `allCapabilities`; ningún otro rol lista `finance.access`. El test de la matriz del cliente (`apps/web/tests/capabilities.test.ts`) afirma la lista EXACTA: es el test que falla primero.

**Files:**
- Modify: `packages/contracts/src/capabilities.ts`
- Test (modify): `apps/web/tests/capabilities.test.ts`

**Interfaces:**
- Consumes: `capabilities` / `roleCapabilities` existentes en `packages/contracts/src/capabilities.ts`.
- Produces: `"finance.access"` como miembro de `capabilities` (y por tanto del tipo `Capability`), en orden alfabético entre `"export.employment.self"` y `"guide.write"`. Solo `family_admin` la posee (herencia de `allCapabilities`).

- [ ] **Step 1: Escribir el test que falla.** En `apps/web/tests/capabilities.test.ts`, dentro del `it('uses only the shared contract capability vocabulary', …)`, añade `'finance.access'` a la lista esperada, entre `'export.employment.self'` y `'guide.write'` (la línea queda `… 'expense.create.self', 'export.employment.self', 'finance.access', 'guide.write', …`). Después, dentro del `it('keeps privileged and self-service operations scoped', …)`, añade al final del cuerpo:

```ts
    // Finanzas: la capacidad solo existe para la administración; la segunda
    // llave (la concesión por membresía) vive en la base, no en esta matriz.
    expect(can('family_admin', 'finance.access')).toBe(true);
    expect(can('family_member', 'finance.access')).toBe(false);
    expect(can('employee_live_in', 'finance.access')).toBe(false);
    expect(can('helper', 'finance.access')).toBe(false);
    expect(can('viewer', 'finance.access')).toBe(false);
```

- [ ] **Step 2: Verlo fallar.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web exec vitest run tests/capabilities.test.ts
```

Salida esperada: `FAIL tests/capabilities.test.ts` con `AssertionError: expected [ 'access.manage', … ] to deeply equal …` (la lista real no contiene `finance.access`).

- [ ] **Step 3: Implementación mínima.** En `packages/contracts/src/capabilities.ts`, dentro del array `capabilities`, inserta una línea entre `"export.employment.self",` y `"guide.write",`:

```ts
  "finance.access",
```

No toques `roleCapabilities`: `family_admin` la hereda de `allCapabilities` y ningún otro rol debe listarla.

- [ ] **Step 4: Verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/contracts test
pnpm --filter @casa-clara/web exec vitest run tests/capabilities.test.ts
```

Ambos en verde (`Test Files … passed`).

- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/src/capabilities.ts apps/web/tests/capabilities.test.ts
git commit -m "feat(contracts): capacidad finance.access exclusiva de la administración"
```

---

### Task 2: Sobres de comandos `finance` en contracts

Los comandos de sync se enrutan por `aggregateType` (`CommandEnvelopeV1`) y el payload lleva el discriminador. Para finanzas el discriminador es `kind`, con los nombres EXACTOS del doc de interfaces. Esta fase congela los dos primeros: `finance.grant.write` y `finance.revoke.write` (las fases 5+ ampliarán la unión). Patrón a imitar: `membershipSetExpiryPayloadSchema`/`membershipCommandPayloadSchema` en `packages/contracts/src/schemas.ts` (líneas ~507-521).

**Files:**
- Modify: `packages/contracts/src/index.ts` (unión `AggregateType`)
- Modify: `packages/contracts/src/schemas.ts` (enum del sobre + schemas de payload)
- Test (modify): `packages/contracts/src/index.test.ts`

**Interfaces:**
- Consumes: `commandEnvelopeSchema`, `uuidSchema` (schemas.ts); `AggregateType` (index.ts).
- Produces: `AggregateType` gana `"finance"` (alfabético: entre `"extra_work"` y `"food"`); `financeGrantPayloadSchema`, `financeRevokePayloadSchema`, `financeCommandPayloadSchema` (unión discriminada por `kind` con literales `"finance.grant.write"` y `"finance.revoke.write"`, ambos con `membershipId: uuid`).

- [ ] **Step 1: Escribir el test que falla.** En `packages/contracts/src/index.test.ts`: añade `financeCommandPayloadSchema` a la lista de imports de `"./schemas.js"` y, al final del fichero (fuera del `describe` existente), añade:

```ts
describe("comandos de finanzas (fase 1: concesión)", () => {
  it("acepta los dos kinds congelados y rechaza cualquier otro", () => {
    expect(
      financeCommandPayloadSchema.parse({
        kind: "finance.grant.write",
        membershipId: "11000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      kind: "finance.grant.write",
      membershipId: "11000000-0000-4000-8000-000000000001",
    });
    expect(
      financeCommandPayloadSchema.parse({
        kind: "finance.revoke.write",
        membershipId: "11000000-0000-4000-8000-000000000001",
      }).kind,
    ).toBe("finance.revoke.write");
    expect(() =>
      financeCommandPayloadSchema.parse({
        kind: "finance.account.update",
        membershipId: "11000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("el sobre de sync acepta aggregateType finance", () => {
    expect(
      commandEnvelopeSchema.parse({
        apiVersion: API_VERSION,
        operationId: "99999999-0000-4000-8000-000000000001",
        householdId: "10000000-0000-4000-8000-000000000001",
        schemaVersion: 1,
        aggregateType: "finance",
        aggregateId: null,
        baseRevision: null,
        occurredAt: "2026-08-31T10:00:00.000Z",
        payload: {
          kind: "finance.grant.write",
          membershipId: "11000000-0000-4000-8000-000000000001",
        },
      }).aggregateType,
    ).toBe("finance");
  });
});
```

- [ ] **Step 2: Verlo fallar.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/contracts test
```

Salida esperada: fallo de compilación/ejecución `SyntaxError: … does not provide an export named 'financeCommandPayloadSchema'`.

- [ ] **Step 3: Implementación mínima.** En `packages/contracts/src/index.ts`, dentro de la unión `AggregateType`, inserta `| "finance"` entre `| "extra_work"` y `| "food"`. En `packages/contracts/src/schemas.ts`: (a) en el `z.enum([...])` de `commandEnvelopeSchema`, inserta `"finance",` entre `"extra_work",` y `"food",`; (b) junto a los schemas de membership (después de `membershipCommandPayloadSchema`), añade:

```ts
/**
 * Concesión del módulo Finanzas (spec §4): `kind` congelado con los nombres
 * canónicos del doc de interfaces. Las fases posteriores amplían esta unión
 * con el resto de comandos `finance.*`.
 */
export const financeGrantPayloadSchema = z.object({
  kind: z.literal("finance.grant.write"),
  membershipId: uuidSchema,
});

export const financeRevokePayloadSchema = z.object({
  kind: z.literal("finance.revoke.write"),
  membershipId: uuidSchema,
});

export const financeCommandPayloadSchema = z.discriminatedUnion("kind", [
  financeGrantPayloadSchema,
  financeRevokePayloadSchema,
]);
```

- [ ] **Step 4: Verde.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/contracts test && pnpm --filter @casa-clara/contracts typecheck
```

- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/schemas.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): sobres de comandos finance.grant/revoke.write"
```

---

### Task 3: Migración `0034_finance.sql` — esquema y cerrojo

Un solo fichero `BEGIN;…COMMIT;`, siguiente número libre (0034). Patrones a calcar del repo: tabla con RLS+GRANT+auditoría de `packages/db/migrations/0013_contacts.sql`; bucles `DO … FOREACH` de RLS y auditoría de `0005_rls.sql` (líneas 32-48) y `0004_audit_and_jobs.sql` (líneas 263-284); trigger-reja de `0030_personal_y_altas.sql` (`enforce_password_flag_transition`). El runner (`migrate.mjs` + `0018_rls_force_compat.sql`) ya gestiona FORCE en Supabase: la migración pone `ENABLE + FORCE` sin condicionales, como 0032. El test rojo es la primera versión de `tests/030_finance_rls.sql` (bloque estructural); la matriz de filas llega en la Task 4. Nota: el nombre `030_finance_rls.sql` convive con `030_menu_week_templates.sql` — el runner ordena por nombre y ejecuta ambos; el nombre lo fija el doc de interfaces.

**Files:**
- Create: `packages/db/migrations/0034_finance.sql`
- Test (create): `packages/db/tests/030_finance_rls.sql`

**Interfaces:**
- Consumes: `app.households`, `app.household_memberships`, `app.tenant_context_matches(uuid)`, `app.current_household_role()`, `app.current_household_id()`, `app.current_membership_id()`, `app_private.write_audit_event()`, rol `casa_clara_app`.
- Produces: tablas `app.finance_module_grants` (membership_id, granted_by_membership_id, granted_at, revoked_at, revoked_by_membership_id) · `finance_accounts` (name, bank, kind, owner_label, bank_ref, owner_aliases jsonb, transfer_refs jsonb, archived_at) · `finance_categories` (parent_id, name, kind) · `finance_rules` (rule_type, pattern, category_id, priority, origin) · `finance_import_batches` (filename, bank, imported_at, new_count, dup_count) · `finance_transactions` (account_id, batch_id, op_date, value_date, concept, provider, provider_norm, amount_cents, balance_cents, code_common, code_own, category_id, status, transfer_group_id, dedup_hash, recurrence, recurrence_manual, bank_category, raw jsonb, currency_code CHECK='EUR') · `finance_provider_aliases` (provider_norm, display) · `finance_events` (name) · `finance_transaction_events` (transaction_id, event_id) · `finance_event_rules` (event_id, provider_norm, concept_norm, category_id); todas con `household_id uuid NOT NULL REFERENCES app.households`, `id uuid DEFAULT gen_random_uuid()`, PK `(household_id, id)`, RLS ENABLE+FORCE, GRANT a `casa_clara_app`, trigger de auditoría. Función `app.finance_enabled() RETURNS boolean`.

- [ ] **Step 1: Escribir el test estructural que falla.** Crea `packages/db/tests/030_finance_rls.sql` con EXACTAMENTE este contenido inicial:

```sql
-- Matriz negativa del módulo Finanzas (spec §4). Requiere migraciones +
-- fixtures aplicadas por el runner. Este primer bloque convierte el esquema
-- del doble cerrojo en aserciones; la matriz de filas viene después.
DO $assert_finance_schema$
DECLARE
  finance_tables text[] := ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ];
  table_name text;
  locked_tables integer;
  audit_triggers integer;
BEGIN
  FOREACH table_name IN ARRAY finance_tables LOOP
    IF to_regclass('app.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'missing finance table app.%', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = to_regclass('app.' || table_name)
         AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'app.% lacks ENABLE ROW LEVEL SECURITY', table_name;
    END IF;
    IF NOT has_table_privilege('casa_clara_app', 'app.' || table_name, 'SELECT') THEN
      RAISE EXCEPTION 'casa_clara_app cannot read app.%', table_name;
    END IF;
  END LOOP;

  IF to_regprocedure('app.finance_enabled()') IS NULL THEN
    RAISE EXCEPTION 'app.finance_enabled() is missing';
  END IF;

  -- Doble cerrojo: TODAS las políticas de finance_* exigen finance_enabled(),
  -- con la única excepción de la tabla de concesiones.
  SELECT count(DISTINCT tablename)::integer INTO locked_tables
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app'
     AND tablename = ANY (finance_tables)
     AND tablename <> 'finance_module_grants'
     AND qual LIKE '%finance_enabled%';
  IF locked_tables <> 9 THEN
    RAISE EXCEPTION 'only % of 9 finance tables enforce app.finance_enabled()', locked_tables;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'finance_module_grants'
       AND qual LIKE '%finance_enabled%'
  ) THEN
    RAISE EXCEPTION 'finance_module_grants must not depend on its own lock';
  END IF;

  IF to_regclass('app.finance_module_grants_live_idx') IS NULL THEN
    RAISE EXCEPTION 'missing partial unique index for live grants';
  END IF;
  IF to_regclass('app.finance_categories_one_transfer_root_idx') IS NULL THEN
    RAISE EXCEPTION 'missing single-transfer-root partial unique index';
  END IF;

  SELECT count(*)::integer INTO audit_triggers
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'app'
     AND relation.relname = ANY (finance_tables)
     AND trigger_row.tgname LIKE '%\_audit';
  IF audit_triggers <> 10 THEN
    RAISE EXCEPTION 'expected 10 finance audit triggers, found %', audit_triggers;
  END IF;
END
$assert_finance_schema$;
```

- [ ] **Step 2: Verlo fallar.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm test:db
```

Salida esperada: `not ok N - tests/030_finance_rls.sql` con `# missing finance table app.finance_module_grants`.

- [ ] **Step 3: Escribir la primera mitad de la migración (concesiones, cerrojo y tablas).** Crea `packages/db/migrations/0034_finance.sql`:

```sql
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Módulo «Finanzas» (docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md
-- §4-§5). Diez tablas en `app`, todas con doble cerrojo en RLS: rol
-- family_admin Y concesión viva por membresía. Un admin sin concesión ve CERO
-- filas aunque llame a la API a mano; los otros cuatro papeles, cero por rol.
--
-- Desviación deliberada del patrón append-only laboral: las transacciones de
-- finanzas son un conjunto de trabajo analítico (recategorizar, confirmar,
-- agrupar es el uso normal). Se permiten UPDATE y DELETE bajo RLS, con el
-- trigger de auditoría registrando cada mutación. El ledger laboral no se toca.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Concesiones por membresía ─────────────────────────────────────────────
-- Una concesión viva es una fila con revoked_at IS NULL; revocar escribe
-- revoked_at (histórico conservado, patrón push_subscriptions/0030).
CREATE TABLE app.finance_module_grants (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  granted_by_membership_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  revoked_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, granted_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, revoked_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CHECK ((revoked_at IS NULL) = (revoked_by_membership_id IS NULL))
);

CREATE UNIQUE INDEX finance_module_grants_live_idx
  ON app.finance_module_grants (household_id, membership_id)
  WHERE revoked_at IS NULL;

-- Reja: solo se concede a membresías family_admin (patrón 0030).
CREATE FUNCTION app.enforce_finance_grant_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  target_role app.household_role;
BEGIN
  SELECT role INTO target_role
    FROM app.household_memberships
   WHERE household_id = NEW.household_id AND id = NEW.membership_id;
  IF target_role IS DISTINCT FROM 'family_admin' THEN
    RAISE EXCEPTION 'finance access can only be granted to a family_admin membership'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finance_module_grants_target_guard
BEFORE INSERT ON app.finance_module_grants
FOR EACH ROW EXECUTE FUNCTION app.enforce_finance_grant_target();

-- ── 2. El cerrojo ────────────────────────────────────────────────────────────
CREATE FUNCTION app.finance_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() = 'family_admin'
     AND EXISTS (
       SELECT 1
         FROM app.finance_module_grants AS grant_row
        WHERE grant_row.household_id = app.current_household_id()
          AND grant_row.membership_id = app.current_membership_id()
          AND grant_row.revoked_at IS NULL
     )
$$;

REVOKE ALL ON FUNCTION app.finance_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finance_enabled() TO casa_clara_app;

-- ── 3. Tablas del dominio ────────────────────────────────────────────────────
CREATE TABLE app.finance_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- NULL: cuenta sin banco (p. ej. Efectivo). Las refs de inversión viven en
  -- transfer_refs: datos, no código.
  bank text CHECK (bank IS NULL OR bank IN ('caixabank', 'deutsche_bank', 'openbank', 'amex')),
  kind text NOT NULL CHECK (kind IN ('comun', 'personal', 'inversion')),
  owner_label text NOT NULL DEFAULT '' CHECK (length(owner_label) <= 120),
  bank_ref text CHECK (bank_ref IS NULL OR length(btrim(bank_ref)) BETWEEN 1 AND 64),
  owner_aliases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(owner_aliases) = 'array'),
  transfer_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(transfer_refs) = 'array'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, bank_ref),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE TABLE app.finance_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  parent_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('gasto', 'ingreso', 'transferencia')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, parent_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT,
  UNIQUE (household_id, parent_id, name)
);

-- Invariante del origen: exactamente UNA categoría raíz `transferencia` por hogar.
CREATE UNIQUE INDEX finance_categories_one_transfer_root_idx
  ON app.finance_categories (household_id)
  WHERE kind = 'transferencia' AND parent_id IS NULL;

CREATE TABLE app.finance_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  rule_type text NOT NULL CHECK (rule_type IN ('proveedor_exacto', 'concepto_contiene', 'codigo_norma43')),
  pattern text NOT NULL CHECK (length(btrim(pattern)) BETWEEN 1 AND 200),
  category_id uuid NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'agente')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, category_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.finance_import_batches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  filename text NOT NULL CHECK (length(btrim(filename)) BETWEEN 1 AND 255),
  bank text NOT NULL CHECK (bank IN ('caixabank', 'deutsche_bank', 'openbank', 'amex')),
  imported_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  new_count integer NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  dup_count integer NOT NULL DEFAULT 0 CHECK (dup_count >= 0),
  PRIMARY KEY (household_id, id)
);

CREATE TABLE app.finance_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  -- NULL: apunte manual. Borrar el lote deshace la importación (CASCADE, como el origen).
  batch_id uuid,
  op_date date NOT NULL,
  value_date date,
  concept text NOT NULL CHECK (length(concept) <= 500),
  provider text,
  provider_norm text,
  amount_cents bigint NOT NULL,
  balance_cents bigint,
  currency_code text NOT NULL DEFAULT 'EUR' CHECK (currency_code = 'EUR'),
  code_common text,
  code_own text,
  category_id uuid,
  status text NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'sugerida_regla', 'sugerida_agente', 'confirmada')),
  transfer_group_id uuid,
  -- Prefijos semánticos conservados del origen: manual-, cashpair-, invmirror-.
  dedup_hash text NOT NULL CHECK (length(btrim(dedup_hash)) BETWEEN 1 AND 128),
  recurrence text CHECK (recurrence IS NULL OR recurrence IN ('recurrente', 'extraordinario')),
  recurrence_manual boolean NOT NULL DEFAULT false,
  bank_category text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, dedup_hash),
  FOREIGN KEY (household_id, account_id)
    REFERENCES app.finance_accounts(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, batch_id)
    REFERENCES app.finance_import_batches(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, category_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT
);

CREATE INDEX finance_transactions_op_date_idx
  ON app.finance_transactions (household_id, op_date);
CREATE INDEX finance_transactions_status_idx
  ON app.finance_transactions (household_id, status);

CREATE TABLE app.finance_provider_aliases (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  provider_norm text NOT NULL CHECK (length(btrim(provider_norm)) BETWEEN 1 AND 200),
  display text NOT NULL CHECK (length(btrim(display)) BETWEEN 1 AND 200),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, provider_norm)
);

CREATE TABLE app.finance_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, name)
);

CREATE TABLE app.finance_transaction_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, transaction_id, event_id),
  FOREIGN KEY (household_id, transaction_id)
    REFERENCES app.finance_transactions(household_id, id) ON DELETE CASCADE,
  -- Borrar un evento desvincula, no borra transacciones.
  FOREIGN KEY (household_id, event_id)
    REFERENCES app.finance_events(household_id, id) ON DELETE CASCADE
);

CREATE TABLE app.finance_event_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  provider_norm text,
  concept_norm text,
  category_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, event_id)
    REFERENCES app.finance_events(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, category_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT,
  -- O por (proveedor[, concepto]) o por categoría: nunca una regla vacía.
  CHECK (provider_norm IS NOT NULL OR category_id IS NOT NULL)
);

COMMIT;
```

- [ ] **Step 4: Ejecutar y ver el fallo avanzar.** Mismo comando del Step 2. Salida esperada: `not ok N - tests/030_finance_rls.sql` con `# app.finance_module_grants lacks ENABLE ROW LEVEL SECURITY` (las tablas ya existen; faltan RLS, grants y auditoría).

- [ ] **Step 5: Completar la migración (RLS, grants y auditoría).** ANTES del `COMMIT;` final de `0034_finance.sql`, añade:

```sql
-- ── 4. RLS: doble cerrojo en todo, salvo las concesiones ────────────────────
DO $enable_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$enable_rls$;

-- Las concesiones: las lee cualquier administración del hogar (para pintar la
-- tarjeta de Ajustes) y las muta la administración vía comandos. Sin DELETE:
-- revocar escribe revoked_at y el histórico se conserva.
CREATE POLICY finance_grants_admin_read ON app.finance_module_grants
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY finance_grants_admin_insert ON app.finance_module_grants
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY finance_grants_admin_update ON app.finance_module_grants
  FOR UPDATE USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );

-- El resto: TODA operación exige hogar en contexto Y cerrojo de finanzas.
DO $finance_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_accounts', 'finance_categories', 'finance_rules',
    'finance_import_batches', 'finance_transactions', 'finance_provider_aliases',
    'finance_events', 'finance_transaction_events', 'finance_event_rules'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I_finance_admin_all ON app.%I FOR ALL '
      'USING (app.tenant_context_matches(household_id) AND app.finance_enabled()) '
      'WITH CHECK (app.tenant_context_matches(household_id) AND app.finance_enabled())',
      table_name, table_name
    );
  END LOOP;
END
$finance_policies$;

-- ── 5. Grants y auditoría ────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON app.finance_module_grants TO casa_clara_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.finance_accounts, app.finance_categories, app.finance_rules,
  app.finance_import_batches, app.finance_transactions,
  app.finance_provider_aliases, app.finance_events,
  app.finance_transaction_events, app.finance_event_rules
  TO casa_clara_app;

DO $audit_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON app.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event()',
      table_name, table_name
    );
  END LOOP;
END
$audit_triggers$;
```

- [ ] **Step 6: Verde completo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm test:db
```

Salida esperada: `ok N - tests/030_finance_rls.sql` y TODAS las demás en `ok` — en particular `tests/010_schema_and_constraints.sql`, cuya cobertura automática de RLS/FORCE incluye ya las 10 tablas nuevas.

- [ ] **Step 7: Commit.**

```bash
git add packages/db/migrations/0034_finance.sql packages/db/tests/030_finance_rls.sql
git commit -m "feat(db): migración 0034 — esquema de finanzas con doble cerrojo RLS"
```

---

### Task 4: Fixtures `002_finance.sql` y matriz negativa completa

Los tres runners de fixtures del repo (`packages/db/scripts/run-sql-tests.mjs`, `packages/server/test-support/global-setup.mjs`, `apps/web/e2e/db-global-setup.ts`) recorren `packages/db/fixtures/*.sql` ordenado: `002_finance.sql` se carga solo con existir — NO hay que extender ningún runner (verifícalo en el Step 6). La matriz sigue el idioma de `tests/020_rls_matrix.sql`: bloques `BEGIN; SET LOCAL ROLE casa_clara_app; … COMMIT;`, `set_config` + `app.set_household_context`, y fallos esperados capturados con `EXCEPTION WHEN`. Prefijos de UUID exclusivos: `f1*` (roble), `f2*` (olivo), `fa*` (sembrado del test).

**Files:**
- Create: `packages/db/fixtures/002_finance.sql`
- Modify: `packages/db/tests/030_finance_rls.sql` (añadir la matriz al final)
- Modify: `packages/db/package.json` (script `test:rls`)

**Interfaces:**
- Consumes: esquema 0034; hogares/membresías de `fixtures/001_two_households.sql` (roble `10000000-…-0001`, admin roble `11000000-…-0001`, family `…-0002`, employee `…-0003`, helper `…-0004`, viewer `…-0005`; olivo `20000000-…-0001`, admin olivo `21000000-…-0001`).
- Produces: datos sintéticos de finanzas en ambos hogares + concesión viva SOLO para el admin de roble (`f1900000-0000-4000-8000-000000000001`); suite `tests/030_finance_rls.sql` completa, ejecutada por `pnpm test:db` y `pnpm test:rls`.

- [ ] **Step 1: Escribir la matriz que falla.** Añade AL FINAL de `packages/db/tests/030_finance_rls.sql`:

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Sembrado propio del fichero (prefijo fa*): una SEGUNDA administración del
-- roble SIN concesión — la fila que demuestra que el rol solo no abre nada.
-- Se elimina al final para no alterar los conteos de las suites posteriores.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('fixture:roble:admin2', 'Fixture Segunda Admin Roble');
INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('fa900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'fixture:roble:admin2', 'family_admin');
COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_app;

-- Admin del roble CON concesión: ve lo suyo, nada del olivo, y las rejas
-- estructurales (cruce de hogar, segunda raíz de transferencia, concesión a
-- quien no administra) fallan con su SQLSTATE exacto.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_granted_admin$
BEGIN
  IF (SELECT count(*) FROM app.finance_module_grants) <> 1
     OR (SELECT count(*) FROM app.finance_accounts) <> 2
     OR (SELECT count(*) FROM app.finance_categories) <> 4
     OR (SELECT count(*) FROM app.finance_rules) <> 1
     OR (SELECT count(*) FROM app.finance_import_batches) <> 1
     OR (SELECT count(*) FROM app.finance_transactions) <> 2
     OR (SELECT count(*) FROM app.finance_provider_aliases) <> 1
     OR (SELECT count(*) FROM app.finance_events) <> 1
     OR (SELECT count(*) FROM app.finance_transaction_events) <> 1
     OR (SELECT count(*) FROM app.finance_event_rules) <> 1 THEN
    RAISE EXCEPTION 'granted family_admin read matrix failed';
  END IF;
  IF (SELECT count(*) FROM app.finance_accounts
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.finance_transactions
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.finance_categories
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'granted admin leaked olivo finance rows';
  END IF;

  -- Suplantación de hogar: escribir en el olivo desde el roble → 42501.
  BEGIN
    INSERT INTO app.finance_events (household_id, name)
    VALUES ('20000000-0000-4000-8000-000000000001', 'Evento intruso');
    RAISE EXCEPTION 'cross-tenant finance insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Segunda raíz de transferencia: el índice parcial la mata (23505).
  BEGIN
    INSERT INTO app.finance_categories (household_id, name, kind)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Otra transferencia', 'transferencia');
    RAISE EXCEPTION 'second transfer-root category unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Conceder a la persona de apoyo: la reja del disparador (23514).
  BEGIN
    INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001',
            '11000000-0000-4000-8000-000000000004',
            '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'granting finance to a helper unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$assert_granted_admin$;

-- Admin del roble SIN concesión: cero filas de finanzas. Las concesiones sí
-- las ve (cualquier admin pinta Ajustes con ellas), pero no le abren nada.
SELECT set_config('app.user_id', 'fixture:roble:admin2', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  'fa900000-0000-4000-8000-000000000001'
);

DO $assert_ungranted_admin$
BEGIN
  IF (SELECT count(*) FROM app.finance_accounts) <> 0
     OR (SELECT count(*) FROM app.finance_categories) <> 0
     OR (SELECT count(*) FROM app.finance_rules) <> 0
     OR (SELECT count(*) FROM app.finance_import_batches) <> 0
     OR (SELECT count(*) FROM app.finance_transactions) <> 0
     OR (SELECT count(*) FROM app.finance_provider_aliases) <> 0
     OR (SELECT count(*) FROM app.finance_events) <> 0
     OR (SELECT count(*) FROM app.finance_transaction_events) <> 0
     OR (SELECT count(*) FROM app.finance_event_rules) <> 0 THEN
    RAISE EXCEPTION 'ungranted family_admin must see zero finance rows';
  END IF;
  IF (SELECT count(*) FROM app.finance_module_grants) <> 1
     OR (SELECT app.finance_enabled()) THEN
    RAISE EXCEPTION 'grant visibility or lock state wrong for ungranted admin';
  END IF;
  BEGIN
    INSERT INTO app.finance_events (household_id, name)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Evento sin cerrojo');
    RAISE EXCEPTION 'ungranted admin wrote a finance row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$assert_ungranted_admin$;

-- Los otros cuatro papeles del roble: cero en TODO, concesiones incluidas.
DO $assert_non_admin_roles$
DECLARE
  role_pair record;
BEGIN
  FOR role_pair IN
    SELECT * FROM (VALUES
      ('fixture:roble:family',   '11000000-0000-4000-8000-000000000002'::uuid),
      ('fixture:roble:employee', '11000000-0000-4000-8000-000000000003'::uuid),
      ('fixture:roble:helper',   '11000000-0000-4000-8000-000000000004'::uuid),
      ('fixture:roble:viewer',   '11000000-0000-4000-8000-000000000005'::uuid)
    ) AS pairs(user_id, membership_id)
  LOOP
    PERFORM set_config('app.user_id', role_pair.user_id, true);
    PERFORM set_config('app.household_id', '', true);
    PERFORM set_config('app.membership_id', '', true);
    PERFORM set_config('app.role', '', true);
    PERFORM app.set_household_context(
      '10000000-0000-4000-8000-000000000001', role_pair.membership_id);
    IF (SELECT count(*) FROM app.finance_module_grants) <> 0
       OR (SELECT count(*) FROM app.finance_accounts) <> 0
       OR (SELECT count(*) FROM app.finance_categories) <> 0
       OR (SELECT count(*) FROM app.finance_rules) <> 0
       OR (SELECT count(*) FROM app.finance_import_batches) <> 0
       OR (SELECT count(*) FROM app.finance_transactions) <> 0
       OR (SELECT count(*) FROM app.finance_provider_aliases) <> 0
       OR (SELECT count(*) FROM app.finance_events) <> 0
       OR (SELECT count(*) FROM app.finance_transaction_events) <> 0
       OR (SELECT count(*) FROM app.finance_event_rules) <> 0 THEN
      RAISE EXCEPTION '% unexpectedly read finance rows', role_pair.user_id;
    END IF;
  END LOOP;
END
$assert_non_admin_roles$;

-- Admin del OLIVO sin concesión: su hogar tiene datos de finanzas sembrados y
-- aun así ve cero. La concesión es por membresía, no por hogar.
SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

DO $assert_olivo_admin$
BEGIN
  IF (SELECT count(*) FROM app.finance_accounts) <> 0
     OR (SELECT count(*) FROM app.finance_categories) <> 0
     OR (SELECT count(*) FROM app.finance_transactions) <> 0
     OR (SELECT count(*) FROM app.finance_module_grants) <> 0 THEN
    RAISE EXCEPTION 'olivo admin without grant read finance rows';
  END IF;
END
$assert_olivo_admin$;

COMMIT;

-- Revocar apaga el módulo EN EL ACTO. Se prueba dentro de una transacción que
-- se revierte, para no alterar la fixture compartida por las demás suites.
BEGIN;
SET LOCAL row_security = off;
UPDATE app.finance_module_grants
   SET revoked_at = statement_timestamp(),
       revoked_by_membership_id = '11000000-0000-4000-8000-000000000001'
 WHERE id = 'f1900000-0000-4000-8000-000000000001';
SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);
DO $assert_revocation_is_immediate$
BEGIN
  IF (SELECT app.finance_enabled())
     OR (SELECT count(*) FROM app.finance_transactions) <> 0 THEN
    RAISE EXCEPTION 'a revoked grant still opened finance';
  END IF;
END
$assert_revocation_is_immediate$;
ROLLBACK;

-- El emisor de trabajos no tiene GRANT sobre finanzas: ni una fila.
BEGIN;
SET LOCAL ROLE casa_clara_worker;
DO $assert_worker_no_finance$
BEGIN
  BEGIN
    PERFORM 1 FROM app.finance_transactions;
    RAISE EXCEPTION 'worker unexpectedly read finance data';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$assert_worker_no_finance$;
COMMIT;

-- Limpieza del sembrado propio: las suites posteriores comparten esta base.
BEGIN;
SET LOCAL row_security = off;
DELETE FROM app.household_memberships
 WHERE id = 'fa900000-0000-4000-8000-000000000001';
DELETE FROM app.user_profiles WHERE user_id = 'fixture:roble:admin2';
COMMIT;
```

- [ ] **Step 2: Verlo fallar.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm test:db
```

Salida esperada: `not ok N - tests/030_finance_rls.sql` con `# granted family_admin read matrix failed` (no hay fixture de finanzas todavía).

- [ ] **Step 3: Escribir la fixture.** Crea `packages/db/fixtures/002_finance.sql` con EXACTAMENTE:

```sql
BEGIN;

-- Datos de finanzas deterministas y ENTERAMENTE inventados para los dos
-- hogares fixture, y la concesión viva SOLO para la administración del roble
-- (spec §4). Prefijos de UUID f1* (roble) y f2* (olivo), exclusivos de este
-- fichero. Requiere el propietario de las migraciones (bootstrap con RLS off).
SET LOCAL row_security = off;

-- Concesión: solo el admin del roble tiene Finanzas encendido.
INSERT INTO app.finance_module_grants (id, household_id, membership_id, granted_by_membership_id) VALUES
  ('f1900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');

INSERT INTO app.finance_accounts (id, household_id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('f1a00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Cuenta común fixture', 'caixabank', 'comun', 'familia',
   'ES0000000000000000000001', '["FAMILIA FIXTURE"]', '[]'),
  ('f1a00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'Fondo indexado fixture', 'openbank', 'inversion', 'familia',
   'ES0000000000000000000002', '[]', '["FIXTURE FONDO"]'),
  ('f2a00000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Cuenta del olivo', 'deutsche_bank', 'comun', 'familia',
   'ES0000000000000000000003', '[]', '[]');

-- Árbol de 2 niveles; exactamente UNA raíz `transferencia` por hogar.
INSERT INTO app.finance_categories (id, household_id, parent_id, name, kind) VALUES
  ('f1c00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', NULL, 'Casa', 'gasto'),
  ('f1c00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'f1c00000-0000-4000-8000-000000000001', 'Supermercado', 'gasto'),
  ('f1c00000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', NULL, 'Nómina', 'ingreso'),
  ('f1c00000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', NULL, 'Transferencias', 'transferencia'),
  ('f2c00000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', NULL, 'Gastos del olivo', 'gasto'),
  ('f2c00000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', NULL, 'Transferencias', 'transferencia');

INSERT INTO app.finance_rules (id, household_id, rule_type, pattern, category_id, priority, origin) VALUES
  ('f1b00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'proveedor_exacto', 'mercado ejemplo', 'f1c00000-0000-4000-8000-000000000002', 10, 'manual');

INSERT INTO app.finance_import_batches (id, household_id, filename, bank, new_count, dup_count) VALUES
  ('f1800000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'extracto-fixture.xls', 'caixabank', 2, 0);

INSERT INTO app.finance_transactions (
  id, household_id, account_id, batch_id, op_date, value_date, concept,
  provider, provider_norm, amount_cents, balance_cents, category_id, status,
  dedup_hash, raw
) VALUES
  ('f1e00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'f1a00000-0000-4000-8000-000000000001', 'f1800000-0000-4000-8000-000000000001',
   '2026-01-10', '2026-01-10', 'COMPRA MERCADO EJEMPLO',
   'Mercado Ejemplo', 'mercado ejemplo', -2350, 100000,
   'f1c00000-0000-4000-8000-000000000002', 'confirmada',
   'fixture-roble-tx-0001', '{"concepto": "COMPRA MERCADO EJEMPLO"}'),
  ('f1e00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'f1a00000-0000-4000-8000-000000000001', 'f1800000-0000-4000-8000-000000000001',
   '2026-01-25', '2026-01-25', 'NOMINA EMPRESA FIXTURE',
   'Empresa Fixture', 'empresa fixture', 180000, 280000,
   NULL, 'pendiente',
   'fixture-roble-tx-0002', '{"concepto": "NOMINA EMPRESA FIXTURE"}'),
  ('f2e00000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'f2a00000-0000-4000-8000-000000000001', NULL,
   '2026-02-05', NULL, 'GASTO DEL OLIVO',
   NULL, NULL, -1500, NULL,
   NULL, 'pendiente',
   'fixture-olivo-tx-0001', '{}');

INSERT INTO app.finance_provider_aliases (id, household_id, provider_norm, display) VALUES
  ('f1d00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'mercado ejemplo', 'Mercado Ejemplo');

INSERT INTO app.finance_events (id, household_id, name) VALUES
  ('f1f00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Semana Santa 2026');

INSERT INTO app.finance_transaction_events (id, household_id, transaction_id, event_id) VALUES
  ('f1f10000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'f1e00000-0000-4000-8000-000000000001', 'f1f00000-0000-4000-8000-000000000001');

INSERT INTO app.finance_event_rules (id, household_id, event_id, provider_norm, concept_norm, category_id) VALUES
  ('f1f20000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'f1f00000-0000-4000-8000-000000000001', 'mercado ejemplo', NULL, NULL);

COMMIT;
```

- [ ] **Step 4: Verde.** Mismo comando del Step 2. Salida esperada: `ok` para las 18 suites, incluida `tests/030_finance_rls.sql`.

- [ ] **Step 5: Cablear `test:rls`.** En `packages/db/package.json`, cambia la línea del script:

```json
    "test:rls": "node scripts/run-sql-tests.mjs tests/020_rls_matrix.sql tests/030_finance_rls.sql"
```

Ejecuta y comprueba `1..2` con ambos `ok`:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm test:rls
```

- [ ] **Step 6: Verificar el cableado a CI y a los runners (sin editar nada).**

```bash
grep -n "test:db\|test:rls" .github/workflows/ci.yml
grep -n "fixtures" packages/db/scripts/run-sql-tests.mjs packages/server/test-support/global-setup.mjs apps/web/e2e/db-global-setup.ts
```

Esperado: el job `database` de CI ya invoca `pnpm test:db` y `pnpm test:rls` (líneas ~111 y ~113) — la suite nueva entra sola; y los tres runners recorren `fixtures/*.sql` ordenado — `002_finance.sql` se carga sin tocar código. Si alguna de las dos cosas no fuera cierta, detente y corrígela antes de seguir.

- [ ] **Step 7: Commit.**

```bash
git add packages/db/fixtures/002_finance.sql packages/db/tests/030_finance_rls.sql packages/db/package.json
git commit -m "test(db): fixtures sintéticas de finanzas y matriz negativa 030 cableada a test:rls"
```

---

### Task 5: `requireFinanceAdmin` y comandos de concesión en `packages/server`

Patrón a calcar: `packages/server/src/commands/membership.ts` (handler + `CommandRejectedError` + validación zod del payload) y `packages/server/src/access.integration.test.ts` (suite contra Postgres real con el login `it_casa_clara_app_login` que provisiona `test-support/global-setup.mjs`). Los comandos `finance.grant.write`/`finance.revoke.write` exigen emisor `family_admin` con `access.manage` (NO exigen concesión propia: cualquier admin concede o revoca, y un admin puede revocarse a sí mismo). `requireFinanceAdmin` es el cerrojo que usarán TODOS los demás handlers y endpoints de fases posteriores.

**Files:**
- Create: `packages/server/src/commands/finance.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `apps/web/src/routes/api/v1/sync/+server.ts`
- Test (create): `packages/server/src/finance-grants.integration.test.ts`

**Interfaces:**
- Consumes: `financeCommandPayloadSchema` (`@casa-clara/contracts/schemas`), `hasCapability` (`@casa-clara/contracts/capabilities`), `ActiveMembership`/`withAuthorizedTransaction` (`./database.js`), `CommandRejectedError`/`CommandHandler`/`CommandHandlers`/`processSyncBatch` (`./sync.js`), `app.finance_enabled()` (0034).
- Produces: `export async function requireFinanceAdmin(client: PoolClient, membership: ActiveMembership): Promise<void>` (lanza `CommandRejectedError("not_allowed")` sin rol, `CommandRejectedError("finance_not_granted")` sin concesión viva); `export const financeCommandHandlers: CommandHandlers` con la clave `finance`.

- [ ] **Step 1: Escribir el test que falla.** Crea `packages/server/src/finance-grants.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { financeCommandHandlers, requireFinanceAdmin } from "./commands/finance.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };
const HELPER_MEMBERSHIP = "11000000-0000-4000-8000-000000000004";

// Administración adicional sembrada SOLO por esta suite (prefijo f09*): la
// fixture compartida solo tiene un admin en el roble y las concesiones se
// ejercen sobre alguien a quien apagar y encender sin tocar la fixture.
const SECOND_ADMIN_USER = "fixture:roble:finance-admin";
const SECOND_ADMIN: AuthenticatedPrincipal = { userId: SECOND_ADMIN_USER };
const SECOND_ADMIN_MEMBERSHIP = "f0900000-0000-4000-8000-000000000001";

function envelope(payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE,
    schemaVersion: 1,
    aggregateType: "finance",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-31T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("concesión y revocación de Finanzas sobre Postgres real (spec §4)", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], financeCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function financeEnabledFor(principal: AuthenticatedPrincipal): Promise<boolean> {
    return withAuthorizedTransaction(appPool, principal, ROBLE, async (client) => {
      const result = await client.query<{ enabled: boolean }>("select app.finance_enabled() as enabled");
      return Boolean(result.rows[0]?.enabled);
    });
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    await adminPool.query(
      `insert into app.user_profiles (user_id, display_name)
       values ($1, 'Fixture Admin Finanzas') on conflict (user_id) do nothing`,
      [SECOND_ADMIN_USER],
    );
    await adminPool.query(
      `insert into app.household_memberships (id, household_id, user_id, role)
       values ($1, $2, $3, 'family_admin') on conflict (id) do nothing`,
      [SECOND_ADMIN_MEMBERSHIP, ROBLE, SECOND_ADMIN_USER],
    );
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("concede, rechaza el duplicado, permite auto-revocarse y rechaza revocar dos veces", async () => {
    expect(await financeEnabledFor(SECOND_ADMIN)).toBe(false);

    const granted = await run(
      ADMIN,
      envelope({ kind: "finance.grant.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(granted.status).toBe("accepted");
    expect(granted.resourceId).toBeTruthy();
    expect(await financeEnabledFor(SECOND_ADMIN)).toBe(true);

    const repeated = await run(
      ADMIN,
      envelope({ kind: "finance.grant.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(repeated).toMatchObject({ status: "rejected", errorCode: "already_granted" });

    // Un admin puede revocarse a sí mismo; otro admin puede devolvérselo.
    const revoked = await run(
      SECOND_ADMIN,
      envelope({ kind: "finance.revoke.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(revoked.status).toBe("accepted");
    expect(await financeEnabledFor(SECOND_ADMIN)).toBe(false);

    const reRevoked = await run(
      ADMIN,
      envelope({ kind: "finance.revoke.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(reRevoked).toMatchObject({ status: "rejected", errorCode: "not_granted" });
  });

  it("solo se concede a family_admin y solo un family_admin emite", async () => {
    const toHelper = await run(
      ADMIN,
      envelope({ kind: "finance.grant.write", membershipId: HELPER_MEMBERSHIP }),
    );
    expect(toHelper).toMatchObject({ status: "rejected", errorCode: "grant_target_not_admin" });

    const fromFamily = await run(
      FAMILY,
      envelope({ kind: "finance.grant.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(fromFamily).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const badPayload = await run(ADMIN, envelope({ kind: "finance.grant.write" }));
    expect(badPayload).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });
  });

  it("requireFinanceAdmin exige rol Y concesión viva dentro de la transacción", async () => {
    // El admin de la fixture tiene concesión viva (fixtures/002_finance.sql).
    await withAuthorizedTransaction(appPool, ADMIN, ROBLE, async (client, membership) => {
      await expect(requireFinanceAdmin(client, membership)).resolves.toBeUndefined();
    });
    // Admin sin concesión (revocada en el test anterior): finance_not_granted.
    await expect(
      withAuthorizedTransaction(appPool, SECOND_ADMIN, ROBLE, (client, membership) =>
        requireFinanceAdmin(client, membership),
      ),
    ).rejects.toMatchObject({ errorCode: "finance_not_granted" });
    // Sin rol de administración: not_allowed.
    await expect(
      withAuthorizedTransaction(appPool, FAMILY, ROBLE, (client, membership) =>
        requireFinanceAdmin(client, membership),
      ),
    ).rejects.toMatchObject({ errorCode: "not_allowed" });
  });
});
```

- [ ] **Step 2: Verlo fallar.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm --filter @casa-clara/server exec vitest run src/finance-grants.integration.test.ts
```

Salida esperada: `Error: Failed to load … Cannot find module './commands/finance.js'` (o equivalente de resolución).

- [ ] **Step 3: Implementación mínima.** Crea `packages/server/src/commands/finance.ts`:

```ts
import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { hasCapability } from "@casa-clara/contracts/capabilities";
import { financeCommandPayloadSchema } from "@casa-clara/contracts/schemas";

import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler, type CommandHandlers } from "../sync.js";

/**
 * Doble cerrojo de Finanzas (spec §4), versión servidor: rol family_admin Y
 * concesión viva, verificados DENTRO de la transacción autorizada con la misma
 * función SQL que imponen las políticas RLS. Lo usan todos los handlers de
 * comandos y todos los endpoints REST de finanzas de las fases siguientes.
 * Análogo a requireAdmin (commands/membership.ts), más la segunda llave.
 */
export async function requireFinanceAdmin(
  client: PoolClient,
  membership: ActiveMembership,
): Promise<void> {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Finanzas es de la familia administradora");
  }
  const result = await client.query<{ enabled: boolean }>(
    "select app.finance_enabled() as enabled",
  );
  if (!result.rows[0]?.enabled) {
    throw new CommandRejectedError("finance_not_granted", "Tu cuenta no tiene Finanzas activado");
  }
}

/**
 * Conceder/revocar NO exige concesión propia: cualquier family_admin con
 * access.manage gestiona quién ve Finanzas (y puede apagarse a sí mismo;
 * otra administración puede devolvérselo).
 */
function requireAccessManagingAdmin(membership: ActiveMembership): void {
  if (membership.role !== "family_admin" || !hasCapability(membership.role, "access.manage")) {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora gestiona Finanzas");
  }
}

async function grantFinance(
  client: PoolClient,
  householdId: UUID,
  actor: ActiveMembership,
  membershipId: UUID,
): Promise<{ resourceId: UUID }> {
  const target = await client.query<{ role: string; revoked: boolean }>(
    `select role::text as role, revoked_at is not null as revoked
       from app.household_memberships
      where household_id = $1 and id = $2`,
    [householdId, membershipId],
  );
  const row = target.rows[0];
  if (!row || row.revoked) {
    throw new CommandRejectedError("membership_not_found", "La membresía no existe o está revocada");
  }
  if (row.role !== "family_admin") {
    // El disparador finance_module_grants_target_guard (0034) respalda esta
    // regla en la base; aquí se rechaza con un código legible antes de chocar.
    throw new CommandRejectedError(
      "grant_target_not_admin",
      "Finanzas solo se concede a la familia administradora",    );
  }
  const live = await client.query<{ id: string }>(
    `select id from app.finance_module_grants
      where household_id = $1 and membership_id = $2 and revoked_at is null`,
    [householdId, membershipId],
  );
  if (live.rows[0]) {
    throw new CommandRejectedError("already_granted", "Esa cuenta ya tiene Finanzas activado");
  }
  const inserted = await client.query<{ id: string }>(
    `insert into app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
     values ($1, $2, $3)
     returning id`,
    [householdId, membershipId, actor.id],
  );
  return { resourceId: inserted.rows[0].id as UUID };
}

async function revokeFinance(
  client: PoolClient,
  householdId: UUID,
  actor: ActiveMembership,
  membershipId: UUID,
): Promise<{ resourceId: UUID }> {
  const updated = await client.query<{ id: string }>(
    `update app.finance_module_grants
        set revoked_at = statement_timestamp(),
            revoked_by_membership_id = $3
      where household_id = $1 and membership_id = $2 and revoked_at is null
      returning id`,
    [householdId, membershipId, actor.id],
  );
  if (!updated.rows[0]) {
    throw new CommandRejectedError("not_granted", "Esa cuenta no tiene Finanzas activado");
  }
  return { resourceId: updated.rows[0].id as UUID };
}

export const financeCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const parsed = financeCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  requireAccessManagingAdmin(membership);
  const payload = parsed.data;
  switch (payload.kind) {
    case "finance.grant.write":
      return grantFinance(client, envelope.householdId, membership, payload.membershipId);
    case "finance.revoke.write":
      return revokeFinance(client, envelope.householdId, membership, payload.membershipId);
  }
};

/** Mapa de handlers de finanzas listo para la ruta de sync. */
export const financeCommandHandlers: CommandHandlers = {
  finance: financeCommandHandler,
};
```

En `packages/server/src/index.ts`, añade (orden alfabético, tras `./commands/extra-work.js`):

```ts
export * from "./commands/finance.js";
```

- [ ] **Step 4: Verde del paquete server.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm --filter @casa-clara/server exec vitest run src/finance-grants.integration.test.ts
pnpm --filter @casa-clara/server typecheck
```

Esperado: `Test Files 1 passed`, `Tests 3 passed`.

- [ ] **Step 5: Registrar el dispatcher en la ruta de sync.** En `apps/web/src/routes/api/v1/sync/+server.ts`: añade `financeCommandHandlers,` a la lista de imports de `'@casa-clara/server'` (orden alfabético, tras `employmentCommandHandlers`) y añade `...financeCommandHandlers,` dentro del objeto `handlers` (tras `...accessCommandHandlers,`). Verifica:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web typecheck
```

- [ ] **Step 6: Commit.**

```bash
git add packages/server/src/commands/finance.ts packages/server/src/index.ts packages/server/src/finance-grants.integration.test.ts "apps/web/src/routes/api/v1/sync/+server.ts"
git commit -m "feat(server): requireFinanceAdmin y comandos finance.grant/revoke.write en el dispatcher"
```

---

### Task 6: Alta coordinada de la sección — routing, títulos, navegación e icono

La spec §8 exige el alta en los 5 puntos obligatorios a la vez, y los tests existentes los atan entre sí (el bucle de `app-title.test.ts` recorre `HOUSEHOLD_MODULES`), así que esta tarea toca los cuatro ficheros web juntos. Patrones: `NESTED_ROUTE_CAPABILITY` de `apps/web/src/lib/auth/routing.ts` (comentario incluido), `NAV_ENTRIES`/órdenes de `AppShell.svelte` (líneas 24-58), `SECTION_LABELS` de `app-title.ts`, paths de trazo único de `NavIcon.svelte`.

**Files:**
- Modify: `apps/web/src/lib/auth/routing.ts`
- Modify: `apps/web/src/lib/app-title.ts`
- Modify: `apps/web/src/lib/components/AppShell.svelte`
- Modify: `apps/web/src/lib/components/NavIcon.svelte`
- Test (modify): `apps/web/tests/routing.test.ts`, `apps/web/tests/app-title.test.ts`

**Interfaces:**
- Consumes: `Capability` (con `finance.access`, Task 1).
- Produces: `HOUSEHOLD_MODULES` += `'finanzas'`; `MODULE_CAPABILITY.finanzas = 'finance.access'`; `NESTED_ROUTE_CAPABILITY['finanzas/analitica'|'finanzas/movimientos'|'finanzas/revision'|'finanzas/eventos'|'finanzas/importar'|'finanzas/ajustes'] = 'finance.access'`; entrada «Finanzas» en `NAV_ENTRIES` y en ambos órdenes; etiquetas en `SECTION_LABELS`; path `finanzas` en `NavIcon`.

- [ ] **Step 1: Escribir los tests que fallan.** En `apps/web/tests/routing.test.ts`: en el primer `it`, cambia la lista esperada de `HOUSEHOLD_MODULES` por `['today', 'employment', 'menu', 'recipes', 'wiki', 'search', 'routines', 'calendar', 'contacts', 'emergency', 'account', 'personal', 'finanzas', 'settings']`; y añade al final del `describe`:

```ts
  it('finanzas exige el doble cerrojo en el módulo y en cada ruta hija', () => {
    expect(MODULE_CAPABILITY.finanzas).toBe('finance.access');
    for (const child of ['analitica', 'movimientos', 'revision', 'eventos', 'importar', 'ajustes']) {
      expect(guardForPath(`/h/casa-roble/finanzas/${child}`)).toEqual({
        householdId: 'casa-roble',
        module: 'finanzas',
        capability: 'finance.access',
        known: true
      });
    }
    // Fail-closed: una hija sin declarar no hereda nada.
    expect(guardForPath('/h/casa-roble/finanzas/otra')).toMatchObject({ known: false, capability: null });
    // La capacidad solo existe en la matriz para la administración.
    expect(can('family_admin', 'finance.access')).toBe(true);
    expect(can('family_member', 'finance.access')).toBe(false);
    expect(can('helper', 'finance.access')).toBe(false);
  });
```

En `apps/web/tests/app-title.test.ts`, dentro del `it('toda sección estable tiene etiqueta…')`, añade:

```ts
    expect(sectionLabelFor('/h/abc/finanzas')).toBe('Finanzas');
    expect(sectionLabelFor('/h/abc/finanzas/analitica')).toBe('Analítica');
    expect(sectionLabelFor('/h/abc/finanzas/movimientos')).toBe('Movimientos');
    expect(sectionLabelFor('/h/abc/finanzas/revision')).toBe('Revisión');
    expect(sectionLabelFor('/h/abc/finanzas/eventos')).toBe('Eventos');
    expect(sectionLabelFor('/h/abc/finanzas/importar')).toBe('Importar');
    expect(sectionLabelFor('/h/abc/finanzas/ajustes')).toBe('Ajustes de Finanzas');
```

- [ ] **Step 2: Verlo fallar.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web exec vitest run tests/routing.test.ts tests/app-title.test.ts
```

Esperado: ambos ficheros en `FAIL` (lista de módulos sin `finanzas`; etiquetas sin definir).

- [ ] **Step 3: routing.ts.** En `apps/web/src/lib/auth/routing.ts`: (a) en `HOUSEHOLD_MODULES`, inserta `'finanzas',` entre `'personal',` y `'settings'`; (b) en `MODULE_CAPABILITY`, antes de `settings`, añade:

```ts
  // Finanzas es de la administración Y de cuenta activada: la capacidad la
  // tiene el rol, pero el layout la retira sin concesión viva (spec §4). La
  // segunda llave nunca vive aquí: este mapa no consulta la base.
  finanzas: 'finance.access',
```

(c) en `NESTED_ROUTE_CAPABILITY`, añade tras las tres entradas de employment:

```ts
  // Finanzas: cada hija declarada una a una (fail-closed), todas con la misma
  // llave del módulo — el doble cerrojo real lo aplican layout y RLS.
  'finanzas/analitica': 'finance.access',
  'finanzas/movimientos': 'finance.access',
  'finanzas/revision': 'finance.access',
  'finanzas/eventos': 'finance.access',
  'finanzas/importar': 'finance.access',
  'finanzas/ajustes': 'finance.access'
```

- [ ] **Step 4: app-title.ts.** En `SECTION_LABELS`, tras la entrada `settings`, añade:

```ts
  finanzas: 'Finanzas',
  'finanzas/analitica': 'Analítica',
  'finanzas/movimientos': 'Movimientos',
  'finanzas/revision': 'Revisión',
  'finanzas/eventos': 'Eventos',
  'finanzas/importar': 'Importar',
  'finanzas/ajustes': 'Ajustes de Finanzas',
```

Ejecuta el comando del Step 2: ahora los dos ficheros en verde.

- [ ] **Step 5: AppShell + NavIcon.** En `apps/web/src/lib/components/AppShell.svelte`: (a) en `NAV_ENTRIES`, tras la línea de `employment`, añade:

```ts
    // Solo la ve quien tiene finance.access EFECTIVO: el servidor ya la retiró
    // del contexto si la membresía no tiene concesión viva (spec §4).
    finanzas: { module: 'finanzas', label: 'Finanzas', short: 'Finanzas', capability: 'finance.access' },
```

(b) en los dos órdenes, inserta `'finanzas'` tras `'employment'`:

```ts
  const handsOnOrder = ['today', 'routines', 'menu', 'wiki', 'employment', 'finanzas', 'calendar', 'contacts'];
  const familyOrder = ['today', 'menu', 'employment', 'finanzas', 'calendar', 'wiki', 'routines', 'contacts'];
```

En `apps/web/src/lib/components/NavIcon.svelte`, en el objeto `paths`, tras `employment`, añade:

```ts
    // Barras sobre ejes: el dinero de la casa, mes a mes.
    finanzas: 'M4 4v16h16M8 16v-6M12 16V7M16 16v-3',
```

- [ ] **Step 6: Verde y gates.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web exec vitest run tests/routing.test.ts tests/app-title.test.ts tests/capabilities.test.ts
pnpm --filter @casa-clara/web check
```

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/lib/auth/routing.ts apps/web/src/lib/app-title.ts apps/web/src/lib/components/AppShell.svelte apps/web/src/lib/components/NavIcon.svelte apps/web/tests/routing.test.ts apps/web/tests/app-title.test.ts
git commit -m "feat(web): alta coordinada de Finanzas en routing, títulos, navegación e icono"
```

---

### Task 7: El layout retira `finance.access` sin concesión viva

`+layout.server.ts` calcula hoy `capabilities = capabilitiesFor(role)` y hace el guard con `can(role, capability)`. Se cambia a: capacidades EFECTIVAS (retirando `finance.access` si `app.finance_enabled()` no es cierto para la membresía) y guard contra esa lista. El helper lee el cerrojo real por transacción autorizada; patrón a calcar: `requirePasswordChange`/`loadAccessOverview` de `apps/web/src/lib/server/access.server.ts`. El test es una suite de integración web con base propia; patrón a calcar: `apps/web/tests/contacts.integration.test.ts` (base `casaclara_*_it` + login `in role casa_clara_app`).

**Files:**
- Create: `apps/web/src/lib/server/finance-access.server.ts`
- Modify: `apps/web/src/routes/h/[householdId]/+layout.server.ts`
- Test (create): `apps/web/tests/finance-access.integration.test.ts`

**Interfaces:**
- Consumes: `withAuthorizedTransaction`, `AuthorizationError`, `createLogger`, `errorCode` (`@casa-clara/server`); `getDatabasePool` (`$lib/server/db.server`); `fixturesAllowed` (`$lib/server/data-source.server`); `app.finance_enabled()`.
- Produces: `export async function financeAccessGranted(user: { id: string }, householdId: string, pool?: Pool | null): Promise<boolean>`.

- [ ] **Step 1: Escribir el test que falla.** Crea `apps/web/tests/finance-access.integration.test.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { financeAccessGranted } from '../src/lib/server/finance-access.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Comportamiento CON base configurada (producción): fixturesAllowed() = false.
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgres://prueba/afirmada' } }));

const APP_LOGIN = 'it_casa_clara_finance_login';
// Base propia (patrón de la suite de contactos): las suites vecinas recrean
// el esquema en paralelo y ninguna puede compartir instancia.
const FINANCE_DB = 'casaclara_finance_it';

const OLIVO_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const OLIVO_ADMIN_USER = { id: 'fixture:olivo:admin' };

function financeUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${FINANCE_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('doble cerrojo de Finanzas leído por el layout', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${FINANCE_DB} with (force)`);
      await cluster.query(`create database ${FINANCE_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: financeUrlFor(adminUrl as string) });
    await admin.connect();
    try {
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(financeUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('true SOLO para la administración con concesión viva; false para el resto', async () => {
    expect(await financeAccessGranted(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(true);
    expect(await financeAccessGranted(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    expect(await financeAccessGranted(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    // Admin de un hogar CON datos de finanzas pero SIN concesión: false.
    expect(await financeAccessGranted(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, appPool)).toBe(false);
  });

  it('falla cerrado: sin membresía en el hogar la respuesta es false', async () => {
    expect(await financeAccessGranted({ id: 'fixture:olivo:admin' }, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    expect(await financeAccessGranted({ id: 'nadie:desconocido' }, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
  });
});
```

- [ ] **Step 2: Verlo fallar.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm --filter @casa-clara/web exec vitest run tests/finance-access.integration.test.ts
```

Esperado: fallo de resolución `Cannot find module '../src/lib/server/finance-access.server'`.

- [ ] **Step 3: Implementar el helper.** Crea `apps/web/src/lib/server/finance-access.server.ts`:

```ts
import type { Pool } from 'pg';

import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import { fixturesAllowed } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:finance-access');

/**
 * ¿Tiene esta persona Finanzas abierto en este hogar? Lee el cerrojo REAL
 * (app.finance_enabled(): rol family_admin Y concesión viva) bajo la misma
 * transacción autorizada que cualquier otra lectura. Falla CERRADO: sin
 * membresía o con avería, false — el módulo no se enseña por accidente. Sin
 * base de datos (demo por fixtures) devuelve true: la maqueta enseña Finanzas
 * como enseña el resto de módulos, y el rol ya filtró al no-admin.
 */
export async function financeAccessGranted(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<boolean> {
  if (!pool) return fixturesAllowed();
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const result = await client.query<{ enabled: boolean }>(
        'select app.finance_enabled() as enabled'
      );
      return Boolean(result.rows[0]?.enabled);
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('finance access check unavailable', { code: errorCode(cause) });
    }
    return false;
  }
}
```

Ejecuta el comando del Step 2: verde (`Tests 2 passed`).

- [ ] **Step 4: Retirar la capacidad en el layout.** En `apps/web/src/routes/h/[householdId]/+layout.server.ts`: (a) cambia el import `import { can, capabilitiesFor } from '$lib/auth/capabilities';` por `import { capabilitiesFor } from '$lib/auth/capabilities';` y añade `import { financeAccessGranted } from '$lib/server/finance-access.server';`; (b) sustituye el bloque del guard (las líneas `const guard = …` hasta el `error(403, …)`) por:

```ts
  const guard = guardForPath(url.pathname);
  // Doble cerrojo de Finanzas (spec §4): la capacidad sale de la matriz por
  // rol, pero solo cuenta con concesión viva en la base. Se retira AQUÍ,
  // antes del guard y del AppContext, para que el guard de rutas, el AppShell
  // y la UI sigan funcionando con su mecanismo de siempre — y el cliente no
  // vea el módulo si no le corresponde. La consulta solo ocurre para quien
  // tiene la capacidad por rol (family_admin).
  const roleCapabilities = capabilitiesFor(membership.role);
  const financeGranted =
    roleCapabilities.includes('finance.access') &&
    (await financeAccessGranted({ id: locals.user.id }, params.householdId));
  const capabilities = financeGranted
    ? roleCapabilities
    : roleCapabilities.filter((capability) => capability !== 'finance.access');
  if (guard?.capability && !capabilities.includes(guard.capability)) {
    error(403, 'Esta parte la lleva la familia.');
  }
```

(c) en el objeto `context`, cambia `capabilities: capabilitiesFor(membership.role),` por `capabilities,`.

- [ ] **Step 5: Gates.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web typecheck && pnpm --filter @casa-clara/web check
```

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/server/finance-access.server.ts "apps/web/src/routes/h/[householdId]/+layout.server.ts" apps/web/tests/finance-access.integration.test.ts
git commit -m "feat(web): el layout retira finance.access sin concesión viva"
```

---

### Task 8: Páginas esqueleto de las 7 rutas de Finanzas

Cada pantalla es `PageHeader` + estado vacío honesto (`.empty-state` de `app.css`, como `search/+page.svelte`), con `load` que lee conteos reales bajo RLS y cae a `demoOrUnavailable` (patrón de `contacts/+page.server.ts`). «No hay datos» nunca significa «no puedes verlo»: quien llega aquí ya pasó el doble cerrojo del layout.

**Files:**
- Create: `apps/web/src/lib/server/finance-status.server.ts`
- Create: `apps/web/src/routes/h/[householdId]/finanzas/+page.server.ts` y `+page.svelte`
- Create: `apps/web/src/routes/h/[householdId]/finanzas/{analitica,movimientos,revision,eventos,importar,ajustes}/+page.server.ts` y `+page.svelte` (12 ficheros)
- Test (modify): `apps/web/tests/finance-access.integration.test.ts`

**Interfaces:**
- Consumes: `withAuthorizedTransaction`, `unreadable`, `demoOrUnavailable`, `getDatabasePool`, `PageHeader.svelte`.
- Produces: `export async function loadFinanceStatus(user: { id: string }, householdId: string, pool?: Pool | null): Promise<FinanceStatus | null>` con `interface FinanceStatus { accountCount: number; transactionCount: number }`.

- [ ] **Step 1: Escribir el test que falla.** Añade al final del `describe` de `apps/web/tests/finance-access.integration.test.ts` (usa la base ya provisionada), y añade `loadFinanceStatus` al import creándolo desde `'../src/lib/server/finance-status.server'`:

```ts
  it('loadFinanceStatus cuenta bajo RLS lo que ve ESTA membresía', async () => {
    // Admin con concesión: los datos sintéticos del roble (002_finance.sql).
    expect(await loadFinanceStatus(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool)).toEqual({
      accountCount: 2,
      transactionCount: 2
    });
    // Admin del olivo sin concesión: el cerrojo devuelve ceros, no un error.
    expect(await loadFinanceStatus(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, appPool)).toEqual({
      accountCount: 0,
      transactionCount: 0
    });
    // Sin membresía en el hogar: null (la página lo traduce a 403/404).
    expect(await loadFinanceStatus({ id: 'nadie:desconocido' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });
```

Ejecutar (mismo comando de la Task 7 Step 2); esperado: `Cannot find module '../src/lib/server/finance-status.server'`.

- [ ] **Step 2: Implementar el helper.** Crea `apps/web/src/lib/server/finance-status.server.ts`:

```ts
import type { Pool } from 'pg';

import { createLogger, withAuthorizedTransaction } from '@casa-clara/server';

import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:finance-status');

export interface FinanceStatus {
  accountCount: number;
  transactionCount: number;
}

/**
 * Conteos mínimos para las páginas esqueleto de Finanzas: cuántas cuentas y
 * movimientos ve ESTA membresía bajo RLS. El doble cerrojo manda: a un admin
 * sin concesión el layout ya no le deja llegar, y si llegara, la RLS le
 * devolvería ceros — «no hay datos» nunca miente. Null solo sin base o sin
 * membresía (la página lo traduce); una avería real sale como 503 honesto.
 */
export async function loadFinanceStatus(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceStatus | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const result = await client.query<{ accounts: string; transactions: string }>(
        `select
           (select count(*) from app.finance_accounts) as accounts,
           (select count(*) from app.finance_transactions) as transactions`
      );
      const row = result.rows[0];
      return {
        accountCount: Number(row?.accounts ?? 0),
        transactionCount: Number(row?.transactions ?? 0)
      } satisfies FinanceStatus;
    });
  } catch (cause) {
    return unreadable(log, 'finance status', cause);
  }
}
```

Verde: repetir el comando del Step 1.

- [ ] **Step 3: Los 7 `+page.server.ts`.** Crea los siete ficheros — `apps/web/src/routes/h/[householdId]/finanzas/+page.server.ts` y el homónimo dentro de `analitica/`, `movimientos/`, `revision/`, `eventos/`, `importar/` y `ajustes/` — todos con EXACTAMENTE este contenido:

```ts
import { demoOrUnavailable } from '$lib/server/data-source.server';
import { loadFinanceStatus } from '$lib/server/finance-status.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
  const status = locals.user
    ? await loadFinanceStatus({ id: locals.user.id }, params.householdId)
    : null;
  if (status) return { status };
  // Sin base de datos, la demo enseña el esqueleto vacío; con base y avería,
  // 503 honesto (regla de data-source.server.ts).
  return demoOrUnavailable(() => ({ status: { accountCount: 0, transactionCount: 0 } }));
};
```

- [ ] **Step 4: Los 7 `+page.svelte`.** Cada uno lleva EXACTAMENTE esta estructura, sustituyendo los tres huecos «TÍTULO», «COPY_VACÍO» y «COPY_PENDIENTE» por la fila de su ruta en la tabla de abajo:

```svelte
<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="page-wrap">
  <PageHeader eyebrow="Finanzas" title="«TÍTULO»" />
  <section class="empty-state">
    <span aria-hidden="true">€</span>
    {#if data.status.transactionCount === 0}
      <h2>Aún no hay datos de finanzas</h2>
      <p>«COPY_VACÍO»</p>
    {:else}
      <h2>Esta pantalla está en construcción</h2>
      <p>
        Hay {data.status.transactionCount} movimientos guardados en
        {data.status.accountCount} cuentas. «COPY_PENDIENTE»
      </p>
    {/if}
  </section>
</div>
```

| Ruta | «TÍTULO» | «COPY_VACÍO» | «COPY_PENDIENTE» |
|---|---|---|---|
| `finanzas/+page.svelte` | `Finanzas de la casa` | `Cuando se importe el primer extracto, aquí estarán los indicadores del mes: ingresos, gastos, ahorro e inversión.` | `Los indicadores y las gráficas del panel llegan en una fase posterior del módulo.` |
| `analitica/+page.svelte` | `Analítica` | `Cuando haya movimientos importados, aquí vivirán los indicadores ampliados, el resumen mensual y el pivot completo.` | `El pivot y las gráficas de esta pantalla llegan en una fase posterior del módulo.` |
| `movimientos/+page.svelte` | `Movimientos` | `Cuando se importe el primer extracto, aquí estará el libro de movimientos con sus filtros.` | `La tabla de movimientos llega en una fase posterior del módulo.` |
| `revision/+page.svelte` | `Revisión` | `Cuando haya movimientos pendientes o sugeridos, aquí se confirmarán uno a uno o en bloque.` | `La bandeja de revisión llega en una fase posterior del módulo.` |
| `eventos/+page.svelte` | `Eventos` | `Los eventos son etiquetas transversales («Semana Santa 2026») para agrupar gastos. Aquí se crearán y consultarán.` | `La gestión de eventos llega en una fase posterior del módulo.` |
| `importar/+page.svelte` | `Importar extractos` | `Aquí se subirán los extractos del banco, con previsualización antes de confirmar.` | `La importación de extractos llega en una fase posterior del módulo.` |
| `ajustes/+page.svelte` | `Ajustes de Finanzas` | `Aquí se administrarán las cuentas, las categorías, las reglas y los alias de proveedores.` | `Los ajustes del módulo llegan en una fase posterior. La concesión por cuenta vive en los Ajustes del hogar.` |

- [ ] **Step 5: Gates.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web check && pnpm lint
```

Esperado: svelte-check sin errores (las 7 rutas compilan) y el linter de tokens CSS sin quejas (no hay CSS nuevo).

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/server/finance-status.server.ts "apps/web/src/routes/h/[householdId]/finanzas" apps/web/tests/finance-access.integration.test.ts
git commit -m "feat(web): páginas esqueleto de las siete rutas de Finanzas"
```

---

### Task 9: Tarjeta «Finanzas» en Ajustes del hogar

La concesión por admin vive en los Ajustes GENERALES (spec §4), junto a la sección de accesos. Patrones a calcar: constructores de envelopes de `apps/web/src/lib/access/commands.ts`; test de constructores de `apps/web/tests/access-commands.test.ts`; despacho con `OptimisticActions` + `messageOverrides` y tarjeta de `settings/+page.svelte`; lectura bajo RLS de `loadAccessOverview` (`access.server.ts`).

**Files:**
- Create: `apps/web/src/lib/finance/commands.ts`
- Modify: `apps/web/src/lib/server/finance-access.server.ts` (añadir `loadFinanceGrantOverview`)
- Modify: `apps/web/src/routes/h/[householdId]/settings/+page.server.ts`
- Modify: `apps/web/src/routes/h/[householdId]/settings/+page.svelte`
- Test (create): `apps/web/tests/finance-commands.test.ts`
- Test (modify): `apps/web/tests/finance-access.integration.test.ts`

**Interfaces:**
- Consumes: `createCommandEnvelope` (`$lib/offline/schema`), `financeCommandPayloadSchema` (`@casa-clara/contracts/schemas`), `OptimisticActions` (`$lib/offline/optimistic`), token de invalidación `cc:settings` (ya declarado en el load de Ajustes).
- Produces: `grantFinanceAccess(input: { householdId: string; membershipId: string }, options?): CommandEnvelopeV1<FinanceGrantPayload>`; `revokeFinanceAccess(…): CommandEnvelopeV1<FinanceRevokePayload>`; `loadFinanceGrantOverview(user, householdId, pool?): Promise<FinanceGrantOverview | null>` con `FinanceGrantView { membershipId; name; granted; isSelf }`.

- [ ] **Step 1: Test de constructores que falla.** Crea `apps/web/tests/finance-commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código que llega al navegador no importa zod jamás (patrón access-commands).
import {
  commandEnvelopeSchema,
  financeCommandPayloadSchema,
  financeGrantPayloadSchema,
  financeRevokePayloadSchema
} from '@casa-clara/contracts/schemas';

import { grantFinanceAccess, revokeFinanceAccess } from '../src/lib/finance/commands';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000105',
  occurredAt: '2026-08-31T10:00:00.000Z'
};

describe('constructores de envelopes de concesión de Finanzas', () => {
  it('grantFinanceAccess valida contra el contrato y ancla la membresía', () => {
    const envelope = grantFinanceAccess({ householdId: HOUSEHOLD, membershipId: MEMBERSHIP }, OPTIONS);
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('finance');
    expect(envelope.aggregateId).toBe(MEMBERSHIP);
    expect(financeGrantPayloadSchema.parse(envelope.payload)).toEqual({
      kind: 'finance.grant.write',
      membershipId: MEMBERSHIP
    });
  });

  it('revokeFinanceAccess produce el payload congelado de revocación', () => {
    const envelope = revokeFinanceAccess({ householdId: HOUSEHOLD, membershipId: MEMBERSHIP }, OPTIONS);
    expect(financeRevokePayloadSchema.parse(envelope.payload)).toEqual({
      kind: 'finance.revoke.write',
      membershipId: MEMBERSHIP
    });
    expect(financeCommandPayloadSchema.parse(envelope.payload).kind).toBe('finance.revoke.write');
  });
});
```

Ejecutar y ver fallar (`Cannot find module '../src/lib/finance/commands'`):

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web exec vitest run tests/finance-commands.test.ts
```

- [ ] **Step 2: Implementar los constructores.** Crea `apps/web/src/lib/finance/commands.ts`:

```ts
import type { CommandEnvelopeV1 } from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';

/**
 * Constructores puros de los envelopes de concesión de Finanzas (spec §4).
 * Producen los payloads CONGELADOS de @casa-clara/contracts/schemas
 * (financeGrantPayloadSchema / financeRevokePayloadSchema); la validación zod
 * vive en los tests y en el servidor, nunca en el bundle del navegador.
 * Patrón calcado de $lib/access/commands.ts.
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

export interface FinanceGrantPayload {
  kind: 'finance.grant.write';
  membershipId: string;
}

export interface FinanceRevokePayload {
  kind: 'finance.revoke.write';
  membershipId: string;
}

export function grantFinanceAccess(
  input: { householdId: string; membershipId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<FinanceGrantPayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'finance',
    aggregateId: input.membershipId,
    payload: {
      kind: 'finance.grant.write',
      membershipId: input.membershipId
    } satisfies FinanceGrantPayload
  }) as CommandEnvelopeV1<FinanceGrantPayload>;
}

export function revokeFinanceAccess(
  input: { householdId: string; membershipId: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<FinanceRevokePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'finance',
    aggregateId: input.membershipId,
    payload: {
      kind: 'finance.revoke.write',
      membershipId: input.membershipId
    } satisfies FinanceRevokePayload
  }) as CommandEnvelopeV1<FinanceRevokePayload>;
}
```

Verde: repetir el comando del Step 1.

- [ ] **Step 3: Test de la vista de concesiones que falla.** En `apps/web/tests/finance-access.integration.test.ts`, añade `loadFinanceGrantOverview` al import de `finance-access.server` y este caso al final del `describe`:

```ts
  it('loadFinanceGrantOverview lista los admins con su estado; null para el resto', async () => {
    const overview = await loadFinanceGrantOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    expect(overview?.admins).toEqual([
      {
        membershipId: '11000000-0000-4000-8000-000000000001',
        name: 'Fixture Admin Roble',
        granted: true,
        isSelf: true
      }
    ]);
    expect(await loadFinanceGrantOverview(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });
```

Ejecutar la suite y ver fallar por export inexistente.

- [ ] **Step 4: Implementar la vista.** En `apps/web/src/lib/server/finance-access.server.ts`, añade `unreadable` al import de `./data-source.server` y, al final del fichero:

```ts
export interface FinanceGrantView {
  membershipId: string;
  name: string;
  granted: boolean;
  /** La membresía de quien mira: puede desactivarse a sí misma (spec §4). */
  isSelf: boolean;
}

export interface FinanceGrantOverview {
  householdId: string;
  admins: FinanceGrantView[];
}

/**
 * Membresías family_admin vivas del hogar con su estado de concesión, para la
 * tarjeta «Finanzas» de Ajustes. La RLS de finance_module_grants deja leer las
 * concesiones a cualquier admin del hogar; para el resto de roles, null.
 */
export async function loadFinanceGrantOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool()
): Promise<FinanceGrantOverview | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'family_admin') return null;
      const result = await client.query<{ id: string; displayName: string | null; granted: boolean }>(
        `select m.id,
                p.display_name as "displayName",
                exists (
                  select 1 from app.finance_module_grants as g
                   where g.household_id = m.household_id
                     and g.membership_id = m.id
                     and g.revoked_at is null
                ) as granted
           from app.household_memberships as m
           left join app.user_profiles as p on p.user_id = m.user_id
          where m.household_id = $1 and m.role = 'family_admin' and m.revoked_at is null
          order by m.created_at, m.id`,
        [householdId]
      );
      return {
        householdId,
        admins: result.rows.map((row) => ({
          membershipId: row.id,
          name: row.displayName ?? 'Perfil sin nombre',
          granted: row.granted,
          isSelf: row.id === membership.id
        }))
      } satisfies FinanceGrantOverview;
    });
  } catch (cause) {
    return unreadable(log, 'finance grant overview', cause);
  }
}
```

Verde: repetir la suite de integración.

- [ ] **Step 5: Cargar la vista en Ajustes.** En `apps/web/src/routes/h/[householdId]/settings/+page.server.ts`: añade `import { loadFinanceGrantOverview } from '$lib/server/finance-access.server';` y, en el objeto que devuelve `load`, tras la clave `access,` añade:

```ts
    // Concesiones de Finanzas por admin (spec §4): misma pantalla que los
    // accesos, mismo token de invalidación (cc:settings).
    finance: locals.user
      ? await loadFinanceGrantOverview({ id: locals.user.id }, params.householdId)
      : null,
```

- [ ] **Step 6: La tarjeta.** En `apps/web/src/routes/h/[householdId]/settings/+page.svelte`: (a) en el `<script>`, añade el import `import { grantFinanceAccess, revokeFinanceAccess } from '$lib/finance/commands';` y, tras la constante `MEMBERSHIP_MESSAGES`, añade:

```ts
  // Rechazos propios de la concesión de Finanzas (códigos de commands/finance.ts).
  const FINANCE_MESSAGES: Readonly<Record<string, string>> = {
    already_granted: 'Esa cuenta ya tiene Finanzas activado',
    not_granted: 'Esa cuenta no tiene Finanzas activado',
    grant_target_not_admin: 'Finanzas solo se concede a la familia administradora',
    membership_not_found: 'Ese acceso ya no existe'
  };

  function toggleFinance(admin: { membershipId: string; granted: boolean }): void {
    const householdId = context.household.id;
    const envelope = admin.granted
      ? revokeFinanceAccess({ householdId, membershipId: admin.membershipId })
      : grantFinanceAccess({ householdId, membershipId: admin.membershipId });
    busy = true;
    void optimistic
      .run(envelope, { messageOverrides: FINANCE_MESSAGES })
      .finally(() => {
        busy = false;
      });
  }
```

(b) en el marcado, dentro del `{#if access}` y justo ANTES de la sección «Personal», inserta:

```svelte
    <section class="card" aria-labelledby="finance-grants-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Finanzas</p>
          <h2 id="finance-grants-title">Quién puede ver las finanzas de la casa</h2>
        </div>
      </div>
      {#if data.finance}
        <p class="audit-note">
          Finanzas se activa cuenta a cuenta y solo para la familia administradora: quien no lo
          tiene activado no ve el módulo ni una sola cifra. Puedes desactivártelo a ti; otra
          administración puede devolvértelo.
        </p>
        <ul class="wiki-recent" data-lista="finanzas">
          {#each data.finance.admins as admin (admin.membershipId)}
            <li>
              <div class="fila-accion">
                <span class="fila-cuerpo">
                  <strong>{admin.name}</strong>
                  <small>{admin.granted ? 'Ve el módulo de Finanzas' : 'No ve el módulo de Finanzas'}</small>
                </span>
                <span class="fila-fin">
                  {#if admin.granted}
                    <span class="status-chip success">Activado</span>
                  {:else}
                    <span class="status-chip">Apagado</span>
                  {/if}
                  <button
                    class="button secondary small-button"
                    type="button"
                    disabled={busy}
                    onclick={() => toggleFinance(admin)}
                  >
                    {admin.granted ? `Desactivar Finanzas a ${admin.name}` : `Activar Finanzas a ${admin.name}`}
                  </button>
                </span>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="audit-note">
          La concesión de Finanzas se gestiona con la base de datos del hogar conectada.
        </p>
      {/if}
    </section>
```

- [ ] **Step 7: Gates y verde final de la tarea.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm --filter @casa-clara/web exec vitest run tests/finance-commands.test.ts tests/finance-access.integration.test.ts
pnpm --filter @casa-clara/web check
```

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/lib/finance/commands.ts apps/web/src/lib/server/finance-access.server.ts "apps/web/src/routes/h/[householdId]/settings" apps/web/tests/finance-commands.test.ts apps/web/tests/finance-access.integration.test.ts
git commit -m "feat(web): tarjeta de concesiones de Finanzas en Ajustes del hogar"
```

---

### Task 10: Verificación de cierre de fase

Ningún fichero nuevo: se comprueba que la rama queda con TODOS los gates en verde y que el presupuesto de arranque de Hoy no se ha movido (la matriz de capacidades sigue fuera de la raíz de contracts; la entrada de navegación es texto en el AppShell).

**Files:**
- Ninguno (solo ejecución; si algo falla, se arregla en la tarea correspondiente antes de cerrar).

**Interfaces:**
- Consumes: todo lo producido en las tareas 1-9.
- Produces: fase 1 entregada con la rama verde.

- [ ] **Step 1: Suites rápidas.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm lint && pnpm typecheck && pnpm check
```

- [ ] **Step 2: Unit completo.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm test
```

(Los `*.integration.test.ts` hacen `describe.runIf` sobre `TEST_DATABASE_URL`: exporta también la URL si quieres ejecutarlos aquí en vez de en el paso 3.)

- [ ] **Step 3: Base de datos y RLS.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export TEST_DATABASE_URL="postgresql://casa_admin@127.0.0.1:54329/casaclara_dev"
pnpm test:db && pnpm test:rls
pnpm --filter @casa-clara/server test
pnpm --filter @casa-clara/web test
```

- [ ] **Step 4: Presupuesto de arranque.**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
pnpm --filter @casa-clara/web build && pnpm --filter @casa-clara/web verify:bundle
```

Esperado: la construcción pasa y `verify-today-bundle.mjs` confirma que la matriz de capacidades sigue fuera del grafo inicial de Hoy.

- [ ] **Step 5: Commit de cierre solo si hubo arreglos.** Si los pasos anteriores obligaron a tocar algo, committea el arreglo con su ámbito real (`fix(web): …`, `fix(db): …`). Si no, la fase queda cerrada con el commit de la Task 9.
