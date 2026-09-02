# Revisión de seguridad del módulo Finanzas

Fecha: 2026-09-03 · Base de la revisión: commit `02a7597` de la rama del módulo
(`worktree-modulo-finanzas`), es decir, con las olas C y D de la fase 7 ya
dentro. Complementa a [security-baseline.md](security-baseline.md); el diseño
del doble cerrojo está en la spec del módulo (§4 y §10).

Todos los controles de esta página se **ejecutaron** el día de la fecha y la
columna «Resultado» recoge la salida real, no una expectativa. Las órdenes se
lanzan desde la raíz del repositorio, con Node 24 en el `PATH` y —los de base
de datos— con `TEST_DATABASE_URL` apuntando al Postgres desechable de pruebas
(`postgresql://<usuario>:<clave>@127.0.0.1:5439/casaclara_f5`; el contenedor
`casaclara-it-pg`). Sin esa variable, `run-sql-tests.mjs` aborta con
«TEST_DATABASE_URL or DATABASE_URL is required».

## Controles verificados

| # | Control | Cómo se verifica | Resultado |
|---|---|---|---|
| 1 | RLS en todas las tablas `finance_*` y matriz negativa de doble cerrojo | `pnpm test:db && pnpm test:rls` | **Verde.** `test:db`: `# tests 21 passed, 0 failed of 21`. `test:rls`: `# tests 2 passed, 0 failed of 2` (`020_rls_matrix.sql` y `030_finance_rls.sql`). Ambos con código de salida 0. |
| 2 | Todos los endpoints `/api/v1/finance/*` exigen sesión + membresía + `requireFinanceAdmin`, por los ayudantes `financeRead` / `previewImport` / `confirmImport` | `test -d` del directorio, `find … \| wc -l`, `find … -print0 \| xargs -0 -r grep -LE …` y `grep -n requireFinanceAdmin` en los dos módulos de servidor | **Verde.** Directorio presente; **11** `+server.ts` (el mínimo esperado era 9). La lista de los que se saltan los tres ayudantes sale **vacía**. `finance.server.ts` llama al cerrojo en 8 sitios (líneas 101, 144, 212, 518, **572** —`financeRead`—, 659, 753, 851); `finance-imports.server.ts` en 2 (líneas **111** y **165**, dentro de `previewImport` y `confirmImport`). |
| 3 | `grant`/`revoke` pasan por el ayudante de `access.manage`; todo lo demás cruza `requireFinanceAdmin` | greps sobre `packages/server/src/commands/finance.ts` | **Verde.** (a) El ayudante existe: `41:function requireAccessManagingAdmin(...)`, con `42: … !hasCapability(membership.role, "access.manage")`. (b) Los dos handlers pasan por él: `138: case "finance.grant.write":` → `139: requireAccessManagingAdmin(membership);` y `141: case "finance.revoke.write":` → `142: requireAccessManagingAdmin(membership);`. (c) El resto del despachador cruza el cerrojo antes del `switch`: `1290: await requireFinanceAdmin(client, membership);` (`grep -c` = 4 apariciones del nombre en el fichero). |
| 4 | Los extractos subidos no se persisten en ningún almacenamiento | `test -d` de los dos caminos + `grep -rn "writeFile\|createWriteStream\|putObject\|storage"` sobre ellos, sin tests | **Verde.** Los dos directorios existen y el grep sale **vacío**: el multipart se parsea en memoria dentro de la transacción autorizada (spec §10). |
| 5 | Ningún dato bancario real en el repositorio | `git ls-files \| grep -Ei '\.(db\|sqlite\|sqlite3\|xls\|xlsx\|csv)$'` + `git grep -n "finanzas\.db" -- ':!docs/'` + revisión manual de las muestras sintéticas | **Verde con matiz** (ver «El control 5, con precisión» más abajo). El primer grep sale **vacío**: no hay ni un fichero de datos versionado. El segundo devuelve **3 líneas**, todas cadenas de texto, ninguna un dato: son la ayuda de uso del script de migración y dos rutas sintéticas de su prueba. Muestras revisadas: `packages/server/src/finance/parsers/synthetic-samples.ts`. |
| 6 | La capa de navegador no arrastra código de servidor | `grep -rn "@housekeeper/server" apps/web/src/lib/finance apps/web/src/lib/components/finance` | **Verde.** Cuatro importaciones, las cuatro `import type` (`api.ts:15-26`, `detail.ts:7`, `FinanceDetailPanel.svelte:2`, `LedgerTable.svelte:3`); la quinta línea que casa es un comentario (`api.ts:5`). Los tipos se borran al compilar: nada de `@housekeeper/server` llega al navegador. |
| 7 | La falta de concesión nunca se distingue en la API REST: siempre 404, jamás 403 | grep de `error(403` y de las traducciones a 404 en los endpoints y en `financeRead` | **Verde.** Los únicos dos `error(403…)` de toda la superficie REST son el control de origen cruzado (`imports/preview/+server.ts:19` e `imports/confirm/+server.ts:77`, «Origen no permitido»), no la concesión. Sin membresía o sin concesión: `finance.server.ts:578` y `imports/{preview,confirm}/+server.ts:44-45` y `:114-115` responden `error(404, 'Hogar no encontrado')` (Ruling R2). |
| 8 | Los logs no imprimen importes ni conceptos | `grep -rn "log\.\(info\|warn\|error\)"` sobre los tres módulos de servidor de finanzas, el paquete `packages/server/src/finance` y el despachador de comandos; más `grep -rn "console\."` | **Verde.** Dos únicas llamadas reales, ambas estructuradas y sin carga útil: `finance-access.server.ts:33` → `log.error('finance access check unavailable', { code: errorCode(cause) })` y `finance.server.ts:580` → `log.error('finance api unavailable', { code: errorCode(cause) })`. `errorCode` (`packages/server/src/logging.ts:94-103`) devuelve un código de ≤ 64 caracteres o el nombre del error, nunca el mensaje. Cero `console.*` en el módulo. Las otras tres coincidencias son prosa dentro de comentarios. |
| 9 | Las 10 tablas `app.finance_*` tienen RLS **activada y forzada**, y ninguna política deja leer datos financieros sin concesión | consulta sobre `pg_class` y `pg_policies` en la base ya migrada por el control 1 | **Verde.** 10 tablas, `sin_rls = 0`, `sin_force = 0`. Las 9 políticas de datos llevan `app.tenant_context_matches(household_id) AND app.finance_enabled()`; el veredicto «políticas de datos sin `finance_enabled()`» devuelve **0 filas**. La tabla de la propia concesión se excluye a propósito (ver abajo). |
| 10 | El rol de aplicación no puede puentear la RLS ni es propietario | `select rolname, rolbypassrls, rolsuper from pg_roles …` | **Verde.** `casa_clara_app`, `casa_clara_app_login` y `casa_clara_worker`: `rolbypassrls = f`, `rolsuper = f`. Sus privilegios sobre `finance_*` son `SELECT/INSERT/UPDATE/DELETE` de tabla (y solo `SELECT/INSERT/UPDATE` sobre `finance_module_grants`), siempre bajo política. |

