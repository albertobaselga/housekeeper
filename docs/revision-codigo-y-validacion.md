# Revisión adversarial del sistema (v2)

**Fecha:** 7 de agosto de 2026
**Rama revisada:** `codex/brief-completion` (`f173653`)
**Contrato de aceptación:** `docs/acceptance/brief-v2-adapted.md` (AC-01…AC-26 + F4-01…F4-03)
**Baseline de seguridad:** `docs/security/security-baseline.md`
**Método:** ejecución completa de las suites, lectura de la evidencia criterio por criterio y catorce sondeos adversariales contra una base Postgres reprovisionada desde cero.

Esta revisión sustituye por completo a la anterior, que evaluaba el prototipo `demo-v0.1.0` ya retirado. El revisor no ha escrito ninguna línea del código evaluado y no ha modificado nada fuera de este documento.

---

## Resumen ejecutivo

Sobre los 29 criterios de la matriz adaptada (26 AC + 3 F4):

| Estado | Recuento | Criterios |
|---|---|---|
| **Cumplido** | 8 | AC-01, AC-03A, AC-14, AC-15, AC-16, AC-17, AC-23, F4-01 |
| **Parcial** | 20 | AC-02, AC-04, AC-05, AC-06A, AC-07, AC-08, AC-09, AC-10, AC-11, AC-12, AC-18, AC-19, AC-20, AC-21, AC-22, AC-24, AC-25, AC-26, F4-02, F4-03 |
| **Pendiente** | 1 | AC-13 |

**Todo lo automatizado está en verde.** `pnpm test` (290 pruebas en 47 ficheros), `pnpm lint`, `pnpm typecheck` (1.061 ficheros, 0 errores), `pnpm test:db` (esquema + matriz RLS), `pnpm db:migrate` ejecutado dos veces (idempotente), 15 pruebas Playwright y 3 de axe pasan sin un solo fallo. El código que existe está bien construido: la aritmética es exacta en `bigint`, los invariantes críticos viven en la base de datos y no en la aplicación, y los sondeos de aislamiento multi-tenant y de inmutabilidad resistieron todos los intentos de tumbarlos.

**El problema no es la calidad de lo escrito, sino la distancia entre lo escrito y lo que la matriz exige como evidencia.** Tres huecos estructurales explican casi todos los "Parcial":

1. **La suite Playwright corre exclusivamente en modo fixture de solo lectura.** Los quince casos arrancan la web sin `DATABASE_URL` y varios de ellos *asertan que las acciones de escritura no existen* (`toHaveCount(0)` sobre el editor de menú, "expediente legible pero sin acciones de escritura"). Once criterios exigen literalmente evidencia E2E; ninguno la tiene sobre datos reales.
2. **No existe ninguna ruta de adjuntos.** `app.storage_objects` está en el esquema y ClamAV levanta en Compose, pero ni `apps/web/src` ni `packages/server/src` mencionan la tabla. El almacén `blobs` de IndexedDB guarda la foto en el dispositivo y `sync.ts` nunca la sube. AC-07, AC-11 y AC-12 dependen de esto, y el control 5 del baseline no tiene código.
3. **Un defecto funcional bloqueante sin cubrir:** el feed ICS es inalcanzable en cualquier despliegue real (sonda S4a).

Con la regla de salida vigente ("cero defectos P0/P1"), **ningún gate está en condiciones de declararse superado hoy**. F2 es el más cercano y su cierre es cuestión de horas; F1 y F4 requieren trabajo de implementación, no solo de pruebas.

---

## Verificación global ejecutada

| Comando | Resultado |
|---|---|
| `pnpm install` | OK (618 paquetes, lockfile íntegro) |
| `pnpm db:migrate` (1.ª pasada) | Aplica 0008, 0009, 0010 sobre una base con restos previos |
| `pnpm db:migrate` (2.ª pasada) | `Database is up to date; no migrations applied.` Runner idempotente |
| `TEST_DATABASE_URL=… DATABASE_URL=… pnpm test` | **290 pasan, 0 fallan.** domain 33, contracts 5, worker 39, server 68, web 145 |
| `pnpm lint` | Limpio |
| `pnpm typecheck` | Limpio (`svelte-check`: 1.061 ficheros, 0 errores, 0 avisos) |
| `pnpm test:db` | `1..2 ok` (`010_schema_and_constraints.sql`, `020_rls_matrix.sql`) |
| `pnpm test:e2e` | 15 pasan en 8,9 s |
| `pnpm test:a11y` | 3 pasan en 7,6 s (login, Hoy, Emergencias; sin incidencias serias) |

Ningún rojo. Tres observaciones sobre la propia verificación, que condicionan cuánto vale ese verde:

- **`pnpm test` no ejecuta la matriz RLS ni el importador wiki.** `packages/db` no declara script `test`, solo `test:db`, `test:rls` y `test:import`, y `pnpm -r --if-present test` los salta. CI sí los invoca por separado (`.github/workflows/ci.yml`), pero en local un `pnpm test` verde no dice nada sobre RLS.
- **Toda suite de integración usa `describe.runIf(Boolean(adminUrl))`.** Sin `TEST_DATABASE_URL` desaparecen en silencio y el resultado sigue siendo verde. En CI el guardián `scripts/ci/run-tests-nonempty.sh` lo cubre; en local no hay red de seguridad.
- **ESLint ignora `**/*.svelte` por completo** (comentario en `eslint.config.mjs`: "pendiente de incorporarse"). Todos los componentes y páginas quedan fuera del lint.

