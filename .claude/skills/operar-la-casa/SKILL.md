---
name: operar-la-casa
description: Operar y mantener Housekeeper como administrador — dar de alta personas, contratos, rutinas, notas de la guía, contactos, menú, liquidaciones y avisos; instalar de cero en local o en Vercel + Supabase; migrar, respaldar, rotar secretos y diagnosticar. Úsala ante cualquier petición de administración («añade una hoja a la guía», «crea una rutina», «da de alta a una persona»), de instalación o de mantenimiento de esta aplicación.
---

# Operar Housekeeper

Housekeeper gestiona un hogar real y la relación laboral con quien trabaja en él.
**Está en producción sirviendo a una familia y a una empleada de verdad.** Un
error aquí no rompe una pantalla: rompe el sueldo de alguien, o le impide
registrar el trabajo que hizo.

Esta skill es el índice operativo. Las hojas de detalle:

- [referencia-operaciones.md](referencia-operaciones.md) — cada operación de
  administración: por dónde se hace, qué rol hace falta, qué NO hay que hacer.
- [referencia-instalacion.md](referencia-instalacion.md) — instalación de cero
  en local, despliegue nuevo en Vercel + Supabase, alta de un hogar, y la lista
  completa de variables de entorno con las que degradan en silencio.
- [referencia-mantenimiento.md](referencia-mantenimiento.md) — migraciones,
  planificador de la cola, copias, rotación de secretos, pruebas y diagnóstico.

---

## Las cuatro reglas que no se rompen

### 1. La pantalla antes que el SQL. Siempre.

Escribir en la base a mano **salta las invariantes del dominio**, y varias de
ellas no se pueden reparar después:

| Invariante | Dónde vive | Qué pasa si la saltas |
|---|---|---|
| Versiones de contrato inmutables | disparador `agreement_versions_append_only` (0002) | Una versión reescrita a mano deja el expediente mintiendo sobre lo que se pactó |
| Catálogo de conceptos congelado | `extra_work_types_frozen` (0021) | Cambiar una tarifa a mano revaloriza días ya trabajados |
| Concepto congelado el día trabajado | `extra_work_events_type_freeze` | Un evento con el concepto de otra versión rompe la valoración |
| Libro contable de solo-añadir | `app.*_ledger_entries` | Un saldo tocado a mano deja de cuadrar con su historial y nadie sabe cuál es el bueno |
| RLS forzada por hogar | `0005_rls.sql` | Conectado como propietario **no hay RLS**: se puede escribir en el hogar equivocado sin que nada avise |

Además, escribir por la pantalla deja **autoría y motivo**. Un `UPDATE` no deja
nada: dentro de seis meses nadie sabrá quién cambió el salario ni por qué.

Las escrituras de negocio de la aplicación **no son form actions**: viajan por
`POST /api/v1/sync` como comandos con `operationId` (idempotencia) y su
capacidad se comprueba en el servidor, comando a comando. Ese es el camino que
usa la interfaz, y es el que hay que usar.

**Cuándo sí toca un guion**: el alta inicial de un hogar (no hay pantalla que
cree hogares) y el volcado del manual. Están en
[referencia-instalacion.md](referencia-instalacion.md).

### 2. Ningún dato real del hogar entra en el repositorio

Nombres, importes, horarios y URLs de calendario viven en un JSON **fuera de
Git**, en modo `600`. Todos los ejemplos del repositorio —y de esta skill— son
inventados. Lo exige el [ADR 0001](../../../docs/adr/0001-plataforma-autogestionada.md).

### 3. Media configuración es peor que ninguna