### La consulta del control 9 y su salida

```sql
SELECT c.relname AS tabla, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'app' AND c.relkind = 'r' AND c.relname LIKE 'finance\_%'
 ORDER BY c.relname;
```

```
           tabla            | rls | force
----------------------------+-----+-------
 finance_accounts           | t   | t
 finance_categories         | t   | t
 finance_event_rules        | t   | t
 finance_events             | t   | t
 finance_import_batches     | t   | t
 finance_module_grants      | t   | t
 finance_provider_aliases   | t   | t
 finance_rules              | t   | t
 finance_transaction_events | t   | t
 finance_transactions       | t   | t
(10 rows)
```

Y el veredicto negativo, que es el que de verdad manda —«ninguna política
permite al rol de aplicación leer datos financieros sin concesión»—:

```sql
SELECT tablename, policyname, cmd, coalesce(qual, '(sin USING)') AS using_expr
  FROM pg_policies
 WHERE schemaname = 'app' AND tablename LIKE 'finance\_%'
   AND tablename <> 'finance_module_grants'
   AND coalesce(qual, '') NOT LIKE '%finance_enabled()%';
```

```
 tablename | policyname | cmd | using_expr
-----------+------------+-----+------------
(0 rows)
```

`finance_module_grants` se excluye **a propósito y no por descuido**: es la
tabla de la concesión misma, y sus tres políticas exigen contexto de hogar más
`app.current_household_role() = 'family_admin'`. Tiene que poder leerse sin
concesión, porque si no nadie podría concederla ni revocarla; no contiene ni un
importe ni un concepto, solo a quién se le ha dado el módulo, quién se lo dio y
cuándo.

