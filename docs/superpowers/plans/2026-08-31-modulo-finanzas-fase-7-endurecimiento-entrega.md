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
  Re-ejecuta `pnpm test:a11y` tras cada corrección hasta `7 passed`.
- [ ] **Step 5: Commit.**
  ```bash
  git add apps/web/e2e/critical.a11y.ts apps/web/src
  git commit -m "test(a11y): las tres pantallas de finanzas entran en la suite crítica"
  ```

---

### Task 2: E2E fixture — navegación de las 7 pantallas y denegación por rol

**Files:**
- Create: `apps/web/e2e/finanzas.e2e.ts`
- Test: `apps/web/e2e/finanzas.e2e.ts` (se ejecuta con `pnpm test:e2e`)

**Interfaces:**
- Consumes: las 7 rutas del módulo (`finanzas`, `finanzas/analitica`, `finanzas/movimientos`, `finanzas/revision`, `finanzas/eventos`, `finanzas/importar`, `finanzas/ajustes`); guard de routing de fase 1 (`MODULE_CAPABILITY.finanzas = "finance.access"`, `NESTED_ROUTE_CAPABILITY`, fail-closed 404); helpers `loginAs`/`HOUSEHOLD`.
- Produces: spec e2e de navegación y denegación (spec §11: «navegación de las 7 pantallas como admin-con-concesión; 403/404 para el resto de roles»).

El patrón a imitar es `apps/web/e2e/roles.e2e.ts`: navegación directa por URL, aserción del `status()` de la respuesta y del texto del guard («no está incluida en tu acceso» para 403). El 404 fail-closed de ruta hija no declarada sigue el test «una ruta hija no declarada falla cerrada con 404» de ese mismo fichero.

- [ ] **Step 1: Escribe la spec completa** en `apps/web/e2e/finanzas.e2e.ts`:
  ```ts
  import { expect, test } from '@playwright/test';

  import { HOUSEHOLD, loginAs } from './helpers';

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
- [ ] **Step 2: Ejecuta y ve el resultado.**
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  pnpm test:e2e
  ```
  Salida esperada: todas las specs `*.e2e.ts` en verde, incluidas las 6 pruebas nuevas. Si un rol recibe un código distinto del esperado (p. ej. 404 donde el test espera 403), NO ajustes el test a ciegas: comprueba contra la spec §4/§8 qué declara `NESTED_ROUTE_CAPABILITY` y qué hace el guard de `apps/web/src/routes/h/[householdId]/+layout.server.ts`; el contrato es 403 para capacidad ausente en ruta declarada y 404 para ruta no declarada. Corrige el lado que esté violando el contrato.