---

## Matriz de criterios

Leyenda: **Cumplido** = evidencia ejecutable que ejercita el caso literal del criterio. **Parcial** = el mecanismo existe pero falta una parte nombrada de la evidencia exigida. **Pendiente** = sin implementación.

### Fase 1 — expediente laboral

| ID | Estado | Evidencia y hueco |
|---|---|---|
| AC-01 | **Cumplido** | `packages/domain/src/domain.test.ts` → `it("no aplica a marzo un cambio salarial de junio")` (la versión de junio está en el input y el motor elige `agreement-march`). Inmutabilidad en BD verificada por sonda **S3c**: el trigger de `0003_finance_and_documents.sql` rechaza el `UPDATE` de una línea de liquidación cerrada incluso ejecutado como superusuario. |
| AC-02 | **Parcial** | La cifra dorada de 1.453,30 € **no se reproduce por comandos**. Existe en tres sitios y ninguno es el recorrido real: (a) motor puro con `SettlementInput` escrito a mano (`packages/domain/src/domain.test.ts` → `it("reproduce el ejemplo de aceptación y mantiene trazabilidad")`); (b) filas precocinadas en `packages/db/fixtures/001_two_households.sql:250` y su aserción en `packages/db/tests/010_schema_and_constraints.sql:26`; (c) lectura de esas fixtures en `apps/web/tests/employment.integration.test.ts:88`. El único cierre end-to-end por comandos es **abril de 2025 por 154.450 €** (`packages/server/src/employment.integration.test.ts` → `it("cierra abril con líneas trazables, hash y el total exacto del motor…")`), correcto pero de otro mes y otro total. La tarifa congelada en su fecha sí está probada (`frozenUnitRateCents` v2, líneas 388-405). El "E2E de trazabilidad" que pide el criterio no existe: el único e2e laboral corre en modo fixture. |
| AC-03A | **Cumplido** | `packages/domain/src/domain.test.ts` → `it("genera descanso permanente, sin caducidad ni importe")` (0 € + crédito permanente). En BD: `packages/server/src/employment.integration.test.ts` → `it("resuelve un festivo trabajado como descanso y acredita 1440 min permanentes en el libro")`. Append-only confirmado por sonda **S3b**. Ninguna ruta del código contiene lógica de caducidad de saldo. |
| AC-04 | **Parcial** | Estados cubiertos: `packages/domain/src/domain.test.ts` → `it("conserva una jornada realizada sin aprobación hasta que se resuelva")` y `packages/server/src/expense-extra.integration.test.ts` → `it("mark_performed sin aceptación previa deja el evento pendiente de resolución")`. **Huecos:** no hay ningún job de avisos para trabajo pendiente de resolución (los únicos encolados son `notification.settlement_due` y `time_report.autoconfirm`); el "E2E por ambos roles" solo existe en modo fixture y verifica ausencia de acciones. |
| AC-05 | **Parcial** | El devengo del mes en curso **sí existe en la web**: `apps/web/src/lib/employment/model.ts:515` proyecta con `calculateSettlement` sobre los hechos reales del mes y `apps/web/src/routes/h/[householdId]/employment/+page.svelte:122,144,154` pinta resumen, desglose y ancla de origen por línea (`{#if line.href}<a href={line.href}>`). Probado en `apps/web/tests/employment-model.test.ts` y `apps/web/tests/employment.integration.test.ts`. **Hueco:** el "E2E de navegación" al origen no existe. |
| AC-06A | **Parcial** | Aviso D-3: `packages/server/src/reminders.integration.test.ts` → `it("el cierre de mayo encola notification.settlement_due con run_at = due_on - 3 días")` y escalada a +3 días en `apps/worker/src/reminders.test.ts`. WhatsApp: `apps/worker/src/integrations.ts:9` produce solo `wa.me`, probado en `apps/worker/src/documents.test.ts` → `it("solo crea enlaces WhatsApp iniciados por la persona")`. **Dos huecos:** (1) **el cierre no crea ningún evento de calendario** — `app_private.ics_feed_events` (`0009`) hace `LEFT JOIN app.routines` y no conoce las liquidaciones; (2) el "test que impide Cloud API" es la aserción del formato del enlace, no una prueba de ausencia. Ver además el defecto **P1-1** que deja el feed ICS inservible. |
| AC-07 | **Parcial** | Pagos parciales, exactos y exceso: `packages/server/src/employment.integration.test.ts` → `it("pago parcial no permite confirmar; el resto exacto sí, sin exceder jamás el total")` (`settlement_not_fully_paid`, `payment_exceeds_settlement`). **Huecos:** no existe ningún test de concurrencia (`Promise.all` / carreras) en `packages/server`; y el "justificante opcional durable" no tiene implementación — nadie sube nada a Storage. |
| AC-08 | **Parcial** | `confirm_receipt` sella `confirmed_by_employee_at` en una columna distinta del registro de pago familiar, y `derivePaymentStatus` distingue `paid` de `receipt_confirmed` (`packages/domain/src/domain.test.ts` → `it("solo confirma cobro cuando todos los pagos están confirmados")`). RLS verificado por sonda **S6**. **Hueco:** el E2E con `employee_live_in` (`apps/web/e2e/employment.e2e.ts:39`) es modo fixture y afirma "sin acciones de escritura". |
| AC-09 | **Parcial** | Job idempotente y escalada: `packages/server/src/reminders.integration.test.ts` (estado vía `app_private.settlement_reminder_state`) y `apps/worker/src/reminders.test.ts` (re-encolado a +3 días; estados terminales completan sin efecto). **Hueco:** sin E2E. |
| AC-10 | **Parcial** | `apps/web/e2e/offline.e2e.ts` → `test('las páginas visitadas siguen abriendo en modo avión')` abre `/emergency` con `context.setOffline(true)` y comprueba el `h1` y el texto "112". **Hueco central: no hay ninguna medición de tiempo.** No existe aserción de ≤500 ms en el test, ni presupuesto Lighthouse para esa ruta (`infra/quality/lighthouserc.json` solo mide `/login` y `/offline`, preset `desktop`), ni configuración móvil (`playwright.config.ts` define dos proyectos, ambos `devices['Desktop Chrome']`), ni evidencia de dispositivo Android de referencia. |
| AC-11 | **Parcial** | Sincronización única e idempotente probada a fondo: `packages/server/src/sync.integration.test.ts` → `it("acepta el gasto de la empleada, replica como duplicate y detecta payload alterado")`, más `apps/web/tests/sync.test.ts` y `apps/web/tests/offline.test.ts` → `it('keeps outbox records until explicit server acknowledgement')`. **Hueco crítico: el adjunto no se conserva.** `apps/web/tests/offline.test.ts` → `it('persists attachment blobs independently from the outbox')` solo demuestra que el Blob se guarda en IndexedDB; `apps/web/src/lib/offline/sync.ts` no menciona blobs y no hay endpoint de subida. La foto se queda en el teléfono. |
| AC-12 | **Parcial** | Verificado en vivo (sondas **S6** helper y **S6** viewer): cero filas en `settlements`, `settlement_lines`, `expenses`, `employment_agreements`, `payments` y `compensation_ledger_entries`. E2E de rol: `apps/web/e2e/roles.e2e.ts` → `it('la persona de apoyo tampoco accede a datos laborales')`. **Dos huecos frente al literal "Matriz negativa RLS/API/Storage":** `packages/db/tests/020_rls_matrix.sql` solo ejercita `family_admin`, `viewer` y el rol worker — faltan `family_member`, `employee_live_in` y `helper`, contra el control 1 del baseline que exige los cinco; y **no hay Storage que auditar**. |
| AC-13 | **Pendiente** | La exportación laboral de la empleada **no existe**. Lo único presente es `buildEmployeeExport()` en `apps/worker/src/documents.ts:103`, un constructor de ZIP determinista con test unitario (`apps/worker/src/documents.test.ts:38`) que **nadie invoca**: no hay tipo de job registrado en `apps/worker/src/index.ts`, ni endpoint, ni botón. El export que sí existe (`/api/v1/households/[householdId]/handover`) es el traspaso de F4-02 y está restringido a `family_admin` — la empleada recibe `null`. No hay PDF ni CSV de histórico a un clic. |

