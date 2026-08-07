# Casa Clara

Prototipo local autenticado de la PWA descrita en el brief de producto v2. Sirve para recorrer la experiencia, probar los cinco roles y validar parte de las reglas con datos ficticios. **No es un sistema laboral ni una aplicación preparada para datos reales.**

La revisión contra los 26 criterios originales está en [docs/revision-codigo-y-validacion.md](docs/revision-codigo-y-validacion.md).

## Ejecutar la demo

Requiere Node.js 20 o posterior y no instala dependencias.

```bash
# En un clon nuevo; este workspace ya tiene su .env local
cp .env.example .env
npm run serve
```

Abre `http://127.0.0.1:4173/#today`.

`npm run serve` inicia el servidor local que lee `.env`, sirve únicamente los recursos permitidos y expone las sesiones demo. `npm run serve:static` existe solo para inspeccionar archivos: no ofrece autenticación y la aplicación no permitirá iniciar sesión.

## Usuarios demo

Las siguientes credenciales son deliberadamente ficticias y solo sirven en `127.0.0.1`. Están configuradas en el `.env` local, que Git ignora, y se reproducen en `.env.example` para facilitar la demo.

| Persona | Rol | Correo | Contraseña |
|---|---|---|---|
| Alberto | `family_admin` | `alberto.admin@casaclara.demo` | `Demo-Admin-2026!` |
| Marta | `family_member` | `marta.familia@casaclara.demo` | `Demo-Familia-2026!` |
| Ana | `employee_live_in` | `ana.empleada@casaclara.demo` | `Demo-Ana-2026!` |
| Lucía | `helper` | `lucia.apoyo@casaclara.demo` | `Demo-Apoyo-2026!` |
| Diego | `viewer` | `diego.canguro@casaclara.demo` | `Demo-Visor-2026!` |

Para cambiar de rol, abre el menú de la cuenta, cierra sesión y entra con otra cuenta. Ya no existe un selector que permita elevar privilegios sin contraseña.

Las sesiones se mantienen en memoria en el servidor y usan una cookie `HttpOnly`, `SameSite=Strict` y con caducidad. El servidor comprueba origen en las escrituras, limita intentos de login y nunca sirve `.env`, `server.mjs` ni `.git`. Para que una sesión previamente validada pueda reabrir la PWA sin red, se conserva localmente su perfil público hasta la caducidad configurada.

Esto sigue siendo **autenticación de demo, no una frontera de seguridad**: los datos semilla están empaquetados en `data.js` y pueden inspeccionarse sin sesión. Producción necesita autenticación real, API autorizada y RLS; no introduzcas información personal o laboral real.

## Recorrido recomendado

1. Entra como Alberto para revisar el acuerdo, resolver una excepción y registrar pagos parciales o totales.
2. Cierra sesión y entra como Ana para registrar su semana, añadir una excepción, guardar un gasto y confirmar el cobro cuando el importe esté cubierto.
3. Entra como Marta para comprobar lectura completa del expediente y edición de menú/wiki, sin permisos para salario, cierres o pagos.
4. Busca `lavadra`, `vitro` o un contacto; las ediciones locales de la wiki también entran en el índice.
5. En Menú, cambia de día, escala una receta y recorre el aviso demostrativo de alérgenos.
6. Entra como Lucía: solo verá operación doméstica, menú de hoy, wiki, rutinas, contactos y emergencias.
7. Entra como Diego: solo tendrá Hoy, agenda operativa, contactos y emergencias; las rutas directas no autorizadas muestran acceso denegado.
8. Tras una primera carga autenticada, prueba una recarga sin red para comprobar el shell, el rol cacheado y la pantalla de emergencias.

El estado funcional se conserva en el navegador. Para reiniciar completamente la demo hay que borrar los datos del sitio.

## Alcance real

