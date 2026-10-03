# Módulo Cupones — diseño

Fecha: 2026-10-03 · Rama: `feat/cupones` · Base: `main` @ `79e6a4c`
Estado: aprobado por el propietario en conversación (decisiones §2), con orden
expresa de implementarlo hasta producción.

## 1. Qué es y para quién

Una cartera de cupones **de la familia**. Alguien de la familia hace una foto a un
cupón (de descuento, vale, promoción), apunta unos pocos campos y lo guarda. Más
tarde cualquiera de la familia lo **recupera** (lo encuentra, lo abre, enseña el
código o la foto en caja), **apunta cada uso** y, cuando ya no sirve, lo
**descarta** (y puede recuperarlo si se equivocó).

La aplicación **no controla** los usos: solo los **registra** y lleva el
**inventario** (cuántos usos quedan). Que un cupón esté caducado o gastado no
impide nada; solo decide **qué se ve por defecto** (filtros).

Criterio de éxito: en la puerta del súper, en dos toques se ve el código del
cupón que se busca; tras usarlo, un toque lo apunta; los cupones caducados o
gastados dejan de estorbar en la lista sin perderse.

## 2. Decisiones del propietario (2026-10-03)

| # | Decisión | Elegido |
|---|---|---|
| D-audiencia | Quién | **Solo la familia**: `family_admin` y `family_member`. Empleada (`employee_live_in`), apoyo (`helper`) y acceso puntual (`viewer`) **no ven nada** del módulo, ni la foto ni sus metadatos. |
| D-reparto | De quién es cada cupón | **De toda la familia**: cualquiera de los dos papeles ve, crea, edita, usa, anula usos, descarta y recupera todos. |
| D-extracción | Cómo se rellenan los campos | **A mano en la v1**, con el flujo «foto primero → campos después» para enchufar en la fase 2 una propuesta de campos por IA (§12) sin cambiar el modelo. |
| D-usos | Usos | `max_uses` = 1, N o sin límite. **Solo registro e inventario, sin control**: no se rechaza un uso por agotado, caducado ni descartado. Cada uso guarda fecha y quién; un uso apuntado por error se **anula**. |
| D-visibilidad | Caducidad y uso | **Filtros**: por defecto se ven los disponibles; caducados, usados y descartados se ocultan en sus propios filtros. Un cupón de un uso, al usarse, pasa a «Usados»; uno de varios usos muestra su marca («2 de 5 usados») mientras siga disponible. |
| D-offline | Ver sin red | **Solo con red.** Usar, anular, descartar y recuperar sin red se encolan (bandeja de salida estándar). Crear exige red (hay que subir la foto). |
| D-campos | Campos | **Mínimos**: comercio, qué ofrece, código, caducidad, usos máximos, notas, foto. |
| D-aviso | Caducidad próxima | **Asunto en Hoy** (`kind: 'news'`) para la familia. Sin push. |

## 3. Fuera de alcance (v1)

Extracción por IA u OCR · lectura o generación de códigos de barras/QR · importes,
porcentajes y ahorro · enlace con Finanzas, la compra o los gastos · búsqueda
global · consulta sin red · notificaciones push · borrado físico de cupones o de
fotos · tarjetas regalo con saldo · cupones personales privados dentro de la
familia · variables de entorno nuevas · dependencias nuevas.

## 4. Modelo de datos — migración `packages/db/migrations/0039_coupons.sql`

Un único `BEGIN; … COMMIT;`. Calcar forma de `0016_shopping_and_archiving.sql`,
`0031_routine_completion_void.sql` y `0038_gastos_privados_y_alta_sin_admin.sql`.

```sql
CREATE TABLE app.coupons (
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  id uuid NOT NULL,                              -- generado por el cliente
  merchant text NOT NULL CHECK (length(btrim(merchant)) BETWEEN 1 AND 120),
  offer text NOT NULL CHECK (length(btrim(offer)) BETWEEN 1 AND 200),
  code text CHECK (code IS NULL OR length(btrim(code)) BETWEEN 1 AND 120),
  expires_on date,
  max_uses integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 999), -- NULL = sin límite
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  photo_storage_object_id uuid NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  discarded_at timestamptz,
  discarded_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, photo_storage_object_id) REFERENCES app.storage_objects(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, discarded_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK ((discarded_at IS NULL) = (discarded_by_membership_id IS NULL))
);

CREATE TABLE app.coupon_uses (
  household_id uuid NOT NULL,
  id uuid NOT NULL,                              -- generado por el cliente
  coupon_id uuid NOT NULL,
  used_on date NOT NULL,                         -- fecha local del hecho (Europe/Madrid), la pone el cliente
  used_by_membership_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  voided_at timestamptz,
  voided_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, coupon_id) REFERENCES app.coupons(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, used_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, voided_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK ((voided_at IS NULL) = (voided_by_membership_id IS NULL))
);
CREATE INDEX coupon_uses_live_idx ON app.coupon_uses (household_id, coupon_id) WHERE voided_at IS NULL;
CREATE INDEX coupons_household_idx ON app.coupons (household_id, discarded_at, expires_on);
```

