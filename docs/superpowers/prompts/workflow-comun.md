# Workflow común de una funcionalidad: del diseño a producción

> Este documento es la mitad compartida de todos los prompts de
> `docs/superpowers/prompts/`. Cada prompt lo da por leído y solo añade lo
> específico de su funcionalidad. Si un prompt y este fichero se contradicen,
> manda el prompt, porque es el más concreto; si descubres que este fichero
> está desfasado respecto al repositorio, corrígelo en el mismo PR y dilo.

Housekeeper **está en producción sirviendo a una familia y a una empleada de
verdad**. Un error aquí no rompe una pantalla: rompe el sueldo de alguien, o le
impide registrar el trabajo que hizo. Esa frase, de la skill `operar-la-casa`,
es la razón de cada puerta de este workflow.

---

## 0. Antes de nada: el entorno

1. **Worktree propio.** Sigue `superpowers:using-git-worktrees`. Rama
   `feat/<tema>` desde `origin/main` al día (`git fetch` y `git merge --ff-only
   origin/main`). Nunca commits directos a `main`.
2. **Node 24 por nvm.** La versión está fijada en `.nvmrc` y en `engines`. La
   shell no interactiva de las herramientas **no carga nvm**: antepón el `bin`
   de la versión de nvm al `PATH` en cada comando que ejecute `pnpm`, o la
   build usará otro Node y fallará de formas raras.
3. **Postgres 18 desechable en Docker** para las suites con base de datos. En
   la máquina de desarrollo actual, el PostgreSQL de `127.0.0.1:54329` que
   cita el README **lo ocupa otra aplicación (Paperclip)**: no lo uses. Levanta
   el tuyo en otro puerto y exporta `TEST_DATABASE_URL` y `E2E_DATABASE_URL`
   hacia él. Las suites de base de datos se ejecutan **en secuencia, nunca en
   paralelo** (crean bases y roles de nombre fijo).
4. **Rutas absolutas en Bash, nunca `cd`.** El directorio de trabajo persiste
   entre llamadas y los hooks dejan ficheros de estado (`.omc/`) en el
   directorio actual; un `cd docs/… && git add .` ya contaminó un commit.
   Revisa `git status` justo antes de cada commit.
5. **Sin `git stash` a secas.** La pila de stash es compartida con otras
   sesiones. Si tienes que apartar trabajo, haz un commit WIP.
6. **Instala con `pnpm install --frozen-lockfile`.** Si un prompt añade
   dependencias, el lockfile cambia en un commit propio y explícito.

Lecturas obligatorias antes de diseñar nada (en este orden, y enteras):

| Documento | Para qué |
|---|---|
| `README.md` | Mapa del monorepo, suites y qué bloquea un despliegue |
| `CONTRIBUTING.md` | Reglas que no se negocian: datos sintéticos, migraciones append-only, ninguna batería sin job, fallar cerrado |
| `.claude/skills/operar-la-casa/SKILL.md` y sus tres hojas | Los cinco papeles, dónde está cada cosa y las trampas |
| `docs/architecture/delivery-quality-contract.md` | Presupuesto de arranque de Hoy, `suite-coverage`, por qué cada puerta |
| `docs/superpowers/specs/2026-10-03-modulo-cupones-design.md` | El molde de un módulo completo, con las decisiones y su porqué |
| `docs/security/revision-cupones.md` | Cómo es una revisión de seguridad **ejecutada**, y la deuda abierta de la 0005 |
| `docs/security/security-baseline.md` | Controles obligatorios |
| `docs/despliegue/runbook-despliegue.md` | El procedimiento de producción, §2 y §7 sobre todo |
| `.env.example` | Inventario completo de variables y qué degrada en silencio |
| `apps/web/src/lib/app-title.ts` | La regla del nombre del producto (ya causó fallos reales) |

---

## 1. Diseño

Usa `superpowers:brainstorming`. El prompt ya trae las decisiones cerradas
por el propietario: **no las vuelvas a preguntar**. Pregunta solo lo que el
prompt deja abierto, agrupado en una sola tanda con `AskUserQuestion` y con
una recomendación por pregunta.

1. **Explora el código** antes de proponer: agentes `explore` para localizar
   y lectura directa de los ficheros que el prompt nombra. Las suposiciones
   sobre «cómo funciona» se verifican leyendo, no recordando.
2. **Documentación oficial** para cualquier SDK, API o protocolo externo:
   `dependency-expert` o `document-specialist` (y Context7 si está
   disponible), con la versión instalada en `pnpm-lock.yaml`. Nunca
   adivines nombres de campos ni contratos.