El rastro de auditoría, que sí guarda la fila entera, lleva su propio cerrojo
desde `0037_finance_endurecimiento.sql`:

```
         policyname          | permissive  |      roles       |  cmd   |                          using_expr
-----------------------------+-------------+------------------+--------+-------------------------------------------------------------
 audit_events_finance_lock   | RESTRICTIVE | {casa_clara_app} | SELECT | ((entity_table !~~ 'finance\_%'::text) OR app.finance_enabled())
 audit_events_read           | PERMISSIVE  | {public}         | SELECT | (app.tenant_context_matches(household_id) AND (…))   ← abreviada
```

Restrictiva, no permisiva: las permisivas de una misma orden se combinan con
`OR` y solo podrían ampliar el acceso. Sin ella, una administración sin
concesión veía cero movimientos por la vía normal y, acto seguido, leía
concepto, proveedor, importe y saldo de cada uno en la auditoría.

## Producción (Supabase): una desviación esperada y el control que sí vale allí

En el despliegue de producción, el propietario del esquema **no puede puentear
la RLS**, así que el runner intercala `0018_rls_force_compat.sql` entre
migraciones y levanta el **forzado** (no la RLS) de las tablas que le
pertenecen (`0018_rls_force_compat.sql:44-56`: `ALTER TABLE … NO FORCE ROW
LEVEL SECURITY` para cada tabla de `app`/`app_private` cuyo propietario alcanza
el usuario en curso). Consecuencia, medida en la **simulación del despliegue**
—no en la base de pruebas de esta página, que sí corre con propietario
privilegiado—: las 10 tablas `app.finance_*` quedan allí con
`relrowsecurity = true` y `relforcerowsecurity = false`.

**Es lo esperado, no un hallazgo.** `FORCE ROW LEVEL SECURITY` solo cambia algo
para el **propietario** de la tabla, y el rol de aplicación nunca lo es: se
conecta como `casa_clara_app_login` (miembro de `casa_clara_app`), que no es
propietario, no es superusuario y tiene `rolbypassrls = f` —comprobado en el
control 10—. Para él, las políticas se aplican con o sin `FORCE`. Ver
`docs/despliegue/supabase-esquema.md` §2, fila 1.

Por eso, **en Supabase el control 9 no se comprueba con `relforcerowsecurity`**,
que allí siempre saldrá `false` y no significa nada. El control equivalente que
sí vale es el veredicto negativo de arriba, que no depende del forzado:

```sql
-- Debe devolver 0 filas, también en producción.
SELECT tablename, policyname, cmd, qual
  FROM pg_policies
 WHERE schemaname = 'app' AND tablename LIKE 'finance\_%'
   AND tablename <> 'finance_module_grants'
   AND coalesce(qual, '') NOT LIKE '%finance_enabled()%';

-- Y, complementario: el rol de aplicación sigue sin poder puentear la RLS.
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
 WHERE rolname IN ('casa_clara_app', 'casa_clara_app_login');
```

En producción se espera, pues: `relrowsecurity = true` en las 10 tablas,
`relforcerowsecurity = false` en las 10, cero políticas sin
`app.finance_enabled()`, y `rolbypassrls = f`.

## El control 5, con precisión