| Área | Disponible | Pendiente para cumplir el brief |
|---|---|---|
| Usuarios y roles | Login local, sesiones con cookie y cinco perfiles con guardas de ruta/acción | Magic link/passkey, usuarios persistentes, scopes por campo, caducidad individual, revocación distribuida y RLS |
| Liquidación y pagos | Ejemplo de marzo, suma pura, trazabilidad visual, pagos parciales y confirmación separada | Motor desde acuerdos/eventos, cierre real, PDF determinista, hash, auditoría e histórico completo |
| Jornadas, extras y saldos | Registro y confirmación local, clasificación de fin de semana y tarifa congelada al resolver | Máquina completa, autoconfirmación, libros append-only, vencimientos y conexión automática con liquidaciones |
| Acuerdo laboral | Versiones semilla y nuevas versiones locales no retroactivas | Persistencia inmutable, diff/notificación, resolución temporal completa y reglas configurables |
| Gastos y offline | Gastos visibles, outbox durable y shell cacheado; las operaciones permanecen pendientes hasta ACK | Foto durable, OCR, transporte idempotente, ACK parcial, conflictos y sincronización entre dispositivos |
| Menú y recetas | Cinco franjas, grupos, edición local, escalado y aviso demostrativo | Semanas reales/plantillas, asignación de recetas con cruce por comensal y compra calculada |
| Wiki y búsqueda | Páginas, espacios, alias, erratas, búsqueda en cuerpo/ediciones y contactos accionables | Jerarquía, revisiones/diff, importador Markdown, adjuntos, traducciones, analítica agregada y agrupación semántica de huecos |
| Contactos, calendario y emergencias | Directorio, llamada/WhatsApp, agenda filtrada, impresión y recarga offline | ICS/API real, eventos generados, PDF firmado/determinista y snapshot remoto de 24 h |

Los selectores de foto o justificante no almacenan archivos. OCR, WhatsApp Cloud, ICS, PDFs de servidor, hash criptográfico y backend aparecen únicamente como alcance futuro o representación visual.

## Persistencia y PWA

- `localStorage` conserva el estado visible del prototipo.
- IndexedDB mantiene una outbox y snapshots como andamiaje local.
- Cada escritura compatible se conserva como pendiente incluso con red; sin backend no existe entrega ni ACK.
- El service worker precachea el shell, incluido `auth.js`, y permite reabrir una sesión demo vigente sin conexión.
- La sesión offline local es manipulable por quien controle el navegador; no sustituye autorización de servidor.
- El snapshot crítico se escribe, pero la interfaz todavía usa los datos semilla empaquetados y no hidrata un snapshot remoto versionado.

## Arquitectura

- `server.mjs`: servidor local, parser de `.env`, sesiones demo y lista cerrada de archivos públicos.
- `auth.js`: cliente de sesión y fallback local con caducidad para la prueba offline.
- `index.html`: login, shell semántico y navegación.
- `styles.css`: sistema visual responsive, accesibilidad, impresión y estados.
- `app.js`: router, permisos, vistas, estado local y flujos interactivos.
- `logic.js`: liquidación semilla, dinero, permisos, escalado y búsqueda como funciones puras.
- `data.js`: datos ficticios del hogar y ejemplo de aceptación.
- `offline.js`: outbox y snapshot en IndexedDB.
- `sw.js`: precaché y navegación offline.
- `tests/`: pruebas unitarias de lógica y del servidor de autenticación demo.

## Pruebas

```bash
npm test
```

La batería actual contiene **16 pruebas**: cálculo y redondeo monetario, pagos parciales, búsqueda, escalado, permisos de cinco roles, roles desconocidos, parser de `.env`, login/cookie/sesión/logout y bloqueo de archivos internos.

Durante la revisión también se comprobó en Chrome real:

- login y logout de las cinco cuentas;
- acciones permitidas y rutas denegadas por rol;
- recarga offline autenticada con el rol `viewer` y banner visible;
- instalación de `casa-clara-shell-v5`;
- carga sin errores de página en los recorridos verificados.

No hay todavía Lighthouse/axe en CI, pruebas completas de IndexedDB, backend/RLS ni pruebas end-to-end versionadas en el repositorio.

## Siguiente paso técnico

Implementar la Fase 1 sobre Postgres multi-tenant: autenticación por enlace mágico o passkey, RLS por hogar/rol/campo, libros append-only, auditoría laboral, motor de liquidación en céntimos enteros, snapshots inmutables, Storage y sincronización idempotente. Hasta entonces la demo debe usarse exclusivamente con datos ficticios.
