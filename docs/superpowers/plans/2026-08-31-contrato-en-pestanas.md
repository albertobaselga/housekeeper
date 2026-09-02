# Contrato en pestañas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La sección Contrato pasa a ser una sola pantalla con pestañas (rutas hermanas unidas por una barra común): Resumen, Conceptos, Vacaciones, Pagos y Contrato/Condiciones, por empleada, con alta de personas y documento de pago en PDF.

**Architecture:** Las pestañas son rutas SvelteKit (dos nuevas: `conceptos` y `pagos`), unidas por `EmploymentTabs.svelte`; el contenido existente se recoloca, no se reescribe. El PDF por liquidación se genera bajo demanda en el servidor con `pdf-lib` bajo RLS. Especificación: `docs/ux/rediseno-contrato-en-pestanas.md`.

**Tech Stack:** SvelteKit 2 + Svelte 5 (runas), TypeScript, Postgres con RLS, pdf-lib 1.17.1, Vitest, Playwright.

## Global Constraints

- Todo el texto visible y los comentarios, en castellano, con la voz de la casa (los comentarios explican decisiones, no describen líneas).
- El dinero NUNCA pasa por `Number`: `parseCents`/`formatCents` con `BigInt` (`model.ts:28-52`).
- CSS solo con tokens: `apps/web/scripts/lint-css-tokens.mjs` rechaza longitudes/colores/`font-weight` a pelo también en los `<style>` de los `.svelte`. `font-weight` solo 400/500/700.
- Rutas anidadas nuevas se declaran en `NESTED_ROUTE_CAPABILITY` o fallan cerradas.
- Ningún `<svelte:head><title>` en páginas: el título lo pinta el layout raíz desde `$lib/app-title`.
- El formulario de alta de personal sigue «liso» (sin `use:enhance`): decisión de presupuesto documentada en `personal/+page.svelte:145-154`.
- No tocar: la cola offline, los form actions existentes, el trigger append-only de versiones, `verify-today-bundle.mjs` (no importar nada nuevo hacia el grafo de Hoy).
- Comprobaciones: `pnpm --filter @housekeeper/web test` (unit), `pnpm typecheck`, `pnpm lint`, `pnpm --filter @housekeeper/web check` (incluye lint de CSS). Integración/e2e requieren Postgres (`test:e2e:db`, `*.integration.test.ts`); si el entorno no tiene BD, dejarlo dicho en el informe final.

---

### Task 1: Rutas nuevas declaradas — capacidad y título

**Files:**
- Modify: `apps/web/src/lib/auth/routing.ts:66-70` (NESTED_ROUTE_CAPABILITY)
- Modify: `apps/web/src/lib/app-title.ts:40-59` (SECTION_LABELS)
- Test: `apps/web/tests/routing.test.ts` (ver qué asserts cubren las 3 hijas actuales y añadir las 2 nuevas), `apps/web/tests/app-title.test.ts`

**Interfaces:**
- Produces: `NESTED_ROUTE_CAPABILITY['employment/conceptos'] === 'settlement.read'` y `NESTED_ROUTE_CAPABILITY['employment/pagos'] === 'settlement.read'`; `SECTION_LABELS['employment/conceptos'] === 'Conceptos del mes'`, `SECTION_LABELS['employment/pagos'] === 'Pagos'`.

- [ ] **Step 1: Test en rojo** — en `routing.test.ts`, junto a los casos de `employment/acuerdo|condiciones|vacaciones`, añadir que `guardForPath('/h/x/employment/conceptos')` y `.../pagos` devuelven `{known: true, capability: 'settlement.read'}`. Ejecutar `pnpm --filter @housekeeper/web test -- routing` → FALLA (`known: false`).
- [ ] **Step 2: Implementar** — añadir a `NESTED_ROUTE_CAPABILITY`:

```ts
  // · `employment/conceptos` — registrar y decidir extras, gastos y conceptos a
  //   mano. Misma llave que la raíz (`settlement.read`): la familia no
  //   administradora entra y ve lo pendiente en solo lectura, como hoy en la
  //   principal; quién escribe lo deciden las capacidades finas y la RLS.
  'employment/conceptos': 'settlement.read',
  // · `employment/pagos` — las cuentas de cada mes. Misma llave que la raíz;
  //   los importes los recorta la RLS igual que en el resumen.
  'employment/pagos': 'settlement.read'
```

  y a `SECTION_LABELS`: `'employment/conceptos': 'Conceptos del mes'`, `'employment/pagos': 'Pagos'`.