- [ ] **Step 3: Commit.**
  ```bash
  git add apps/web/e2e/finanzas.e2e.ts
  git commit -m "test(e2e): las siete pantallas de finanzas y su denegación por rol"
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

  // Conceder y revocar son comandos por /api/v1/sync (finance.grant.write /
  // finance.revoke.write, exigen access.manage + rol admin del emisor). La
  // fixture 002_finance.sql deja concesión viva solo al admin de roble = la
  // cuenta `admin` de esta batería. La spec restaura el estado al terminar:
  // la batería dbe2e comparte base entre specs.
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
- [ ] **Step 3: Ejecuta contra el Postgres local.** El clúster local del worktree es el que usa `test:e2e:db` por omisión (`postgresql://casa_admin@127.0.0.1:54329/casaclara_wt_u`); el globalSetup recrea esquema y fixtures en cada ejecución:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  pnpm test:e2e:db
  ```
  Salida esperada: toda la batería `*.dbe2e.ts` en verde, incluida esta spec. Si el botón de conceder no existe tras revocarse (auto-concesión bloqueada), eso contradice la spec §4 —la tarjeta lista TODAS las membresías admin con interruptor y el comando solo exige `access.manage` + rol admin— y se corrige en el handler, no en el test.
- [ ] **Step 4: Commit.**
  ```bash
  git add apps/web/e2e/finanzas-concesion.dbe2e.ts
  git commit -m "test(dbe2e): conceder y revocar finanzas cambia lo visible bajo RLS"
  ```

---

### Task 4: dbe2e — importar, previsualizar, confirmar y deshacer contra Postgres real

**Files:**
- Create: `apps/web/e2e/finanzas-importar.dbe2e.ts`
- Test: `apps/web/e2e/finanzas-importar.dbe2e.ts` (se ejecuta con `pnpm test:e2e:db`)

**Interfaces:**
- Consumes: `POST /api/v1/finance/imports/preview` (multipart: `file`) y `POST /api/v1/finance/imports/confirm` (multipart: `file` + `payload` JSON con cuentas nuevas) vía la pantalla Importar (fase 5); comando `finance.import.undo`; muestras sintéticas de los parsers de la fase 2 (van al repo, spec §11); prefijos de `dedup_hash` preservados.
- Produces: spec dbe2e del ciclo completo de importación con deshacer (spec §11: «importar→previsualizar→confirmar→deshacer contra Postgres real»).

- [ ] **Step 1: Localiza una muestra sintética y la pantalla real.** Las muestras de los parsers son ficheros del repo (fase 2). Encuéntralas y elige UNA (preferible la de OpenBank o CaixaBank):
  ```bash
  find packages/server -type f \( -name '*.xls' -o -name '*.xlsx' \) | sort
  ```
  Anota la ruta exacta (p. ej. `packages/server/src/finance/parsers/<muestras>/<fichero>.xls`; usa la que exista). Después lee la pantalla para anclar los selectores:
  ```bash
  sed -n 1,120p apps/web/src/routes/h/\[householdId\]/finanzas/importar/+page.svelte
  ```
  Anota: el selector del `input[type="file"]`, el texto del botón de confirmar (se espera «Confirmar»), el del deshacer del historial (se espera «Deshacer») y cómo pinta la previsualización (nuevas/duplicadas) y el formulario de cuentas desconocidas. Ajusta los literales del Step 2 a lo que veas — la estructura del flujo es contrato de la spec §7/§8 y no cambia.
- [ ] **Step 2: Escribe la spec** en `apps/web/e2e/finanzas-importar.dbe2e.ts` (la ruta de la muestra se resuelve desde `apps/web`, que es el cwd de Playwright):
  ```ts
  import path from 'node:path';

  import { expect, test } from '@playwright/test';

  import { HOUSEHOLD, loginAs } from './helpers';

  // Muestra sintética de la fase 2 (extracto inventado, formato real).
  // AJUSTA la ruta a la que devolvió `find packages/server -name '*.xls*'`.
  const SAMPLE = path.resolve('..', '..', 'packages/server/src/finance/parsers/RUTA-DE-LA-MUESTRA');

  test('importar: previsualizar, confirmar y deshacer deja la base como estaba', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);

    // 1. Previsualización: el fichero viaja entero y vuelve el banco detectado
    //    y los conteos (nuevas/duplicadas). Sin estado en el servidor.
    await page.locator('input[type="file"]').setInputFiles(SAMPLE);
    await expect(page.getByText(/nuevas/i)).toBeVisible();

    // 2. Si el extracto trae cuentas que el hogar no conoce (unknown_refs),
    //    la previsualización pide crearlas: rellena el formulario mínimo.
    const accountForm = page.getByLabel('Nombre de la cuenta');
    if (await accountForm.count()) {
      await accountForm.first().fill('Cuenta corriente E2E');
    }

    // 3. Confirmar: reenvía el fichero + el JSON de cuentas nuevas, inserta el
    //    lote y ejecuta el pipeline. El historial gana una fila.
    await page.getByRole('button', { name: 'Confirmar' }).click();
    const batchRow = page.locator('tr, li', { hasText: path.basename(SAMPLE) }).first();
    await expect(batchRow).toBeVisible();

    // 4. Los movimientos importados existen bajo RLS.
    await page.goto(`/h/${HOUSEHOLD}/finanzas/movimientos`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // 5. Deshacer (comando finance.import.undo): borrar el lote arrastra sus
    //    transacciones (ON DELETE CASCADE) y el historial vuelve a su estado.
    await page.goto(`/h/${HOUSEHOLD}/finanzas/importar`);
    await page.locator('tr, li', { hasText: path.basename(SAMPLE) }).first()
      .getByRole('button', { name: 'Deshacer' }).click();
    await expect(page.locator('tr, li', { hasText: path.basename(SAMPLE) })).toHaveCount(0);
  });
  ```
- [ ] **Step 3: Ejecuta.**
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  pnpm test:e2e:db
  ```
  Salida esperada: batería en verde incluida esta spec. El deshacer restaura el estado, así que las specs vecinas no ven residuos. Si la previsualización marca todas las filas como duplicadas, es que otra spec ya importó esa muestra sin deshacer: revisa que el paso 5 se ejecute siempre (usa `test.afterEach` con el deshacer si hiciera falta garantizarlo ante fallos intermedios).