`apps/web/src/lib/server/deployment-config.js` sólo exige cuatro variables:
`DATABASE_URL`, `DATABASE_AUTH_URL`, `BETTER_AUTH_SECRET` y `BETTER_AUTH_URL`.
**Todo lo demás falla de forma elegante y parece sano.** Por eso se llegó a
producción sin avisos push, sin depósito de adjuntos y sin clave de firma de
snapshots. La lista de lo que degrada en silencio y cómo comprobarlo de verdad
está en [referencia-instalacion.md](referencia-instalacion.md#lo-que-degrada-en-silencio).

### 4. Nunca contra producción sin que te lo pidan explícitamente

Ensaya siempre contra una base local. Los guiones de alta tienen `--dry-run` y
son la única marcha atrás que existe: el alta de un contrato **no tiene
deshacer**.

---

## Los cinco roles

Fuente de verdad: `packages/contracts/src/capabilities.ts` y el enum
`app.household_role` de `packages/db/migrations/0001_identity_and_context.sql`.
Son exactamente estos, y el rol es de la **membresía en ese hogar**, no de la
persona: la misma persona puede ser `family_admin` en un hogar y `helper` en otro.

| Rol | Etiqueta en pantalla | En una frase |
|---|---|---|
| `family_admin` | Administrador familiar | Puede todo. Es quien administra la casa |
| `family_member` | Miembro de la familia | Familia sin poderes de acceso ni de contrato |
| `employee_live_in` | Empleada interna | Quien trabaja en la casa. La única con contrato |
| `helper` | Apoyo del hogar | Ayuda puntual: guía, menú, rutinas y contactos |
| `viewer` | Acceso puntual | Sólo calendario, contactos y emergencias |

**Sólo `family_admin`** tiene `access.manage`, `agreement.write`, `guide.write`,
`settlement.close` y `payment.register`. Escribir la Guía es cosa de la
administración y de nadie más, porque la Guía es a la vez el manual de acogida
de quien trabaja aquí.

La comprobación se hace **dos veces por diseño**: en
`apps/web/src/routes/h/[householdId]/+layout.server.ts` (403 amable) y otra vez
en la RLS de PostgreSQL contra la fila real, que es la que de verdad cuenta.

---

## Dónde está cada cosa

Todas las pantallas cuelgan de `/h/<hogar>/…`, donde `<hogar>` es el UUID del
hogar. **No hay pantalla que cree hogares ni que cambie de hogar**: el hogar
sale de la URL.

| Área | Pantalla | Rol mínimo | Detalle |
|---|---|---|---|
| Hoy | `/h/<hogar>/today` | cualquiera | [ops](referencia-operaciones.md#hogares) |
| Personas y accesos | `/h/<hogar>/settings` | `family_admin` | [ops](referencia-operaciones.md#personas-cuentas-roles-y-caducidad) |
| Alta de personal | `/h/<hogar>/personal` | `family_admin` | [ops](referencia-operaciones.md#personas-cuentas-roles-y-caducidad) |
| Tu contraseña y tus avisos | `/h/<hogar>/account` | cualquiera | [ops](referencia-operaciones.md#avisos-push) |
| Contrato (resumen del mes) | `/h/<hogar>/employment` | `settlement.read` | [ops](referencia-operaciones.md#liquidaciones-pagos-y-el-pdf) |
| Conceptos del mes (extras, gastos, adelantos, ausencias) | `/h/<hogar>/employment/conceptos` | `settlement.read` | [ops](referencia-operaciones.md#contratos) |
| Liquidaciones, pagos y el recibo en PDF | `/h/<hogar>/employment/pagos` | `settlement.read` | [ops](referencia-operaciones.md#liquidaciones-pagos-y-el-pdf) |
| Contrato (alta y versiones) | `/h/<hogar>/employment/acuerdo` | `family_admin` | [ops](referencia-operaciones.md#contratos) |
| Condiciones pactadas | `/h/<hogar>/employment/condiciones` | `agreement.read` | [ops](referencia-operaciones.md#contratos) |
| Vacaciones | `/h/<hogar>/employment/vacaciones` | `agreement.read` | [ops](referencia-operaciones.md#vacaciones) |
| Rutinas | `/h/<hogar>/routines` | `routine.read` | [ops](referencia-operaciones.md#rutinas) |
| Guía de la casa | `/h/<hogar>/wiki` | `content.read` | [ops](referencia-operaciones.md#guía-de-la-casa) |
| Contactos | `/h/<hogar>/contacts` | cualquiera | [ops](referencia-operaciones.md#contactos-y-emergencias) |
| Emergencias | `/h/<hogar>/emergency` | cualquiera | [ops](referencia-operaciones.md#contactos-y-emergencias) |
| Menú y compra | `/h/<hogar>/menu` | `menu.read` | [ops](referencia-operaciones.md#menú-recetas-alérgenos-comensales-y-compra) |
| Recetas | `/h/<hogar>/recipes` | `content.read` | [ops](referencia-operaciones.md#menú-recetas-alérgenos-comensales-y-compra) |
| Calendario | `/h/<hogar>/calendar` | `calendar.read` | [ops](referencia-operaciones.md#calendario-y-calendarios-enlazados) |
| Buscar | `/h/<hogar>/search` | `search.use` | — |
| Finanzas | `/h/<hogar>/finanzas` | `family_admin` **con concesión** | [ops](referencia-operaciones.md#finanzas) |

**Las seis rutas de `employment` son una sola pantalla en pestañas.** El
expediente laboral se repartió porque no cabía en una página de móvil: se entra
por el resumen del mes y se cambia de pestaña sin salir de Contrato. Importa
saber cuál es cuál, porque **cada cosa se hace en la suya**: apuntar una jornada
extra o un gasto, en Conceptos; cerrar el mes, registrar el pago y descargar el
recibo, en Pagos. Buscarlas en el resumen es el error más común desde el
rediseño.

---

## Las trampas, en una pantalla

Lo que más caro sale. El detalle de cada una, en las hojas.

1. **El contrato no tiene deshacer.** La versión 1 y su catálogo de conceptos son
   inmutables. Un contrato dado de alta **sin conceptos de trabajo extra** deja a
   quien trabaja sin poder registrar ni una jornada, y **no se arregla hacia
   atrás**: una versión nueva sólo rige desde su fecha. Ensaya con `--dry-run`.

2. **`DATABASE_AUTH_URL` tiene que ser el rol `casa_clara_auth_login`** (nombre
   legado del proyecto anterior; ver
   [docs/despliegue/identificadores-legado.md](../../../docs/despliegue/identificadores-legado.md)).
   Si le pones el rol propietario, Better Auth crea sus tablas en `public` en
   vez de en `casa_auth`. El alta de cuentas **dice que ha ido bien e imprime
   las contraseñas**, y luego no entra nadie: 401 para todo el mundo.
   Verificado.

3. **Sin `SNAPSHOT_SIGNING_KEY_B64` la aplicación responde 200 y parece sana.**
   Cada instancia firma con una clave efímera propia, así que el modo sin
   conexión deja de verificar entre arranques en frío. Es el fallo más silencioso
   de los tres que llegaron a producción.

4. **La cadencia vieja de rutinas ya no se traduce.** `frequency` e
   `intervalCount` se retiraron en la 0033; un comando con esa forma se rechaza
   con `routine_cadence_format_retired`. La cadencia de hoy es
   `pattern` + `anchorOn` + los campos de ese patrón.

5. **`agreement:seed` YA NO es el guion peligroso que fue.** Se niega a escribir
   sin catálogo y aborta si intentas cambiar condiciones ya pactadas. Si has
   leído en algún sitio que nunca debe usarse, esa nota está desfasada — pero la
   pantalla sigue siendo la vía normal, porque deja autoría y pasa por RLS.

6. **`--until` del runner de migraciones no es una opción de línea de órdenes.**
   Es un parámetro de la función `applyMigrations()` y sólo lo usan las pruebas.

7. **Conectado como propietario no hay RLS.** Los guiones de alta escriben por
   fuera del aislamiento por hogar a propósito. Comprueba dos veces a qué hogar
   apuntas.

8. **Las suites de base de datos van en secuencia, nunca en paralelo.** Crean
   bases y roles de nombre fijo y se pisan entre ellas.

---

## Documentación del repositorio

Esta skill indexa; no duplica. Lo que hay que leer entero antes de tocar nada
serio:

| Documento | Cuándo |
|---|---|
| [docs/despliegue/alta-de-hogar.md](../../../docs/despliegue/alta-de-hogar.md) | Poner un hogar en pie, de punta a punta |
| [docs/despliegue/acceso-produccion.md](../../../docs/despliegue/acceso-produccion.md) | Contraseñas, reposición y pérdida del acceso de administración |
| [docs/despliegue/runbook-despliegue.md](../../../docs/despliegue/runbook-despliegue.md) | Desplegar |
| [docs/despliegue/plan-vercel-supabase.md](../../../docs/despliegue/plan-vercel-supabase.md) | Por qué cada decisión de la plataforma |
| [docs/personal-y-contratos.md](../../../docs/personal-y-contratos.md) | El modelo laboral |
| [docs/rutinas-y-calendario.md](../../../docs/rutinas-y-calendario.md) | El modelo de cadencia y el calendario |
| [docs/notificaciones.md](../../../docs/notificaciones.md) | Qué se notifica y, sobre todo, qué no |
| [docs/runbooks/planificador-cola.md](../../../docs/runbooks/planificador-cola.md) | La cola en producción |
| [docs/runbooks/backup-restore.md](../../../docs/runbooks/backup-restore.md) | Copias y restauración |
| [docs/runbooks/notificaciones-push.md](../../../docs/runbooks/notificaciones-push.md) | Poner en marcha los avisos |
| [docs/runbooks/importar-manual.md](../../../docs/runbooks/importar-manual.md) | Volcar el manual de convivencia |
| [docs/runbooks/security-incident.md](../../../docs/runbooks/security-incident.md) | Incidente de seguridad |
| [.env.example](../../../.env.example) | Inventario comentado de TODAS las variables |

`docs/manual/` es el manual de la familia. **No se toca desde aquí.**