Reglas:

- **RLS**: `ENABLE` junto a cada `CREATE TABLE`; `FORCE ROW LEVEL SECURITY` de las
  dos tablas **al final del fichero** (lección de la 0032). Políticas:
  - `coupons_family_read` (SELECT) y `coupons_family_write` (INSERT/UPDATE, sin
    DELETE): `app.tenant_context_matches(household_id) AND app.family_role()`. En
    `WITH CHECK` de INSERT, `created_by_membership_id = app.current_membership_id()`.
  - `coupon_uses_family_read` / `_write`: igual, heredando visibilidad con
    `EXISTS` sobre `app.coupons` (patrón `0008:382-389`); en INSERT,
    `used_by_membership_id = app.current_membership_id()`; en UPDATE solo se
    pueden fijar `voided_at`/`voided_by_membership_id` y `voided_by = yo` (patrón
    dos ramas de `0031:137-158`; un uso anulado no se «desanula»).
  - **Foto**: política permisiva **nueva** `storage_objects_read_coupon_photo` ON
    `app.storage_objects` FOR SELECT: `app.tenant_context_matches(household_id)
    AND EXISTS (SELECT 1 FROM app.coupons c WHERE c.household_id =
    storage_objects.household_id AND c.photo_storage_object_id = storage_objects.id)`.
    Como el `EXISTS` pasa por la RLS de `coupons` (solo familia), la foto solo la
    ve la familia. **No se crea fila en `app.documents`** (con `household` o
    `employment` la empleada vería los metadatos; `private` dejaría fuera al
    resto de la familia). No se toca `documents_read` ni las políticas existentes.
- **Sin DELETE**: no se concede `DELETE` a `casa_clara_app` en ninguna de las dos.
- `GRANT SELECT, INSERT, UPDATE` explícitos a `casa_clara_app`; nada a
  `casa_clara_worker`.
- `updated_at` con `app_private.touch_updated_at()`.
- **Auditoría** de ambas tablas con el bucle de `0036:463-480`.
- Bloque `DO $check$` final que compruebe en `pg_policies`/`pg_class` que existen
  las políticas, `relrowsecurity` y `relforcerowsecurity` (patrón `0038:80-110`).
- **Sin triggers de invariante de usos** (D-usos).
- Si hace falta una función, preferir plpgsql; nada de `LANGUAGE sql` con
  `row_security = off` antes del `FORCE`.

Suite SQL `packages/db/tests/210_coupons.sql` (estructura de
`030_finance_rls.sql`), añadida a la lista de `test:rls` en
`packages/db/package.json`: matriz de los cinco papeles (familia lee/escribe;
empleada, apoyo y viewer ven **cero** cupones, **cero** usos y **cero** objetos de
almacenamiento de fotos de cupón), aislamiento entre hogares, `WITH CHECK` de
autoría, anulación (pareja `voided_*`, no se desanula), sin DELETE, CHECKs de
longitud y `max_uses`, membresía caducada sin acceso, ENABLE+FORCE.

## 5. Contratos — `packages/contracts`

- Capacidad nueva **`coupon.access`** en `src/capabilities.ts` (tras
  `"content.publish"`), en `family_member` (y `family_admin` por «todas»). No
  reexportar la matriz desde la raíz. Actualizar la lista exacta de
  `apps/web/tests/capabilities.test.ts`.
- `"coupon"` en **las dos** listas: `AggregateType` (`src/index.ts`) y el
  `z.enum` de `commandEnvelopeSchema` (`src/schemas.ts`). Añadir un test que
  compare ambas listas para que no vuelvan a divergir.
- `couponCommandPayloadSchema` = `z.discriminatedUnion("action", …)`:

| action | payload (además de `action`) |
|---|---|
| `create` | `couponId` uuid, `merchant` 1–120, `offer` 1–200, `code` 1–120 \| null, `expiresOn` `YYYY-MM-DD` \| null, `maxUses` 1–999 \| null, `notes` ≤1000 \| null, `photoStorageObjectId` uuid |
| `update` | `couponId`, `merchant`, `offer`, `code`, `expiresOn`, `maxUses`, `notes` (sustitución completa de los campos editables) y `photoStorageObjectId` uuid **opcional** (cambiar foto) |
| `use` | `couponId`, `useId` uuid, `usedOn` `YYYY-MM-DD` |
| `void_use` | `couponId`, `useId` |
| `discard` | `couponId` |
| `restore` | `couponId` |

  Texto: `trim()` y cadenas vacías → `null` en los opcionales (lo hace el
  constructor del cliente y lo vuelve a validar Zod). Tipos de payload solo como
  `type`/`interface` en `src/index.ts` (precedente Finanzas).

## 6. Dominio puro — `packages/domain/src/coupons/`

Subpath `"./coupons"` en `packages/domain/package.json` (precedente `./finance`).
Sin reloj: «hoy» llega como `LocalDate`.

```ts
export type CouponBucket = 'available' | 'used' | 'expired' | 'discarded';
export interface CouponFacts { maxUses: number | null; liveUses: number; expiresOn: LocalDate | null; discarded: boolean; }
export function couponBucket(facts: CouponFacts, today: LocalDate): CouponBucket;
// Precedencia: discarded > used (maxUses != null && liveUses >= maxUses) > expired (expiresOn < today) > available.
export function remainingUses(facts: CouponFacts): number | null; // null = sin límite; nunca negativo
export function expiresSoon(facts: CouponFacts, today: LocalDate, days?: number): boolean; // available && expiresOn ∈ [today, today+days], days = 3
export const COUPON_EXPIRY_NOTICE_DAYS = 3;
```

Tests unitarios exhaustivos de bordes (caduca hoy = disponible; ayer = caducado;
`liveUses > maxUses` = usado y quedan 0; sin límite nunca «usado»).

## 7. Servidor

### 7.1 Comandos — `packages/server/src/commands/coupon.ts`

`couponCommandHandlers` reexportado en `packages/server/src/index.ts` y registrado
en `apps/web/src/routes/api/v1/sync/+server.ts`. Orden fijo: papel → `safeParse`
→ SQL bajo RLS (`withAuthorizedTransaction`) → `{ resourceId }`. Switch
exhaustivo con `never` (patrón `commands/finance.ts:1278-1401`).

- **Papel**: si el papel no es `family_admin`/`family_member` →
  `CommandRejectedError('forbidden')` (o el código equivalente que ya use el
  repo para «esta parte la lleva la familia»; reutilizar, no inventar).
- `create`: comprobar la foto (abajo) e `INSERT … ON CONFLICT (household_id, id)
  DO NOTHING` (idempotente por id del cliente aunque «Reintentar» cambie el
  `operationId`).
- `update`: `UPDATE` de los campos; si viene `photoStorageObjectId`, misma
  comprobación de foto. Inexistente o invisible → `coupon_not_found`.
- `use`: `INSERT INTO coupon_uses … ON CONFLICT DO NOTHING`. Cupón inexistente →
  `coupon_not_found`. **No** se rechaza por agotado, caducado ni descartado.
- `void_use`: `UPDATE … SET voided_at = now(), voided_by = yo WHERE id = $useId
  AND coupon_id = $couponId AND voided_at IS NULL`; si ya estaba anulado no hace
  nada (convergente); si no existe → `coupon_use_not_found`.
- `discard` / `restore`: escritura convergente `WHERE (discarded_at IS NULL) = $x`
  (patrón `setArchived`, `commands/food.ts:95-124`).
- **Regla de enlace de la foto** (seguridad): el `storage_object` debe existir en
  el hogar, **`created_by_membership_id = yo`**, `deleted_at IS NULL`,
  `media_type IN ('image/jpeg','image/png','image/webp')`. Si no →
  `coupon_photo_invalid`. Nunca «cualquier objeto visible» (`family_admin` ve
  todos los objetos y podría colgar el justificante privado de otra persona).