- [ ] **Step 3: Verde** — repetir los tests de routing y app-title. PASS.
- [ ] **Step 4: Commit** — `feat(web): declarar las rutas de conceptos y pagos del contrato`.

---

### Task 2: Ruta `employment/conceptos` (contenido movido desde la principal)

**Files:**
- Create: `apps/web/src/routes/h/[householdId]/employment/conceptos/+page.server.ts`
- Create: `apps/web/src/routes/h/[householdId]/employment/conceptos/+page.svelte`

**Interfaces:**
- Consumes: `loadEmploymentOverview` (mismo uso que `employment/+page.server.ts:6-27`, incluida `?empleada=` y `depends('cc:employment')`; en modo maqueta devuelve overview null → la página enseña su estado de solo lectura, sin fixture propio).
- Produces: página con `ExtraWorkPendingCard`, `ExpensesPendingCard` y `ManualAdjustmentsCard` con exactamente las mismas props que hoy les pasa `employment/+page.svelte:229-334`, más la tira de chips de empleada (copiar el bloque `:211-225` con hrefs a esta ruta) y `OutboxTriageCard`.

- [ ] **Step 1:** `+page.server.ts` — copiar el de la raíz (`employment/+page.server.ts`) cambiando la rama fixture: `return demoOrUnavailable(() => ({ overview: null }));` (la maqueta de demostración solo vive en el Resumen).
- [ ] **Step 2:** `+page.svelte` — `PageHeader` con `eyebrow="Contrato"`, `title="Conceptos del mes"`, `description="Jornadas extra, gastos, adelantos y ausencias: aquí se apuntan y aquí se deciden."`. Mover desde `employment/+page.svelte` los derivados que estas tarjetas necesitan (`agreement`, `isOwnAgreement`, `canRegisterExtra`, `canRegisterForEmployee`, `selectedEmployeeLabel`, `canSubmitExpense`, `canConfirmWork`, `canCloseSettlement`, `seesAmounts`, líneas `:26-72`) y las tres tarjetas + `OutboxTriageCard` + `ActionStatus`/`OptimisticActions` (mismo patrón `invalidateToken: 'cc:employment'`). Para quien no ve importes, conservar la tarjeta «Importes reservados» adaptada (`:341-348`).
- [ ] **Step 3:** Comprobar en frío: `pnpm --filter @housekeeper/web typecheck && pnpm --filter @housekeeper/web check`.
- [ ] **Step 4: Commit** — `feat(web): pestaña de conceptos del mes`.

---

### Task 3: Ruta `employment/pagos` (historial movido) 

**Files:**
- Create: `apps/web/src/routes/h/[householdId]/employment/pagos/+page.server.ts` (idéntico patrón que Task 2)
- Create: `apps/web/src/routes/h/[householdId]/employment/pagos/+page.svelte`

**Interfaces:**
- Consumes: `overview.settlements: SettlementView[]`, `SettlementActions` con las props de `employment/+page.svelte:454-460`, `openSettlementForm` (el `<details>` de apertura, `:136-164`, se muda aquí: abrir la cuenta es el primer acto del historial de pagos).
- Produces: una tarjeta por liquidación (mover el bloque `employment/+page.svelte:401-464` entero), cada una con el enlace del documento:

```svelte
<a class="button secondary small-button"
   href={`/api/v1/households/${overview.householdId}/settlements/${settlement.id}/documento`}
   download={`pago-${settlement.periodLabel.toLocaleLowerCase('es').replaceAll(' ', '-')}.pdf`}>
  Descargar el documento de pago (PDF)
</a>
```

  (El enlace se pinta para quien ve importes; el endpoint de Task 8 responde 404 al resto. Hasta que Task 8 exista el enlace devuelve 404: por eso Task 8 va antes de tocar las e2e.)

- [ ] **Step 1:** Server load como Task 2.
- [ ] **Step 2:** Página: `PageHeader` `title="Pagos"`, `description="Las cuentas de cada mes: qué se pagó, qué falta y su documento."` + selector de empleada + apertura de cuenta + historial movido.
- [ ] **Step 3:** `typecheck` + `check` en verde.
- [ ] **Step 4: Commit** — `feat(web): pestaña de pagos con el historial de cuentas`.

---

### Task 4: `EmploymentTabs.svelte` + integración en las seis rutas

**Files:**
- Create: `apps/web/src/lib/components/employment/EmploymentTabs.svelte`
- Modify: los seis `+page.svelte` de `employment{,/conceptos,/pagos,/vacaciones,/acuerdo,/condiciones}` — la barra se pinta inmediatamente después del `PageHeader`.

