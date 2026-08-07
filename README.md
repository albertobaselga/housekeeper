# Casa Clara

PWA multi-tenant para la relación laboral doméstica y la operación del hogar, descrita en el brief de producto v2. Monorepo pnpm con SvelteKit (SSR/BFF), worker Node, dominio puro, contratos compartidos, migraciones PostgreSQL con RLS forzada e infraestructura Docker Compose. **Solo datos sintéticos: no es un sistema laboral en producción.**

- Criterios de aceptación y desviaciones aprobadas: [docs/acceptance/brief-v2-adapted.md](docs/acceptance/brief-v2-adapted.md)
- Contrato de entrega y calidad (scripts y gates de CI): [docs/architecture/delivery-quality-contract.md](docs/architecture/delivery-quality-contract.md)
- Decisión de plataforma: [docs/adr/0001-plataforma-autogestionada.md](docs/adr/0001-plataforma-autogestionada.md)
- Revisión del prototipo original: [docs/revision-codigo-y-validacion.md](docs/revision-codigo-y-validacion.md)

## Estructura

| Ruta | Contenido |
|---|---|
| `apps/web` | SvelteKit + TypeScript: shell PWA, capacidades por rol, IndexedDB (snapshot/outbox/blobs), `/api/v1` (sync, snapshot), Better Auth |
| `apps/worker` | Worker Node: cola `app_private.job_queue`, PDF determinista, integraciones (S3 privado, SMTP, OCR, web push) |
| `packages/contracts` | Contratos públicos versionados (AppContext, CommandEnvelope, SyncResult, CriticalSnapshot…) con esquemas Zod |
| `packages/domain` | Motor puro: liquidaciones en céntimos `bigint`, máquina de jornadas extra |
| `packages/server` | Primitivas de servidor: transacción autorizada con RLS, idempotencia append-only, lote de sync, firma Ed25519 |
| `packages/db` | Migraciones PostgreSQL 18 multi-tenant, fixtures de dos hogares y pruebas de esquema/RLS |
| `infra` | Compose local/staging, Caddy, Dockerfiles, backups, observabilidad y calidad |

## Requisitos

Node 24 (fijado en `engines`) y pnpm 10.17 (vía corepack). Para la pila completa, Docker Compose.

```bash
corepack enable
pnpm install
```

## Desarrollo

```bash
pnpm dev                 # web en modo demo (cuentas fixture, sin base de datos)
pnpm test                # unidades de todos los workspaces
pnpm typecheck
pnpm lint
pnpm build
```

Sin `DATABASE_URL` la web sirve datos sintéticos en memoria y la sincronización responde 503 (no finge confirmaciones). Con Postgres configurado, la sesión opera bajo RLS real.

### Base de datos

```bash
export DATABASE_URL=postgresql://usuario@host:5432/basedatos
pnpm db:migrate          # idempotente; registra cada migración con su SHA-256
pnpm test:db             # invariantes de esquema y libros append-only (parte de cero)
pnpm test:rls            # matriz negativa de aislamiento por hogar y rol
```

### Autenticación

Better Auth con magic link como método principal. La contraseña existe solo para las cinco cuentas demo locales y únicamente con `ENABLE_DEMO_PASSWORD_AUTH=true`; se siembran de forma idempotente:

```bash
pnpm --filter @casa-clara/web seed:demo   # requiere DATABASE_AUTH_URL, SEED_DATABASE_URL y las credenciales DEMO_* del entorno
```

### Pila local completa

```bash
cp infra/env/local.env.example infra/env/local.env
docker compose --env-file infra/env/local.env -f infra/compose.local.yml up --build --wait
```

Levanta Caddy (`http://localhost:8080`), web, worker, PostgreSQL 18, MinIO, Mailpit y ClamAV; perfiles opcionales `observability` y `backup`. El procedimiento de staging sintético está en [docs/runbooks/staging-synthetic.md](docs/runbooks/staging-synthetic.md).

## Demo original

El prototipo vanilla validado está preservado en el tag [`demo-v0.1.0`](../../tree/demo-v0.1.0); su estado local no se migra. Las cuentas demo (`*.casaclara.demo`) y todos los datos del repositorio son deliberadamente ficticios: no introduzcas información personal o laboral real.
