# Prompt: módulo Garantías, del diseño a producción

Fecha de las decisiones: 2026-10-31 · Propietario: Alberto Baselga · Estado:
listo para ejecutar en una sesión futura · Orden recomendado: **1 de 4** (ver
`README.md` de esta carpeta).

> **Cómo usar este prompt.** Pégalo, o pide a la sesión que lo lea, junto con
> `docs/superpowers/prompts/workflow-comun.md`. El workflow común dice **cómo**
> se trabaja en este repositorio (entorno, fases, puertas, producción); este
> prompt dice **qué** se construye y qué está ya decidido. Lo que aquí está
> cerrado no se vuelve a preguntar; lo que está propuesto se puede discutir con
> argumentos; lo que está abierto se pregunta al propietario en una sola tanda
> antes de escribir el spec.

---

## 1. Qué se construye y por qué

Un **archivo de garantías de la casa**, hermano de Cupones. Cualquier cosa que
tenga garantía o que convenga poder reclamar: una lavadora, el coche y su
última reparación, un móvil, una caldera, una obra. Alguien de la familia
guarda lo que tiene a mano (la foto del ticket, el certificado, la factura en
PDF), apunta de qué artículo se trata y hasta cuándo responde quien lo vendió
o lo reparó. Meses después, cuando algo se rompe, en dos toques se encuentra
la garantía, se ve si **sigue vigente** y se enseña el papel.

En palabras del propietario: tiene que ser **muy genérico**. No es un gestor
de electrodomésticos ni de coches: es «una imagen, un código, un numerito, un
identificador, algo genérico y una descripción del artículo, para después
poderlo buscar», con fecha de compra y fecha de fin de garantía.

Criterio de éxito: delante del técnico, la ficha de la caldera sale en dos
toques y dice «En garantía hasta el 14 de marzo de 2028» con la factura al
lado. Las garantías vencidas dejan de estorbar sin perderse. Buscar «lavadora»,
«Media Markt», el número de serie o «cocina» encuentra la ficha aunque la
persona no recuerde cómo la guardó.

## 2. Decisiones cerradas por el propietario (2026-10-31)

