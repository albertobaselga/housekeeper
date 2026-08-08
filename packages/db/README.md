# @casa-clara/db

Esquema PostgreSQL multi-tenant de Casa Clara: migraciones, fixtures sintéticas de dos hogares y pruebas de invariantes y de la matriz RLS.

## Comandos

- `pnpm bootstrap`: crea los roles de ejecución, el esquema `casa_auth` de Better Auth y los envoltorios de extensión que hagan falta en `DATABASE_URL`. **Se ejecuta una vez por base y siempre antes de `migrate`** (0001 ya concede sobre `casa_clara_app` y `casa_clara_worker`). Con Docker Compose lo dispara solo `infra/postgres/00-create-roles.sh`; en Postgres gestionado hay que invocarlo a mano. Lee `APP_DB_PASSWORD`, `WORKER_DB_PASSWORD` y `AUTH_DB_PASSWORD`.
- `pnpm migrate` (o `pnpm db:migrate` desde la raíz): aplica las migraciones pendientes de `migrations/` a `DATABASE_URL`. El runner registra cada archivo en `public.schema_migrations` con su SHA-256; reejecutarlo no causa cambios y editar una migración ya aplicada aborta con error — escribe una migración nueva.
- `pnpm test` (raíz `test:db`): parte de esquema vacío en `TEST_DATABASE_URL` (o `DATABASE_URL`), aplica migraciones reales y fixtures, y ejecuta `tests/*.sql` con salida TAP.
- `pnpm test:rls` (raíz `test:rls`): solo la matriz negativa RLS.
- `pnpm probe:supabase`: instala el esquema entero desde cero contra una base desechable con un rol que imita al `postgres` de Supabase (`NOSUPERUSER`, `NOBYPASSRLS`, extensiones en `extensions`) y ejecuta las cinco suites. Necesita `PROBE_ADMIN_URL`. Ver `docs/despliegue/supabase-esquema.md`.

La conexión de migración y pruebas debe poder crear esquemas y hacer `SET ROLE casa_clara_app` / `casa_clara_worker` (superusuario del clúster local o de CI; en Supabase se lo concede el propio `bootstrap`). El runtime de la aplicación nunca usa ese rol: se conecta con logins sin `BYPASSRLS`.

## Reglas

- Toda entidad lleva `household_id` y las claves compuestas impiden relaciones cruzadas entre hogares.
- RLS activada en todas las tablas de `app` y `app_private`; el contexto se fija con `app.set_household_context()` tras autenticar (`packages/server`). El **forzado** al propietario del esquema se mantiene donde ese rol puede puentear RLS y lo levanta la migración `0018` donde no puede (Supabase); el aislamiento entre hogares no depende de él y `tests/020_rls_matrix.sql` lo demuestra.
- Acuerdos, libros, transiciones, recibos de comandos y auditoría son append-only; las correcciones son reversos o ajustes, nunca `UPDATE`/`DELETE`.
- Las compensaciones no caducan (desviación AC-03 aprobada): el saldo vive en `compensation_ledger_entries` hasta su consumo o ajuste trazable.
- Las fixtures son deliberadamente ficticias (`fixture-casa-roble`, `fixture-casa-olivo`) y reproducen el caso de aceptación de marzo con total 145.330 céntimos.