### Fase 2 — wiki y descubrimiento

| ID | Estado | Evidencia y hueco |
|---|---|---|
| AC-14 | **Cumplido** | `packages/db/scripts/wiki-import.test.mjs` sobre el corpus `packages/db/fixtures/wiki-corpus/`. Dry-run real (`it('el dry-run informa del plan completo sin escribir nada')` con conteos a cero), comparación estructural de jerarquía por `toEqual` de un mapa hijo→padre, front-matter (`title`, `aliases`, `tags`, `status`), reescritura de enlaces relativos a `wiki:slug` (`toContain('(wiki:placa-de-induccion)')`, `not.toContain('.md)')`), idempotencia del segundo pase y rollback total con identificación del fichero culpable. |
| AC-15 | **Cumplido** | Garantía estructural, no solo de test: `packages/db/migrations/0007_wiki_and_discovery.sql:302-305` define únicamente políticas `SELECT` e `INSERT` sobre `app.wiki_page_slugs`, de modo que el rol de la aplicación no puede liberar un slug jamás. Confirmado por sonda **S3e** (`permission denied for table wiki_page_slugs`). Comportamiento: `packages/server/src/wiki.integration.test.ts` → `it("crea, edita con control de revisión, renombra conservando slugs…")` y `apps/web/tests/wiki.integration.test.ts` → `it('un slug histórico redirige al slug vigente sin registrar lectura')`. |
| AC-16 | **Cumplido** | `packages/server/src/wiki.integration.test.ts:328` → `it("búsqueda: la errata 'lavadra' encuentra la lavadora y el alias 'vitro' trae la placa primero")`, con la cadena literal `lavadra` y la aserción exacta de posición: `expect(typo.slice(0, 3).some((r) => r.title === "Lavadora · programa corto")).toBe(true)`. Ejecutado bajo `withAuthorizedTransaction` con el login `it_casa_clara_app_login` (NOBYPASSRLS). |
| AC-17 | **Cumplido** | Mismo caso, líneas 355-366: `searchWiki(client, "vitro")` y `expect(alias[0]).toMatchObject({ id: placaId, title: "Placa de inducción", … })` — posición 1, bajo permisos reales de un `helper`. |
| AC-18 | **Parcial** | Clustering determinista literal: `packages/server/src/search-gaps.integration.test.ts` → `it("agrupa las variantes equivalentes en un único cluster y separa la consulta distinta")` (`robot cocina` / `robot cozina` / `robot de cocina` → un cluster) e `it("es determinista: dos llamadas devuelven exactamente el mismo resultado")`. **Hueco:** la "revisión de falsos positivos" que exige el criterio no existe en ninguna forma: no hay fixture de falsos positivos, ni columna `dismissed`/`reviewed`, ni comando ni UI de descarte. La única aserción negativa es que `seguro hogar` no se funde con `robot cocina`. |
| AC-19 | **Parcial** | El enlace `tel:` **sí está en la página de resultados**, en las dos ramas activas de `apps/web/src/routes/h/[householdId]/search/+page.svelte:49` (offline y live), con botón "Llamar" sin abrir la ficha. **Tres huecos:** (1) **ningún test toca esa página** — cero coincidencias de `telHref`, `contact-result` o `/h/*/search` en `apps/web/tests` y `apps/web/e2e`; (2) no hay e2e móvil, los dos proyectos Playwright son `Desktop Chrome`; (3) los contactos del resultado live no vienen de la BD sino de `getContactsFixture()` filtrado en memoria, así que no pasan por RLS. La tercera rama (modo demo) enlaza a la ficha, sin `tel:`. |
| AC-20 | **Parcial** | Imposibilidad estructural de guardar identidad: `app.wiki_page_reads` (`0007:164`) tiene PK `(household_id, page_id, read_on)` y **ninguna columna de usuario**; la única escritura es `app.record_wiki_read` (SECURITY DEFINER, `REVOKE ALL FROM PUBLIC`). Ventana de 30 días probada con precisión en `apps/web/tests/wiki.integration.test.ts` → `it('la portada del admin trae jerarquía, fijadas, borradores y contadores de 30 días')` (`reads30d === 5`: 3 de hoy + 2 de hace diez días, las 7 de hace cuarenta fuera). Agregación sin identidad: `packages/server/src/wiki.integration.test.ts` → `it("registra huecos de búsqueda agregados por día y lecturas sin identidad")` (dos lectores distintos → una fila, `read_count: 2`). **Hueco: no existe retención.** Cero coincidencias de purga o borrado sobre `wiki_page_reads` y `search_gap_events` en todo el repo; las filas antiguas se filtran en la consulta y permanecen para siempre, contra la regla de retención del baseline. |