- Códigos nuevos de rechazo: `coupon_not_found`, `coupon_use_not_found`,
  `coupon_photo_invalid`, traducidos en `apps/web/src/lib/offline/error-codes.ts`
  (y `outbox-triage.ts` si procede) con su test.
- Integración `packages/server/src/coupons.integration.test.ts` (`describe.runIf`
  con `TEST_DATABASE_URL`): cada acción, idempotencia (mismo `couponId`/`useId`
  con `operationId` distinto no duplica), regla de la foto (de otra persona, de
  otro hogar, PDF, borrada), rechazo por papel (empleada, apoyo, viewer), dos
  `use` simultáneos con `Promise.all` quedan como dos usos. Prefijos de UUID de
  prueba: `cd…` (hogar roble) y `ce…` (hogar olivo).

### 7.2 Subida de adjuntos (cambio fuera del módulo)

`apps/web/src/lib/server/attachments.server.ts`: hoy el `23505` de la
`UNIQUE (bucket, object_key)` acaba en **500** cuando dos personas suben los mismos
bytes. Traducirlo: si el objeto existente es de la misma membresía y del mismo
hogar, devolverlo (subida idempotente); si no, `AttachmentError` **409**
`attachment_duplicate` con mensaje en castellano («Esa foto ya la subió otra
persona de la casa»). Con test.

### 7.3 Foto — `GET /api/v1/households/[householdId]/coupons/[couponId]/photo`