| # | Decisión | Elegido |
|---|---|---|
| D-audiencia | Quién | **Solo la familia**: `family_admin` y `family_member`, exactamente como Cupones. Empleada interna, apoyo y acceso puntual **no ven nada**: ni filas, ni documentos, ni el asunto en Hoy, ni la entrada de navegación. |
| D-reparto | De quién es cada garantía | **De toda la familia**: cualquiera de los dos papeles ve, crea, edita, archiva y recupera todas. Sin garantías privadas de una persona. |
| D-documentos | Cuántos papeles por garantía | **Varios**: ticket, certificado, factura, parte de reparación… en la misma ficha. **Fotos y PDF** (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`, que son los que ya admite el almacén de adjuntos). |
| D-incidencias | Historial de averías o reclamaciones | **No en v1.** La garantía guarda sus datos y sus papeles; lo que pase después se apunta en las notas o como un documento más. No hay tabla de incidencias. |
| D-genérico | Tipo de artículo | **Sin categorías cerradas.** Un campo de texto libre con sugerencias de lo ya usado, nunca un enumerado. |
| D-fechas | Fechas | Fecha de compra y fecha de fin de garantía. La aplicación dice si está **vigente** o **vencida** en función de hoy. |
| D-búsqueda | Cómo se encuentra | Texto libre sobre todos los campos de texto de la ficha y las etiquetas de sus documentos. |

## 3. Decisiones propuestas por el redactor (revisables en la sesión, con argumentos)

Están marcadas como propuestas porque un constructor sensato podría elegir
otra cosa sin cambiar lo que el propietario pidió. Si la sesión las cambia, lo
dice en el spec con el porqué.

- **Capacidad propia `warranty.access`**, en la misma matriz que
  `coupon.access` (familia entera; nada para los otros tres papeles). No se
  reutiliza `coupon.access` aunque hoy coincidan: dos módulos con una sola
  llave no se pueden separar después sin tocar la base.
- **Agregado `warranty`** con acciones `create`, `update`, `archive`,
  `restore`, `add_document`, `remove_document`. «Archivar» es «ya no tengo
  este artículo» o «esto ya no me interesa», reversible; la fecha de
  vencimiento no cambia de estado nada (como en Cupones, el estado se calcula).
- **Campos de la garantía**: `item` (qué es, 1–120, obligatorio),
  `description` (descripción libre, ≤ 1000), `identifier` (número de serie,
  referencia, número de pedido o lo que haga de identificador, ≤ 120,
  opcional), `vendor` (comercio, marca o taller, ≤ 120, opcional, con
  `datalist` de los ya usados), `category` (texto libre ≤ 60, opcional, con
  `datalist` de las ya usadas: «Electrodoméstico», «Coche», «Reparación»…),
  `purchased_on` (fecha de compra, **opcional**), `warranty_until` (fin de
  garantía, **opcional**: «no la sé» es un estado honesto, y se muestra como
  «Sin fecha de fin»), `notes` (≤ 1000). Las dos fechas son opcionales por el
  mismo argumento: una caldera antigua con certificado y sin ticket se tiene
  que poder guardar. El formulario anima a poner las dos; el `CHECK` de orden
  (`warranty_until >= purchased_on`) solo aplica cuando existen ambas. Todas
  las fechas en el rango 2000–2999 con `CHECK`, como en la 0039.
- **Ayuda para el fin de garantía en el formulario**: además de la fecha, un
  atajo «2 años desde la compra» / «3 años» / «otra duración» que rellena la
  fecha. Se guarda **solo la fecha**; la duración no se persiste.
- **Documentos**: tabla hija `app.warranty_documents` con `label` libre
  (≤ 80, con sugerencias «Ticket de compra», «Certificado de garantía»,
  «Factura», «Parte de reparación») y referencia a `app.storage_objects`.
  **De 0 a 10 documentos por garantía**: se puede guardar una garantía sin
  papel (solo el número y las fechas) porque a veces es lo único que se tiene,
  pero el alta anima a subir el ticket. Quitar un documento es un borrado
  lógico (`removed_at`, `removed_by_membership_id`), nunca `DELETE`.
- **Cubos** (dominio puro, como `couponBucket`): `archived` > `expired`
  (`warranty_until < hoy`) > `active` (incluye las sin fecha de fin, marcadas
  «Sin fecha de fin»). Filtros en la URL `?ver=vigentes|vencidas|archivadas`,
  por defecto `vigentes`, ordenadas por fin de garantía más próximo y las sin
  fecha al final.
- **Aviso en Hoy**: asunto `kind: 'news'` con clave estable `garantias-vencen`
  cuando una garantía vigente vence en **30 días o menos**
  (`WARRANTY_EXPIRY_NOTICE_DAYS = 30`), solo para quien tiene
  `warranty.access`. Sin push. Treinta y no tres como en Cupones, porque una
  garantía que vence invita a revisar el aparato antes, no a correr al súper.
- **Sin red**: ver, exige red (como Cupones). Archivar y recuperar se
  encolan en la bandeja de salida. Crear y añadir documentos exigen red si
  hay fichero que subir; crear sin documento se encola igual que cualquier
  comando.
- **Extracción de campos por IA**: fuera de la v1, con el mismo punto de
  enganche que Cupones §12 (foto primero, campos después, `WarrantyDraft`
  inicial).
- **Dónde se demuestra el PDF de verdad** (decisión del redactor tras la
  comprobación del constructor): las cuatro suites de navegador **no sirven
  bytes reales**, como en Cupones (`db-global-setup.ts` siembra filas de
  `storage_objects` sin fichero detrás, y la maqueta sirve un SVG en `data:`).
  El proxy del documento, el PDF con `sandbox` y el rechazo de un `.docx` se
  demuestran en **vitest** con el almacén simulado y en la **revisión de
  seguridad** contra el MinIO de `infra/compose.local.yml`; «abrir el PDF» de
  verdad se comprueba en el humo de producción. No se añade un almacén real a
  las baterías de CI.

## 4. Preguntas abiertas que la sesión cierra con el propietario antes del spec

Una sola tanda, con recomendación. Si el propietario dice «decide tú», se
toma la recomendación y se anota como decisión del redactor.

1. **La deuda de la 0005.** `docs/security/revision-cupones.md` §«Deuda
   previa» describe dos agujeros de las políticas `storage_objects_write` y
   `documents_write` que Cupones no corrigió, con una migración propuesta y
   ensayada. Garantías abre un **segundo** objetivo a esos agujeros (sus
   documentos). Recomendación: aplicar esa corrección como migración **aparte
   y anterior** a la de garantías, con su suite, en el mismo PR o en uno
   previo. Alternativa: dejarla documentada otra vez y no tocarla.
2. **Importe de compra.** El propietario no lo pidió. Recomendación: **no**
   en v1 (evita céntimos, moneda y la tentación de cruzarlo con Finanzas).
3. **Búsqueda global.** `/h/<hogar>/search` hoy no incluye cupones.
   Recomendación: búsqueda **en el cliente dentro del módulo** en v1, como
   Cupones, reutilizando `foldText` de `apps/web/src/lib/search/offline.ts`;
   la global, si se quiere, en una iteración posterior y para ambos módulos.
4. **El mismo papel en dos garantías, y el papel que subió otra persona.** La
   subida deduplica por `sha256` dentro del hogar
   (`apps/web/src/lib/server/attachments.server.ts`): si la misma persona
   vuelve a subir el mismo fichero recibe el id que ya existía; si lo subió
   **otra** persona de la casa, 409 «Ese fichero ya lo subió alguien de la
   casa». Con garantías de toda la familia, el caso real es un ticket que
   cubre lavadora y secadora, o un certificado que escanea uno y necesita el
   otro. Hay que decidir (a) si un objeto puede estar vivo en dos
   `warranty_documents` y (b) si rige «objeto propio» estricto como en
   Cupones o se admite un objeto subido por cualquier persona **con papel de
   familia**. Cambia el índice de unicidad de documentos vivos, el disparador
   de enlace, el comando y el texto del 409. Recomendación: permitir el mismo
   objeto en varias garantías **del mismo autor**, mantener «objeto propio»
   (no abrir el agujero A de la 0005) y que el 409 diga quién lo tiene que
   añadir («Lo subió Marta: pídele que lo añada a esta garantía»).

## 5. Fuera de alcance (v1)

Incidencias y reclamaciones · importes · extracción por IA u OCR · lectura
de códigos de barras · recordatorios push · enlace con Finanzas, Cupones o la
compra · consulta sin red · borrado físico de garantías o documentos ·
garantías privadas de una persona · compartir una garantía fuera de la casa ·
categorías cerradas · variables de entorno nuevas · dependencias nuevas ·
cambios en el worker o en `CriticalSnapshot`.

## 6. Lee primero (además de la lista del workflow común)

El molde es Cupones. Léelo entero antes de proponer nada; la mayoría de las
decisiones técnicas ya están tomadas allí con su porqué:

| Fichero | Qué copiar o adaptar |
|---|---|
| `docs/superpowers/specs/2026-10-03-modulo-cupones-design.md` | Estructura del spec y todas las secciones técnicas |
| `packages/db/migrations/0039_coupons.sql` | Forma de la migración: tablas por hogar, RLS familia, política de lectura del objeto de almacenamiento heredada por `EXISTS`, disparador de enlace de la foto, `coupon_people()`, auditoría, `DO $check$` |
| `packages/db/tests/210_coupons.sql` | Matriz de los cinco papeles, aislamiento entre hogares, autoría, sin DELETE, ENABLE+FORCE |
| `packages/contracts/src/capabilities.ts`, `src/index.ts`, `src/schemas.ts` y sus tests (`coupon-commands.test.ts`, `aggregate-types.test.ts`); la lista exacta de capacidades vive en `apps/web/tests/capabilities.test.ts` y la de módulos en `apps/web/tests/routing.test.ts` | Capacidad, agregado, esquemas y los tests de listas exactas |
| `packages/domain/src/coupons/` | Dominio puro de cubos con tests de bordes |
| `packages/server/src/commands/coupon.ts` y `packages/server/src/coupons.integration.test.ts` | Handler: papel → `safeParse` → SQL bajo RLS; regla de enlace del objeto (`requireOwnCouponPhoto`); idempotencia por id del cliente; `for update` al cambiar la foto |
| `apps/web/src/lib/server/coupons.server.ts`, `coupon-photo.server.ts`, `fixtures.server.ts`, `today.server.ts` | Cargador bajo RLS, servicio del fichero, maqueta para e2e/a11y, asunto en Hoy |
| `apps/web/src/routes/api/v1/households/[householdId]/receipts/[expenseId]/+server.ts` | **El molde del documento**: ya sirve justificantes en PDF con `Content-Disposition: inline; filename="justificante-<id><ext>"` y CSP `default-src 'none'; sandbox; frame-ancestors 'none'` |
| `apps/web/src/routes/api/v1/households/[householdId]/coupons/[couponId]/photo/+server.ts` | Proxy autenticado solo de imagen, con la comprobación de capacidad y el 404 opaco |
| `apps/web/src/lib/server/attachments.server.ts` y `apps/web/src/lib/attachments/upload.ts` | Tipos admitidos (ya incluye PDF), 10 MiB, firma de bytes, deduplicación por `sha256` y el 409 cuando lo subió otra persona |
| `apps/web/src/lib/components/PhotoPicker.svelte` (compartido; prop `pickAccept`, ya admite `application/pdf` desde `employment/ExpensesPendingCard.svelte`), `apps/web/src/lib/attachments/prepare.ts` (los PDF no se reencodan) | Lo reutilizable del selector; el envoltorio de cupones es `components/coupons/CouponPhotoField.svelte` y `lib/coupons/photo.ts` |
| `apps/web/src/lib/coupons/` y `apps/web/src/lib/components/coupons/` | Constructores de comandos sin Zod, borrador, cartera optimista, componentes (`CouponFields`, hoja de detalle, avisos pegajosos) |
| `apps/web/src/lib/offline/error-codes.ts` | Traducción de los códigos de rechazo (ya trae los tres de cupones) |
| `apps/web/src/routes/h/[householdId]/cupones/` | Página con filtros en la URL, búsqueda en cliente, hoja `?cupon=<id>` |
| `apps/web/e2e/cupones.e2e.ts`, `cupones.dbe2e.ts`, `critical.a11y.ts`, `db-global-setup.ts` (prefijo `cf…`), `mobile-overflow.dbe2e.ts`, `mobile-densidad.dbe2e.ts` | Las cuatro suites de navegador y la siembra |
| `apps/web/scripts/verify-today-bundle.mjs` | Dónde desterrar `src/lib/warranties/` y `src/lib/components/warranties/` |
| `docs/security/revision-cupones.md` | Revisión ejecutada y la deuda de la 0005 |
| `.claude/skills/operar-la-casa/referencia-operaciones.md` §Cupones y `docs/manual/index.html` (capítulo Cupones y tabla «Quién ve qué») | Documentación a calcar |
| `docs/despliegue/runbook-despliegue.md`, puntos 6 y 7 de la lista de «2. Aplicar el esquema» y el bloque Cupones de «7. Humo» | Lo que el runbook dice de un módulo nuevo |

## 7. Diseño de referencia

Es un esbozo para que el spec no parta de cero; el spec manda.

### 7.1 Migración `00NN_warranties.sql` (siguiente número libre)

```sql
CREATE TABLE app.warranties (
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  id uuid NOT NULL,                                    -- generado por el cliente
  item text NOT NULL CHECK (length(btrim(item)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  identifier text CHECK (identifier IS NULL OR length(btrim(identifier)) BETWEEN 1 AND 120),
  vendor text CHECK (vendor IS NULL OR length(btrim(vendor)) BETWEEN 1 AND 120),
  category text CHECK (category IS NULL OR length(btrim(category)) BETWEEN 1 AND 60),
  purchased_on date CHECK (purchased_on IS NULL OR (purchased_on BETWEEN '2000-01-01' AND '2999-12-31')),
  warranty_until date CHECK (warranty_until IS NULL OR (warranty_until BETWEEN '2000-01-01' AND '2999-12-31')),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  archived_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, created_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, archived_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK ((archived_at IS NULL) = (archived_by_membership_id IS NULL)),
  CHECK (warranty_until IS NULL OR purchased_on IS NULL OR warranty_until >= purchased_on)
);

CREATE TABLE app.warranty_documents (
  household_id uuid NOT NULL,
  id uuid NOT NULL,                                    -- generado por el cliente
  warranty_id uuid NOT NULL,
  storage_object_id uuid NOT NULL,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  added_by_membership_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  removed_at timestamptz,
  removed_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, warranty_id) REFERENCES app.warranties(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, storage_object_id) REFERENCES app.storage_objects(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, added_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, removed_by_membership_id) REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK ((removed_at IS NULL) = (removed_by_membership_id IS NULL))
);
```

- RLS: `warranties_family_read` / `_write` con `app.tenant_context_matches`
  y `app.family_role()`; `WITH CHECK` de autoría en INSERT; en
  `warranty_documents` la visibilidad hereda por `EXISTS` sobre
  `app.warranties`, en INSERT `added_by = yo`, en UPDATE solo se fijan
  `removed_*` y `removed_by = yo`. **Sin DELETE** concedido.
- Política permisiva nueva en `app.storage_objects` FOR SELECT,
  `storage_objects_read_warranty_document`, con `EXISTS` sobre
  `warranty_documents` vivos (hereda la RLS de garantías: solo la familia).
  **No se crea fila en `app.documents`** (mismo argumento que Cupones §4).
- Disparador de enlace `warranty_documents_link` (calcar `coupons_photo_link`):
  objeto del hogar, `created_by_membership_id = yo`, `deleted_at IS NULL`,
  `media_type IN ('image/jpeg','image/png','image/webp','application/pdf')`.
- Tope de **10 documentos vivos por garantía** en disparador, con un código
  que el comando traduzca (`warranty_documents_limit`). Índice único de
  documentos vivos por `(household_id, warranty_id, storage_object_id) WHERE
  removed_at IS NULL` (el mismo objeto no se añade dos veces a la misma
  garantía; en garantías distintas, según la respuesta a §4.4).
- `app.warranty_people()` como `app.coupon_people()` para los nombres de
  «Guardado por…» y «Añadido por…» a toda la familia.
- Índices: `(household_id, archived_at, warranty_until)` y el de documentos
  vivos. Auditoría de ambas tablas. `DO $check$` final.
- Suite `packages/db/tests/220_warranties.sql` en `test:rls`.

### 7.2 Contratos y dominio

- `warranty.access` en `capabilities.ts` (familia; lista exacta de
  `capabilities.test.ts` actualizada). `"warranty"` en las dos listas de
  agregados.
- `warrantyCommandPayloadSchema`:

| action | payload (además de `action`) |
|---|---|
| `create` | `warrantyId`, `item`, `description`, `identifier`, `vendor`, `category`, `purchasedOn` \| null, `warrantyUntil` \| null, `notes`, `documents: { documentId, storageObjectId, label }[]` (0–10) |
| `update` | `warrantyId` y la sustitución completa de los campos editables (sin documentos) |
| `archive` / `restore` | `warrantyId` |
| `add_document` | `warrantyId`, `documentId`, `storageObjectId`, `label` |
| `remove_document` | `warrantyId`, `documentId` |

- `packages/domain/src/warranties/`: `warrantyBucket(facts, today)`,
  `expiresSoon(facts, today, days = 30)`, `daysUntilExpiry`,
  `WARRANTY_EXPIRY_NOTICE_DAYS`. Bordes: vence hoy = vigente; ayer =
  vencida; sin fecha = vigente y nunca «vence pronto»; archivada manda.

### 7.3 Servidor

- `packages/server/src/commands/warranty.ts` con `requireFamilyRole` (ya
  existe en `commands/food.ts`), la regla de enlace por documento, `create`
  con `ON CONFLICT DO NOTHING` en garantía y documentos, `update` sin tocar
  documentos, `archive`/`restore` convergentes, `add_document` con el tope,
  `remove_document` convergente. Códigos: `warranty_not_found`,
  `warranty_document_not_found`, `warranty_document_invalid`,
  `warranty_documents_limit`, traducidos en `error-codes.ts`.
- `GET /api/v1/households/[householdId]/warranties/[warrantyId]/documents/[documentId]`
  calcando **la ruta de justificantes** (`receipts/[expenseId]/+server.ts`),
  que ya sirve PDF e imagen con extensión variable: `Content-Type` de la
  lista blanca, `Content-Disposition: inline; filename="garantia-<id><ext>"`
  (nombre sintético, nunca el original), CSP `default-src 'none'; sandbox;
  frame-ancestors 'none'`, `nosniff` y `no-store` (un PDF puede llevar
  JavaScript; el sandbox lo neutraliza). De la ruta de la foto de cupones se
  toma la comprobación de capacidad y el 404 opaco. En la ficha, el PDF se
  abre en una pestaña nueva o se descarga; no se incrusta en un `<iframe>`
  dentro de la aplicación.
- Cargador `warranties.server.ts` → `WarrantyView` con `bucket`,
  `expiresSoon`, `daysUntilExpiry`, documentos vivos con su `url`, nombres; y
  `WarrantiesPageData` con `counts`, `vendors`, `categories`. Maqueta en
  `fixtures.server.ts`.
- Hoy: una consulta más, solo con `warranty.access`; textos del servidor:
  «La garantía de {item} vence {fecha en palabras}» / varios: «{n} garantías
  vencen pronto».

### 7.4 Interfaz

Ruta `/h/<hogar>/garantias`, módulo `garantias` en los puntos coordinados,
`SECTION_LABELS.garantias = 'Garantías'`, entrada de navegación fuera de los
cuatro primeros puestos, trazo propio en `NavIcon.svelte` (un escudo con
marca, no el «+»). Sin rutas hijas: la ficha es `?garantia=<id>`.

- Cabecera que dice el estado: «Garantías · N vigentes». Barra con «Buscar» y
  «Añadir».
- Fila: `<strong>{item}</strong>` con `{vendor}` si lo hay; `<small>`: «En
  garantía hasta el vie 14 mar 2028» / «Vence en 12 días» (chip `warning`
  «Vence pronto») / «Vencida el …» / «Sin fecha de fin»; recuento de
  documentos («3 documentos»). Toda la fila abre la ficha; sin verbo en la
  fila (no hay acción rápida equivalente a «Usar»).
- Ficha (hoja `modalDialog`): `h2` con el artículo; estado en chips;
  identificador **en grande con «Copiar»**; compra y fin de garantía en
  palabras; descripción, categoría, notas, quién la guardó; **documentos**
  como lista de tarjetas (miniatura para imágenes, icono para PDF) con su
  etiqueta, «Abrir» y «Quitar» (dos toques); «Añadir documento»; «Editar»;
  en `.action-row.destructiva` «Archivar la garantía de {item}» o
  «Recuperar».
- Alta plegable en la página: paso 1 «¿Qué es?» (artículo obligatorio, con el
  resto de campos plegados bajo «Más datos»), paso 2 «Papeles» con un
  envoltorio nuevo `WarrantyDocumentField` sobre `PhotoPicker` (que **ya**
  admite PDF por `pickAccept`, como en los gastos: foto ahora / foto guardada /
  elegir un fichero) y etiqueta por documento, paso 3 «Fechas» con el atajo
  de duración.
  El orden es distinto de Cupones a propósito: aquí el papel es opcional y lo
  que identifica es el artículo. Guardar = `create`.
- Búsqueda en cliente con `foldText` sobre item, descripción, identificador,
  comercio, categoría, notas y etiquetas.
- Estados vacíos: «Todavía no hay garantías. Guarda el ticket y el
  certificado de lo que compres y sabrás hasta cuándo responde la tienda.»
- Glosario: «En garantía», «Vence pronto», «Vencida», «Archivar»,
  «Recuperar», «Guardado ✓», «Documento añadido ✓»; nunca «warranty»,
  «expirar», «subir al servidor».
- `src/lib/warranties/` y `src/lib/components/warranties/` desterrados del
  grafo inicial de Hoy. `PhotoPicker` **no cambia**: lo específico (reencodar
  siempre las imágenes, dejar pasar los PDF, mensajes) vive en el envoltorio
  nuevo, como `CouponPhotoField` y `lib/coupons/photo.ts` hacen para Cupones.
  En la maqueta y en las suites de navegador el documento es un SVG en
  `data:` (imagen) o un icono (PDF), nunca bytes reales.

### 7.5 Seguridad

Frontera = RLS + capacidad en hook/layout + papel en el handler. Además:

- Regla de enlace del documento (objeto propio, vivo, tipo permitido) en el
  comando **y** en el disparador.
- PDF: `sandbox`, `nosniff`, `no-store`, nombre de fichero fijo. Nunca se
  reproduce el nombre original del fichero en ninguna respuesta ni log.
- Imágenes reencodadas en cliente sin EXIF/GPS (`alwaysReencode`). Los PDF
  **no** se pueden limpiar en cliente: la revisión de seguridad lo apunta
  como riesgo residual aceptado (metadatos del PDF se conservan).
- Logs: nunca artículo, identificador, comercio, notas ni etiquetas.
- `audit_events` copia los campos (incluido el identificador) y los lee
  `family_admin`: aceptable por la misma razón que en Cupones. Documentarlo.
- Revisión ejecutada en `docs/security/revision-garantias.md`.

### 7.6 Pruebas

Las de Cupones, calcadas y ampliadas con: documentos múltiples y el tope de
10; PDF aceptado y `.docx` rechazado (en vitest, con almacén simulado y un
PDF mínimo válido generado por código con `pdf-lib`); quitar un documento es
lógico y no desaparece el objeto; la empleada ve cero garantías, cero
documentos y cero objetos de almacenamiento de garantía; cubos con «sin
fecha»; aviso en Hoy a 30 días; búsqueda con tildes y mayúsculas. Suites:
`220_warranties.sql`, `warranties.integration.test.ts` (server),
`warranties*.test.ts` (web, incluida la ruta del documento con PDF e imagen),
`garantias.e2e.ts`, `garantias.dbe2e.ts` (siembra con prefijo nuevo en
`db-global-setup.ts`: filas de `storage_objects` **sin bytes detrás**, como
Cupones), entrada en `critical.a11y.ts`, `garantias` en las `ROUTES` de las
suites móviles, y un caso nuevo de distinción Cupones/Garantías en la
navegación (en `mobile-nav.e2e.ts`, que hoy corre a 390×844 y no tiene casos
de cupones, o en las suites móviles dbe2e).

## 8. Workflow específico

Sigue las siete fases del workflow común. Lo propio de este módulo:

1. **Diseño.** Brainstorming corto: solo las tres preguntas de §4. Spec
   `docs/superpowers/specs/YYYY-MM-DD-modulo-garantias-design.md`. Sin spike:
   el molde ya está probado en producción.
2. **Plan.** Un plan maestro con las mismas seis entregas de Cupones §11
   (cimientos; servidor; interfaz; navegador; revisión adversarial;
   documentación) más producción. Si la sesión decide corregir la deuda de la
   0005, esa migración es la **primera tarea** del plan y lleva su propia
   suite y su propia línea en la revisión de seguridad.
3. **Ejecución.** TDD tarea a tarea. Prefijos de UUID de prueba nuevos y
   distintos de los de Cupones (`cd…`, `ce…`, `cf…` están cogidos).
4. **Verificación.** Lista del workflow común entera. El recuento de
   `pnpm test` crece.
5. **Documentación.** Manual (capítulo «Garantías», fila en «Quién ve qué»:
   familia «Todo», los demás «—»), skill (§Garantías en
   `referencia-operaciones.md` con (a)/(b)/(c), fila en «Dónde está cada
   cosa»), runbook (§2 última migración y qué trae; §7 humo con una garantía
   de prueba cuyo artículo diga «Prueba de despliegue» y un PDF sintético;
   recordar que no hay borrado), `security-baseline.md` si cambia algo.
   Variables y dependencias nuevas: **ninguna**.
6. **Producción.** Migración(es) antes del merge por conexión directa, con
   confirmación expresa del propietario y comandos preparados por el agente;
   humo con la cuenta de la familia y con la de la empleada (403 en la ruta,
   404 en un documento).
7. **Los cuatro prompts van en secuencia**, Garantías primero (README de la
   carpeta). Si aun así el servidor MCP (prompt
   `2026-10-31-webmcp-asistentes.md`) llega a `main` antes que este módulo,
   el gate `mcp-coverage` pondrá en rojo este PR: la tarea «herramientas MCP
   de garantías» (lectura: listar y abrir; escritura: las seis acciones, con
   su entrada en el registro de contratos y su descripción) entra **en el
   plan desde el principio**, no como condicional, y se repiten las puertas
   tras el rebase. Si el MCP no existe aún, no hay que preparar nada: las
   herramientas se generarán del registro de contratos cuando llegue.

## 9. Riesgos conocidos

- **PDF con contenido activo.** Mitigado con la CSP de la ruta de
  justificantes y abriendo fuera del shell; verificado en la revisión de
  seguridad contra el MinIO local con un PDF sintético que intente ejecutar
  JavaScript.
- **`PhotoPicker` compartido** con Cupones y con los gastos de la empleada:
  no se toca; si algo obliga a tocarlo, los tests de esos dos sitios se
  ejecutan antes y después.
- **Confusión con Cupones** en navegación y en el manual: los dos trazos y
  las dos etiquetas tienen que distinguirse a 320 px. No existe hoy una prueba
  de eso: se crea (§7.6).
- **Ningún binario en git**: la imagen y el PDF de prueba se generan por
  código en los tests de vitest; las suites de navegador no necesitan bytes.

## 10. Criterio de hecho

La familia abre `/h/<hogar>/garantias` en producción, guarda una garantía con
un ticket en foto y una factura en PDF, la encuentra buscando por el número de
serie, la ficha dice hasta cuándo está en garantía y abre los dos documentos
(esto último se demuestra en el humo de producción, porque las suites de
navegador no sirven bytes);
la empleada recibe 403 en la ruta y 404 en el documento; Hoy avisa de una
garantía que vence en menos de 30 días; `deployable` en verde, revisión de
seguridad ejecutada y publicada, manual, skill y runbook al día, copia
anterior y posterior hechas, y memoria del agente actualizada con la fecha y
la migración.