3. **Spike cuando el prompt lo pida** (o cuando una duda técnica no se
   resuelva leyendo): código desechable, sin pruebas, en una rama aparte, y
   lo aprendido vuelve al spec. Nada del spike se queda sin pasar por el
   plan.
4. **Spec** en `docs/superpowers/specs/YYYY-MM-DD-<tema>-design.md`, con la
   estructura del spec de Cupones: qué es y para quién, decisiones del
   propietario en tabla, fuera de alcance, modelo de datos, contratos,
   dominio, servidor, interfaz, seguridad, pruebas y puertas, entrega,
   fases futuras. Cada decisión lleva su porqué.
5. **Comprobación del constructor**: un subagente fresco lee el spec con la
   plantilla `builder-check-prompt.md` de la skill de brainstorming y
   devuelve lo que aún tendría que preguntar. Lo que puedas decidir tú lo
   decides y lo marcas como tuyo; lo que solo puede decidir el propietario
   va en una única tanda de preguntas.
6. **Revisión adversarial del spec**, en paralelo: `critic` (plan y
   supuestos), `security-reviewer` (fronteras, RLS, datos que salen) y
   `architect` (encaje con contratos, dominio puro, presupuesto de Hoy).
   Incorpora lo que sea defendible; lo que rechaces, dilo en el spec.
7. **Puerta: el propietario aprueba el spec** en la conversación. Hasta
   entonces no se escribe código de producto, no se instalan dependencias y
   no se crean migraciones.

## 2. Plan

Usa `superpowers:writing-plans`. Plan maestro en
`docs/superpowers/plans/YYYY-MM-DD-<tema>.md` y, si el trabajo supera unas
pocas decenas de tareas, un plan por fase como hizo Finanzas
(`2026-08-31-modulo-finanzas-fase-*.md`). Cada tarea: ficheros exactos,
interfaz exacta, la prueba que la demuestra, los comandos que la verifican y
su commit. TDD por defecto. Cada fase cierra con la rama en verde.

Marca con **«⚠️ REQUIERE CONFIRMACIÓN DEL PROPIETARIO»** toda tarea que toque
producción, aplique una migración fuera de local, cree o cambie variables de
entorno en Vercel, o cambie el modelo de cobro. Esas tareas no se ejecutan sin
un «sí» expreso en la conversación.

## 3. Ejecución

Usa `superpowers:subagent-driven-development`: un `executor` por tarea con el
contexto exacto, un revisor por tarea (`quality-reviewer`, y
`security-reviewer` cuando la tarea toque RLS, autenticación, adjuntos o
datos que salen del hogar). Reglas que no se negocian:

- **Solo datos sintéticos.** Dominios `*.demo`, teléfonos no asignables,
  ningún nombre, importe ni documento real. Tampoco en capturas ni en
  fixtures. Ninguna foto ni PDF real en git.
- **Nunca un secreto en el árbol.** `security.yml` pasa gitleaks sobre el
  historial completo. Un secreto commiteado se rota, no se borra.
- **Migraciones append-only**, en un único `BEGIN; … COMMIT;`, con el
  **siguiente número libre en el momento de ejecutar** (comprueba
  `ls packages/db/migrations`; a 31 de octubre de 2026 es `0040`). RLS:
  `ENABLE` junto a cada `CREATE TABLE`, `FORCE ROW LEVEL SECURITY` al final
  del fichero, `GRANT` explícitos a `casa_clara_app` (nombre legado, ver
  `docs/despliegue/identificadores-legado.md`), bloque `DO $check$` final que
  verifique en `pg_policies` y `pg_class` lo que la migración promete.
  Auditoría con el bucle de la 0036. Ninguna función `LANGUAGE sql` con
  `row_security = off` antes del `FORCE`. Suite SQL propia en
  `packages/db/tests/` añadida a `test:rls` en `packages/db/package.json`.
- **Contratos**: capacidades solo en `@housekeeper/contracts/capabilities`
  (no se reexporta desde la raíz); agregado nuevo en las **dos** listas
  (`AggregateType` en `index.ts` y el `z.enum` de `commandEnvelopeSchema` en
  `schemas.ts`) con el test que las compara; payloads preferentemente como
  `z.discriminatedUnion("action", …)` (no todos los agregados históricos lo
  cumplen: `finance` discrimina por `kind` y varios usan esquemas sueltos).