Calcar `receipts/[expenseId]/+server.ts` + la comprobación de bucket de
`settlements/[settlementId]/receipt/+server.ts`: sesión, pertenencia, capacidad
`coupon.access`, consulta bajo RLS `coupons JOIN storage_objects`, flujo desde el
`StorageBackend`, `Content-Type` de la lista blanca, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: no-store`. **404
opaco** si no existe o no se ve. Nunca URL pública ni firmada. Logs sin comercio,
código ni nombre de fichero.

### 7.4 Cargador — `apps/web/src/lib/server/coupons.server.ts`

`loadCoupons(...)` dentro de `withAuthorizedTransaction`; devuelve:

```ts
export interface CouponUseView { id: string; usedOn: string; usedByName: string; }
export interface CouponView {
  id: string; merchant: string; offer: string; code: string | null;
  expiresOn: string | null; maxUses: number | null; liveUses: number;
  remaining: number | null; notes: string | null;
  bucket: CouponBucket; expiresSoon: boolean;
  discardedAt: string | null; createdAt: string; createdByName: string;
  photoUrl: string;               // la ruta de §7.3
  uses: CouponUseView[];          // usos vivos, más recientes primero
}
export interface CouponsPageData { today: string; coupons: CouponView[]; merchants: string[]; counts: Record<CouponBucket, number>; }
```

«Hoy» en Europe/Madrid como `apps/web/src/lib/server/today.server.ts`. Maqueta
`getCouponsFixture()` en `fixtures.server.ts` con `demoOrUnavailable` para el modo
sin base (e2e y a11y). Test de integración del cargador (o en el de servidor).

### 7.5 Hoy

En `today.server.ts`: una consulta más (cupones disponibles que caducan en
`[hoy, hoy+3]`), solo si la persona tiene `coupon.access`. En
`buildTodayDecisions`, un único asunto `kind: 'news'` con texto del servidor:
1 cupón → «El cupón de {comercio} caduca {fecha en palabras}» / detalle `{offer}`
/ `cta: 'Verlo'` / `href: …/cupones?cupon={id}`; varios → «{n} cupones caducan
pronto» / detalle con los comercios / `cta: 'Verlos'` / `href: …/cupones`. Clave
estable `cupones-caducan`. Test en `apps/web/tests/today-decisions.test.ts`
(incluido que la empleada no lo recibe). No toca la plantilla de Hoy ni su
presupuesto de bytes.

## 8. Interfaz — `apps/web`

### 8.1 Alta del módulo (los puntos coordinados, precedente Finanzas)

`HOUSEHOLD_MODULES` += `'cupones'`; `MODULE_CAPABILITY.cupones = 'coupon.access'`
(`src/lib/auth/routing.ts`); `SECTION_LABELS.cupones = 'Cupones'`
(`src/lib/app-title.ts`); entrada en `NAV_ENTRIES` de `AppShell.svelte` **fuera de
los cuatro primeros puestos** de `familyOrder` y `handsOnOrder` (barra lateral y
hoja «Más»); trazo `cupones` en `NavIcon.svelte` (una etiqueta con muesca, no el
«+» genérico). Tests de lista exacta: `routing`, `routes-declared`, `app-title`,
`capabilities`, `mobile-nav` si cambia. Sin rutas hijas (el detalle es una hoja
`?cupon=<id>`, no `cupones/[id]`, que `guardForPath` convertiría en 404). Para
papeles sin la capacidad: 403 amable «Esta parte la lleva la familia.» (ya lo
hace el layout).

### 8.2 Página `src/routes/h/[householdId]/cupones/`

- `+page.server.ts`: `depends('cc:coupons')`, `loadCoupons` o la maqueta.
- Cabecera `PageHeader` cuyo título **dice el estado**: «Cupones · N disponibles»
  (plural resuelto); `ActionStatus` debajo.
- **Filtros** en la URL `?ver=disponibles|usados|caducados|descartados` (por
  defecto `disponibles`), `.chip-strip` con recuento por cubo; navegación con
  `goto(…, { noScroll: true, keepFocus: true })`. Más un campo «Buscar» que filtra
  en el cliente por comercio, oferta, código y notas (sin tocar la búsqueda global).
- **Fila** `.fila-lista` con `data-lista="principal"`: `<strong>{comercio} ·
  {oferta}</strong>`, `<small>` con caducidad en palabras («Caduca el vie 10 oct»,
  «Sin caducidad») y la marca de usos: «Un solo uso» · «2 de 5 usados · quedan 3» ·
  «Sin límite · usado 4 veces». `status-chip warning` «Caduca pronto» si procede.
  Un solo verbo por fila: **«Usar»** (solo en disponibles), con `aria-label` que
  nombra el cupón. Toda la fila abre el detalle.
- **Detalle**: hoja `modalDialog` (como `FinanceDetailPanel`) abierta con
  `?cupon=<id>`: `h2` con el comercio; **código en grande** (tipografía tabular) con
  botón «Copiar»; foto (`<img src={photoUrl}>`, toque → pantalla completa);
  oferta, caducidad, usos, notas, quién lo guardó; **lista de usos** («Usado el
  mar 7 oct por Marta») con «Anular este uso»; acciones «Usar», «Editar»,
  y en `.action-row.destructiva` «Descartar el cupón de {comercio}» o, si está
  descartado, «Recuperar».
- **Usar** = comando `use` con `useId` nuevo y `usedOn` = hoy local; UI optimista
  (`OptimisticActions` apply/revert/settle) con guardia de doble toque por cupón;
  `ActionStatus` «Uso apuntado ✓ · Deshacer» (deshacer = `void_use` del mismo
  `useId`). Funciona sin red (bandeja de salida).
- **Añadir cupón** (botón principal; formulario plegable en la propia página):
  1. **Foto**: dos campos, «Elegir una foto guardada» y «Hacer la foto ahora»
     (`capture="environment"`), extrayendo `PhotoPicker.svelte` de
     `ExpensesPendingCard.svelte` y usándolo en ambos sitios. `prepareAttachment`
     con una opción nueva **`alwaysReencode`** (quita EXIF/GPS siempre; calidad ≥
     0,8 para no romper códigos finos). Vista previa **sin `blob:`** (la CSP no lo
     permite): `canvas.toDataURL`. Subida con `uploadAttachment` **en ese momento**;
     sin red: «Necesitas conexión para guardar la foto del cupón».
  2. **Campos** (`CouponFields.svelte`, alimentado por un `CouponDraft` inicial —
     el punto de enganche de la IA en la fase 2): comercio (obligatorio, con
     `datalist` de comercios ya usados), qué ofrece (obligatorio), código,
     caducidad (`type="date"`), usos (`fieldset` de radios: «Un solo uso» ·
     «Varios usos» → «¿Cuántos?» `inputmode="numeric"` · «Sin límite»), notas.
     Ejemplos en `.field-hint`, nunca en `placeholder`.
  3. Guardar = comando `create` con `couponId` del cliente.
- **Editar**: mismo `CouponFields` con los valores actuales (+ «Cambiar foto»).
- **Estados vacíos**: explican la pantalla («Todavía no hay cupones. Hazle una foto
  al vale y apunta dónde sirve y hasta cuándo.») y por filtro («No hay cupones
  caducados»).
- Constructores de comandos en `src/lib/coupons/commands.ts` **sin Zod** (con
  `satisfies`, patrón `lib/food/commands.ts`). Componentes en
  `src/lib/components/coupons/`. Ambos prefijos **desterrados** del grafo inicial de
  Hoy en `scripts/verify-today-bundle.mjs`.
- CSS solo con tokens (`--space-*`, `--text-*`, `--r-*`), pesos 400/500/700, sin
  colores literales (`pnpm check`). Glosario: «Guardado ✓», «Usar», «Usado»,
  «Caducado», «Descartar», «Recuperar», «Quedan 3 usos»; nunca «canjear»,
  «redención», «sincronizado», «servidor» ni «Housekeeper».

## 9. Seguridad

- Frontera = RLS (§4) + capacidad en hook/layout + papel en el handler.
- La empleada, el apoyo y el viewer no ven filas, ni usos, ni objetos de foto, ni
  el asunto en Hoy, ni la entrada de navegación; la URL directa da 403 y la ruta de
  la foto 404.
- `audit_events` copiará los campos del cupón (incluido el código) y los lee
  `family_admin`: aceptable porque la audiencia del módulo ya incluye a la
  administración. Documentarlo.
- Foto: EXIF/GPS eliminados en cliente (`alwaysReencode`); servida por proxy con
  `nosniff` + `sandbox` + `no-store`; regla de enlace §7.1.
- Logs con lista blanca: nunca comercio, código, oferta, notas ni EXIF.
- Revisión de seguridad **ejecutada** en `docs/security/revision-cupones.md`
  (consultas a `pg_policies`, prueba de la empleada, cabeceras de la foto, logs).

## 10. Pruebas y puertas

- Unitarias: contracts (esquemas y rechazos, igualdad de listas de agregados),
  domain (cubos y bordes), web (`routing`, `routes-declared`, `app-title`,
  `capabilities`, `error-codes`, `today-decisions`, constructores de comandos).
- BD: `210_coupons.sql` en `test:db` y `test:rls`; `db:migrate` ×2 (la segunda
  aplica 0); `probe:supabase`.
- Integración servidor y web con `TEST_DATABASE_URL` **sin skips**.
- Navegador: `e2e/cupones.e2e.ts` (maqueta: lista, filtros, búsqueda, detalle),
  entrada en `e2e/critical.a11y.ts` (lista y hoja abierta), `e2e/cupones.dbe2e.ts`
  (siembra con prefijo `cf…` en `db-global-setup.ts`: alta con foto sintética
  generada por código, usar, deshacer, anular, descartar, recuperar, filtros,
  empleada sin acceso), `cupones` en `ROUTES` de `mobile-overflow.dbe2e.ts` y
  `mobile-densidad.dbe2e.ts`.
- `pnpm lint`, `pnpm typecheck`, `pnpm check`, `pnpm test`, build +
  `verify:bundle`. El recuento de `pnpm test` debe crecer respecto a `main`.
- Solo datos sintéticos; ninguna foto real en git.

## 11. Entrega

1. Cimientos: capacidad, contrato, dominio, migración y suite SQL.
2. Servidor: comandos, subida 409, ruta de la foto, Hoy.
3. Interfaz: alta del módulo, cargador, página, componentes, maqueta.
4. Navegador: e2e, a11y, dbe2e, móviles, bundle.
5. Revisión adversarial (corrección, seguridad, UX/a11y) y correcciones.
6. Documentación: revisión de seguridad, manual (`docs/manual/index.html`, tabla de
   permisos), skill `operar-la-casa`, runbook (§2 «última migración 0039», §7 humo).
7. Producción: `deployable` verde en CI → copia → `db:migrate` en Supabase ×2
   (pooler modo sesión, `uselibpqcompat=true`) **antes** del merge → merge (Vercel
   despliega) → humo (`/api/health`, sondeo sin sesión de las rutas nuevas).

Variables de entorno nuevas: **ninguna**. Dependencias nuevas: **ninguna**.
Worker: **sin cambios**. `CriticalSnapshot`: **sin cambios**.

## 12. Fase 2 (no se implementa): propuesta de campos por IA

Entre el paso 1 (foto subida) y el 2 (campos) del alta: `POST
/api/v1/households/[householdId]/coupons/extract { storageObjectId }` →
`Partial<CouponDraft>` que precarga `CouponFields`; la persona revisa y guarda.
Requerirá decidir proveedor y región (la casa pide host UE), una variable de
entorno opcional y fallar cerrado (sin clave, todo sigue a mano).