**Interfaces:**
- Produces: `<EmploymentTabs householdId={...} current="resumen|conceptos|vacaciones|pagos|contrato" empleada={agreementId|null} />`. Pinta solo las pestañas que las capacidades permiten y propaga `?empleada=`.

- [ ] **Step 1: Componente** (usa `useAppContext` para rol y `can`; enlaces, no tablist — son rutas):

```svelte
<script lang="ts">
  import { can } from '$lib/auth/capabilities';
  import { useAppContext } from '$lib/auth/context';

  let { householdId, current, empleada = null }: {
    householdId: string;
    current: 'resumen' | 'conceptos' | 'vacaciones' | 'pagos' | 'contrato';
    empleada?: string | null;
  } = $props();

  const context = useAppContext();
  const base = $derived(`/h/${householdId}/employment`);
  // La empleada elegida viaja con cada pestaña: cambiar de pestaña nunca
  // cambia de persona. Vacaciones y el contrato reciben el parámetro aunque
  // hoy pinten a todas: así el enlace de vuelta tampoco la pierde.
  const query = $derived(empleada ? `?empleada=${encodeURIComponent(empleada)}` : '');

  // La quinta plaza tiene dos caras: quien pacta ve «Contrato» (acuerdo);
  // quien solo lee ve «Condiciones». Nadie ve las dos.
  const contractTab = $derived(
    can(context.role, 'agreement.write')
      ? { href: `${base}/acuerdo`, label: 'Contrato' }
      : can(context.role, 'agreement.read')
        ? { href: `${base}/condiciones`, label: 'Condiciones' }
        : null
  );

  const tabs = $derived([
    { key: 'resumen', href: `${base}`, label: 'Resumen', show: true },
    { key: 'conceptos', href: `${base}/conceptos`, label: 'Conceptos', show: true },
    { key: 'vacaciones', href: `${base}/vacaciones`, label: 'Vacaciones', show: can(context.role, 'agreement.read') },
    { key: 'pagos', href: `${base}/pagos`, label: 'Pagos', show: true },
    ...(contractTab ? [{ key: 'contrato', href: contractTab.href, label: contractTab.label, show: true }] : [])
  ].filter((tab) => tab.show));
</script>

<!-- Enlaces con aria-current, no un tablist de widget: cada pestaña es una
     ruta con su propia capacidad y su propio trozo de JavaScript. -->
<nav class="employment-tabs scroller" aria-label="Secciones del contrato">
  {#each tabs as tab (tab.key)}
    <a
      class="chip {tab.key === current ? 'active' : ''}"
      href={`${tab.href}${query}`}
      aria-current={tab.key === current ? 'page' : undefined}
      data-sveltekit-noscroll
    >{tab.label}</a>
  {/each}
</nav>

<style>
  /* Misma receta que la tira de chips del expediente: scroller con máscara
     cuando no cabe, sin segunda línea de marco (spec mobile-overflow). */
  .employment-tabs {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }
</style>
```

  (Las clases `.chip`, `.chip.active` y `.scroller` ya existen en `app.css:775-801`; si `.scroller` está acoplada a `.chip-strip`, añadir en `app.css` la variante `.employment-tabs.scroller` junto a aquella, no duplicar la máscara en el componente.)
- [ ] **Step 2:** Integrar en las seis páginas con su `current` correcto y `empleada` = `agreement.id` seleccionado donde exista (`overview?.agreement?.id ?? null`; en acuerdo/condiciones/vacaciones, el `searchParams.get('empleada')` que llegue). En `condiciones` y `vacaciones` (voz de la empleada) la barra también se pinta: ella navega igual.
- [ ] **Step 3:** `check` + arrancar `pnpm dev` y navegar a mano las pestañas si el entorno lo permite.
- [ ] **Step 4: Commit** — `feat(web): barra de pestañas del contrato`.

---

### Task 5: El Resumen adelgaza

**Files:**
- Modify: `apps/web/src/routes/h/[householdId]/employment/+page.svelte`

**Interfaces:**
- Consumes: rutas de Tasks 2-4 ya operativas.

- [ ] **Step 1:** Retirar de la página: `ExtraWorkPendingCard`, `ExpensesPendingCard`, `ManualAdjustmentsCard`, `VacationsCard`, el formulario de apertura (`openSettlementForm`, ya mudado a Pagos), la tarjeta «Versiones y cambios de salario» (`:365-399`) y la de «Cuentas de cada mes» (`:401-464`), con sus imports y derivados que queden sin uso.
- [ ] **Step 2:** Añadir, debajo de la cuenta del mes, la tarjeta de pendientes (solo si hay algo que decidir o registrar):