### Fase 3 — comida y ritmo

| ID | Estado | Evidencia y hueco |
|---|---|---|
| AC-21 | **Parcial** | La matriz comensal-alimento-alérgeno existe de verdad: `app.eu_allergens`, `app.food_allergens`, `app.diners`, `app.diner_flags`, `app.menu_group_diners` (`0008_food_and_rhythm.sql`). Bloqueo y confirmación explícita en `packages/server/src/commands/menu.ts:165` (`allergen_conflict` si `acknowledgeAllergens !== true`), probado literalmente en `packages/server/src/food.integration.test.ts` → `it("AC-21: receta incompatible sin acknowledge se rechaza y con acknowledge procede")`. La UI lo implementa (`menu/+page.svelte:328-341`: banner de bloqueo, checkbox y submit deshabilitado). **Hueco:** cero cobertura de navegador; el único e2e de comida asserta `.menu-slot-editor` `toHaveCount(0)`. |
| AC-22 | **Parcial** | Caso literal 4→6 en dos capas: `apps/web/tests/food-quantities.test.ts` → `it('escala 4→6 raciones de forma exacta (AC-22)')` (`'1.50' → '2.25'`, `'800' → '1200'`, round-trip) y `packages/server/src/food.integration.test.ts` → `it("AC-22: escalado 4→6 multiplica los lineales por 1,5 exacto y respeta los 'fixed'")`. Aritmética en `BigInt` de centésimas, sin `float`. **Dos huecos:** (1) **no hay tests de propiedades** — cero coincidencias de `fast-check`, `fc.assert` o `property(` en el workspace, y ninguna dependencia de property-based testing; (2) la no linealidad es una etiqueta manual (`scaling: 'linear' \| 'fixed'`, seleccionada por el usuario), no una inferencia por unidad: no hay ningún test con "pizca" ni "al gusto", y una unidad `ud` marcada como lineal escala a fracciones sin que nada lo impida. |
| AC-23 | **Cumplido** | `packages/server/src/food.integration.test.ts` → `it("AC-23: duplicate_week dos veces produce el mismo resultado sin duplicados")`. La idempotencia se prueba por **identidad de filas** (`expect(secondPass.rows).toEqual(firstPass.rows)`), no por conteo; copia platos libres, recetas, notas y `servingsOverride` en una acción; rechaza el solapamiento con `week_overlap`; e invalida correctamente la confirmación del hueco destino. |
| AC-24 | **Parcial** | Agregación exacta y respeto estricto de unidades en `packages/server/src/food.integration.test.ts` → `it("AC-24: la compra agrega ingredientes iguales de dos recetas por unidad y sección más añadidos")` (250+500+250 = 1000 ml, el litro sigue siendo entrada aparte, agrupado por sección) y `apps/web/tests/food-quantities.test.ts` → `it('agrega cantidades de dos recetas de forma exacta')`. **Hueco:** no existe el E2E offline que pide el criterio; la lista ni siquiera tiene ruta propia (vive dentro de `/menu`) y ningún e2e la visita. |
| AC-25 | **Parcial** | Aserción de destinatarios impecable en `packages/server/src/rhythm.integration.test.ts` → `it("AC-25: los recipients de un aviso 'family' jamás incluyen a la empleada")` (`not.toContain(EMPLOYEE_EMAIL)`, `not.toContain(HELPER_EMAIL)`). Recurrencia trimestral en `it("completar la ocurrencia vigente avanza next_due_on según cada frecuencia")` (`quarterly`, `intervalCount: 2`, `2027-03-15 → 2027-09-15`). **Hueco:** esa rutina trimestral tiene `audience: "all"` y la rutina del test de destinatarios es `monthly`. **No existe ni un solo caso que combine `quarterly` con `audience: "family"`.** El criterio se infiere por composición de dos tests, no se ejercita. |
| AC-26 | **Parcial** | Hay evidencia ejecutable real, no solo una promesa: `apps/web/tests/food.integration.test.ts` → `it('loadRoutines: próxima fecha y ocurrencia vigente, sin porcentajes ni histórico (AC-26)')` cierra la superficie del DTO con `expect(Object.keys(plantas).sort()).toEqual([…])`, que rompería si alguien añadiese `completionRate`. **Huecos:** falta la "búsqueda de API/esquema" (ningún test recorre `information_schema` ni la superficie de comandos) y la "revisión E2E de todas las vistas"; de hecho el único e2e de rutinas asserta que `.routine-progress` **es visible** (progreso local de demo, no histórico, pero ningún test discrimina una cosa de la otra). |