- [ ] **Step 4: Commit.**
  ```bash
  git add apps/web/e2e/finanzas-importar.dbe2e.ts
  git commit -m "test(dbe2e): importar, confirmar y deshacer contra Postgres real"
  ```

---

### Task 5: Cableado final de CI — el inventario de suites alcanza los ficheros de finanzas

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: `scripts/ci/assert-suite-coverage.py` ejecutado en local con evidencia JUnit real

**Interfaces:**
- Consumes: `scripts/ci/assert-suite-coverage.py` (contrato `--specs 'BASE::GLOB'`, glob con `recursive=True`); informes JUnit de vitest (nombre de `testsuite` relativo a la raíz del workspace) y de Playwright (relativo a `testDir`).
- Produces: gate `suite-coverage` capaz de inventariar `packages/server/src/finance/*.test.ts` y cualquier test anidado futuro; constancia de que las specs nuevas de las tareas 1–4 ya quedan cubiertas por los globs existentes.

Contexto: el job `suite-coverage` de `.github/workflows/ci.yml` inventaría `packages/server::src/*.test.ts` y `apps/web::tests/*.test.ts`. En Python, `glob` sin `**` NO desciende a subdirectorios: los tests de `packages/server/src/finance/` (fase 2) correrían en el job `integration` pero quedarían FUERA del inventario del gate — exactamente el agujero que ese gate existe para cerrar. Las specs de Playwright nuevas (`finanzas.e2e.ts`, `finanzas-concesion.dbe2e.ts`, `finanzas-importar.dbe2e.ts`, y las pruebas añadidas a `critical.a11y.ts`) SÍ las cubren ya los globs `apps/web/e2e::*.e2e.ts` / `*.dbe2e.ts` / `*.a11y.ts`: ahí no hay nada que tocar.

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
  export TEST_DATABASE_URL='postgresql://casa_admin@127.0.0.1:54329/casaclara_wt_u'
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
- Test: `pnpm --filter @casa-clara/web verify:bundle` y `pnpm test:lighthouse`

**Interfaces:**
- Consumes: `apps/web/src/lib/finance/filters.ts` (módulo cliente de finanzas, fase 4); la lista `FORBIDDEN_IN_INITIAL_GRAPH` de `verify-today-bundle.mjs`; `infra/quality/lighthouserc.json` (LCP ≤ 2000 ms, TBT ≤ 200 ms, script ≤ 122880 bytes, a11y = 1).
- Produces: guarda permanente que hace fallar la build si cualquier módulo de finanzas alcanza el grafo inicial de Hoy (spec §8 «Presupuestos»).

- [ ] **Step 1: Comprueba a mano que nada fuera del módulo importa finanzas** (la fuga típica sería un import estático desde el AppShell o el layout):
  ```bash
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  grep -rn "lib/finance" apps/web/src --include='*.svelte' --include='*.ts' \
    | grep -v 'src/lib/finance/' \
    | grep -v 'src/lib/components/finance/' \
    | grep -v 'routes/h/\[householdId\]/finanzas' \
    | grep -v 'routes/api/v1/finance'
  ```
  Salida esperada: vacía. Cada línea que aparezca es una fuga: muévela a la ruta de finanzas o hazla import dinámico antes de seguir.