```svelte
{#if overview.pendingExtras.length > 0 || overview.pendingExpenses.length > 0}
  <article class="card">
    <div class="section-heading">
      <div><p class="eyebrow">Por decidir</p><h2>Lo que espera en Conceptos</h2></div>
    </div>
    <div class="ledger-list">
      {#if overview.pendingExtras.length > 0}
        <div><span><strong>{overview.pendingExtras.length === 1 ? 'Una jornada extra' : `${overview.pendingExtras.length} jornadas extra`}</strong><small>Registradas y sin resolver del todo.</small></span>
        <a class="button secondary small-button" href={`/h/${overview.householdId}/employment/conceptos${agreement ? `?empleada=${agreement.id}` : ''}`}>Ir a Conceptos</a></div>
      {/if}
      {#if overview.pendingExpenses.length > 0}
        <div><span><strong>{overview.pendingExpenses.length === 1 ? 'Un gasto' : `${overview.pendingExpenses.length} gastos`}</strong><small>Presentados y sin decidir.</small></span>
        <a class="button secondary small-button" href={`/h/${overview.householdId}/employment/conceptos${agreement ? `?empleada=${agreement.id}` : ''}`}>Ir a Conceptos</a></div>
      {/if}
    </div>
  </article>
{/if}
```

  y, para quien ve importes, un chip-resumen de la última cuenta (tomar `overview.settlements[0]`: `periodLabel` + `paymentStateLabel` + enlace «Ver los pagos» a la pestaña Pagos). El `nav.action-row` con «Ver mis condiciones»/«Administrar el contrato» (`:357-364`) desaparece: eso ya es la barra de pestañas.
- [ ] **Step 2b:** La rama fixture (`data.employment`, `:523-558`) se conserva tal cual: es la demostración sin BD y no navega.
- [ ] **Step 3:** `check` + tests unit en verde.
- [ ] **Step 4: Commit** — `feat(web): el resumen del contrato se queda con el mes y sus saldos`.

---

### Task 6: Los orígenes de las líneas apuntan a su pestaña

**Files:**
- Modify: `apps/web/src/lib/employment/model.ts:823-838` (`sourceAnchor`), `:1307`, `:1370-1372`
- Modify: `apps/web/src/lib/server/employment.server.ts` (donde construye accrual y settlements, pasar las bases)
- Test: `apps/web/tests/employment-model.test.ts`

**Interfaces:**
- Produces: `sourceAnchor(sourceType, sourceId, bases?: SourceHrefBases)` con `export interface SourceHrefBases { conceptos: string; contrato: string; resumen: string }`. Sin `bases` conserva el fragmento actual (compatibilidad de tests y de la maqueta). Con `bases`: `jornadas-extra → ${bases.conceptos}#extra-{id}`, `gastos → ${bases.conceptos}#gasto-{id}`, `ajustes → ${bases.conceptos}#concepto-{id}`, `anticipos → ${bases.resumen}#anticipo-{id}`, `agreement-version → ${bases.contrato}#version-{id}`.
- `AccrualFacts` y la construcción de `SettlementView` ganan `hrefBases?: SourceHrefBases`; `employment.server.ts` las rellena: `conceptos: /h/{hid}/employment/conceptos`, `resumen: /h/{hid}/employment`, `contrato: acuerdo` si la membresía es `family_admin`, si no `condiciones`.

- [ ] **Step 1: Test en rojo** — en `employment-model.test.ts`, caso nuevo: con `hrefBases`, una línea de jornada extra produce `href === '/h/H/employment/conceptos#extra-E1'` y una de anticipo `'/h/H/employment#anticipo-A1'`; sin bases, se quedan como fragmento (asegurar que los asserts existentes siguen en pie).
- [ ] **Step 2:** Implementar en `model.ts` y enhebrar `hrefBases` por `buildAccrual` y `settlementLineHref`/`buildSettlementViews` hasta `employment.server.ts`.
- [ ] **Step 3:** Verde: `pnpm --filter @housekeeper/web test -- employment-model` y suite completa unit.
- [ ] **Step 4:** Los `id` ancla deben existir en el destino: comprobar que `ExtraWorkPendingCard`/`ExpensesPendingCard`/`ManualAdjustmentsCard` pintan `id="extra-{id}"`, `id="gasto-{id}"`, `id="concepto-{id}"` (hoy los pintaba la principal y las tarjetas; ajustar las tarjetas si falta alguno) y que las tarjetas de versiones (acuerdo y condiciones, Task 7b) llevan `id="version-{id}"`.
- [ ] **Step 5: Commit** — `feat(web): los orígenes de la cuenta enlazan a la pestaña donde viven`.

