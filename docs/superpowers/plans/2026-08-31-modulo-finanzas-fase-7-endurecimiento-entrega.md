# Endurecimiento, CI, documentación, despliegue y migración real — Plan de implementación (Fase 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el módulo Finanzas endurecido (a11y, e2e, dbe2e, presupuestos, seguridad), documentado (manual, skill, runbooks), ensayado de cabo a rabo en local, y solo entonces —con confirmación explícita de Alberto— migrar los datos reales a producción y retirar el sistema antiguo.

**Architecture:** Esta fase no añade features: cierra la cobertura de pruebas de las fases 1–6 (axe en la suite crítica, e2e de las 7 pantallas, dbe2e de concesión e importación), refuerza los gates de CI y de presupuesto de arranque, y actualiza la documentación operativa. La mitad final es procedimiento: ensayo local completo de la migración contra Docker y, tras la puerta de producción, la migración real contra Supabase y la retirada de `cf-finanzas`.

**Tech Stack:** Playwright (`@playwright/test`, `@axe-core/playwright`), vitest, Postgres 18.4 en Docker, GitHub Actions (`.github/workflows/ci.yml`), Lighthouse CI (`@lhci/cli`), Node 24, pnpm.

**Spec:** /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md
**Interfaces:** /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas/docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md

## Global Constraints

- Trabajar SOLO dentro del worktree `/home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas` (rama `worktree-modulo-finanzas`); el repo `/home/abf/github/home-finance` es solo-lectura (fuente a portar).
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

## Regla de oro de esta fase

**Las tareas 1–12 son locales y deben estar TODAS en verde antes de tocar producción.** Las tareas 13, 14 y 15 actúan sobre Supabase, sobre el contenedor `cf-finanzas` y sobre el repo `home-finance`: cada una está marcada **«REQUIERE CONFIRMACIÓN EXPLÍCITA DE ALBERTO ANTES DE EJECUTAR»** y ninguna puede empezar sin (a) la tarea 12 cerrada en verde y (b) un mensaje de Alberto autorizando ESA tarea concreta. Si falta cualquiera de las dos cosas, el trabajo de esta fase termina en la tarea 12.

---

### Task 1: Axe en la suite crítica — Dashboard, Movimientos y Analítica

**Files:**
- Modify: `apps/web/e2e/critical.a11y.ts`
- Modify (solo lo que señale axe en el Step 4): `apps/web/src/lib/components/finance/*.svelte` (típicamente `LedgerTable.svelte`, `PivotTable.svelte`, `CashflowChart.svelte`, `NatureStackChart.svelte`, `CategoryBars.svelte`, `FinanceSparkline.svelte`) y las páginas de `apps/web/src/routes/h/[householdId]/finanzas/`
- Test: `apps/web/e2e/critical.a11y.ts` (la propia spec; se ejecuta con `pnpm test:a11y`)

**Interfaces:**
- Consumes: rutas `/h/[householdId]/finanzas`, `/h/[householdId]/finanzas/movimientos`, `/h/[householdId]/finanzas/analitica` (fase 4/6); modo fixture con cuenta `admin` con concesión demo (patrón `demoOrUnavailable()` de la spec §7); helpers `loginAs(page, 'admin')` y `HOUSEHOLD` de `apps/web/e2e/helpers.ts`.
- Produces: tres tests axe nuevos en la suite crítica con criterio serious/critical = 0 (spec §11).

Contexto: `critical.a11y.ts` ya cubre login, Hoy, Emergencias y la hoja «Más». El patrón a imitar es exactamente el de ese fichero: `loginAs` + `AxeBuilder` + filtro de violaciones `serious`/`critical`. La batería corre en modo fixture (sin base de datos), donde la cuenta `admin` tiene la concesión demo y las pantallas pintan datos sintéticos.