Lo que el control vigila es que no haya **datos**, no que no se **nombre** el
fichero de origen. `git ls-files | grep -Ei '\.(db|sqlite|sqlite3|xls|xlsx|csv)$'`
sale vacío: ni una base SQLite, ni un extracto, ni una hoja de cálculo
versionada.

El segundo grep del guion original —`git grep -n "finanzas\.db" -- ':!docs/'`,
que se esperaba vacío— devuelve hoy **3 líneas**. Se revisaron una a una y
ninguna es un dato:

| Línea | Qué es |
|---|---|
| `packages/db/scripts/migrar-home-finance.mjs:23` | La cadena de ayuda del propio script: `--sqlite <ruta finanzas.db>`. Es la documentación del parámetro. |
| `packages/db/scripts/migrar-home-finance.test.mjs:158` | Un fichero temporal que la prueba **crea ella misma** en `mkdtemp`, con el contenido literal `'contenido sintético'`. |
| `packages/db/scripts/migrar-home-finance.test.mjs:396` | La cadena `'/tmp/finanzas.db'` como ruta de ejemplo al comprobar que el informe se compone bien. |

De modo que el criterio del guion se afina así, y así se ejecuta a partir de
ahora: **`git ls-files` vacío** (ese sí es binario y no admite matices) más la
revisión de las menciones en prosa. Las que viven en `docs/` (el runbook de la
migración, esta misma página) siempre fueron esperadas; a esa lista se suman
ahora las tres del script de migración y su prueba, por el mismo motivo.

La revisión manual de las muestras sintéticas
(`packages/server/src/finance/parsers/synthetic-samples.ts`) confirma que los
extractos se **generan por código**, jamás se copian: titulares inventados
(«SR EJEMPLO», «JUAN EJEMPLO», «EMPRESA EJEMPLO SL»), números de cuenta a ceros
(`2100 0000 0000 0000 1234`, `ES4400190000000000000001`,
`0073 0100 5100 0000 0001`), tarjeta enmascarada (`XXXX-XXXXX-91009`) e
identificador de acreedor SEPA con la **forma** del real y todo ceros
(`ES00000A00000000`), con un comentario en el propio fichero explicando por qué.
Los nombres de banco y comercio (CaixaBank, Deutsche Bank, Openbank, Amex,
Iberdrola, Amazon) son marcadores de formato que el parser necesita reconocer,
no datos de nadie.

## Cómo volver a ejecutar esta revisión

Desde la raíz del repositorio. Los `test -d` y el `find … | wc -l` no son
adorno: si el directorio se mueve o se renombra, un grep sobre una lista vacía
sale «vacío» y el control aparentaría verde sin haber mirado nada.

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
docker start casaclara-it-pg 2>/dev/null || true
export TEST_DATABASE_URL='postgresql://<usuario>:<clave>@127.0.0.1:5439/<base>'

# 1 · RLS y matriz negativa
pnpm test:db && pnpm test:rls

# 2 · Ningún endpoint REST fuera de los tres ayudantes
test -d apps/web/src/routes/api/v1/finance || echo 'CONTROL ROTO: no existe el directorio'
find apps/web/src/routes/api/v1/finance -name '+server.ts' | wc -l          # ≥ 9
find apps/web/src/routes/api/v1/finance -name '+server.ts' -print0 \
  | xargs -0 -r grep -LE "financeRead|previewImport|confirmImport"          # vacío
grep -n "requireFinanceAdmin" apps/web/src/lib/server/finance.server.ts
grep -n "requireFinanceAdmin" apps/web/src/lib/server/finance-imports.server.ts

# 3 · El ayudante de access.manage y los dos handlers que pasan por él
grep -n "access.manage" packages/server/src/commands/finance.ts
grep -n -A1 'case "finance.grant.write":'  packages/server/src/commands/finance.ts
grep -n -A1 'case "finance.revoke.write":' packages/server/src/commands/finance.ts
grep -n "await requireFinanceAdmin(client, membership);" packages/server/src/commands/finance.ts