---

### Task 7: Vacaciones gana el formulario; el contrato, el alta y el historial

**Files:**
- Modify: `apps/web/src/routes/h/[householdId]/employment/vacaciones/+page.server.ts` y `+page.svelte`
- Create: `apps/web/src/lib/components/employment/StaffHireForm.svelte`
- Modify: `apps/web/src/routes/h/[householdId]/personal/+page.svelte` (usar el componente extraído), `personal/+page.server.ts` (solo si hay que exportar tipos)
- Modify: `apps/web/src/routes/h/[householdId]/employment/acuerdo/+page.server.ts` (action `?/hire`) y `+page.svelte`
- Modify: `apps/web/src/routes/h/[householdId]/employment/condiciones/+page.server.ts` y `+page.svelte`

**Interfaces:**
- `StaffHireForm.svelte` props: `{ householdId: string, hired: {name, username, password, withAgreement} | null, hireError: string | null, draft: {displayName?, username?, email?} | null }` — el markup es el de `personal/+page.svelte:112-218` movido literal (form liso `action="?/hire"`, sin `use:enhance`), con los estilos `.handout*`/`.inline-check` que le pertenecen.
- `?/hire` en acuerdo: mismo cuerpo que la action de `personal/+page.server.ts` (delegar en `hireHouseholdMember()` de `$lib/server/staff-hire.server.ts:121`); leer primero esa action y calcarla, no reinterpretarla.
- Vacaciones: el load añade `overview` (mismo `loadEmploymentOverview` con `?empleada=`) y la página pinta `VacationsCard` (props de `employment/+page.svelte:327-334`) encima del historial cuando `can(role,'leave.approve')` o hay saldo propio que enseñar.
- Condiciones: el load devuelve también `versions: AgreementVersionView[]` (ya vienen en el overview que consulta); la página añade al final la tarjeta «Historial de versiones» calcada de la que el Resumen pierde (`employment/+page.svelte:365-399`), en voz de tú («Tu contrato, versión a versión»), con `id="version-{id}"` por fila.
- Acuerdo: debajo de la tarjeta «Alta / Nuevo contrato» existente, tarjeta «Entra alguien nuevo en la casa» con `StaffHireForm` (visible siempre para quien llega: la ruta ya exige `agreement.write`, que solo tiene la administración). En cada fila de versión, `id="version-{id}"`.

- [ ] **Step 1:** Extraer `StaffHireForm` y dejar Personal funcionando igual (mismo HTML resultante; comprobar con `check` y mirando la página).
- [ ] **Step 2:** Action `?/hire` en acuerdo + tarjeta con el componente.
- [ ] **Step 3:** Vacaciones: load + `VacationsCard` + la persona elegida primero si llega `?empleada=`.
- [ ] **Step 4:** Condiciones: historial de versiones.
- [ ] **Step 5:** `check` + unit en verde. Nota: `staff-hire.integration.test.ts` protege el alta; si el entorno tiene BD, correrlo.
- [ ] **Step 6: Commit** — `feat(web): alta de personas desde el contrato, vacaciones con su formulario y condiciones con su historial`.

---

### Task 8: Documento de pago en PDF

**Files:**
- Create: `apps/web/src/lib/server/settlement-document.server.ts`
- Create: `apps/web/src/routes/api/v1/households/[householdId]/settlements/[settlementId]/documento/+server.ts`
- Test: `apps/web/tests/settlement-document.integration.test.ts` (patrón de `employment-export.integration.test.ts`)

