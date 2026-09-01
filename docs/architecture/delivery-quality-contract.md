# Contrato de entrega y calidad

## Interfaces que la infraestructura espera

El monorepo debe publicar estos scripts raíz; si falta uno, CI falla en vez de omitirlo:

| Script | Responsabilidad |
|---|---|
| `lint` | Lint sin reescritura. |
| `typecheck` | Tipos de todos los workspaces. |
| `build` | Build reproducible de web y worker. |
| `test:unit` | Unidades y motor de dominio; imprime recuento positivo. |
| `db:migrate` | Aplica todas las migraciones a la DB indicada. Reejecutarlo no debe causar cambios. |
| `test:db` | Restricciones, libros, auditoría y concurrencia. |
| `test:rls` | Matriz negativa de hogares, roles, campos y Storage. |
| `test:import` | Ida y vuelta del importador del manual y del corpus wiki. |
| `test:e2e` | Flujos, PWA, offline e IndexedDB en modo fixture (11 specs `*.e2e.ts`). |
| `test:e2e:db` | Aceptación de los cinco roles contra Postgres real bajo RLS (26 specs `*.dbe2e.ts`). |
| `test:a11y` | axe, teclado, foco y escalado. |
| `test:lighthouse` | Arranca la web y ejecuta LHCI con `infra/quality/lighthouserc.json`. |

La web escucha en 3000 y su health path se configura con `WEB_HEALTH_PATH` (default `/api/health`). El worker escucha en 3001 y ofrece `/health`. `/api/metrics` y `/metrics` son el contrato objetivo de web y worker para activar el perfil de observabilidad; el worker todavía no debe considerarse instrumentado. Los healthchecks no deben tocar proveedores externos ni devolver datos personales.

## Gates

Todos viven en `.github/workflows/ci.yml`, un job por puerta:

| Job | Qué corre | Postgres propio |
|---|---|---|
| `static-analysis` | `lint`, `typecheck`, `build`, `verify:bundle` | no |
| `unit` | `test:unit` | no |
| `compose` | `scripts/ci/validate-compose.sh` | no |
| `database` | `db:migrate` desde cero → `test:db` → `test:rls` → `test:import` → `db:migrate` otra vez | sí |
| `integration` | `@housekeeper/server`, `@housekeeper/web` y `@housekeeper/worker`, **en secuencia** | sí |
| `e2e-fixture` | `test:e2e` y `test:a11y` | no |
| `e2e-database` | `test:e2e:db` | sí |
| `lighthouse` | `test:lighthouse` | no |
| `suite-coverage` | `assert-suite-coverage.py` sobre toda la evidencia JUnit | no |
| **`deployable`** | **Agrega los nueve anteriores. Es el único check que hay que exigir en la protección de rama y el que bloquea un despliegue.** | no |

`security.yml` corre aparte en cada PR, en push a `main` y cada lunes: gitleaks sobre el historial completo, `pnpm audit --prod --audit-level high` y `dependency-review`.

**Aislamiento de bases.** Las suites de integración recrean el esquema y crean bases y roles de nombre fijo (`housekeeper_access_it`, `it_housekeeper_app_login`, `e2e_housekeeper_web`…). Cada job que necesita PostgreSQL declara su **propio contenedor de servicio**, de modo que los nombres fijos no pueden colisionar entre jobs; dentro de un job, los pasos son secuenciales. En local, la misma regla: una suite de base de datos a la vez por clúster.

**Fase:** todos los AC de la fase, backup/restauración y revisión adversarial por una persona/agente distinto del autor.

## Guardas anti-falso-verde

Tres capas, cada una nacida de un fallo real:

1. `scripts/ci/run-tests-nonempty.sh` — falla si el runner termina con éxito sin haber ejecutado ninguna prueba. Nació del falso verde en WSL, donde el npm de Windows finalizaba con éxito tras ejecutar cero pruebas. Normaliza la salida quitando secuencias ANSI antes de buscar el recuento: Vitest 3.x colorea su resumen precisamente cuando detecta `CI=true`.
2. `scripts/ci/assert-junit-nonempty.py` — falla si el JUnit no existe, no parsea o suma cero casos.
3. `scripts/ci/assert-suite-coverage.py` — falla si un fichero de spec **existe en el árbol pero no aparece ejecutado** en ningún informe JUnit, o si aparece con todos sus casos saltados. Cubre los dos huecos que documentó `docs/despliegue/plan-vercel-supabase.md` §12.2: las specs `*.dbe2e.ts` que no invocaba ningún workflow y las suites de integración inertes por falta de base de datos. Las dos primeras guardas no los detectaban, porque bastaba con que *alguna* prueba corriera.