# 4 · Los extractos no se persisten
test -d packages/server/src/finance || echo 'CONTROL ROTO: no existe el directorio'
grep -rn "writeFile\|createWriteStream\|putObject\|storage" \
  apps/web/src/routes/api/v1/finance packages/server/src/finance \
  --include='*.ts' | grep -v '\.test\.'                                     # vacío

# 5 · Ningún dato bancario real versionado
git ls-files | grep -Ei '\.(db|sqlite|sqlite3|xls|xlsx|csv)$'               # vacío
git grep -n "finanzas\.db" -- ':!docs/'                                     # solo prosa, ver arriba

# 6 · La capa de navegador no arrastra código de servidor
grep -rn "@housekeeper/server" apps/web/src/lib/finance apps/web/src/lib/components/finance
#   → solo líneas `import type` (y un comentario)

# 7 · Sin concesión, 404; los únicos 403 son de origen cruzado
grep -rn "error(403" apps/web/src/routes/api/v1/finance apps/web/src/lib/server/finance*.ts

# 8 · Los logs no llevan importes ni conceptos
grep -rn "log\.\(info\|warn\|error\)" \
  apps/web/src/lib/server/finance*.ts packages/server/src/finance \
  packages/server/src/commands/finance.ts

# 9 y 10 · Estado real de la base (las consultas están más arriba)
psql "$TEST_DATABASE_URL" -f <fichero con las consultas de las secciones 9 y 10>
```

## Lo que queda fuera y por qué

- **El cerrojo REST no se busca fichero a fichero en cada `+server.ts`**, y eso
  es una desviación consciente de la letra de la spec §10 («los endpoints REST
  comprueban sesión + membresía + concesión uno a uno»). Vive centralizado en
  `financeRead` / `previewImport` / `confirmImport`, **dentro** de la
  transacción autorizada. Buscar `requireFinanceAdmin` en cada ruta daría un
  falso positivo por endpoint —ninguna lo contiene— y duplicarlo en las once
  rutas sería peor, no mejor: once sitios que pueden divergir en vez de tres.
  Lo que se comprueba, y es más fuerte, es que **ningún** `+server.ts` se salta
  los tres ayudantes (control 2b, salida vacía) y que **los tres** llaman al
  cerrojo (control 2c).
- **«Admin sin concesión» no está en la batería de maqueta**, y también es una
  desviación consciente: la spec §11 la pedía junto a los 403/404 del resto de
  roles en e2e con fixtures, pero el modo maqueta concede Finanzas de demo a la
  cuenta `admin` y no sabe quitárselo. El caso vive en dbe2e, contra Postgres
  real: `apps/web/e2e/finanzas-concesion.dbe2e.ts` revoca la concesión por SQL,
  comprueba que `/h/<hogar>/finanzas` responde **403** aunque el rol siga siendo
  `family_admin`, que el enlace de menú desaparece, y restaura en un `finally`.
  Lo que sí cubre la maqueta (`apps/web/e2e/finanzas.e2e.ts:292-315`): las siete
  pantallas en 200 para admin-con-concesión, 403 para las cuatro cuentas sin la
  capacidad y 404 para una ruta hija no declarada.
- **Página y API responden distinto, a propósito.** La página devuelve 403 con
  un mensaje genérico —el mismo tanto si falta el rol como si falta la
  concesión, así que no delata cuál de las dos—; la API REST devuelve 404
  siempre, indistinguible de un hogar inexistente (Ruling R2). El control 7
  vigila la API, que es la superficie que un tercero puede sondear.
- El catch-all del sistema antiguo y su autenticación básica desaparecen con la
  retirada de `cf-finanzas` (runbook de despliegue, fase de producción).
- Auditoría: toda mutación de finanzas pasa por los triggers de `audit_events`
  con autoría; se verifica en las suites de base de datos, no aquí. Lo que sí se
  revisa aquí es **quién puede leer** ese rastro (política
  `audit_events_finance_lock`, arriba).
- Esta revisión no cubre el despliegue: credenciales, rotación de secretos y
  retirada del sistema antiguo van en los runbooks de `docs/despliegue/`.