**Interfaces:**
- `buildSettlementDocument(user: {id: string}, householdId: string, settlementId: string): Promise<{ pdf: Uint8Array; filename: string } | null>` — carga bajo RLS (patrón `withUserConnection` que use `employment-export.server.ts`); `null` si la RLS no devuelve la liquidación (→ 404 sin distinguir «no existe» de «no te toca», como `receipts/[expenseId]/+server.ts`).
- Contenido del PDF (todo dato ya existente en `SettlementRow/LineRow/PaymentRow` + nombre del hogar + etiqueta de la empleada): membrete con el nombre del hogar; «Documento de pago · {periodo}»; empleada; una línea por concepto (`concept`, fecha, importe con signo); total a pagar; debajo del total y NUNCA dentro, lo que consta sin transferirse (conceptos anotados y complementos que paga la casa, si los hay); pagos (método, fecha valor, referencia, importe); pagado/pendiente; estado de la confirmación de cobro; pie «Documento doméstico no oficial» y fecha de generación.
- Render: reutilizar los ayudantes de `employment-export.server.ts` (`pdfSafe`, la receta A4/Helvetica/paginado de `renderSummaryPdf:600`); exportarlos desde ese módulo si están privados, no copiarlos.
- Endpoint: calcar la disciplina de cabeceras de `receipts/[expenseId]/+server.ts` (401 sin sesión, 404 sin hogar, `nosniff`, CSP con sandbox, `cache-control: private, no-store`), con `content-type: application/pdf` y `content-disposition: attachment; filename="{filename}"`.

- [ ] **Step 1: Test en rojo** (si hay BD): la familia administradora descarga y los bytes empiezan por `%PDF`; el documento de una cuenta con extra + gasto + concepto anotado contiene sus tres etiquetas (extraer texto o comprobar longitud/estructura como haga `employment-export.integration.test.ts`); `family_member` recibe `null`/404; otra casa, 404.
- [ ] **Step 2:** Implementar módulo + endpoint.
- [ ] **Step 3:** Verde (o, sin BD, `typecheck`+`check` y el test queda escrito para CI).
- [ ] **Step 4: Commit** — `feat(web): documento de pago en PDF por cada cuenta`.

---

### Task 9: Atajos de Adelanto y Ausencia en los conceptos a mano

**Files:**
- Modify: `apps/web/src/lib/components/employment/ManualAdjustmentsCard.svelte`

**Interfaces:**
- Consumes: el formulario existente de la tarjeta (leerla entera antes de tocar; usa `recordManualAdjustment` de `commands.ts:344-374`).
- Produces: encima del formulario, tres botones de precarga — «Adelanto», «Ausencia», «Otro concepto» — que SOLO rellenan el mismo formulario (ninguna ruta de escritura nueva): Adelanto → etiqueta «Adelanto entregado», motivo «Entregado a cuenta el …», importe en negativo, descuenta del pago (`addsToPay: true`); Ausencia → etiqueta «Ausencia no retribuida», motivo con el día, importe en negativo, `addsToPay: true`; Otro → formulario en blanco como hoy. El importe queda editable: la precarga es un empujón, no una jaula.
- Nota en pantalla (audit-note): los anticipos con cuota siguen siendo de solo lectura en Resumen; este atajo apunta un descuento del mes.

- [ ] **Step 1:** Leer la tarjeta; añadir presets con `$state` local.
- [ ] **Step 2:** `check` en verde; probar a mano si hay entorno.
- [ ] **Step 3: Commit** — `feat(web): adelantos y ausencias como atajos del concepto a mano`.

---

### Task 10: Pruebas que navegan y barrido final

**Files:**
- Modify: `apps/web/e2e/family-employment.dbe2e.ts`, `apps/web/e2e/employee-flow.dbe2e.ts`, `apps/web/e2e/employment.e2e.ts`, `apps/web/e2e/mobile-densidad.dbe2e.ts`, `apps/web/e2e/critical.a11y.ts` (los que toquen las secciones movidas)
- Modify: `apps/web/tests/employment.integration.test.ts` y vecinos SOLO si asertan sobre la forma de la página (la mayoría asertan sobre el overview del servidor, que no cambia)

- [ ] **Step 1:** `grep -rn "employment" apps/web/e2e apps/web/src/lib/server/today.server.ts apps/web/src/lib/wiki` y revisar cada enlace/paso de navegación: lo que buscaba tarjetas en la principal ahora pasa por su pestaña (p. ej. aceptar jornada → `employment/conceptos`; cerrar y pagar → `employment/pagos`; apuntar vacaciones → `employment/vacaciones`).
- [ ] **Step 2:** Ejecutar TODO lo que el entorno permita: `pnpm --filter @housekeeper/web test`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @housekeeper/web check`; con BD: `pnpm test:e2e:db`, integración. Arreglar hasta verde.
- [ ] **Step 3:** Autorrevisión contra la especificación (`docs/ux/rediseno-contrato-en-pestanas.md`): cada requisito señalable a una pestaña/función entregada.
- [ ] **Step 4: Commit** — `test(web): la navegación por pestañas del contrato, cubierta`.
