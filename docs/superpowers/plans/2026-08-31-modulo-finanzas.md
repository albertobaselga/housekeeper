# Módulo Finanzas — plan maestro

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Este fichero es el índice: la ejecución va
> plan de fase a plan de fase, tarea a tarea.

**Goal:** Fusionar home-finance en casa-clara como módulo exclusivo de administradores con
activación por cuenta, migrar sus datos a producción y retirar el sistema antiguo.

**Spec:** `docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md`
**Interfaces canónicas y restricciones globales:** `docs/superpowers/plans/2026-08-31-modulo-finanzas-interfaces.md`

## Planes de fase

| # | Plan | Entrega |
|---|---|---|
| 1 | `2026-08-31-modulo-finanzas-fase-1-cimientos.md` | Capacidad, esquema 0034 + RLS + suite 030, concesiones + Ajustes, routing/nav/esqueletos |
| 2 | `2026-08-31-modulo-finanzas-fase-2-dominio-parsers.md` | `domain/finance` completo, 4 parsers, `computeDedupHash`, pipeline unificado |
| 3 | `2026-08-31-modulo-finanzas-fase-3-etl.md` | `migrar-home-finance.mjs`, informe de verificación, runbook de ensayo local |
| 4 | `2026-08-31-modulo-finanzas-fase-4-ui-lectura.md` | FilterBar, Dashboard, Movimientos (lectura), DetailPanel, endpoints GET, gráficas SVG |
| 5 | `2026-08-31-modulo-finanzas-fase-5-ui-escritura.md` | Comandos finance.*, Revisión, Eventos, Importar, Ajustes del módulo |
| 6 | `2026-08-31-modulo-finanzas-fase-6-analitica-pivot.md` | Analítica completa + pivot con DnD y ActionBar |
| 7 | `2026-08-31-modulo-finanzas-fase-7-endurecimiento-entrega.md` | a11y/e2e/dbe2e, CI, docs, ensayo local completo, producción y retirada |

## Orden y paralelismo

- Fase 2 puede ir EN PARALELO con la fase 1 (el dominio puro no toca BD ni web).
- Fase 3 tras 1+2 · Fase 4 tras 1+2 · Fase 5 tras 4 · Fase 6 tras 4 (en paralelo con 5) ·
  Fase 7 la última.
- Cada fase cierra con la rama en verde (`lint`, `typecheck`, `check`, `test`, `test:db`,
  `test:rls` y los e2e que le apliquen).

## Puertas duras

1. **Producción (Supabase) prohibida en fases 1–6.** Todo contra Postgres local en Docker.
2. En fase 7, las tareas de producción y retirada están marcadas «⚠️ REQUIERE CONFIRMACIÓN
   DE ALBERTO» y no se ejecutan sin su «sí» expreso en la conversación: primero TODO en
   verde en local, incluido el ensayo completo de la migración.
3. Copia de seguridad de `finanzas.db` ya realizada y verificada (2026-08-31, sha256
   `681c611d…`, en `/home/abf/backups/home-finance/`).
