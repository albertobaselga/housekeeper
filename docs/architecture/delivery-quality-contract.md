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
| `test:e2e` | Flujos, PWA, offline e IndexedDB. |
| `test:a11y` | axe, teclado, foco y escalado. |
| `test:lighthouse` | Arranca la web y ejecuta LHCI con `infra/quality/lighthouserc.json`. |

La web escucha en 3000 y su health path se configura con `WEB_HEALTH_PATH` (default `/api/health`). El worker escucha en 3001 y ofrece `/health`. `/api/metrics` y `/metrics` son el contrato objetivo de web y worker para activar el perfil de observabilidad; el worker todavía no debe considerarse instrumentado. Los healthchecks no deben tocar proveedores externos ni devolver datos personales.

## Gates

1. **PR rápido:** lint, tipos, build, unitarios, Compose, migración desde cero, invariantes DB y RLS.
2. **Navegador:** E2E, offline, axe y Lighthouse. El Android de referencia se valida manualmente al cerrar cada fase.
3. **Seguridad:** secretos en todo el historial, dependencias de producción y revisión de nuevas dependencias.
4. **Fase:** todos los AC de la fase, backup/restauración y revisión adversarial por una persona/agente distinto del autor.

Los test runners pasan por `scripts/ci/run-tests-nonempty.sh` o generan JUnit validado por `assert-junit-nonempty.py`. Esto evita el falso verde observado en WSL, donde el npm de Windows finalizaba con éxito tras ejecutar cero pruebas.

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