- **Dominio puro**: `packages/domain` sin `pg`, sin `fetch`, sin reloj. El
  «hoy» llega como argumento.
- **Servidor**: escrituras como comandos por `POST /api/v1/sync`, dentro de
  `withAuthorizedTransaction`, orden fijo papel → `safeParse` → SQL bajo RLS,
  idempotentes por el id que genera el cliente. Ficheros servidos por proxy
  autenticado con `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox`, `Cache-Control: no-store` y 404 opaco.
  Nunca URL pública ni firmada. Logs con lista blanca: nunca un dato del
  hogar.
- **Interfaz**: alta del módulo en los puntos coordinados (`HOUSEHOLD_MODULES`
  y `MODULE_CAPABILITY` en `apps/web/src/lib/auth/routing.ts`,
  `SECTION_LABELS` en `apps/web/src/lib/app-title.ts`,
  `NAV_ENTRIES` en `AppShell.svelte`, trazo en `NavIcon.svelte`) con sus tests
  de lista exacta; CSS solo con tokens (`pnpm check` lo vigila); glosario en
  castellano llano; estados vacíos que explican la pantalla; `prefers-reduced-
  motion` respetado. El módulo entero **desterrado del grafo inicial de Hoy**
  en `apps/web/scripts/verify-today-bundle.mjs`.
- **Commits** pequeños, en castellano, `tipo(ámbito): qué cambia`, con el
  porqué en el cuerpo. Termina cada mensaje con la línea de coautoría que te
  indique el entorno.
- **Nunca contra producción**, salvo en la fase 6 y con confirmación.

## 4. Verificación

Nada se declara hecho sin evidencia ejecutada. La lista mínima, con la salida
leída, no supuesta:

```bash
pnpm lint && pnpm typecheck && pnpm --filter @housekeeper/web check
pnpm test                       # el recuento de pruebas debe crecer respecto a main
pnpm db:migrate && pnpm db:migrate   # la segunda aplica 0
pnpm test:db && pnpm test:rls && pnpm test:import
pnpm --filter @housekeeper/server test    # con TEST_DATABASE_URL, sin skips
pnpm --filter @housekeeper/web test       # con TEST_DATABASE_URL, sin skips
pnpm --filter @housekeeper/worker exec vitest run
pnpm test:e2e && pnpm test:a11y && pnpm test:e2e:db
pnpm build && pnpm verify:bundle
pnpm test:lighthouse            # si la funcionalidad toca una ruta medida o añade una pública
```

Después:

- `verifier` (sonnet; opus si el cambio es grande o de seguridad) con la
  lista de afirmaciones del plan y la evidencia de cada una.
- **Revisión de seguridad ejecutada** en `docs/security/revision-<tema>.md`
  con la estructura de `revision-cupones.md`: controles verificados con sus
  consultas y su salida, matriz por papel, riesgos residuales aceptados, y
  la sección «Cómo volver a ejecutar esta revisión» con los comandos.
- Revisión UX y de accesibilidad sobre capturas sintéticas a 320 px y en
  escritorio (`designer` o `ux-researcher`), y corrección de lo que salga.
- El gate `suite-coverage` de CI compara los ficheros de spec con los
  ejecutados: toda batería nueva necesita su job o su entorno. **No se relaja
  el gate.**

## 5. Documentación

Forma parte de la entrega, no viene después:

- **Manual de la familia** `docs/manual/index.html`: capítulo del módulo con
  capturas sintéticas en `docs/manual/capturas/` (y su entrada en
  `docs/manual/capturas/titulos.json`), y la fila nueva de la tabla «Quién ve
  qué».
  `node scripts/construir-manual-publicable.mjs` debe seguir funcionando.
- **Skill `operar-la-casa`**: sección en `referencia-operaciones.md` con (a)
  por dónde, (b) rol, (c) qué NO hacer; fila en la tabla «Dónde está cada
  cosa» de `SKILL.md`; variables nuevas en `referencia-instalacion.md`.
- **Runbook de despliegue**: §2 (última migración esperada, qué trae la
  nueva, reglas de orden), §5 (variables nuevas en Vercel), §7 (humo de la
  funcionalidad con datos de prueba que se queden marcados como tales).
- **`.env.example`** con cada variable nueva: destino, carácter y qué pasa si
  falta.
- **README**: mapa del monorepo y sección de documentación si hay piezas
  nuevas; tabla de suites si hay comandos nuevos.