Este tercer gate no se relaja nunca: si falla, se le da al fichero el job o el entorno que necesita.

## Presupuesto de arranque de Hoy

`pnpm --filter @housekeeper/web verify:bundle` acota en 120 kB el JavaScript que
la pantalla Hoy necesita antes de ser interactiva, y de paso vigila dos fugas
concretas. Conviene entender **por qué** se escapan los bytes antes de tocarlo.

El troceo de rolldown reparte los módulos por **alcanzabilidad**, no por binding
usado. Si un módulo del arranque importa otro módulo, todo lo que ese segundo
módulo exporte y esté vivo en algún punto de la aplicación acaba en el mismo
fichero, aunque la pantalla Hoy no lo mire nunca. Un `export ... from` de más
basta: no hay tree-shaking que lo arregle, porque la decisión de troceo es
anterior.

Eso costó dos apaños fallidos y medio presupuesto:

- **`@housekeeper/contracts` (la raíz) la carga cualquier pantalla**, porque de
  ahí sale `canonicalJson` y con él se verifica la firma del paquete offline en
  el arranque. La matriz de roles y capacidades vivía en ese mismo módulo, así
  que sus ~1,2 kB de tablas viajaban con él sin que nadie los usara: el servidor
  resuelve las capacidades de la sesión en `+layout.server.ts` y las manda ya
  resueltas dentro de `AppContextV1`. Vive ahora en
  `@housekeeper/contracts/capabilities`, **sin reexport desde `index.ts`**.
- **El layout `/h/[householdId]` se carga en todas las pantallas
  autenticadas.** `AppShell` solo necesitaba las cinco etiquetas de rol, pero
  convivían con `can()` y el troceo juntaba las dos cosas: 1,6 kB para escribir
  «Empleada interna». Las etiquetas viven ahora en `$lib/auth/role-labels.ts`.

La regla, en una línea: **de un módulo que se carga siempre solo pueden salir
tipos y funciones pequeñas; las tablas de datos van a un submódulo propio.**

Dos herramientas la sostienen:

- El plugin `housekeeper:client-module-map` de `apps/web/vite.config.ts` escribe
  `.svelte-kit/housekeeper-module-map.json` (fuera de `output/`, no se despliega)
  con los bytes que cada módulo fuente aporta a cada trozo. Sin él, un trozo que
  engorda es un misterio: el manifiesto de Vite no dice qué módulo cae dónde.
- `apps/web/scripts/verify-today-bundle.mjs` usa ese mapa para listar los doce
  módulos más pesados cuando el presupuesto se rompe, y mantiene una lista de
  módulos **desterrados** del grafo inicial con la razón dentro del mensaje de
  error. Para desterrar uno nuevo, se añade a `FORBIDDEN_IN_INITIAL_GRAPH`.

La puerta mide el **nodo de página** de Hoy. El informe imprime además la carga
real de la ruta (arranque del cliente + layouts + página), que es lo que baja el
navegador; se informa y no se acota porque ahí es donde se escondió la matriz
durante meses sin que ninguna cifra lo delatara.

## Límites de observabilidad

- Prometheus recibe únicamente métricas técnicas agregadas: latencia, errores, edad de outbox/snapshot, conflictos y jobs.
- No se exportan nombres, correos, household IDs reales, texto de búsquedas, contenido wiki, datos médicos ni rutas de objetos.
- `AuditLog`, consultas fallidas y contadores de lectura son datos de producto bajo RLS, no telemetría.
- Grafana tiene reporting y comprobación de actualizaciones desactivados en Compose.
- No hay replay de sesión, analítica de terceros ni WhatsApp Cloud API.

## Integración por agentes

- El integrador conserva propiedad exclusiva de contratos compartidos y orden de migraciones.
- Cada agente trabaja en worktree y rama `codex/*` propios; no se comparten archivos durante una oleada.
- Cada entrega incluye commit, lista de archivos, pruebas y riesgos. El integrador revisa el diff y ejecuta gates tras cada merge.
- Datos/seguridad, web/PWA y calidad pueden avanzar en paralelo solo después de fijar interfaces. Wiki precede a recetas; outbox idempotente precede a escrituras offline.