- [ ] **Step 2: Construye y averigua el id exacto del módulo en el mapa de trozos** (la forma del id es la que compara la guarda tras `normalize`):
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  pnpm --filter @casa-clara/web build
  grep -o '"[^"]*finance/filters[^"]*"' apps/web/.svelte-kit/casa-clara-module-map.json | head -1
  ```
  Anota el id (se espera `src/lib/finance/filters.ts`; si sale con otro prefijo, usa el que salga sin los `../` iniciales, que `normalize` ya los quita).
- [ ] **Step 3: Añade la regla a `FORBIDDEN_IN_INITIAL_GRAPH`** en `apps/web/scripts/verify-today-bundle.mjs`, tras la regla existente de `capabilities.ts` y con su mismo idioma (el porqué dentro del mensaje):
  ```js
  {
    module: 'src/lib/finance/filters.ts',
    why:
      'nada de Finanzas puede tocar el arranque de Hoy: el módulo entero vive en los chunks\n' +
      '    de sus rutas (/h/[householdId]/finanzas) y SheetJS es solo-servidor. Si este módulo\n' +
      '    aparece aquí, una importación estática desde el layout o desde Hoy lo está\n' +
      '    arrastrando por alcanzabilidad: hazla dinámica o devuélvela a la ruta de finanzas.'
  }
  ```
- [ ] **Step 4: Verde del presupuesto.**
  ```bash
  pnpm --filter @casa-clara/web verify:bundle
  ```
  Salida esperada: `Today initial graph: N files, M bytes (K de margen sobre 120000); WikiEditor remains route-lazy.` sin excepción. Si la regla nueva dispara, la propia excepción nombra los bytes y el porqué: arregla la fuga (Step 1) y repite.
- [ ] **Step 5: Lighthouse.**
  ```bash
  pnpm test:lighthouse
  ```
  Salida esperada: las cuatro aserciones de `infra/quality/lighthouserc.json` en verde sobre `/login` y `/offline` (finanzas no toca esas rutas: si algo falla aquí es una regresión del arranque, no del módulo — diagnostica con el informe de `artifacts/lighthouse`).
- [ ] **Step 6: Commit.**
  ```bash
  git add apps/web/scripts/verify-today-bundle.mjs
  git commit -m "build(presupuestos): finanzas queda desterrado del arranque de Hoy por guarda"
  ```

---

### Task 7: Revisión de seguridad del módulo, con evidencia ejecutada

**Files:**
- Create: `docs/security/revision-finanzas.md`
- Test: los comandos de verificación del propio documento (cada uno con su salida esperada)

**Interfaces:**
- Consumes: `app.finance_enabled()` y las políticas RLS de `0034_finance.sql`; `requireFinanceAdmin` de `packages/server/src/commands/finance.ts`; los endpoints `GET/POST /api/v1/finance/*`; suites `pnpm test:db` (tests/010: ninguna tabla sin RLS) y `pnpm test:rls` (020 + `tests/030_finance_rls.sql`).
- Produces: la revisión de seguridad de la spec §10, como checklist ejecutada y fechada (patrón de documento: `docs/security/security-baseline.md`, secciones cortas con controles verificables).

- [ ] **Step 1: Ejecuta las cinco comprobaciones y guarda las salidas.** Desde la raíz del worktree, con `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`:
  1. RLS automática y matriz negativa: `pnpm test:db && pnpm test:rls` → todas las suites en verde (010 cubre las 10 tablas `finance_*`; 030 es la matriz de doble cerrojo: admin-con-concesión ve, admin-sin-concesión 0 filas, los otros 4 roles 0 filas, cero fugas roble↔olivo, suplantación 42501).
  2. Ningún endpoint REST sin cerrojo: `grep -rL "requireFinanceAdmin" $(find apps/web/src/routes/api/v1/finance -name '+server.ts')` → salida vacía (`grep -L` lista los ficheros SIN la llamada; cualquier ruta que aparezca es un agujero y se corrige antes de cerrar la tarea).
  3. Ningún comando sin cerrojo, y grant/revoke con `access.manage`: `grep -c "requireFinanceAdmin" packages/server/src/commands/finance.ts` → ≥ 1; `grep -n "access.manage" packages/server/src/commands/finance.ts` → aparece en los handlers de `finance.grant.write` y `finance.revoke.write`.
  4. Los extractos no se persisten: `grep -rn "writeFile\|createWriteStream\|putObject\|storage" apps/web/src/routes/api/v1/finance packages/server/src/finance --include='*.ts' | grep -v '\.test\.'` → salida vacía (el multipart se procesa en memoria, spec §10).
  5. Ningún dato real en el repo: `git grep -l "finanzas\.db\|informe-semestre1" -- ':!docs/superpowers'` → vacío, y revisión manual de que las muestras de `packages/server` usan titulares e importes inventados (anota los ficheros revisados).
- [ ] **Step 2: Escribe `docs/security/revision-finanzas.md`** con esta estructura (rellena cada «Resultado» con la salida real y la fecha):
  ```markdown
  # Revisión de seguridad del módulo Finanzas

  Fecha: <fecha de ejecución> · Revisión sobre la rama `worktree-modulo-finanzas`.
  Complementa a [security-baseline.md](security-baseline.md); el diseño del doble
  cerrojo está en la spec del módulo (§4 y §10).

  ## Controles verificados

  | # | Control | Cómo se verifica | Resultado |
  |---|---|---|---|
  | 1 | RLS en todas las tablas `finance_*` y matriz negativa de doble cerrojo | `pnpm test:db && pnpm test:rls` | <verde, suites y fecha> |
  | 2 | Todos los endpoints `/api/v1/finance/*` exigen sesión + membresía + `requireFinanceAdmin` | `grep -rL "requireFinanceAdmin" $(find apps/web/src/routes/api/v1/finance -name '+server.ts')` vacío | <vacío> |
  | 3 | Todos los comandos `finance.*` pasan por `requireFinanceAdmin`; `grant/revoke` exigen además `access.manage` | greps sobre `packages/server/src/commands/finance.ts` | <líneas encontradas> |
  | 4 | Los extractos subidos no se persisten en ningún almacenamiento | grep de escrituras en los caminos de importación, vacío | <vacío> |
  | 5 | Ningún dato bancario real en el repositorio | `git grep` + revisión manual de las muestras sintéticas | <ficheros revisados> |

  ## Lo que queda fuera y por qué

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
- Consumes: la tabla «Dónde está cada cosa» de `SKILL.md` (columnas Área/Pantalla/Rol mínimo/Detalle) y la estructura por secciones `## …` de `referencia-operaciones.md`; comandos `finance.grant.write`/`finance.revoke.write`; runbook de la migración (`docs/runbooks/migrar-home-finance.md`, fase 3).
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
    [docs/runbooks/migrar-home-finance.md](../../../docs/runbooks/migrar-home-finance.md).
  ```
- [ ] **Step 3: Verifica las anclas y commit.**
  ```bash
  grep -n "^## Finanzas" .claude/skills/operar-la-casa/referencia-operaciones.md
  grep -n "finanzas" .claude/skills/operar-la-casa/SKILL.md
  git add .claude/skills/operar-la-casa/SKILL.md .claude/skills/operar-la-casa/referencia-operaciones.md
  git commit -m "docs(skill): operar finanzas — concesión y operación mensual"
  ```

---

### Task 10: El runbook de despliegue cuenta con Finanzas

**Files:**
- Modify: `docs/despliegue/runbook-despliegue.md`
- Test: greps de verificación al final de la tarea

**Interfaces:**
- Consumes: `docs/despliegue/runbook-despliegue.md` (§2 «Aplicar el esquema», §7 «Humo posterior al despliegue»); migración `0034_finance.sql`; runbook de migración de la fase 3.
- Produces: runbook de despliegue actualizado (alcance de la fase: criterio de migraciones al día, humo con finanzas, sin variables nuevas).

- [ ] **Step 1: Actualiza el criterio de salida de las migraciones.** En §2, paso 2, sustituye la línea `Criterio de salida: **17/17 migraciones aplicadas**. Repetir el comando debe` por:
  ```markdown
  Criterio de salida: **34/34 migraciones aplicadas** (la última, `0034_finance.sql`;
  el número exacto lo dice el propio runner al terminar). Repetir el comando debe
  ```
- [ ] **Step 2: Nota de Finanzas en §2.** Tras el paso 4 de §2 (Better Auth), añade:
  ```markdown
  5. **Finanzas no añade variables de entorno**: SheetJS vive solo en el servidor y
     los extractos no se persisten, así que no hay bucket ni clave nuevos. Lo único
     que trae la 0034 es el esquema y su RLS de doble cerrojo. La carga de los datos
     históricos es una migración única aparte, con su propio runbook:
     [`../runbooks/migrar-home-finance.md`](../runbooks/migrar-home-finance.md) —
     **no se ejecuta sin confirmación explícita del propietario**.
  ```
- [ ] **Step 3: Humo con Finanzas en §7.** Añade a la lista de comprobaciones de «7. Humo posterior al despliegue», tras la línea del login:
  ```markdown
  - [ ] Con una concesión de Finanzas activa (Ajustes → tarjeta Finanzas), el
        Dashboard de `/h/<hogar>/finanzas` responde y pinta los KPIs; una cuenta
        sin concesión no ve el módulo en la navegación y recibe 403 por URL directa.
  ```
- [ ] **Step 4: Verifica y commit.**
  ```bash
  grep -n "34/34\|migrar-home-finance\|tarjeta Finanzas" docs/despliegue/runbook-despliegue.md
  git add docs/despliegue/runbook-despliegue.md
  git commit -m "docs(despliegue): el runbook cuenta con la 0034 y el humo de finanzas"
  ```

---

### Task 11: Ensayo local COMPLETO de la migración contra Docker

**Files:**
- Modify: `docs/runbooks/migrar-home-finance.md` (solo si el ensayo revela erratas del runbook de la fase 3; el procedimiento no se cambia, se corrige)
- Test: el informe de verificación del ETL y el humo de las 7 pantallas; **ninguna evidencia con datos reales entra en el repo**

**Interfaces:**
- Consumes: `packages/db/scripts/migrar-home-finance.mjs` con su contrato CLI exacto — `--household <slug>`, `--dry-run`, `--verify-only`, `--force-empty-check` (interfaces §packages/db); el runbook de ensayo de la fase 3 (`docs/runbooks/migrar-home-finance.md`; si la fase 3 lo dejó con otro nombre, localízalo con `ls docs/runbooks/ | grep -i finan` y usa ese, sin renombrarlo); la base origen `/home/abf/github/home-finance/backend/data/finanzas.db` (SOLO LECTURA); `pnpm db:migrate`.
- Produces: el ensayo exigido por la spec §9.4 ejecutado de cabo a rabo sobre el código terminado, con informe local guardado FUERA de ambos repos.

**Los datos migrados son reales.** Viven en el Docker local y en el informe local, nunca en git, nunca en fixtures, nunca en un test. Cualquier fichero que este ensayo produzca se guarda fuera del árbol de ambos repos.

- [ ] **Step 1: Localiza y lee ENTERO el runbook de la fase 3.**
  ```bash
  ls docs/runbooks/ | grep -i finan
  ```
  Se espera `migrar-home-finance.md`. Léelo completo antes de ejecutar nada: este ensayo es ese runbook «de cabo a rabo», y si en algún paso el runbook y esta tarea difieren, manda el runbook (y se anota la discrepancia).
- [ ] **Step 2: Verifica que la copia de seguridad datada del origen existe** (la que exige el runbook como paso previo, spec §9.1 y §13: única copia de la BD origen). Comprueba en la ruta que el runbook nombra que hay una copia fechada de `finanzas.db` FUERA de los árboles de ambos repos y que su tamaño coincide con el original (`ls -l /home/abf/github/home-finance/backend/data/finanzas.db` como contraste). Si no existe, créala exactamente como diga el runbook ANTES de seguir.
- [ ] **Step 3: Postgres 18.4 limpio en Docker y esquema completo.**
  ```bash
  docker run --name cc-finanzas-ensayo \
    -e POSTGRES_USER=casa_admin -e POSTGRES_PASSWORD=ensayo-local \
    -e POSTGRES_DB=casaclara_ensayo \
    -p 127.0.0.1:54340:5432 -d postgres:18.4-alpine
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  export ENSAYO_URL='postgresql://casa_admin:ensayo-local@127.0.0.1:54340/casaclara_ensayo'
  DATABASE_URL="$ENSAYO_URL" pnpm db:migrate
  DATABASE_URL="$ENSAYO_URL" pnpm db:migrate   # idempotencia: la segunda aplica 0
  ```
  Salida esperada: primera pasada aplica las 34 migraciones (0001–0034); segunda pasada, 0.
- [ ] **Step 4: Alta del hogar de ensayo** siguiendo el paso correspondiente del runbook de la fase 3 (que a su vez sigue `docs/despliegue/alta-de-hogar.md`). Anota el slug del hogar: es el `--household` de los pasos siguientes.
- [ ] **Step 5: ETL en ensayo, en el orden del contrato.**
  ```bash
  DATABASE_URL="$ENSAYO_URL" node packages/db/scripts/migrar-home-finance.mjs --household <slug> --dry-run
  DATABASE_URL="$ENSAYO_URL" node packages/db/scripts/migrar-home-finance.mjs --household <slug>
  DATABASE_URL="$ENSAYO_URL" node packages/db/scripts/migrar-home-finance.mjs --household <slug> --verify-only
  ```
  El informe de verificación (obligatorio: conteos por tabla origen=destino, suma de `amount_cents` por cuenta y mes idénticas, grupos de transferencia con suma 0, distribución de estados, min/max de fechas) se imprime y se guarda donde diga el runbook, **fuera del repo**. Contrasta además a ojo contra `/home/abf/github/home-finance/backend/data/informe-semestre1-2026.md` (solo lectura). Repetir el ETL sin `--force-empty-check` debe abortar por «el hogar ya tiene datos»: compruébalo.
- [ ] **Step 6: Humo de la UI con ese hogar**, siguiendo el paso de smoke del runbook de la fase 3 (arranque local de la web contra `$ENSAYO_URL`). Recorre las 7 pantallas y comprueba que Dashboard, Movimientos y Analítica cuadran con los números del informe del Step 5 (ingresos, gastos, ahorro y conteo de movimientos del semestre).
- [ ] **Step 7: Limpieza y cierre.**
  ```bash
  docker rm -f cc-finanzas-ensayo
  ```
  Si el ensayo destapó una errata del runbook (un comando que no era, una ruta que faltaba), corrígela ahora en `docs/runbooks/migrar-home-finance.md` y committea:
  ```bash
  git add docs/runbooks/migrar-home-finance.md
  git commit -m "docs(runbook): corregir lo que falló al ensayar la migración de finanzas"
  ```
  Si el ensayo destapó un bug de código o de datos: PARA, arréglalo con su test en la tarea que corresponda, y **repite esta tarea desde el Step 3**. El ensayo solo se da por bueno si sale limpio de una pasada.

---

### Task 12: Puerta de producción — todo en verde, y solo entonces preguntar

**Files:**
- Test: todos los gates del repositorio; sin cambios de código

**Interfaces:**
- Consumes: todos los gates de la rama (interfaces §Restricciones globales) más las baterías de navegador y los presupuestos.
- Produces: la evidencia de que la rama está entregable ANTES de la primera acción contra producción. **Ninguna tarea posterior puede empezar sin esta cerrada.**

- [ ] **Step 1: Pasada completa de gates, en secuencia** (las suites de BD nunca en paralelo):
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  cd /home/abf/github/housekeeper/.claude/worktrees/modulo-finanzas
  pnpm lint && pnpm typecheck && pnpm check
  pnpm test
  pnpm test:db
  pnpm test:rls
  pnpm --filter @casa-clara/web build && pnpm --filter @casa-clara/web verify:bundle
  pnpm test:e2e
  pnpm test:a11y
  pnpm test:e2e:db
  pnpm test:lighthouse
  ```
  Criterio: TODO en verde, sin excepciones ni skips nuevos. Cualquier rojo se arregla (con su test) antes de continuar; esta tarea se repite desde el principio tras cada arreglo.
- [ ] **Step 2: Working tree limpio y rama al día.** `git status` sin cambios sin committear (salvo artefactos ignorados) y `git log --oneline -15` mostrando los commits de las tareas 1–11.
- [ ] **Step 3: Ensayo local certificado.** Confirma que la tarea 11 terminó limpia de una pasada (informe verificado + humo de 7 pantallas). Si no, no hay puerta.
- [ ] **Step 4: PARAR y preguntar.** Escribe a Alberto el estado: gates en verde, ensayo limpio, y la lista de las tres tareas de producción (13, 14, 15) con lo que cada una hace. **No ejecutes nada de las tareas 13–15 hasta tener su confirmación explícita, tarea por tarea.** Sin respuesta, el trabajo de esta fase termina aquí y la rama queda lista para revisión y merge.

---

### Task 13: PRODUCCIÓN — migración 0034 y ETL real en Supabase — **REQUIERE CONFIRMACIÓN EXPLÍCITA DE ALBERTO ANTES DE EJECUTAR**

**Files:**
- Test: el informe de verificación del ETL contra producción (local, fuera del repo); sin cambios de código

**Interfaces:**
- Consumes: conexión directa 5432 de Supabase con rol propietario (patrón §2 de `docs/despliegue/runbook-despliegue.md`: el runner de migraciones toma un advisory lock de sesión que el pooler no conserva); `pnpm db:migrate`; `packages/db/scripts/migrar-home-finance.mjs` (mismo contrato CLI que en el ensayo); runbook `docs/runbooks/migrar-home-finance.md`.
- Produces: esquema 0034 vivo en producción y los 1.111 movimientos históricos migrados y verificados (spec §9.5).

**Cada step de esta tarea requiere la confirmación previa de Alberto para la tarea entera; si algo sale distinto de lo esperado, PARAR y consultar antes de continuar. Ninguna credencial se escribe en ningún fichero del repo.**

- [ ] **Step 1 (requiere confirmación de Alberto): Copia de seguridad previa de producción.** Antes de tocar el esquema, `pnpm backup:full` de casa-clara con el estado ACTUAL (pre-finanzas), siguiendo §8 del runbook de despliegue (`BACKUP_DATABASE_URL` = conexión directa; las `S3_*` del gestor de contraseñas). Verifica que el directorio final no es `.partial` y que `SHA256SUMS` existe.
- [ ] **Step 2 (requiere confirmación de Alberto): Migraciones en Supabase.**
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
  export DIRECTA='postgresql://postgres:CLAVE@db.PROYECTO.supabase.co:5432/postgres'   # del gestor de contraseñas
  DATABASE_URL="$DIRECTA" pnpm db:migrate
  DATABASE_URL="$DIRECTA" pnpm db:migrate   # repetir debe aplicar 0
  ```
  Criterio de salida: 34/34 aplicadas (la última, `0034_finance.sql`); segunda pasada, 0.
- [ ] **Step 3 (requiere confirmación de Alberto): ETL real, ensayado primero en seco.**
  ```bash
  DATABASE_URL="$DIRECTA" node packages/db/scripts/migrar-home-finance.mjs --household <slug-real> --dry-run
  DATABASE_URL="$DIRECTA" node packages/db/scripts/migrar-home-finance.mjs --household <slug-real>
  DATABASE_URL="$DIRECTA" node packages/db/scripts/migrar-home-finance.mjs --household <slug-real> --verify-only
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