- **ADR** en `docs/adr/` cuando la funcionalidad cambie una decisión
  anterior o asuma un riesgo nuevo, con el formato de los existentes
  (estado, contexto, decisión, consecuencias).
- **CONTRIBUTING** si nace una regla que todo módulo futuro debe cumplir.

## 6. Producción

El despliegue está descrito en `docs/despliegue/runbook-despliegue.md`; aquí
solo el orden y las puertas. Topología: la web en Vercel despliega **al
mergear en `main`**, la base vive en Supabase y **nada aplica migraciones por
sí solo**.

Dos hechos de esta instalación que cambian cómo se trabaja:

- **Las credenciales de producción no están en la máquina donde corre el
  agente.** El agente prepara los comandos exactos, con sus criterios de
  salida, y el **propietario los ejecuta** y pega la salida. El agente
  verifica después con lo observable (health, humo, sondeos sin sesión).
- **`main` no tiene protección de rama.** La disciplina de «`deployable` en
  verde antes de mergear» la aplica quien mergea, no la plataforma.

Orden, sin saltos:

1. PR contra `main` con la descripción completa (qué, por qué, cómo se ha
   comprobado con lo ejecutado, variables y migraciones nuevas). Esperar a
   que **`deployable`** esté en verde en `ci.yml` y `security.yml` no tenga
   avisos nuevos atribuibles al cambio.
2. **⚠️ Copia de seguridad previa** (`pnpm backup:full` con
   `BACKUP_DATABASE_URL` directa), guardada fuera del repositorio y
   verificada.
3. **⚠️ Variables de entorno nuevas en Vercel ANTES del merge**, respetando la
   regla indivisible del ADR 0003: lo que entra junto, entra junto.
4. **⚠️ Migraciones ANTES del merge**, por conexión directa (5432) con el rol
   propietario, en un momento sin subidas en curso, y dos veces (la segunda
   aplica 0). Comprobar justo antes de mergear:

   ```bash
   psql "$DIRECTA" -Atc "select max(filename) from public.schema_migrations"
   ```

   Con el código nuevo y la migración sin aplicar, Hoy puede responder 503 a
   toda la familia.
5. **Merge** (fusión de la rama, sin squash salvo que el propietario lo
   pida). Vercel despliega. Comprobar en el panel que la build es la del
   merge y que terminó.
6. **Humo** con la lista del §7 del runbook ampliada con la de la
   funcionalidad: `/api/health`, entrar, Hoy sin 503, lo nuevo con datos de
   prueba marcados como tales, la denegación por papel con una cuenta que no
   deba ver nada, y la cola drenando.
7. **⚠️ Copia posterior** y nota de qué se desplegó, cuándo y con qué
   migración, en el runbook si cambia algo del procedimiento.
8. **No se vuelve atrás con un Instant Rollback** si el cambio trajo una
   migración o un agregado nuevo: se corrige hacia delante (runbook §2.7).

## 7. Cierre

- Informe final en la conversación con evidencia: qué se desplegó, qué se
  verificó y cómo, qué queda fuera y por qué, y la lista de decisiones que
  tomaste tú.
- Memoria del agente actualizada con lo no derivable del código: fechas,
  qué hay en producción, deudas conocidas, trampas nuevas.
- Si el workflow mismo enseñó algo, corrige este fichero.

---

## Las trampas, en una pantalla

1. El nombre: «Housekeeper» es el nombre del proyecto. Lee
   `apps/web/src/lib/app-title.ts` antes de escribir texto de interfaz. El
   prompt de la web pública cambia esta regla; hasta que ese cambio esté en
   `main`, rige la actual.
2. Un `__data.json` puede saltarse el `load` del layout: cada cargador
   comprueba la capacidad por su cuenta.
3. Un POST a una form action corre **antes** que cualquier `load`: la
   capacidad de las rutas se comprueba en `hooks.server.ts` para lo que no es
   GET. No lo «limpies» llevándolo al layout.
4. `family_admin` ve todos los objetos de almacenamiento del hogar: enlazar
   «cualquier objeto visible» a algo que la familia ve es publicar el
   justificante privado de otra persona. La regla es «objeto propio, vivo y
   del tipo permitido».
5. Media configuración es peor que ninguna: todo lo que degrade en silencio
   se documenta en `.env.example` y se comprueba en el humo.
6. `--until` del runner de migraciones no es una opción de línea de órdenes.
7. Las dos ramas de septiembre repitieron los números 0036 y 0037: el runner
   ordena por nombre completo, así que conviven; nunca renombres una
   migración aplicada.