### Fase 4 — plantillas, traspaso y accesos

| ID | Estado | Evidencia y hueco |
|---|---|---|
| F4-01 | **Cumplido** | `packages/server/src/templates.integration.test.ts` → `it("F4-01 multi-tenant: olivo no clona la plantilla de roble y no ve nada del clon")`. La clonación cruzada se rechaza por RLS (`template_not_found`: el origen literalmente no existe para el otro hogar, no es una comprobación aplicativa) y el aislamiento se verifica a tres niveles con `expect(olivoView).toEqual({ spaces: 0, pages: 0, revisions: 0 })`. Jerarquía y slugs en `it("set_template marca y desmarca; clone_template copia jerarquía, revisión vigente, slugs y enlaces")`. |
| F4-02 | **Parcial** | El manifest es sólido y verificable de verdad: `apps/web/tests/handover.integration.test.ts` → `it('el manifest lista cada fichero con su sha-256 correcto y un hash global verificable')` recalcula cada hash y el global; más determinismo byte a byte y el excelente `it('JAMÁS expediente laboral: ninguna entrada contiene los canarios sembrados')`. **Tres huecos frente al literal del criterio:** (1) **el round-trip no es un round-trip** — `it('round-trip: el directorio wiki/ del ZIP pasa por el importador sin errores')` invoca `importCorpus` con `dryRun: true` y no compara nada entre origen y destino; (2) **los adjuntos no se exportan** — `ALLOWED_ENTRIES` (`handover.server.ts:23-29`) es una allowlist cerrada de cinco patrones de texto, sin un solo byte binario; (3) **las relaciones se pierden** — `renderWikiPage()` emite front-matter sin campo de padre y escribe las páginas planas en `wiki/<space>/<slug>.md`, así que un export→import aplana el árbol; el fixture lo oculta porque solo tiene dos páginas hermanas. |
| F4-03 | **Parcial** | La revocación inmediata está bien probada para un rol: `packages/server/src/access.integration.test.ts` → `it("revocar corta el acceso al instante: la siguiente transacción del revocado lanza AuthorizationError")`, con el patrón correcto (transacción OK antes → revoke → `AuthorizationError` después). Las sondas **S7** y **S7b** confirman además que la barrera está en la propia base de datos, no solo en `withAuthorizedTransaction`. **Tres huecos:** (1) **la mitad "`expires_at` bloquea al vencer" no se ejercita en ningún sitio** — los dos tests de caducidad usan una fecha futura o rechazan la fecha pasada (`expiry_in_past`), y no hay test de reloj, ni fake timers, ni fixture vencida; (2) `020_rls_matrix.sql` no menciona `expires_at`; (3) la revocación se prueba para **un** rol (visor), no para los cinco que exige el criterio. |

