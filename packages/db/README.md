# @casa-clara/db

Esquema PostgreSQL multi-tenant de Casa Clara: migraciones, fixtures sintéticas de dos hogares y pruebas de invariantes y de la matriz RLS.

## Comandos

- `pnpm migrate` (o `pnpm db:migrate` desde la raíz): aplica las migraciones pendientes de `migrations/` a `DATABASE_URL`. El runner registra cada archivo en `public.schema_migrations` con su SHA-256; reejecutarlo no causa cambios y editar una migración ya aplicada aborta con error — escribe una migración nueva.
- `pnpm test` (raíz `test:db`): parte de esquema vacío en `TEST_DATABASE_URL` (o `DATABASE_URL`), aplica migraciones reales y fixtures, y ejecuta `tests/*.sql` con salida TAP.
- `pnpm test:rls` (raíz `test:rls`): solo la matriz negativa RLS.

La conexión de migración y pruebas debe poder crear esquemas y hacer `SET ROLE casa_clara_app` / `casa_clara_worker` (superusuario del clúster local o de CI). El runtime de la aplicación nunca usa ese rol: se conecta con logins sin `BYPASSRLS` (`infra/postgres/00-create-roles.sh`).

## Reglas

- Toda entidad lleva `household_id` y las claves compuestas impiden relaciones cruzadas entre hogares.
- RLS activada y forzada en todas las tablas de `app` y `app_private`; el contexto se fija con `app.set_household_context()` tras autenticar (`packages/server`).
- Acuerdos, libros, transiciones, recibos de comandos y auditoría son append-only; las correcciones son reversos o ajustes, nunca `UPDATE`/`DELETE`.
- Las compensaciones no caducan (desviación AC-03 aprobada): el saldo vive en `compensation_ledger_entries` hasta su consumo o ajuste trazable.
- Las fixtures son deliberadamente ficticias (`fixture-casa-roble`, `fixture-casa-olivo`) y reproducen el caso de aceptación de marzo con total 145.330 céntimos.