- [ ] **Step 1: Estado de partida en verde.** Ejecuta la suite actual para tener línea base:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  pnpm --filter @casa-clara/web exec playwright install chromium
  pnpm test:a11y
  ```
  Salida esperada: `4 passed` (las cuatro pruebas existentes). Si algo falla aquí, arréglalo ANTES de seguir: no es de esta tarea.
- [ ] **Step 2: Escribe las tres pruebas nuevas.** Añade al final de `apps/web/e2e/critical.a11y.ts` (mismo import de helpers, misma función `seriousViolations`):
  ```ts
  test('el Dashboard de Finanzas no tiene incidencias serias de accesibilidad', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`/h/${HOUSEHOLD}/finanzas`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('Movimientos de Finanzas no tiene incidencias serias de accesibilidad', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('Analítica de Finanzas no tiene incidencias serias de accesibilidad', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`/h/${HOUSEHOLD}/finanzas/analitica`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
  ```
- [ ] **Step 3: Ejecuta y lee el resultado.** `pnpm test:a11y`. Dos salidas posibles:
  - `7 passed` → sigue al Step 5.
  - Falla con violaciones: axe imprime en el diff del `toEqual([])` el `id` de la regla (p. ej. `color-contrast`, `button-name`, `aria-required-children`) y el `html` del nodo culpable. Ese es tu test en rojo.
- [ ] **Step 4: Corrige cada violación en su componente.** Los nodos señalados viven en `apps/web/src/lib/components/finance/*.svelte` o en las páginas de `apps/web/src/routes/h/[householdId]/finanzas/`. Correcciones concretas por regla, siempre con tokens de `apps/web/src/app.css`:
  - `color-contrast`: sustituye el color literal o el token decorativo por el token de texto de la casa que ya usa el resto de la pantalla (mira qué token usa el texto vecino que sí pasa y usa ese).
  - `button-name` / `link-name`: los botones de solo-icono (p. ej. ✎, ⇄, chips del pivot) reciben `aria-label="…"` con el verbo en español («Editar alias», «Vincular transferencia»).
  - `th-has-data-cells` / `td-headers-attr` en tablas (`LedgerTable`, `PivotTable`): cada `<th>` lleva `scope="col"` o `scope="row"`.
  - `svg-img-alt` en las gráficas SVG: `role="img"` + `<title>` descriptivo, o `aria-hidden="true"` si la información ya está en texto al lado.
  Re-ejecuta `pnpm test:a11y` tras cada corrección hasta `7 passed`. Anota la lista de ficheros que has tocado: son los que entran en el commit del Step 5, uno a uno.
- [ ] **Step 5: Commit.** Añade la spec y SOLO los ficheros de UI que corregiste en el Step 4, nombrados uno a uno (nunca `git add apps/web/src` entero: arrastraría cambios ajenos a esta tarea). Ejemplo con dos correcciones reales; sustituye por tu lista:
  ```bash
  git status --short apps/web/src   # contrasta que solo aparece lo que tocaste en el Step 4
  git add apps/web/e2e/critical.a11y.ts
  git add "apps/web/src/lib/components/finance/LedgerTable.svelte" \
          "apps/web/src/routes/h/[householdId]/finanzas/analitica/+page.svelte"
  git commit -m "test(a11y): las tres pantallas de finanzas entran en la suite crítica"
  ```
  Si el Step 4 no necesitó corregir nada, el commit lleva solo `apps/web/e2e/critical.a11y.ts`.

---

### Task 2: E2E fixture — navegación de las 7 pantallas y denegación por rol

**Files:**
- Modify: `apps/web/e2e/finanzas.e2e.ts` (lo **crea la fase 4**, Task 12; aquí se AMPLÍA: se añaden tests al final y se sustituye uno solo, el de denegación)
- Modify (solo si el Step 2 lo destapa): los `+page.server.ts` de `revision/`, `eventos/`, `importar/` y `ajustes/` bajo `apps/web/src/routes/h/[householdId]/finanzas/`, para darles rama de maqueta
- Test: `apps/web/e2e/finanzas.e2e.ts` (se ejecuta con `pnpm test:e2e`)

**Interfaces:**
- Consumes: las 7 rutas del módulo (`finanzas`, `finanzas/analitica`, `finanzas/movimientos`, `finanzas/revision`, `finanzas/eventos`, `finanzas/importar`, `finanzas/ajustes`); guard de routing de fase 1 (`MODULE_CAPABILITY.finanzas = "finance.access"`, `NESTED_ROUTE_CAPABILITY`); códigos canónicos de acceso (interfaces §Resoluciones canónicas 11: **403** en ruta declarada sin capacidad, **404** solo en ruta hija NO declarada); helpers `loginAs`/`HOUSEHOLD` que ya importa el fichero de la fase 4.
- Produces: spec e2e de navegación y denegación (spec §11: «navegación de las 7 pantallas como admin-con-concesión; 403/404 para el resto de roles»). El caso «admin **sin** concesión» NO se cubre aquí —el modo fixture da concesión demo a la cuenta `admin` y no sabe quitársela—: lo cubre la **Task 3** contra Postgres real, y esa es la trazabilidad de esa mitad de §11.

El fichero ya existe: la fase 4 lo dejó con **cuatro** tests (Dashboard con KPIs, Movimientos con panel de detalle, el de denegación para la empleada y el de ruta hija inventada con 404). Esta tarea **añade al final** y borra dos de los existentes —los dos que quedan absorbidos por los tests nuevos—, como dice el Step 1. El patrón a imitar es `apps/web/e2e/roles.e2e.ts`: navegación directa por URL, aserción del `status()` de la respuesta y del texto del guard («no está incluida en tu acceso» para 403). El 404 fail-closed de ruta hija no declarada sigue el test «una ruta hija no declarada falla cerrada con 404» de ese mismo fichero.

- [ ] **Step 1: Amplía la spec existente.** Abre `apps/web/e2e/finanzas.e2e.ts` (fase 4) y haz DOS cosas, sin tocar los tests de Dashboard y Movimientos:

  **(a) Borra los DOS tests de la fase 4 que esta tarea absorbe.** Son `la empleada no alcanza Finanzas: 403 en ruta declarada sin capacidad` —lo absorbe el bucle de cuatro roles del apartado (b), que cubre a la empleada y a tres roles más— y `una ruta hija inventada de Finanzas sí es 404` —lo absorbe el test de `/finanzas/privado` del apartado (b)—. **No toques los de Dashboard y Movimientos.** El contrato es el canónico (interfaces §Resoluciones canónicas 11): 403 para capacidad ausente en ruta declarada —`finanzas` SÍ está declarado en `HOUSEHOLD_MODULES`/`MODULE_CAPABILITY`— y 404 solo para ruta hija NO declarada. Un 404 para la empleada en `/h/<hogar>/finanzas` es un bug del guard, no un contrato.

  **(b) Añade al final del fichero** el bloque `SCREENS` y los tests nuevos. **No repitas los imports** (`@playwright/test` y `./helpers` ya están arriba) ni redeclares `HOUSEHOLD`/`loginAs`:
  ```ts
  const SCREENS = [
    'finanzas',
    'finanzas/analitica',
    'finanzas/movimientos',
    'finanzas/revision',
    'finanzas/eventos',
    'finanzas/importar',
    'finanzas/ajustes'
  ] as const;

  test('la administración con concesión recorre las siete pantallas de Finanzas', async ({ page }) => {
    await loginAs(page, 'admin');
    for (const screen of SCREENS) {
      const response = await page.goto(`/h/${HOUSEHOLD}/${screen}`);
      expect(response?.status(), `${screen} debería responder 200`).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  });

  for (const account of ['family', 'employee', 'helper', 'viewer'] as const) {
    test(`la cuenta ${account} no alcanza Finanzas por URL directa`, async ({ page }) => {
      await loginAs(page, account);
      const module = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
      expect(module?.status()).toBe(403);
      await expect(page.locator('body')).toContainText('no está incluida en tu acceso');
      const child = await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
      expect(child?.status()).toBe(403);
    });
  }

  test('una ruta hija de Finanzas no declarada falla cerrada con 404', async ({ page }) => {
    await loginAs(page, 'admin');
    const response = await page.goto(`/h/${HOUSEHOLD}/finanzas/privado`);
    expect(response?.status()).toBe(404);
  });
  ```
- [ ] **Step 2: Ejecuta y lee el resultado.**
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  pnpm test:e2e
  ```
  Salida esperada: todas las specs `*.e2e.ts` en verde. El fichero queda con 8 tests: los 2 de la fase 4 que se conservan (Dashboard y Movimientos) y los 6 de esta tarea (el recorrido de las siete pantallas, los cuatro roles denegados y la ruta hija no declarada). Si ves 9 o 10, es que no borraste los dos tests que indica el Step 1(a). Cómo leer los dos fallos posibles:
  - **Un rol recibe un código distinto del esperado** (p. ej. 404 donde el test espera 403): NO ajustes el test a ciegas. El contrato canónico es 403 para capacidad ausente en ruta declarada y 404 para ruta no declarada (interfaces §Resoluciones canónicas 11); comprueba qué declara `NESTED_ROUTE_CAPABILITY` en `apps/web/src/lib/auth/routing.ts` y qué hace el guard de `apps/web/src/routes/h/[householdId]/+layout.server.ts`, y corrige el lado que viola el contrato.
  - **Una pantalla del bucle no responde 200 sino el estado de datos no disponibles** (`DATA_UNAVAILABLE_STATUS` de `apps/web/src/lib/server/data-source.server.ts`): eso pasa con `revision`, `eventos`, `importar` y `ajustes`, que son pantallas de la fase 5 cuya única cobertura de navegador era dbe2e. Significa que su `load` no tiene rama de maqueta. **Se añade la rama `demoOrUnavailable()` allí**, con su fixture, exactamente como las pantallas de la fase 4; nunca se relaja esta aserción ni se saca la ruta de `SCREENS`.
- [ ] **Step 3: Commit.**
  ```bash
  git add apps/web/e2e/finanzas.e2e.ts
  git commit -m "test(e2e): las siete pantallas de finanzas y su denegación por rol"
  ```
  Si el Step 2 obligó a añadir la rama de maqueta a algún `load` de la fase 5, ese arreglo va en un commit aparte y anterior, con sus ficheros nombrados:
  ```bash
  git add "apps/web/src/routes/h/[householdId]/finanzas/revision/+page.server.ts"
  git commit -m "fix(finanzas): revisión también pinta la maqueta en modo fixture"
  ```

---

### Task 3: dbe2e — conceder y revocar cambia lo visible, con acuse de comando

**Files:**
- Create: `apps/web/e2e/finanzas-concesion.dbe2e.ts`
- Test: `apps/web/e2e/finanzas-concesion.dbe2e.ts` (se ejecuta con `pnpm test:e2e:db`)

**Interfaces:**
- Consumes: comandos `finance.grant.write` y `finance.revoke.write` por `POST /api/v1/sync` (emitidos por la tarjeta «Finanzas» de `/h/[householdId]/settings`, fase 1/5); fixture `packages/db/fixtures/002_finance.sql` (concesión viva SOLO para el admin de roble, que es la cuenta `admin` de la batería, membresía `11000000-0000-4000-8000-000000000001`); `app.finance_enabled()` en RLS.
- Produces: spec dbe2e de «concesión/revocación cambiando lo visible» con acuse veraz de comandos (spec §11).

La batería dbe2e corre contra Postgres real con RLS (config `apps/web/playwright.db.config.ts`, un solo worker, sin paralelismo: el estado se comparte entre specs, así que esta spec DEBE dejar la concesión como la encontró).

- [ ] **Step 1: Ancla los selectores a la tarjeta real.** Lee el markup de la tarjeta de concesiones para copiar los nombres accesibles exactos de sus botones:
  ```bash
  grep -rn "Finanzas" apps/web/src/routes/h/\[householdId\]/settings/ | head -20
  ```
  Abre el fichero que aparezca y anota: el heading de la tarjeta (se espera «Finanzas»), el verbo del botón de revocar (se espera «Revocar») y el de conceder (se espera «Conceder»). Si difieren, usa los reales en el Step 2 — los verbos vienen de la spec §4 («interruptor conceder/revocar»), así que una divergencia grande es un bug de la fase 1, no de esta spec.
- [ ] **Step 2: Escribe la spec** en `apps/web/e2e/finanzas-concesion.dbe2e.ts`:
  ```ts
  import { expect, test } from '@playwright/test';

  import { HOUSEHOLD, loginAs } from './helpers';

  test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

  // Conceder y revocar son comandos por /api/v1/sync (finance.grant.write /
  // finance.revoke.write, exigen access.manage + rol admin del emisor). La
  // fixture 002_finance.sql deja concesión viva solo al admin de roble = la
  // cuenta `admin` de esta batería, que es la ÚNICA concesión viva de la base
  // compartida. La batería corre con workers: 1 y sin paralelismo, así que si
  // esta spec terminara con la concesión revocada envenenaría a todas las
  // specs de finanzas posteriores (finanzas-importar, finanzas-revision).
  // Por eso el afterEach de abajo repone la concesión pase lo que pase,
  // incluso si el cuerpo del test se rompe a mitad.
  test.afterEach(async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`/h/${HOUSEHOLD}/settings`);
    const card = page.locator('section', { has: page.getByRole('heading', { name: 'Finanzas' }) });
    const conceder = card.getByRole('button', { name: /Conceder/ }).first();
    if (await conceder.count()) {
      await conceder.click();
      await expect(card.getByRole('button', { name: /Revocar/ }).first()).toBeVisible();
    }
    const restored = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
    expect(restored?.status(), 'la concesión debe quedar como estaba para las specs siguientes').toBe(200);
  });

  test('revocar y devolver la concesión cambia lo que la administración ve', async ({ page }) => {
    await loginAs(page, 'admin');

    // Con concesión viva el módulo responde.
    const before = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
    expect(before?.status()).toBe(200);

    // Revocarse a sí misma desde la tarjeta «Finanzas» de Ajustes.
    await page.goto(`/h/${HOUSEHOLD}/settings`);
    const card = page.locator('section', { has: page.getByRole('heading', { name: 'Finanzas' }) });
    await card.getByRole('button', { name: /Revocar/ }).first().click();
    // Acuse del comando: el interruptor pasa a ofrecer «Conceder».
    await expect(card.getByRole('button', { name: /Conceder/ }).first()).toBeVisible();

    // Sin concesión: 403 aunque el rol siga siendo family_admin (doble cerrojo).
    const denied = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
    expect(denied?.status()).toBe(403);
    // Y la navegación deja de ofrecer el módulo.
    await page.goto(`/h/${HOUSEHOLD}/today`);
    await expect(page.getByRole('link', { name: 'Finanzas' })).toHaveCount(0);

    // La tarjeta sigue siendo legible y operable para cualquier admin
    // (finance_module_grants no exige concesión): se la devuelve.
    await page.goto(`/h/${HOUSEHOLD}/settings`);
    const cardAgain = page.locator('section', { has: page.getByRole('heading', { name: 'Finanzas' }) });
    await cardAgain.getByRole('button', { name: /Conceder/ }).first().click();
    await expect(cardAgain.getByRole('button', { name: /Revocar/ }).first()).toBeVisible();

    const restored = await page.goto(`/h/${HOUSEHOLD}/finanzas`);
    expect(restored?.status()).toBe(200);
  });
  ```
- [ ] **Step 3: Ejecuta contra el Postgres local.** `E2E_DATABASE_URL` se exporta SIEMPRE de forma explícita (interfaces §Resoluciones canónicas 15): el valor por omisión de `test:e2e:db` en `apps/web/package.json` apunta a `127.0.0.1:54329`, puerto prohibido en esta máquina porque lo ocupa la base embebida de Paperclip, otra aplicación. El `globalSetup` recrea esquema y fixtures sobre la base a la que apunte esa variable, así que un descuido aquí migra encima de datos ajenos:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  docker start casaclara-it-pg 2>/dev/null || true
  export E2E_DATABASE_URL='postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u'
  pnpm test:e2e:db
  ```
  Salida esperada: toda la batería `*.dbe2e.ts` en verde, incluida esta spec. Si el botón de conceder no existe tras revocarse (auto-concesión bloqueada), eso contradice la spec §4 —la tarjeta lista TODAS las membresías admin con interruptor y el comando solo exige `access.manage` + rol admin— y se corrige en el handler, no en el test.
- [ ] **Step 4: Commit.**
  ```bash
  git add apps/web/e2e/finanzas-concesion.dbe2e.ts
  git commit -m "test(dbe2e): conceder y revocar finanzas cambia lo visible bajo RLS"
  ```

---

### Task 4: dbe2e — el ciclo de importación, ampliado con la vista de Movimientos bajo RLS

**Files:**
- Modify: `apps/web/e2e/finanzas-importar.dbe2e.ts` (lo **crea la fase 5**, Task 12, con el ciclo previsualizar→confirmar→deshacer ya escrito y verde; aquí se AÑADE un test al final, sin tocar el existente)
- Test: `apps/web/e2e/finanzas-importar.dbe2e.ts` (se ejecuta con `pnpm test:e2e:db`)

**Interfaces:**
- Consumes: la spec de la fase 5 y sus constantes de módulo, en particular `OPENBANK_HTML` (extracto sintético construido **en memoria**: interfaces §Resoluciones canónicas 14 — las muestras se GENERAN por código, nunca hay binarios de extractos en git); `POST /api/v1/finance/imports/preview` y `POST /api/v1/finance/imports/confirm` vía la pantalla Importar (fase 5); comando `finance.import.undo`; pantalla Movimientos y filtros de URL `from`/`to`/`q` (fase 4).
- Produces: la mitad que le faltaba a §11 sobre el ciclo de importación — que lo importado **se ve en Movimientos bajo RLS** y que el deshacer lo deja en cero —, sin duplicar el ciclo que ya cubre la fase 5.

El fichero ya existe y está verde: la fase 5 escribió ahí `importar: previsualizar, dar de alta la cuenta, confirmar y deshacer`, con los selectores reales de su pantalla («Nombre de la cuenta nueva», «Confirmar importación», acuses «2 nuevas» / «Importadas 2») y el manejo del `dialog` de confirmación del deshacer. **No se reescribe: se amplía.** La spec §11 pedía además la comprobación de extremo a extremo de que los movimientos importados existen para el usuario autorizado y desaparecen al deshacer; eso es lo que añade esta tarea.

- [ ] **Step 1: Lee la spec de la fase 5 y ancla lo que vas a reutilizar.**
  ```bash
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  cat apps/web/e2e/finanzas-importar.dbe2e.ts
  ```
  Anota tres cosas: (a) el nombre exacto de la constante del extracto sintético (se espera `OPENBANK_HTML`, con dos movimientos de julio de 2026, uno de ellos con el concepto `TRANSFERENCIA A FAVOR DE CLARA DEMO, CONCEPTO ALQUILER JULIO`); (b) los literales de los botones («Confirmar importación», «Deshacer») y del campo de cuenta nueva («Nombre de la cuenta nueva»); (c) que el deshacer abre un `dialog` del navegador y la spec lo acepta con `page.once('dialog', …)`. El test nuevo reutiliza los tres tal cual: si algún literal difiere del esperado, usa el real del fichero.
- [ ] **Step 2: Añade el test al final del fichero**, sin repetir imports ni redeclarar `OPENBANK_HTML` (ya está en el módulo), y con un `afterEach` que garantice el deshacer aunque el test se rompa a mitad — la batería dbe2e comparte base entre specs:
  ```ts
  // Ampliación de la fase 7: lo importado tiene que VERSE en Movimientos bajo
  // RLS, y el deshacer tiene que dejarlo en cero. El ciclo de importación en sí
  // ya lo cubre el test de arriba (fase 5): aquí solo se comprueba el efecto
  // sobre los datos que ve la administración con concesión.
  const MOVIMIENTOS_JULIO = `/h/${HOUSEHOLD}/finanzas/movimientos?from=2026-07-01&to=2026-07-31&q=ALQUILER+JULIO`;

  async function deshacerSiQueda(page: import('@playwright/test').Page) {
    await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
    const fila = page.locator('tr', { hasText: 'movimientos-e2e.xls' });
    if (await fila.count()) {
      page.once('dialog', (dialog) => void dialog.accept());
      await fila.first().getByRole('button', { name: 'Deshacer' }).click();
      await expect(page.locator('tr', { hasText: 'movimientos-e2e.xls' })).toHaveCount(0);
    }
  }

  test.describe('lo importado se ve y el deshacer lo borra', () => {
    test.afterEach(async ({ page }) => {
      await loginAs(page, 'admin');
      await deshacerSiQueda(page);
    });

    test('los movimientos del lote aparecen en Movimientos y desaparecen al deshacer', async ({ page }) => {
      await loginAs(page, 'admin');

      // Punto de partida: el hogar no tiene todavía el movimiento del extracto.
      await page.goto(MOVIMIENTOS_JULIO);
      await expect(page.locator('.finance-ledger .finance-row')).toHaveCount(0);

      // Importar el mismo extracto sintético de la fase 5 (en memoria, sin
      // ficheros binarios en el repo).
      await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
      await page.setInputFiles('input[type="file"]', {
        name: 'movimientos-e2e.xls',
        mimeType: 'application/vnd.ms-excel',
        buffer: Buffer.from(OPENBANK_HTML, 'latin1')
      });
      await expect(page.locator('body')).toContainText('2 nuevas');

      // El alta de cuenta es condicional a propósito: el test de la fase 5 corre
      // antes en este mismo fichero y su deshacer borra el lote y sus
      // transacciones, pero la cuenta «OpenBank E2E» que dio de alta se queda.
      // Si ya existe, la previsualización no pide crearla y no hay formulario.
      const nombreCuenta = page.getByLabel('Nombre de la cuenta nueva');
      if (await nombreCuenta.count()) {
        await nombreCuenta.fill('OpenBank E2E');
      }

      await page.getByRole('button', { name: 'Confirmar importación' }).click();
      await expect(page.locator('.success-message')).toContainText('Importadas 2');

      // El movimiento existe para la administración con concesión: RLS lo deja pasar.
      await page.goto(MOVIMIENTOS_JULIO);
      const filas = page.locator('.finance-ledger .finance-row');
      await expect(filas).toHaveCount(1);
      await expect(filas.first()).toContainText('ALQUILER JULIO');

      // Deshacer: el lote se va con sus transacciones (ON DELETE CASCADE).
      await deshacerSiQueda(page);
      await page.goto(MOVIMIENTOS_JULIO);
      await expect(page.locator('.finance-ledger .finance-row')).toHaveCount(0);
    });
  });
  ```
- [ ] **Step 3: Ejecuta.** `E2E_DATABASE_URL` explícita siempre (interfaces §Resoluciones canónicas 15: el valor por omisión de `apps/web/package.json` apunta al puerto 54329, prohibido en esta máquina — lo ocupa la base embebida de Paperclip):
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  docker start casaclara-it-pg 2>/dev/null || true
  export E2E_DATABASE_URL='postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u'
  pnpm test:e2e:db
  ```
  Salida esperada: batería en verde, con los dos tests de este fichero (el de la fase 5 y el nuevo). El `afterEach` deshace siempre, así que las specs vecinas no ven residuos. Si la previsualización marca las dos filas como duplicadas en vez de nuevas, es que un lote anterior quedó sin deshacer: ejecuta de nuevo la batería completa (el `globalSetup` recrea esquema y fixtures) y comprueba que el `afterEach` está donde debe.
- [ ] **Step 4: Commit.**
  ```bash
  git add apps/web/e2e/finanzas-importar.dbe2e.ts
  git commit -m "test(dbe2e): lo importado se ve en movimientos y el deshacer lo borra"
  ```

---

### Task 5: Cableado final de CI — el inventario de suites alcanza los ficheros de finanzas

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: `scripts/ci/assert-suite-coverage.py` ejecutado en local con evidencia JUnit real

**Interfaces:**
- Consumes: `scripts/ci/assert-suite-coverage.py` (contrato `--specs 'BASE::GLOB'`, glob con `recursive=True`); informes JUnit de vitest (nombre de `testsuite` relativo a la raíz del workspace) y de Playwright (relativo a `testDir`).
- Produces: gate `suite-coverage` capaz de inventariar `packages/server/src/finance/*.test.ts` y cualquier test anidado futuro; constancia de que las specs nuevas de las tareas 1–4 ya quedan cubiertas por los globs existentes.

Contexto: el job `suite-coverage` de `.github/workflows/ci.yml` inventaría `packages/server::src/*.test.ts` y `apps/web::tests/*.test.ts`. En Python, `glob` sin `**` NO desciende a subdirectorios: los tests de `packages/server/src/finance/` (fase 2) correrían en el job `integration` pero quedarían FUERA del inventario del gate — exactamente el agujero que ese gate existe para cerrar, y el que la fase 4 daba por cerrado sin estarlo. Las specs de Playwright del módulo —`finanzas.e2e.ts` (creada en la fase 4, ampliada en la Task 2), `finanzas-importar.dbe2e.ts` (creada en la fase 5, ampliada en la Task 4), `finanzas-concesion.dbe2e.ts` (nueva, Task 3) y las pruebas añadidas a `critical.a11y.ts` (Task 1)— SÍ las cubren ya los globs `apps/web/e2e::*.e2e.ts` / `*.dbe2e.ts` / `*.a11y.ts`: ahí no hay nada que tocar. El inventario va por fichero, así que ampliar una spec existente no cambia nada del gate.

- [ ] **Step 1: Demuestra el agujero (rojo).**
  ```bash
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  python3 - <<'PY'
  import glob
  plano = sorted(glob.glob('packages/server/src/*.test.ts'))
  recursivo = sorted(glob.glob('packages/server/src/**/*.test.ts', recursive=True))
  fuera = [p for p in recursivo if p not in plano]
  print('Fuera del inventario actual:', *fuera, sep='\n  ')
  assert any('finance' in p for p in fuera), 'no hay tests de finanzas anidados: revisa la fase 2'
  PY
  ```
  Salida esperada: la lista de tests bajo `packages/server/src/finance/` que el gate actual no ve.
- [ ] **Step 2: Corrige los dos globs en `.github/workflows/ci.yml`** (paso «Every Vitest file of web, server and worker must have run» del job `suite-coverage`). Cambia exactamente estas dos líneas:
  - `--specs 'apps/web::tests/*.test.ts'` → `--specs 'apps/web::tests/**/*.test.ts'`
  - `--specs 'packages/server::src/*.test.ts'` → `--specs 'packages/server::src/**/*.test.ts'`
  (`**` con `recursive=True` también casa la raíz, así que los ficheros planos actuales siguen inventariados.)
- [ ] **Step 3: Verde local del gate de vitest.** Genera la evidencia del server (su vitest ya escribe JUnit en `artifacts/unit/`, es lo que recoge CI) y pásale el gate con el glob nuevo:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  export TEST_DATABASE_URL='postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u'
  pnpm --filter @casa-clara/server test
  python3 scripts/ci/assert-suite-coverage.py \
    --label 'suites de vitest del server' \
    --specs 'packages/server::src/**/*.test.ts' \
    --junit 'artifacts/unit/*.xml'
  ```
  Salida esperada: `Cobertura de suites de vitest del server: N/N ficheros con casos ejecutados.` y código de salida 0. Si algún test de finanzas aparece como «no ejecutado», el nombre de su `testsuite` en el JUnit no coincide con la ruta: mira el XML en `artifacts/unit/` y corrige el glob, nunca el gate.
- [ ] **Step 4: Verde local del gate de Playwright** (confirma que las specs de las tareas 1–4 quedan inventariadas). Con las baterías ya ejecutadas en las tareas 2–4 (sus JUnit viven en `artifacts/e2e/`):
  ```bash
  python3 scripts/ci/assert-suite-coverage.py \
    --label 'specs de Playwright' \
    --specs 'apps/web/e2e::*.e2e.ts' \
    --specs 'apps/web/e2e::*.dbe2e.ts' \
    --specs 'apps/web/e2e::*.a11y.ts' \
    --junit 'artifacts/e2e/*.xml'
  ```
  Salida esperada: `Cobertura de specs de Playwright: N/N ficheros con casos ejecutados.` Si falta alguno, re-ejecuta la batería que lo produce (`pnpm test:e2e`, `pnpm test:a11y`, `pnpm test:e2e:db`) y repite.
- [ ] **Step 5: Commit.**
  ```bash
  git add .github/workflows/ci.yml
  git commit -m "ci(cobertura): el inventario de vitest desciende a los tests anidados de finanzas"
  ```

---

### Task 6: Presupuestos — finanzas desterrado del arranque de Hoy y Lighthouse en verde

**Files:**
- Modify: `apps/web/scripts/verify-today-bundle.mjs`
- Modify (solo si el Step 5 lo exige): los `apps/web/src/lib/components/finance/*.svelte` que animen sin bloque `prefers-reduced-motion`
- Test: `pnpm --filter @casa-clara/web verify:bundle` y `pnpm test:lighthouse`

**Interfaces:**
- Consumes: `apps/web/src/lib/finance/filters.ts` (módulo cliente de finanzas, fase 4) y `apps/web/src/lib/components/finance/LedgerTable.svelte` (componente representativo, fase 4) como los dos ids vigilados; la lista `FORBIDDEN_IN_INITIAL_GRAPH` de `verify-today-bundle.mjs`; `infra/quality/lighthouserc.json` (LCP ≤ 2000 ms, TBT ≤ 200 ms, script ≤ 122880 bytes, a11y = 1).
- Produces: guarda permanente que hace fallar la build si cualquier módulo o componente de finanzas alcanza el grafo inicial de Hoy, y la comprobación de `prefers-reduced-motion` del módulo (spec §8 «Presupuestos»).

- [ ] **Step 1: Comprueba a mano que nada fuera del módulo importa finanzas** (la fuga típica sería un import estático desde el AppShell o el layout). El grep busca las DOS formas del import — `$lib/finance/*` y `$lib/components/finance/*` —, porque un componente arrastra tanto como un módulo:
  ```bash
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  grep -rn "lib/finance\|components/finance" apps/web/src --include='*.svelte' --include='*.ts' \
    | grep -v 'src/lib/finance/' \
    | grep -v 'src/lib/components/finance/' \
    | grep -v 'routes/h/\[householdId\]/finanzas' \
    | grep -v 'routes/api/v1/finance' \
    | grep -v 'routes/h/\[householdId\]/settings'
  ```
  Salida esperada: vacía. Cada línea que aparezca es una fuga: muévela a la ruta de finanzas o hazla import dinámico antes de seguir.

  **La excepción de `settings` es deliberada y está documentada aquí para que nadie la «arregle»:** la tarjeta «Finanzas» de concesiones vive en los Ajustes del hogar por diseño (contrato de interfaces: «`src/routes/h/[householdId]/settings/` (modificar): tarjeta «Finanzas» de concesiones»), así que la fase 1 importa allí `grantFinanceAccess`/`revokeFinanceAccess` de `$lib/finance/commands`. Ese import es legítimo: Ajustes no está en el grafo de arranque de Hoy, y quien decide de verdad si algo llega a ese grafo es `verify-today-bundle.mjs`, que mide alcanzabilidad real, no este grep. Si aparece cualquier OTRA ruta fuera de la lista, sí es fuga.
- [ ] **Step 2: Construye y averigua los ids exactos en el mapa de trozos** (la forma del id es la que compara la guarda tras `normalize`). Vigilamos dos módulos representativos: uno de lógica y uno de componente, porque las dos rutas de fuga son distintas:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  pnpm --filter @casa-clara/web build
  grep -o '"[^"]*finance/filters[^"]*"' apps/web/.svelte-kit/casa-clara-module-map.json | head -1
  grep -o '"[^"]*components/finance/LedgerTable[^"]*"' apps/web/.svelte-kit/casa-clara-module-map.json | head -1
  ```
  Anota los dos ids (se esperan `src/lib/finance/filters.ts` y `src/lib/components/finance/LedgerTable.svelte`; si salen con otro prefijo, usa el que salga sin los `../` iniciales, que `normalize` ya los quita).
- [ ] **Step 3: Añade las DOS reglas a `FORBIDDEN_IN_INITIAL_GRAPH`** en `apps/web/scripts/verify-today-bundle.mjs`, tras la regla existente de `capabilities.ts` y con su mismo idioma (el porqué dentro del mensaje):
  ```js
  {
    module: 'src/lib/finance/filters.ts',
    why:
      'nada de Finanzas puede tocar el arranque de Hoy: el módulo entero vive en los chunks\n' +
      '    de sus rutas (/h/[householdId]/finanzas) y SheetJS es solo-servidor. Si este módulo\n' +
      '    aparece aquí, una importación estática desde el layout o desde Hoy lo está\n' +
      '    arrastrando por alcanzabilidad: hazla dinámica o devuélvela a la ruta de finanzas.'
  },
  {
    module: 'src/lib/components/finance/LedgerTable.svelte',
    why:
      'los componentes de Finanzas tampoco entran en el arranque de Hoy. Esta regla cubre la\n' +
      '    otra puerta de fuga: un componente del módulo importado estáticamente desde AppShell,\n' +
      '    desde el layout del hogar o desde una tarjeta de Hoy. Si aparece aquí, hazlo import\n' +
      '    dinámico dentro de la ruta de finanzas; nunca subas el presupuesto para taparlo.'
  }
  ```
- [ ] **Step 4: Verde del presupuesto.**
  ```bash
  pnpm --filter @casa-clara/web verify:bundle
  ```
  Salida esperada: `Today initial graph: N files, M bytes (K de margen sobre 120000); WikiEditor remains route-lazy.` sin excepción. Si la regla nueva dispara, la propia excepción nombra los bytes y el porqué: arregla la fuga (Step 1) y repite.
- [ ] **Step 5: `prefers-reduced-motion` respetado en todo lo que se mueve** (spec §8: es un presupuesto más, y la auditoría axe de la Task 1 no lo cubre). Lo que se mueve en este módulo son el toast con Deshacer y el fantasma del arrastrar-y-soltar del pivot (fase 6) y las transiciones de las gráficas (fase 4):
  ```bash
  grep -rn "transition\|animation" apps/web/src/lib/components/finance --include='*.svelte' | grep -v 'prefers-reduced-motion'
  grep -rln "prefers-reduced-motion" apps/web/src/lib/components/finance
  ```
  Criterio: todo fichero de `components/finance` que aparezca en el primer grep tiene que aparecer también en el segundo. El arreglo, dentro del `<style>` del componente que falte, con la misma forma que ya usa el repertorio de la casa:
  ```css
  @media (prefers-reduced-motion: reduce) {
    .toast, .pivot-ghost { transition: none; animation: none; }
  }
  ```
  Si el componente que falta es del toast o del arrastre (fase 6), el arreglo va ahí, en su componente, no en una hoja global.
- [ ] **Step 6: Lighthouse.**
  ```bash
  pnpm test:lighthouse
  ```
  Salida esperada: las cuatro aserciones de `infra/quality/lighthouserc.json` en verde sobre `/login` y `/offline` (finanzas no toca esas rutas: si algo falla aquí es una regresión del arranque, no del módulo — diagnostica con el informe de `artifacts/lighthouse`).
- [ ] **Step 7: Commit.**
  ```bash
  git add apps/web/scripts/verify-today-bundle.mjs
  git commit -m "build(presupuestos): finanzas queda desterrado del arranque de Hoy por guarda"
  ```
  Si el Step 5 obligó a añadir bloques `prefers-reduced-motion`, van en su propio commit con los componentes nombrados:
  ```bash
  git add "apps/web/src/lib/components/finance/PivotTable.svelte"
  git commit -m "fix(finanzas): respetar prefers-reduced-motion en el pivot y el toast"
  ```

---

### Task 7: Revisión de seguridad del módulo, con evidencia ejecutada

**Files:**
- Create: `docs/security/revision-finanzas.md`
- Test: los comandos de verificación del propio documento (cada uno con su salida esperada)

**Interfaces:**
- Consumes: `app.finance_enabled()` y las políticas RLS de `0034_finance.sql`; `requireFinanceAdmin` de `packages/server/src/commands/finance.ts`; los helpers que lo aplican en la web —`financeRead` de `apps/web/src/lib/server/finance.server.ts` (fase 4) y `previewImport`/`confirmImport` de `apps/web/src/lib/server/finance-imports.server.ts` (fase 5)—; los endpoints `GET/POST /api/v1/finance/*`; suites `pnpm test:db` (tests/010: ninguna tabla sin RLS) y `pnpm test:rls` (020 + `tests/030_finance_rls.sql`).
- Produces: la revisión de seguridad de la spec §10, como checklist ejecutada y fechada (patrón de documento: `docs/security/security-baseline.md`, secciones cortas con controles verificables).

- [ ] **Step 1: Ejecuta las cinco comprobaciones y guarda las salidas.** Desde la raíz del worktree, con las variables exportadas (sin `TEST_DATABASE_URL`, `run-sql-tests.mjs` aborta con «TEST_DATABASE_URL or DATABASE_URL is required»):
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  docker start casaclara-it-pg 2>/dev/null || true
  export TEST_DATABASE_URL='postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u'
  ```
  1. RLS automática y matriz negativa: `pnpm test:db && pnpm test:rls` → todas las suites en verde (010 cubre las 10 tablas `finance_*`; la suite de RLS de finanzas es la matriz de doble cerrojo: admin-con-concesión ve, admin-sin-concesión 0 filas, los otros 4 roles 0 filas, cero fugas roble↔olivo, suplantación 42501).
  2. **Ningún endpoint REST sin cerrojo.** El cerrojo está centralizado a propósito: los GET pasan por `financeRead` (`apps/web/src/lib/server/finance.server.ts`) y los POST de importación por `previewImport`/`confirmImport` (`apps/web/src/lib/server/finance-imports.server.ts`), y son esos tres helpers los que llaman a `requireFinanceAdmin` dentro de la transacción autorizada. Por eso NO se busca `requireFinanceAdmin` dentro de cada `+server.ts` —ninguno lo contiene, y buscarlo daría un falso positivo por endpoint—: se comprueba que todos pasan por uno de los tres helpers, y que los tres tienen el cerrojo.
     ```bash
     # (a) El find tiene que devolver ficheros; si devuelve cero, el control ha fallado
     #     (directorio movido o renombrado), no está verde.
     find apps/web/src/routes/api/v1/finance -name '+server.ts' | wc -l   # ≥ 9 endpoints esperados
     # (b) Ninguno fuera de los tres helpers autorizados. El -print0/-r evita que
     #     grep se quede colgado leyendo de la entrada estándar con la lista vacía.
     find apps/web/src/routes/api/v1/finance -name '+server.ts' -print0 \
       | xargs -0 -r grep -LE "financeRead|previewImport|confirmImport"
     # (c) Y los tres helpers sí llaman al cerrojo.
     grep -n "requireFinanceAdmin" apps/web/src/lib/server/finance.server.ts
     grep -n "requireFinanceAdmin" apps/web/src/lib/server/finance-imports.server.ts
     ```
     Criterio: (a) ≥ 1 fichero, (b) salida vacía, (c) al menos una línea en cada uno. Cualquier `+server.ts` que aparezca en (b) es un agujero real —hace su propia consulta sin pasar por el cerrojo— y se corrige antes de cerrar la tarea; el arreglo es hacerlo pasar por el helper, jamás duplicar el `requireFinanceAdmin` en la ruta.
  3. Ningún comando sin cerrojo, y grant/revoke con `access.manage`: `grep -c "requireFinanceAdmin" packages/server/src/commands/finance.ts` → ≥ 1; `grep -n "access.manage" packages/server/src/commands/finance.ts` → aparece en los handlers de `finance.grant.write` y `finance.revoke.write`.
  4. Los extractos no se persisten: `grep -rn "writeFile\|createWriteStream\|putObject\|storage" apps/web/src/routes/api/v1/finance packages/server/src/finance --include='*.ts' | grep -v '\.test\.'` → salida vacía (el multipart se procesa en memoria, spec §10).
  5. **Ningún dato real en el repo.** Lo que se comprueba es que no hay DATOS, no que no haya menciones: el runbook de la fase 3 nombra `/home/abf/github/home-finance/backend/data/finanzas.db` en prosa varias veces, y eso es documentación legítima que no se toca.
     ```bash
     git ls-files | grep -Ei '\.(db|sqlite|sqlite3|xls|xlsx|csv)$'   # esperado: vacío
     git grep -n "finanzas\.db" -- ':!docs/'                          # esperado: vacío
     ```
     Criterio: las dos salidas vacías. Más la revisión manual de que las muestras sintéticas de `packages/server/src/finance/parsers/synthetic-samples.ts` usan titulares e importes inventados (anota los ficheros revisados). Las menciones en prosa dentro de `docs/` (runbooks, esta misma revisión) son esperadas y se documentan como tales en la tabla.
- [ ] **Step 2: Escribe `docs/security/revision-finanzas.md`** con esta estructura (rellena cada «Resultado» con la salida real y la fecha):
  ```markdown
  # Revisión de seguridad del módulo Finanzas

  Fecha: <fecha de ejecución> · Revisión sobre la rama `worktree-modulo-finanzas`.
  Complementa a [security-baseline.md](security-baseline.md); el diseño del doble
  cerrojo está en la spec del módulo (§4 y §10).

  ## Controles verificados

  | # | Control | Cómo se verifica | Resultado |
  |---|---|---|---|
  | 1 | RLS en todas las tablas `finance_*` y matriz negativa de doble cerrojo | `pnpm test:db && pnpm test:rls` (con `TEST_DATABASE_URL` exportada) | <verde, suites y fecha> |
  | 2 | Todos los endpoints `/api/v1/finance/*` exigen sesión + membresía + `requireFinanceAdmin`, por los helpers `financeRead` / `previewImport` / `confirmImport` | `find … -print0 \| xargs -0 -r grep -LE "financeRead\|previewImport\|confirmImport"` vacío, con `find … \| wc -l` ≥ 9, más `grep -n requireFinanceAdmin` en `finance.server.ts` y `finance-imports.server.ts` | <nº de endpoints, vacío, líneas del cerrojo> |
  | 3 | Todos los comandos `finance.*` pasan por `requireFinanceAdmin`; `grant/revoke` exigen además `access.manage` | greps sobre `packages/server/src/commands/finance.ts` | <líneas encontradas> |
  | 4 | Los extractos subidos no se persisten en ningún almacenamiento | grep de escrituras en los caminos de importación, vacío | <vacío> |
  | 5 | Ningún dato bancario real en el repositorio | `git ls-files \| grep -Ei '\.(db\|sqlite\|xls\|xlsx\|csv)$'` vacío + `git grep -n "finanzas\.db" -- ':!docs/'` vacío + revisión manual de las muestras sintéticas | <ficheros revisados> |

  ## Lo que queda fuera y por qué

  - El cerrojo NO se busca fichero a fichero en cada `+server.ts`: vive
    centralizado en `financeRead` / `previewImport` / `confirmImport`, dentro de
    la transacción autorizada. Duplicarlo en cada ruta sería peor, no mejor.
  - Las menciones en prosa de `finanzas.db` dentro de `docs/` (el runbook de la
    migración, esta misma revisión) son esperadas: el control 5 vigila que no
    haya datos en el repositorio, no que no se nombre el fichero de origen.
  - El catch-all del sistema antiguo y su autenticación básica desaparecen con la
    retirada de `cf-finanzas` (runbook de despliegue, fase de producción).
  - Auditoría: toda mutación de finanzas pasa por los triggers de `audit_events`
    con autoría; se verifica en las suites de base de datos, no aquí.
  ```
- [ ] **Step 3: Verifica y commit.** `grep -n "Resultado" docs/security/revision-finanzas.md` no debe mostrar ningún marcador `<...>` sin rellenar.
  ```bash
  git add docs/security/revision-finanzas.md
  git commit -m "docs(seguridad): revisión ejecutada del módulo de finanzas"
  ```

---

### Task 8: El manual de la casa cuenta Finanzas

**Files:**
- Modify: `docs/manual/index.html`
- Test: `node scripts/construir-manual-publicable.mjs /tmp/manual-finanzas.html` (falla si el manual cita capturas inexistentes o se pasa de tamaño)

**Interfaces:**
- Consumes: la sección `<section id="familia-admin">` del manual y su índice `<nav aria-label="Índice del manual">`; el idioma de la casa (`<span class="ui">…</span>` para elementos de pantalla, h3 con id `fa-*`).
- Produces: el apartado del manual que exige la spec §10 («quién lo ve, cómo se concede, cómo se importa el mes»).

- [ ] **Step 1: Añade la entrada al índice.** En el `<nav aria-label="Índice del manual">`, justo después de la línea `<a class="sub" href="#fa-ajustes">Ajustes y accesos</a>`, inserta:
  ```html
  <a class="sub" href="#fa-finanzas">Finanzas de la casa</a>
  ```
- [ ] **Step 2: Añade el apartado.** Dentro de `<section id="familia-admin">`, después del bloque de «Ajustes y accesos» (el h3 con `id="fa-ajustes"` y sus párrafos) y antes del siguiente h3, inserta — sin `<figure class="captura">`: no hay captura y el constructor falla si se cita una que no existe:
  ```html
  <h3 id="fa-finanzas">Finanzas de la casa</h3>
  <p>
    <span class="ui">Finanzas</span> es el módulo del dinero de la casa: importa los
    extractos del banco, clasifica los movimientos y enseña el ahorro del mes. No lo
    ve todo el mundo, ni siquiera toda la administración: solo los administradores a
    los que se les haya <strong>concedido</strong>. La concesión se da y se quita en
    <span class="ui">Ajustes</span>, en la tarjeta <span class="ui">Finanzas</span>;
    quien no la tiene no encuentra el módulo por ningún sitio, y eso es lo esperado.
  </p>
  <p>
    El mes a mes son tres pasos: descargar los extractos de la web del banco, subirlos
    en <span class="ui">Importar</span> —la aplicación detecta el banco sola y avisa de
    los movimientos repetidos— y confirmar en <span class="ui">Revisión</span> las
    categorías que propone. El resultado se mira en el
    <span class="ui">Dashboard</span> y, con más detalle, en
    <span class="ui">Analítica</span>. Si una importación salió mal, su fila del
    historial de <span class="ui">Importar</span> tiene
    <span class="ui">Deshacer</span>: la quita entera, como si no hubiera pasado.
  </p>
  ```
- [ ] **Step 3: Verifica que el manual sigue siendo publicable.**
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  node scripts/construir-manual-publicable.mjs /tmp/manual-finanzas.html
  ```
  Salida esperada: el guion termina sin error y escribe `/tmp/manual-finanzas.html`. Abre el fichero y comprueba que el índice enlaza a «Finanzas de la casa» y que el apartado se lee bien.
- [ ] **Step 4: Commit.**
  ```bash
  git add docs/manual/index.html
  git commit -m "docs(manual): finanzas de la casa — quién lo ve y el mes a mes"
  ```

---

### Task 9: La skill operar-la-casa aprende a operar Finanzas

**Files:**
- Modify: `.claude/skills/operar-la-casa/SKILL.md`
- Modify: `.claude/skills/operar-la-casa/referencia-operaciones.md`
- Test: greps de verificación (anclas y tabla) al final de la tarea

**Interfaces:**
- Consumes: la tabla «Dónde está cada cosa» de `SKILL.md` (columnas Área/Pantalla/Rol mínimo/Detalle) y la estructura por secciones `## …` de `referencia-operaciones.md`; comandos `finance.grant.write`/`finance.revoke.write`; runbook de la migración (`docs/runbooks/migracion-home-finance.md`, nombre único fijado en interfaces §Resoluciones canónicas 13; lo crea la fase 3).
- Produces: la actualización de la skill que exige la spec §10 (operación mensual: descargar extractos, importar, revisar; conceder/revocar).

- [ ] **Step 1: Fila en la tabla de `SKILL.md`.** En la tabla «Dónde está cada cosa», tras la fila de «Buscar», añade:
  ```markdown
  | Finanzas | `/h/<hogar>/finanzas` | `family_admin` **con concesión** | [ops](referencia-operaciones.md#finanzas) |
  ```
- [ ] **Step 2: Sección nueva en `referencia-operaciones.md`.** Añade al final del fichero (mismo tono que las secciones existentes: por dónde se hace, qué rol hace falta, qué NO hay que hacer):
  ```markdown
  ## Finanzas

  El módulo de finanzas es de administradores, y ni siquiera de todos: además del
  rol `family_admin` hace falta una **concesión por membresía** (doble cerrojo,
  impuesto en RLS por `app.finance_enabled()`). Un admin sin concesión ve cero
  filas aunque llame a la API a mano, y no ve el módulo en la navegación.

  ### Conceder o revocar el módulo a un administrador

  - **Dónde**: `/h/<hogar>/settings`, tarjeta **Finanzas**. Lista las membresías
    `family_admin` con su interruptor conceder/revocar.
  - **Rol**: `family_admin` (los comandos `finance.grant.write` /
    `finance.revoke.write` exigen además `access.manage`).
  - Un admin puede revocarse a sí mismo; cualquier otro admin puede devolvérselo.
    Revocar no borra nada: escribe `revoked_at` y conserva el histórico.
  - Los administradores nuevos nacen con Finanzas apagado.

  ### La operación mensual

  1. **Descargar los extractos** de la web de cada banco (CaixaBankNow → Cuentas →
     Saldo y movimientos → exportar Excel; Deutsche Bank online → Cuentas →
     descarga de movimientos; OpenBank y Amex desde sus áreas de cliente).
  2. **Importar**: `/h/<hogar>/finanzas/importar` → elegir el fichero → la
     previsualización dice el banco detectado, cuántos movimientos son nuevos y
     cuántos repetidos, y pide crear las cuentas que no conozca → Confirmar.
     El fichero no se guarda en ningún sitio: se procesa y se descarta.
  3. **Revisar**: `/h/<hogar>/finanzas/revision` — confirmar las categorías
     sugeridas, fila a fila o en bloque; la casilla «Regla» crea la regla al
     confirmar para que el mes que viene venga hecho.
  4. Mirar el mes en el **Dashboard** y en **Analítica**.

  ### Qué NO hay que hacer

  - **Nada de SQL a mano** sobre las tablas `finance_*`: las escrituras van por
    comandos de `/api/v1/sync` con autoría y auditoría, como todo lo demás.
  - **Ningún extracto real entra en el repositorio** (ni en fixtures ni en tests):
    las muestras del repo son sintéticas.
  - Una importación equivocada **no se arregla borrando filas**: se deshace desde
    el historial de Importar (borra el lote entero y sus transacciones).
  - La migración desde el sistema antiguo (home-finance) fue única y está
    congelada; su runbook es
    [docs/runbooks/migracion-home-finance.md](../../../docs/runbooks/migracion-home-finance.md).
  ```
- [ ] **Step 3: Verifica las anclas y commit.** El tercer grep comprueba que el enlace al runbook apunta a un fichero que existe de verdad (el nombre canónico es `migracion-home-finance.md`, no `migrar-…`):
  ```bash
  grep -n "^## Finanzas" .claude/skills/operar-la-casa/referencia-operaciones.md
  grep -n "finanzas" .claude/skills/operar-la-casa/SKILL.md
  test -f docs/runbooks/migracion-home-finance.md && echo "runbook OK"
  grep -rn "migrar-home-finance" .claude/skills/operar-la-casa/   # esperado: vacío
  git add .claude/skills/operar-la-casa/SKILL.md .claude/skills/operar-la-casa/referencia-operaciones.md
  git commit -m "docs(skill): operar finanzas — concesión y operación mensual"
  ```

---

### Task 10: El runbook de despliegue cuenta con Finanzas

**Files:**
- Modify: `docs/despliegue/runbook-despliegue.md`
- Test: greps de verificación al final de la tarea

**Interfaces:**
- Consumes: `docs/despliegue/runbook-despliegue.md` (§2 «Aplicar el esquema», §7 «Humo posterior al despliegue»); migración `0034_finance.sql`; runbook de migración de la fase 3 (`docs/runbooks/migracion-home-finance.md`, interfaces §Resoluciones canónicas 13); `packages/db/scripts/run-sql-tests.mjs`, que ejecuta todos los `packages/db/tests/*.sql`; códigos canónicos de acceso (403 en ruta declarada sin capacidad).
- Produces: runbook de despliegue actualizado (alcance de la fase: criterios de salida de migraciones y de suites SQL sin números falsos, humo con finanzas, sin variables nuevas, enlace correcto al runbook de la migración).

- [ ] **Step 1: Actualiza el criterio de salida de las migraciones.** En §2, paso 2, sustituye la línea `Criterio de salida: **17/17 migraciones aplicadas**. Repetir el comando debe` por un criterio **sin número fijo** — la numeración de `packages/db/migrations/` tiene huecos (no existen 0019 ni 0024), así que cualquier cifra escrita a mano envejece mal y hace parar un despliegue sano:
  ```markdown
  Criterio de salida: la última migración aplicada es `0034_finance.sql` y el runner
  no deja ninguna pendiente (imprime el recuento al terminar; la numeración tiene
  huecos históricos, así que el número total no es el del último fichero).
  Repetir el comando debe
  ```
- [ ] **Step 2: Corrige de paso el criterio de las suites SQL** (está justo debajo, en el paso 3 de §2, y también lleva un número falso: `run-sql-tests.mjs` ejecuta TODOS los `packages/db/tests/*.sql`, que hoy son 17 y serán 18 con la suite de RLS de finanzas). Sustituye `Criterio de salida: **5/5 suites en verde**. Si la matriz RLS falla, PARAR:` por:
  ```markdown
  Criterio de salida: **todas las suites de `packages/db/tests/` en `ok`**, incluida
  la de RLS de finanzas (`030_finance_rls.sql`); el runner imprime cuántas ha
  ejecutado. Si la matriz RLS falla, PARAR:
  ```
- [ ] **Step 3: Nota de Finanzas en §2.** Tras el paso 4 de §2 (Better Auth), añade:
  ```markdown
  5. **Finanzas no añade variables de entorno**: SheetJS vive solo en el servidor y
     los extractos no se persisten, así que no hay bucket ni clave nuevos. Lo único
     que trae la 0034 es el esquema y su RLS de doble cerrojo. La carga de los datos
     históricos es una migración única aparte, con su propio runbook:
     [`../runbooks/migracion-home-finance.md`](../runbooks/migracion-home-finance.md) —
     **no se ejecuta sin confirmación explícita del propietario**.
  ```
- [ ] **Step 4: Humo con Finanzas en §7.** Añade a la lista de comprobaciones de «7. Humo posterior al despliegue», tras la línea del login:
  ```markdown
  - [ ] Con una concesión de Finanzas activa (Ajustes → tarjeta Finanzas), el
        Dashboard de `/h/<hogar>/finanzas` responde y pinta los KPIs; una cuenta
        sin concesión no ve el módulo en la navegación y recibe 403 por URL directa.
  ```
- [ ] **Step 5: Verifica y commit.** El segundo grep tiene que salir vacío: el nombre canónico del runbook es `migracion-home-finance.md` y un enlace a `migrar-…` quedaría roto para siempre dentro de documentación permanente.
  ```bash
  grep -n "0034_finance.sql\|migracion-home-finance\|tarjeta Finanzas\|packages/db/tests" docs/despliegue/runbook-despliegue.md
  grep -n "migrar-home-finance\|17/17\|5/5 suites" docs/despliegue/runbook-despliegue.md   # esperado: vacío
  git add docs/despliegue/runbook-despliegue.md
  git commit -m "docs(despliegue): el runbook cuenta con la 0034 y el humo de finanzas"
  ```

---

### Task 11: Ensayo local COMPLETO de la migración contra Docker

**Files:**
- Modify: `docs/runbooks/migracion-home-finance.md` (lo crea la fase 3; aquí solo se corrige si el ensayo revela erratas — el procedimiento no se cambia, se corrige)
- Test: el informe de verificación del ETL y el humo de las 7 pantallas; **ninguna evidencia con datos reales entra en el repo**

**Interfaces:**
- Consumes: `packages/db/scripts/migrar-home-finance.mjs` con el contrato CLI canónico (interfaces §Resoluciones canónicas 12, que lo produce la fase 3): `--sqlite <ruta>` y `--database-url <url>` son **obligatorios** —el guion NO lee `DATABASE_URL` del entorno y aborta con código 2 si faltan—, más `--household <slug>`, `--backup-dir <dir>` (donde deja el informe) y los modos `--dry-run` / `--verify-only`; el runbook de ensayo de la fase 3 (`docs/runbooks/migracion-home-finance.md`, nombre único de interfaces §Resoluciones canónicas 13); la base origen `/home/abf/github/home-finance/backend/data/finanzas.db` (SOLO LECTURA); el clúster de pruebas `casaclara-it-pg` en `127.0.0.1:5439`; `pnpm db:migrate`.
- Produces: el ensayo exigido por la spec §9.4 ejecutado de cabo a rabo sobre el código terminado, con informe local guardado FUERA de ambos repos.

**Los datos migrados son reales.** Viven en el Docker local y en el informe local, nunca en git, nunca en fixtures, nunca en un test. Cualquier fichero que este ensayo produzca se guarda fuera del árbol de ambos repos.

- [ ] **Step 0 (PUERTA, añadido tras la fase 1): la cadena 0001→0034 aplica con un propietario NOBYPASSRLS.** El ensayo normal corre como `ci_admin`, que es superusuario del contenedor y **puentea la RLS**, así que no reproduce Supabase y puede esconder un fallo que solo aparece en producción. Al implementar la migración 0034, el ejecutor de la fase 1 informó de que `0032_push_subscriptions.sql` podría no aplicarse bajo propietario sin BYPASSRLS: su función `app_private.push_delivery_recorded` es `LANGUAGE sql` con `SET row_security = off` y se planifica ya en el `CREATE`, dentro de la misma transacción que 230 líneas antes puso `FORCE` sobre `push_subscriptions` — donde `0018_rls_force_compat.sql` no puede intervenir → `42501`. Si eso es cierto, la cadena se detiene **antes** de 0034 y la migración de producción fallaría a mitad. Compruébalo AQUÍ, en local:

  ```bash
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  docker exec casaclara-it-pg dropdb -U ci_admin --if-exists casaclara_nobypass
  docker exec casaclara-it-pg createdb -U ci_admin casaclara_nobypass
  # Propietario sin BYPASSRLS, como en Supabase:
  docker exec casaclara-it-pg psql -U ci_admin -d casaclara_nobypass -c \
    "create role cc_owner login password 'solo-local' nobypassrls createrole; alter database casaclara_nobypass owner to cc_owner;"
  DATABASE_URL="postgresql://cc_owner:solo-local@127.0.0.1:5439/casaclara_nobypass" pnpm --filter @casa-clara/db bootstrap
  DATABASE_URL="postgresql://cc_owner:solo-local@127.0.0.1:5439/casaclara_nobypass" pnpm db:migrate
  ```

  **Criterio:** la cadena aplica las 34 migraciones y termina sin error.
  - Si termina en verde: el aviso no se materializa, anótalo en el informe y sigue con el Step 1.
  - Si muere en `0032` con `42501`: está confirmado. **NO se edita `0032`** (es append-only y ya está aplicada en producción si el módulo de avisos funciona allí). Antes de nada, comprueba el estado REAL de producción —`select name from public.schema_migrations order by name` contra Supabase en solo lectura— porque si `0032` ya consta aplicada allí, el problema no afecta a la migración de producción y basta con dejarlo documentado. Si no consta, escribe una migración `0036_push_delivery_recorded_plpgsql.sql` (el número `0035` ya lo ocupa `0035_finance_endurecimiento.sql`, de la fase 1) que sustituya esa función por una equivalente en `plpgsql` (que no planifica el cuerpo en el `CREATE`), con su prueba, y repite este Step 0 hasta verde. Ninguna tarea de producción (13, 14, 15) puede empezar con este paso en rojo.
- [ ] **Step 1: Localiza y lee ENTERO el runbook de la fase 3.**
  ```bash
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  ls docs/runbooks/ | grep -i finan
  ```
  Se espera exactamente `migracion-home-finance.md` (nombre único, interfaces §Resoluciones canónicas 13). Léelo completo antes de ejecutar nada: este ensayo es ese runbook «de cabo a rabo», y si en algún paso el runbook y esta tarea difieren, manda el runbook (y se anota la discrepancia).
- [ ] **Step 2: Copia de seguridad datada del origen** (Paso 0 del runbook, spec §9.1 y §13: única copia de la BD origen, fuera de los árboles de ambos repos porque el guion se niega a escribir dentro de un repo git). Comprueba si ya existe y, si no, créala con los mismos comandos del runbook:
  ```bash
  ls -l /home/abf/github/home-finance/backend/data/finanzas.db
  ls -l ~/copias-home-finance/ 2>/dev/null

  # Si no hay copia del día, hazla ahora (es el Paso 0 del runbook, literal):
  mkdir -p ~/copias-home-finance
  cp /home/abf/github/home-finance/backend/data/finanzas.db \
     ~/copias-home-finance/finanzas-$(date +%Y-%m-%dT%H-%M-%S).db
  sha256sum /home/abf/github/home-finance/backend/data/finanzas.db ~/copias-home-finance/finanzas-*.db
  ```
  Criterio: el sha256 del original y el de la copia recién creada coinciden. Anota la ruta exacta de la copia: es el `--sqlite` de los pasos siguientes.
  ```bash
  export COPIA=~/copias-home-finance/finanzas-<fecha-de-la-copia>.db
  test -f "$COPIA" && echo "copia lista: $COPIA"
  ```
- [ ] **Step 3: Postgres 18.4 limpio en Docker y esquema completo.**
  ```bash
  # Base de ensayo limpia en el clúster compartido de pruebas (127.0.0.1:5439).
  # NUNCA el puerto 54329: en esta máquina lo ocupa la base embebida de Paperclip, otra aplicación.
  docker start casaclara-it-pg 2>/dev/null || true
  docker exec casaclara-it-pg dropdb -U ci_admin --if-exists casaclara_ensayo
  docker exec casaclara-it-pg createdb -U ci_admin casaclara_ensayo
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  export ENSAYO_URL='postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_ensayo'
  DATABASE_URL="$ENSAYO_URL" pnpm db:migrate
  DATABASE_URL="$ENSAYO_URL" pnpm db:migrate   # idempotencia: la segunda aplica 0
  ```
  Salida esperada: la primera pasada aplica todas las migraciones pendientes y la última es `0034_finance.sql`; la segunda pasada aplica 0. **No cuentes migraciones a mano**: la numeración de `packages/db/migrations/` tiene huecos (no existen 0019 ni 0024), así que el recuento no coincide con el número del último fichero — el que manda es el que imprime el runner.
- [ ] **Step 4: Alta del hogar de ensayo.** El runbook de la fase 3 lo hace por SQL directo contra la base de ensayo (para el humo de la UI con cuentas de verdad, sigue en cambio `docs/despliegue/alta-de-hogar.md`, como dice el propio runbook). El clúster es el compartido, así que el contenedor es `casaclara-it-pg` y el usuario `ci_admin` — **nunca un contenedor `pg-ensayo-finanzas` ni un usuario `ensayo`, que no existen en esta máquina**:
  ```bash
  docker exec -i casaclara-it-pg psql -U ci_admin -d casaclara_ensayo -c \
    "SET row_security = off;
     INSERT INTO app.households (slug, display_name)
     VALUES ('hogar-ensayo', 'Hogar del ensayo');"
  docker exec casaclara-it-pg psql -U ci_admin -d casaclara_ensayo -tAc \
    "SELECT slug FROM app.households;"
  export SLUG=hogar-ensayo
  ```
  Salida esperada: `INSERT 0 1` y el `SELECT` devolviendo `hogar-ensayo`. Ese es el `--household` de los pasos siguientes.
- [ ] **Step 5: ETL en ensayo, en el orden del contrato.** El guion NO lee `DATABASE_URL` del entorno: `--sqlite` y `--database-url` son obligatorios y sin ellos sale con código 2 («Falta --sqlite»). `--backup-dir` es donde deja el informe, siempre fuera de ambos repos:
  ```bash
  node packages/db/scripts/migrar-home-finance.mjs \
    --sqlite "$COPIA" --database-url "$ENSAYO_URL" --household "$SLUG" \
    --backup-dir ~/copias-home-finance --dry-run
  node packages/db/scripts/migrar-home-finance.mjs \
    --sqlite "$COPIA" --database-url "$ENSAYO_URL" --household "$SLUG" \
    --backup-dir ~/copias-home-finance
  node packages/db/scripts/migrar-home-finance.mjs \
    --sqlite "$COPIA" --database-url "$ENSAYO_URL" --household "$SLUG" \
    --backup-dir ~/copias-home-finance --verify-only
  ```
  Las tres ejecuciones deben terminar en `Resultado: OK` y código de salida 0. El informe de verificación (obligatorio: conteos por tabla origen=destino, suma de `amount_cents` por cuenta y mes idénticas, grupos de transferencia con suma 0, distribución de estados, min/max de fechas) se imprime y queda en `~/copias-home-finance/informe-migracion-<fecha>.md`, **fuera del repo**. Contrasta además a ojo contra `/home/abf/github/home-finance/backend/data/informe-semestre1-2026.md` (solo lectura). Comprueba de paso el cerrojo de reejecución: repetir el ETL real sobre el mismo hogar debe abortar por «el hogar ya tiene datos» salvo que se pase `--force-empty-check`.
- [ ] **Step 6: Humo de la UI con ese hogar.** Monta la web contra la base de ensayo (es el paso de smoke del runbook de la fase 3, que remite a `.claude/skills/operar-la-casa/referencia-instalacion.md`) y recórrela con el navegador:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  DATABASE_URL="$ENSAYO_URL" pnpm --filter @casa-clara/web build
  DATABASE_URL="$ENSAYO_URL" PORT=4173 node apps/web/build   # deja este proceso corriendo
  ```
  En otra terminal, entra en `http://127.0.0.1:4173`, concede Finanzas al admin del ensayo desde Ajustes → tarjeta **Finanzas**, y recorre las 7 pantallas (`finanzas`, `analitica`, `movimientos`, `revision`, `eventos`, `importar`, `ajustes`). Comprueba que Dashboard, Movimientos y Analítica cuadran con los números del informe del Step 5 (ingresos, gastos, ahorro y conteo de movimientos del semestre). Al terminar, para el servidor con Ctrl-C.
- [ ] **Step 7: Limpieza y cierre.** La base de ensayo contiene datos financieros REALES y vive en el clúster **compartido** de pruebas: se borra la BASE, nunca el contenedor (un `docker rm -f casaclara-it-pg` se llevaría por delante el clúster entero, con las bases de todas las suites):
  ```bash
  docker exec casaclara-it-pg dropdb -U ci_admin --if-exists casaclara_ensayo
  docker exec casaclara-it-pg psql -U ci_admin -lqt | grep -c casaclara_ensayo   # esperado: 0
  ```
  Si el ensayo destapó una errata del runbook (un comando que no era, una ruta que faltaba), corrígela ahora en `docs/runbooks/migracion-home-finance.md` y committea:
  ```bash
  git add docs/runbooks/migracion-home-finance.md
  git commit -m "docs(runbook): corregir lo que falló al ensayar la migración de finanzas"
  ```
  Si el ensayo destapó un bug de código o de datos: PARA, arréglalo con su test en la tarea que corresponda, y **repite esta tarea desde el Step 3**. El ensayo solo se da por bueno si sale limpio de una pasada.

---

### Task 12: Puerta de producción — todo en verde, y solo entonces preguntar

**Files:**
- Test: todos los gates del repositorio; sin cambios de código

**Interfaces:**
- Consumes: todos los gates de la rama (interfaces §Restricciones globales) más las baterías de navegador y los presupuestos; `TEST_DATABASE_URL` y `E2E_DATABASE_URL` explícitas contra `casaclara-it-pg` (`127.0.0.1:5439`), nunca los valores por omisión de los `package.json`.
- Produces: la evidencia de que la rama está entregable ANTES de la primera acción contra producción. **Ninguna tarea posterior puede empezar sin esta cerrada.**

- [ ] **Step 1: Pasada completa de gates, en secuencia** (las suites de BD nunca en paralelo). **Las dos variables de base de datos se exportan SIEMPRE, antes de nada**: sin `TEST_DATABASE_URL` las suites SQL abortan con «TEST_DATABASE_URL or DATABASE_URL is required» y —mucho peor— `pnpm test` sigue devolviendo 0 porque todas las suites de integración de server y web son `describe.runIf(Boolean(adminUrl))` y se SALTAN en silencio: la puerta daría verde sin haber ejecutado ni una sola prueba de integración. Y sin `E2E_DATABASE_URL`, `test:e2e:db` cae a su valor por omisión, el puerto 54329 prohibido (interfaces §Resoluciones canónicas 15):
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  docker start casaclara-it-pg 2>/dev/null || true
  export TEST_DATABASE_URL='postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u'
  export E2E_DATABASE_URL='postgresql://ci_admin:ci-only-password@127.0.0.1:5439/casaclara_wt_u'

  pnpm lint && pnpm typecheck && pnpm check
  pnpm test
  pnpm test:import
  pnpm test:db
  pnpm test:rls
  pnpm --filter @casa-clara/web build && pnpm --filter @casa-clara/web verify:bundle
  pnpm test:e2e
  pnpm test:a11y
  pnpm test:e2e:db
  pnpm test:lighthouse
  ```
  Criterio: TODO en verde **y sin skips**. El verde no basta: contrasta el recuento de tests ejecutados por `pnpm test` contra el de la rama base (`git stash` no hace falta; vale con `git log` y el último informe de CI de `main`) y comprueba que ha crecido, no que se ha quedado igual. Un total que no sube después de seis fases de trabajo significa que las suites de integración se están saltando por una variable sin exportar. Cualquier rojo —o cualquier skip nuevo— se arregla (con su test) antes de continuar; esta tarea se repite desde el principio tras cada arreglo.
- [ ] **Step 2: Working tree limpio y rama al día.** `git status` sin cambios sin committear (salvo artefactos ignorados) y `git log --oneline -15` mostrando los commits de las tareas 1–11.
- [ ] **Step 3: Ensayo local certificado.** Confirma que la tarea 11 terminó limpia de una pasada (informe verificado + humo de 7 pantallas). Si no, no hay puerta.
- [ ] **Step 4: PARAR y preguntar.** Escribe a Alberto el estado: gates en verde, ensayo limpio, y la lista de las tres tareas de producción (13, 14, 15) con lo que cada una hace. **No ejecutes nada de las tareas 13–15 hasta tener su confirmación explícita, tarea por tarea.** Sin respuesta, el trabajo de esta fase termina aquí y la rama queda lista para revisión y merge.

---

### Task 13: PRODUCCIÓN — migración 0034 y ETL real en Supabase — **REQUIERE CONFIRMACIÓN EXPLÍCITA DE ALBERTO ANTES DE EJECUTAR**

**Files:**
- Test: el informe de verificación del ETL contra producción (local, fuera del repo); sin cambios de código

**Interfaces:**
- Consumes: conexión directa 5432 de Supabase con rol propietario (patrón §2 de `docs/despliegue/runbook-despliegue.md`: el runner de migraciones toma un advisory lock de sesión que el pooler no conserva); `pnpm db:migrate`; `packages/db/scripts/migrar-home-finance.mjs` (mismo contrato CLI canónico que en el ensayo: `--sqlite` y `--database-url` obligatorios, `--backup-dir` para el informe); runbook `docs/runbooks/migracion-home-finance.md`; la copia datada del origen del día (`$COPIA`, Paso 0 del runbook).
- Produces: esquema 0034 vivo en producción y los 1.111 movimientos históricos migrados y verificados (spec §9.5).

**Cada step de esta tarea requiere la confirmación previa de Alberto para la tarea entera; si algo sale distinto de lo esperado, PARAR y consultar antes de continuar. Ninguna credencial se escribe en ningún fichero del repo.**

- [ ] **Step 1 (requiere confirmación de Alberto): Copia de seguridad previa de producción.** Antes de tocar el esquema, copia completa de casa-clara con el estado ACTUAL (pre-finanzas), siguiendo §8 del runbook de despliegue. Las credenciales salen del gestor de contraseñas y no se escriben en ningún fichero del repo:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  export DIRECTA='postgresql://postgres:CLAVE@db.PROYECTO.supabase.co:5432/postgres'   # del gestor de contraseñas
  export BACKUP_DATABASE_URL="$DIRECTA"
  export S3_ENDPOINT=… S3_REGION=… S3_PRIVATE_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
  pnpm backup:full
  ```
  Verifica antes de seguir: el directorio datado final NO lleva sufijo `.partial`, y dentro están `base.dump` (verificado por el propio guion), `SHA256SUMS` y `manifest.json`. Sin esa copia, no se toca el esquema.
  Copia también el origen del día, como en el ensayo (Paso 0 del runbook), y anota su ruta en `$COPIA`:
  ```bash
  cp /home/abf/github/home-finance/backend/data/finanzas.db \
     ~/copias-home-finance/finanzas-$(date +%Y-%m-%dT%H-%M-%S).db
  sha256sum /home/abf/github/home-finance/backend/data/finanzas.db ~/copias-home-finance/finanzas-*.db
  export COPIA=~/copias-home-finance/finanzas-<fecha-de-hoy>.db
  ```
- [ ] **Step 2 (requiere confirmación de Alberto): Migraciones en Supabase.**
  ```bash
  DATABASE_URL="$DIRECTA" pnpm db:migrate
  DATABASE_URL="$DIRECTA" pnpm db:migrate   # repetir debe aplicar 0
  ```
  Criterio de salida: la última aplicada es `0034_finance.sql` y no queda ninguna pendiente; la segunda pasada aplica 0. No cuentes migraciones a mano: la numeración tiene huecos (no existen 0019 ni 0024) y el recuento lo imprime el runner.
- [ ] **Step 3 (requiere confirmación de Alberto): ETL real, ensayado primero en seco.** Mismo contrato CLI que en el ensayo (`--sqlite` y `--database-url` obligatorios; el guion no lee `DATABASE_URL` del entorno), con la copia del Step 1 como origen:
  ```bash
  node packages/db/scripts/migrar-home-finance.mjs \
    --sqlite "$COPIA" --database-url "$DIRECTA" --household <slug-real> \
    --backup-dir ~/copias-home-finance --dry-run
  node packages/db/scripts/migrar-home-finance.mjs \
    --sqlite "$COPIA" --database-url "$DIRECTA" --household <slug-real> \
    --backup-dir ~/copias-home-finance
  node packages/db/scripts/migrar-home-finance.mjs \
    --sqlite "$COPIA" --database-url "$DIRECTA" --household <slug-real> \
    --backup-dir ~/copias-home-finance --verify-only
  ```
  El informe se imprime y se guarda **en local, fuera del repo**. Criterios: conteos origen=destino en las 9 tablas; sumas de `amount_cents` por cuenta y por mes idénticas; grupos de transferencia con suma 0; distribución de estados igual a la del origen; min/max de fechas del semestre. Contraste adicional contra `/home/abf/github/home-finance/backend/data/informe-semestre1-2026.md`. **Si UNA sola cifra no cuadra: PARAR, no seguir a la tarea 14, y consultar a Alberto con el informe en la mano.**

---

### Task 14: PRODUCCIÓN — activar la concesión y humo de las 7 pantallas — **REQUIERE CONFIRMACIÓN EXPLÍCITA DE ALBERTO ANTES DE EJECUTAR**

**Files:**
- Test: comprobación visual contra los números del informe de la tarea 13; sin cambios de código

**Interfaces:**
- Consumes: comando `finance.grant.write` (tarjeta «Finanzas» de `/h/<hogar>/settings` en producción); las 7 pantallas bajo `/h/<hogar>/finanzas`; el informe de verificación de la tarea 13.
- Produces: el módulo activo SOLO para la cuenta de Alberto (spec §2.1) y verificado sobre datos reales (spec §9.5).

- [ ] **Step 1 (requiere confirmación de Alberto): Conceder solo a Alberto.** Con la sesión de Alberto en producción: Ajustes del hogar → tarjeta **Finanzas** → conceder a su propia membresía. Verificar que NINGUNA otra membresía queda con concesión.
- [ ] **Step 2: Humo de las 7 pantallas contra el informe.** Con la sesión de Alberto, recorrer `finanzas`, `analitica`, `movimientos`, `revision`, `eventos`, `importar`, `ajustes` y contrastar: totales del Dashboard y de Analítica con las sumas por mes del informe; conteo de movimientos; estados en Revisión; cuentas y categorías en Ajustes del módulo. Anotar cada cifra comprobada en una nota local (fuera del repo).
- [ ] **Step 3: Humo negativo.** Con una cuenta de producción que NO sea la de Alberto (o tras revocar en una cuenta de prueba admin si existe): el módulo no aparece en la navegación y `/h/<hogar>/finanzas` responde 403. Con la de Alberto, una ruta hija inventada responde 404.
- [ ] **Step 4: Veredicto.** Si TODO cuadra, comunicar a Alberto que la migración está verificada y pedir confirmación para la retirada (tarea 15). Si algo no cuadra: PARAR, no retirar nada — el sistema antiguo sigue intacto y es la referencia.

---

### Task 15: PRODUCCIÓN — retirada del sistema antiguo — **REQUIERE CONFIRMACIÓN EXPLÍCITA DE ALBERTO ANTES DE EJECUTAR**

**Files:**
- Modify: `/home/abf/github/home-finance/README.md` (fuera del worktree: es la ÚNICA escritura permitida en ese repo, la exige la spec §9.6 y solo con la confirmación de esta tarea)
- Test: comprobaciones post-retirada de cada step

**Interfaces:**
- Consumes: contenedor Docker `cf-finanzas`; variables `FINANZAS_AUTH_USER`/`FINANZAS_AUTH_PASS` del sistema antiguo; `pnpm backup:full` (worker de casa-clara, §8 del runbook de despliegue).
- Produces: sistema antiguo apagado y congelado, credenciales quemadas retiradas, copia completa de casa-clara con los datos ya migrados (spec §9.6).

- [ ] **Step 1 (requiere confirmación de Alberto): Apagar y retirar el túnel.**
  ```bash
  docker stop cf-finanzas && docker rm cf-finanzas
  docker ps -a | grep -i finanzas   # salida esperada: vacía
  ```
  Con esto desaparecen el catch-all y la autenticación básica compartida del sistema antiguo.
- [ ] **Step 2 (requiere confirmación de Alberto): Retirar las credenciales antiguas.** Localiza dónde viven las `FINANZAS_AUTH_*` en la máquina (`grep -rn "FINANZAS_AUTH" /home/abf/github/home-finance/.env 2>/dev/null; grep -rn "FINANZAS_AUTH" ~/.bashrc ~/.profile 2>/dev/null`) y elimina esas líneas de los ficheros de entorno donde aparezcan (NO de `main.py`: el código del repo viejo no se toca). Son credenciales quemadas: han viajado por un quick tunnel.
- [ ] **Step 3 (requiere confirmación de Alberto): Copia completa de casa-clara con los datos migrados.** Según §8 del runbook de despliegue:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  export BACKUP_DATABASE_URL="$DIRECTA"
  export S3_ENDPOINT=… S3_REGION=… S3_PRIVATE_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
  pnpm backup:full
  ```
  Verifica: directorio datado sin sufijo `.partial`, `base.dump` verificado por el propio guion, `SHA256SUMS` y `manifest.json` presentes.
- [ ] **Step 4 (requiere confirmación de Alberto): Nota de congelación en home-finance.** Añade al PRINCIPIO de `/home/abf/github/home-finance/README.md`, justo tras el título `# Finanzas Familiares`:
  ```markdown
  > **⛔ CONGELADO desde <fecha>.** Este sistema ya no se usa: las finanzas de la
  > casa viven ahora en el módulo **Finanzas de casa-clara**
  > (repo `housekeeper`, rutas `/h/<hogar>/finanzas`), con los 6 primeros meses de
  > 2026 migrados y verificados. Aquí no se importa ni se corrige nada más.
  > La BD SQLite (`backend/data/finanzas.db`) y `samples/` se conservan en esta
  > máquina como archivo personal y siguen fuera de git. El túnel `cf-finanzas`
  > está retirado y sus credenciales, revocadas.
  ```
  Y committea EN ESE repo (evitando `git add -A`, que arrastraría artefactos):
  ```bash
  git -C /home/abf/github/home-finance add README.md
  git -C /home/abf/github/home-finance commit -m "docs: congelado — las finanzas viven ahora en casa-clara"
  ```
- [ ] **Step 5: Cierre de fase.** Comunica a Alberto el resumen final: migrado, verificado, retirado, copiado. Los extractos de `samples/` quedan en esta máquina como archivo personal (no se suben a ningún sitio). La rama `worktree-modulo-finanzas` queda lista para su merge por el camino normal de revisión.