---

## Sondeos adversariales ejecutados

Base exclusiva `casaclara_wt_k`, reprovisionada desde cero (`drop schema app cascade` → migraciones → fixtures). Rol de ataque `probe_casa_clara_app_login`: `LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE casa_clara_app`, es decir, exactamente los privilegios con los que corre la web en `infra/compose.local.yml` y `infra/compose.staging.yml`.

| # | Sondeo | Comando | Resultado | Veredicto |
|---|---|---|---|---|
| S1 | Leer la liquidación dorada de roble con contexto de olivo | `app.user_id='fixture:olivo:admin'`; `set_household_context(olivo)`; `select … from app.settlements where id='12b00000-…-000000000001'` | `filas devueltas: 0` | **Resiste** |
| S1b | Forzar el contexto de otro hogar | `app.set_household_context(roble, membresía de olivo)` con identidad de olivo | `42501: active membership not found for authenticated identity` | **Resiste** |
| S2 | Enviar por `processSyncBatch` un envelope con `householdId` de otro hogar | `processSyncBatch(pool, {userId:'fixture:roble:employee'}, [envelope{householdId: OLIVO, expense.submit}], PROD_HANDLERS)` con el mismo mapa de handlers que `/api/v1/sync` | ACK `rejected / not_authorized`; **0 filas persistidas**. Control con el hogar propio: `accepted` con `resourceId` — la sonda no falló por payload inválido | **Resiste** |
| S3a | `UPDATE` directo de una revisión wiki (sembrada por comando real) | `update app.wiki_revisions set body_markdown='MANIPULADO' where id=…`, ejecutado como `casa_admin` (superusuario, BYPASSRLS) | `55000: las revisiones de wiki son inmutables; añade una revisión nueva` | **Resiste** |
| S3b | `UPDATE` de un asiento del libro de compensación | `update app.compensation_ledger_entries set delta_minutes=1 where id='12700000-…'` (delta original 1440) | `55000: compensation ledger entries are append-only` | **Resiste** |
| S3c | `UPDATE` de una línea de la liquidación de marzo cerrada | `update app.settlement_lines set amount_cents=1 where id=…` | `55000: settlement lines are immutable after settlement closure` | **Resiste** |
| S3d | `DELETE` de un evento de auditoría | `delete from app.audit_events where id=…` | `55000: audit_events is append-only` | **Resiste** |
| S3e | Liberar un slug histórico con el rol de la aplicación (AC-15) | `delete from app.wiki_page_slugs where slug='pagina-sonda'` con contexto de `family_admin` bajo RLS | `42501: permission denied for table wiki_page_slugs` | **Resiste** |
| S3f | Borrar un gasto (hallazgo colateral) | `delete from app.expenses where description='Sonda control mismo hogar'` como superusuario | `55000: expenses cannot be deleted; cancel or reject instead` | **Resiste** |
| **S4a** | **Invocar `app_private.ics_feed_events` con el rol con el que corre la web** (lo que hace `GET /api/v1/ics/[token]`) | `select * from app_private.ics_feed_events('<hash>')` con `probe_casa_clara_app_login` | **`42501: permission denied for schema app_private`** | **FALLA — defecto P1-1** |
| S4b | Feed ICS revocado | `app_private.ics_feed_events(hash)` antes y después de `update ics_feeds set revoked_at = now()` | activo: 1 fila; revocado: **0 filas** (la ruta hace `error(404)` con cero filas) | **Resiste** |
| S5 | La empleada aprueba su propio gasto pendiente | `processSyncBatch(principal=fixture:roble:employee, expense{action:'approve'} sobre su propio gasto)` | ACK `rejected / not_allowed`; estado final `pending` | **Resiste** |
| S6 | `helper` y `viewer` leyendo el expediente laboral (AC-12) | `select count(*)` sobre `settlements`, `settlement_lines`, `expenses`, `employment_agreements`, `payments`, `compensation_ledger_entries` | `0` en las seis tablas, para ambos roles | **Resiste** |
| S7 / S7b | Membresía caducada y revocada usadas **sin** pasar por `withAuthorizedTransaction` | `update household_memberships set expires_at = ayer` (resp. `revoked_at = now()`); luego `app.set_household_context(roble, esa membresía)` | `42501: active membership not found for authenticated identity` en ambos casos | **Resiste** |

Trece de catorce sondeos rebotaron. El aislamiento multi-tenant, la inmutabilidad append-only y la separación de roles están donde deben estar —en la base de datos— y no se dejan tumbar ni desde SQL directo con superusuario ni desde la capa de comandos. El único que rompió, S4a, no es un fallo de seguridad sino de disponibilidad, y es tanto más grave por no tener ninguna prueba que lo detecte.

---

## Riesgos y deuda priorizada

### P1 — bloquean la declaración de gate

**P1-1. El feed ICS es inalcanzable en cualquier despliegue real.**
`packages/db/migrations/0001_identity_and_context.sql:20` concede `USAGE ON SCHEMA app_private` **solo a `casa_clara_worker`**. La migración `0009` concede `EXECUTE` sobre `app_private.ics_feed_events(text)` a `casa_clara_app`, pero sin `USAGE` sobre el esquema ese `GRANT` no sirve de nada. La ruta `apps/web/src/routes/api/v1/ics/[token]/+server.ts:39` es el único punto de `apps/web` que toca `app_private`, y en local y staging la web corre como `casa_clara_app_login` (Compose). Resultado: **toda petición al feed devuelve un error del servidor**, no el 404 diseñado. Ninguna prueba lo cubre: los tests de `rhythm.integration.test.ts` ejercitan los comandos `ics_feed create/revoke` sobre `app.ics_feeds`, nunca la función de emisión con el rol correcto. Reproducción: sonda S4a. *Propietario sugerido: equipo de BD. Corrección de una línea, pero exige además un test de la ruta con el rol de la aplicación.*

**P1-2. AC-13 no está implementado.** La exportación laboral de la empleada en PDF y CSV a un clic no existe en ninguna capa: sin job, sin endpoint, sin UI. `buildEmployeeExport()` es código muerto con test unitario. Es el único **Pendiente** de la matriz y hunde por sí solo la meta de 26/26.

**P1-3. No existe ninguna ruta de adjuntos.** `app.storage_objects` está en el esquema, ClamAV levanta en Compose y el worker sabe subir a S3 (solo el recibo), pero no hay ni un byte de código de aplicación que reciba, ponga en cuarentena, analice o publique un adjunto. El almacén `blobs` de IndexedDB nunca se vacía hacia el servidor. Consecuencia: AC-07 (justificante durable), AC-11 (conserva el adjunto) y la parte de Storage de AC-12 son inalcanzables, y el control 5 del baseline es papel.

**P1-4. La evidencia E2E que exige la matriz no existe.** Los 15 casos Playwright arrancan sin `DATABASE_URL` y varios asertan explícitamente la ausencia de las acciones que deberían probar. Once criterios (AC-02, 04, 05, 07, 08, 09, 13, 19, 21, 23, 24, 26) piden evidencia de navegador que hoy no se produce sobre datos reales. Mientras esto no cambie, la mayoría de los "Parcial" no puede promocionar por mucho que se refuercen los tests de integración.

### P2 — aplazables solo con propietario, fecha y aceptación explícita

- **P2-1. AC-10 sin medición.** No hay ningún número de milisegundos en ninguna parte del repositorio. El criterio es cuantitativo y hoy se evalúa cualitativamente.
- **P2-2. Matriz RLS negativa incompleta.** `020_rls_matrix.sql` cubre 3 de los 5 roles del brief. El control 1 del baseline exige los cinco.
- **P2-3. F4-03 sin test de reloj.** La mitad del criterio (`expires_at` bloquea al vencer) no se ejercita, y la revocación se prueba para un solo rol.
- **P2-4. Retención inexistente.** Ninguna purga de `wiki_page_reads` ni `search_gap_events`. El baseline pide reglas de retención como datos versionados; no hay ni reglas ni datos.
- **P2-5. `ALLOW_SYNTHETIC_DATA_ONLY` no lo lee nadie.** La variable se declara en `infra/compose.staging.yml` y en el workflow de navegador, pero cero líneas de código la consultan. El control 9 del baseline no se aplica: nada impide hoy que staging reciba datos reales.
- **P2-6. Sin logger con allowlist ni redacción.** No existe módulo de logging en el repositorio. El control 8 no está implementado ni puede verificarse.
- **P2-7. AC-06A no crea evento de calendario.** El cierre encola recibo y aviso D-3, pero ningún evento de calendario para el vencimiento; el feed ICS solo proyecta rutinas.
- **P2-8. Sin test de concurrencia de pagos.** AC-07 lo exige literalmente ("test de concurrencia DB") y `packages/server` no tiene ninguno.
- **P2-9. F4-02 aplana la jerarquía y omite adjuntos.** El traspaso no es reimportable con fidelidad estructural, y el único test que podría detectarlo es un dry-run sin comparación.
- **P2-10. CSP sin prueba.** La política con nonces está bien definida (`apps/web/svelte.config.js`) y Caddy añade su capa, pero ningún test comprueba la cabecera emitida. El control 7 depende de que nadie la rompa por accidente.

### P3 — deuda que conviene cerrar, sin bloquear

- **P3-1.** ESLint ignora `**/*.svelte`: toda la capa de presentación está sin lint.
- **P3-2.** `packages/db` no declara script `test`; `pnpm test` no ejecuta la matriz RLS ni el importador. Solo CI los cubre.
- **P3-3.** `describe.runIf(Boolean(adminUrl))` hace que las suites de integración desaparezcan en silencio sin base de datos.
- **P3-4.** AC-25: falta un único caso `quarterly` + `family`. Es trivial y cierra el criterio.
- **P3-5.** AC-22: sin property-based testing y sin cobertura de unidades no escalables por naturaleza ("pizca", "al gusto", huevos).
- **P3-6.** AC-18: sin mecanismo de revisión ni descarte de falsos positivos en los huecos documentales.
- **P3-7.** AC-19: la página de búsqueda no tiene ningún test y sus contactos "live" salen de fixture en memoria, no de la BD bajo RLS.
- **P3-8.** Comentario obsoleto en `packages/server/src/employment.integration.test.ts:289-290` ("el flujo administrativo de aprobación de gastos no forma parte de esta oleada"): ese flujo sí existe y está probado en `expense-extra.integration.test.ts`. El test siembra con `adminPool` (BYPASSRLS) donde ya podría usar el comando real.

---

## Desviaciones aprobadas vigentes

Copiadas de `docs/acceptance/brief-v2-adapted.md`, todas confirmadas en el código:

1. **AC-03:** las compensaciones no caducan. El saldo se conserva hasta su consumo o ajuste trazable; no existe aviso de caducidad. *Confirmado: no hay lógica de caducidad en `packages/domain/src/ledger.ts` ni en el esquema.*
2. **Fase 4:** incluye plantillas de wiki, exportación de traspaso y caducidad/revocación inmediata de accesos. Se mantienen únicamente los cinco roles del brief. *Confirmado: el enum de roles tiene exactamente cinco valores.*
3. **Fuera de alcance:** asistente conversacional y bitácora diaria. *Confirmado: sin rastro en el repositorio.*
4. **Recibo:** PDF mensual informal, claramente rotulado como no oficial. No se afirma conformidad con un modelo laboral oficial.
5. **WhatsApp:** solo enlaces `wa.me` iniciados conscientemente por una persona. No se usa Cloud API ni se envían mensajes automáticos. *Confirmado: `apps/worker/src/integrations.ts` solo construye `wa.me`; no hay dependencia de Cloud API.*
6. **Idioma:** interfaz inicial únicamente en español, con claves y modelo preparados para i18n. *Confirmado: `locale` en `app.wiki_revisions`, contenido solo en español.*
7. **Entornos:** esta oleada entrega local y staging sintético. No autoriza producción ni datos reales.

### Desviación no documentada que requiere aceptación explícita

**Editor visual de wiki (Milkdown).** No existe ninguna mención a Milkdown ni a ningún editor visual en el código, las dependencias o la documentación del repositorio: `apps/web/src/lib/components/wiki/WikiEditor.svelte` es un formulario con `<textarea>` de Markdown en crudo, cargado de forma diferida. Funciona y está probado (`apps/web/tests/wiki-commands.test.ts`), pero **la lista de desviaciones aprobadas de `docs/acceptance/brief-v2-adapted.md` no recoge este aplazamiento**. O bien se añade formalmente como octava desviación aprobada con propietario y fecha, o bien queda como criterio de producto incumplido y sin registrar. Clasificado aquí como P3 hasta que se decida.

---

## Recomendación sobre los gates

| Gate | Cumplido / Parcial / Pendiente | Recomendación |
|---|---|---|
| **F1** (AC-01…AC-13) | 2 / 10 / 1 | **No superado.** Acumula tres de los cuatro P1 (AC-13 sin implementar, sin ruta de adjuntos, sin E2E real) y el criterio cuantitativo AC-10 sin medir. |
| **F2** (AC-14…AC-20) | 4 / 3 / 0 | **No superado, pero al alcance.** Es el bloque más sólido: importador, slugs, `lavadra` y `vitro` son evidencia literal irreprochable. Bloquean la falta de retención (P2-4), la revisión de falsos positivos (AC-18) y que la página de búsqueda no tenga ni un test (AC-19). |
| **F3** (AC-21…AC-26) | 1 / 5 / 0 | **No superado.** El backend es correcto y está bien probado en todos los criterios; lo que falta es evidencia de navegador (AC-21, AC-24, AC-26) y dos casos de test triviales (AC-25 `quarterly`+`family`, AC-22 property-based). Es el gate con mejor relación entre trabajo pendiente y criterios que desbloquea. |
| **F4** (F4-01…F4-03) | 1 / 2 / 0 | **No superado.** F4-02 no hace el round-trip que declara y pierde adjuntos y jerarquía; F4-03 no ejercita la mitad del criterio (`expires_at`) y prueba la revocación en 1 de 5 roles. Además, P1-1 deja inservible una pieza entregada de esta fase. |

**Veredicto.** El sistema es notablemente más sólido de lo que sugiere el recuento: los invariantes que de verdad importan —aislamiento entre hogares, inmutabilidad del libro y de las liquidaciones, separación de roles, exactitud del dinero— resistieron todos los intentos de romperlos y viven en la base de datos, donde deben estar. Pero la regla de salida vigente es "cero defectos P0/P1", y hay cuatro P1 abiertos, uno de ellos un defecto funcional reproducible que ninguna prueba detecta. **No recomiendo declarar superado ningún gate hoy.** El camino más corto al verde es, por este orden: corregir P1-1 (una línea más su test), implementar AC-13, arrancar la suite Playwright contra Postgres real, y decidir si los adjuntos entran en esta oleada o se convierten en una desviación aprobada con propietario y fecha.
