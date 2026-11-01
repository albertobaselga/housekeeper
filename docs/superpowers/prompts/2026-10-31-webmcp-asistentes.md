# Prompt: servidor MCP de la casa para ChatGPT y Claude, del diseño a producción

Fecha de las decisiones: 2026-10-31 · Propietario: Alberto Baselga · Estado:
listo para ejecutar en una sesión futura · Orden recomendado: **3 de 4** (ver
`README.md` de esta carpeta). **Depende** del prompt de acceso
(`2026-11-01-acceso-enlaces-magicos-resend.md`): el alta de personas por el
asistente solo tiene sentido cuando la persona recibe su enlace de acceso por
correo.

> **Cómo usar este prompt.** Léelo junto con
> `docs/superpowers/prompts/workflow-comun.md`, que dice cómo se trabaja en
> este repositorio. Aquí está qué se construye, qué está cerrado, qué se
> propone y qué queda abierto. Es la funcionalidad más compleja de las tres:
> trae un **spike obligatorio** antes del spec, un **ADR** y una **regla
> nueva para todo módulo futuro**.

---

## 1. Qué se construye y por qué

Que toda la parte administrativa de la casa se pueda hacer **hablando con el
asistente que cada persona ya usa** (ChatGPT, Claude), sin instalar nada: la
persona le da la dirección del servidor de la casa a su asistente, entra con
su usuario y su contraseña de siempre, y a partir de ahí pide «apunta una
rutina los martes para regar», «¿qué cupones caducan esta semana?», «da de
alta a Marta como apoyo hasta el 30 de junio» o «cierra la cuenta de octubre».
El asistente usa las **mismas** operaciones que la pantalla, con los
**mismos** permisos: lo que esa persona no puede hacer en la aplicación,
tampoco puede hacerlo por el asistente.

Tres principios del propietario:

1. **Todo lo que se configura y gestiona en la aplicación se puede hacer por
   aquí**, incluidas las altas de personal y de contratos. La única excepción
   son las contraseñas: ninguna contraseña, provisional o no, pasa por un
   chat de terceros.
2. **Cada funcionalidad futura trae sus herramientas**: añadir un módulo sin
   su parte MCP no pasa el CI.
3. **Cada persona, con su papel.** El asistente de la empleada ve lo que ve la
   empleada; el de un acceso puntual, el calendario y los contactos; el de la
   administración, todo.

Criterio de éxito: el propietario conecta ChatGPT y Claude a su casa desde la
pantalla «Tu acceso» en menos de cinco minutos, sin leer documentación
externa; crea una rutina y un cupón desde el chat y los ve en la aplicación;
una cuenta de la empleada conectada a Claude no consigue ni listar cupones ni
ver finanzas; y el repositorio rechaza un módulo nuevo que no exponga sus
herramientas.

## 2. Decisiones cerradas por el propietario (2026-10-31)

| # | Decisión | Elegido |
|---|---|---|
| D-forma | Qué es | Un **servidor MCP remoto** expuesto por la propia web, al que los asistentes se conectan por URL. **Nada que instalar** en el ordenador ni en el móvil de la persona. No es un plugin de ChatGPT, ni un paquete npm, ni una extensión de Claude Code (aunque Claude Code pueda conectarse como un cliente más). |
| D-alcance | Qué cubre la v1 | **Absolutamente toda la administración y gestión**: lo que viaja por comandos (`POST /api/v1/sync`, incluidas la caducidad y revocación de accesos y la concesión de Finanzas, que ya son comandos), las lecturas de todas las pantallas, y las operaciones que hoy son form actions (alta de persona, alta de contrato y versión nueva de contrato). |
| D-contraseñas | Lo único excluido | **Ninguna contraseña ni enlace de acceso** por el MCP: ni reponer, ni cambiar, ni leer. Esas herramientas no existen; donde haga falta, la respuesta remite a la pantalla. |
| D-alta-personas | Alta de personas por el asistente (2026-11-01) | **Sí, completa**: la herramienta da de alta a la persona con su papel (y su contrato si procede) y **la persona recibe por correo su enlace de acceso**, como en cualquier alta desde que el acceso es por enlaces mágicos (prompt `2026-11-01-acceso-enlaces-magicos-resend.md`). No hay contraseña provisional que enseñar a nadie. |
| D-nombre | Nombre que ven los asistentes (2026-11-01) | **Homekeeping**, ya desde este prompt: se cambian `APP_NAME` y el `name` largo del manifiesto (y su test). El `short_name` del icono instalado sigue siendo «Hogar» hasta la web pública. La familia verá el nombre nuevo en la pantalla de acceso: se avisa antes. |
| D-quien | Quién conecta | **Cualquier persona con cuenta, con su papel**, desde su propia pantalla «Tu acceso». Sin concesión de la administración. |
| D-privacidad | Datos hacia terceros | Cada persona **acepta un aviso al conectar** que dice qué datos de la casa saldrán hacia el proveedor de su asistente. Queda documentado como riesgo asumido en un **ADR nuevo**, al estilo de `docs/security/adjuntos-sin-antivirus.md`. |
| D-futuro | Módulos futuros | Toda funcionalidad nueva **incluye sus herramientas MCP y su ayuda**; una puerta en CI lo exige. Regla escrita en `CONTRIBUTING.md`. |
| D-clientes | Con qué se prueba | **ChatGPT y Claude** (claude.ai, Claude Desktop y Claude Code) son los clientes que se verifican en producción. Cualquier otro cliente MCP que hable el protocolo estándar debería funcionar, pero no se promete. |

## 3. Decisiones propuestas por el redactor (revisables en la sesión, con argumentos)

### 3.1 Arquitectura

- **Transporte**: MCP sobre **Streamable HTTP sin estado**, montado en
  `apps/web` como ruta `/mcp` (o `/api/mcp`), en el runtime Node de Vercel.
  La web es **una sola función** con `maxDuration` de 60 s (`svelte.config.js`):
  nada de SSE de larga duración, nada de sesiones en memoria; cada petición
  se autentica y se resuelve sola. Si el SDK oficial exige algo que no encaja
  con SvelteKit o con esa restricción, el spike lo descubre y el spec decide
  (SDK adaptado o JSON-RPC propio sobre la especificación).
- **Antes de nada, Better Auth parcheado.** La 1.6.26 instalada arrastra dos
  avisos *high* (GHSA-q84f-53jg-9ppm y GHSA-r4xp-prcw-77qf, corregidos en la
  1.7.7) y uno de ellos toca justo la superficie OAuth. Si el prompt de acceso
  ya la subió, comprobar la versión; si no, subirla aquí en commit propio y
  **volver a verificar** que el plugin `mcp` y sus opciones (abajo) siguen
  igual en esa versión, porque entre versiones el plugin puede haberse
  reorganizado.
- **Autenticación: OAuth 2.1 con el plugin `mcp` de Better Auth**, que **ya
  está instalado** (Better Auth 1.6.26 trae `plugins/mcp`, además de
  `oidc-provider`, `bearer` y `jwt`; comprobado en el almacén de pnpm). Se
  importa desde `better-auth/plugins` (`mcp`, `withMcpAuth`,
  `oAuthDiscoveryMetadata`, `oAuthProtectedResourceMetadata`); no hay subpath
  `better-auth/plugins/mcp`. Sus opciones relevantes: `loginPage`
  (obligatoria), `resource` y `oidcConfig` (`allowDynamicClientRegistration`,
  `consentPage`, `requirePKCE`, `scopes`, `accessTokenExpiresIn`,
  `refreshTokenExpiresIn`); sus tablas: `oauthApplication`,
  `oauthAccessToken`, `oauthConsent`. Es exactamente lo que piden ChatGPT y
  Claude para un servidor remoto: *Authorization Code + PKCE*, **registro
  dinámico de clientes** (RFC 7591), metadatos del servidor de autorización
  (RFC 8414) y del recurso protegido (RFC 9728). **Ojo**: el plugin sirve sus
  endpoints y metadatos bajo el `basePath` de Better Auth
  (`/api/auth/mcp/authorize|token|register`, `/api/auth/.well-known/…`); los
  clientes buscan `/.well-known/oauth-protected-resource` y
  `/.well-known/oauth-authorization-server` en la **raíz**, así que hay que
  crear esas rutas en `apps/web/src/routes/.well-known/` con los helpers del
  plugin. Es trabajo del spike y de la fase 1, no algo que exista. La
  **pantalla de consentimiento es propia**, en castellano, y es donde vive el
  aviso de privacidad de D-privacidad. Ningún proveedor de identidad nuevo.
  **Esto se verifica en la documentación oficial de la versión instalada
  antes de escribir el spec** (dependency-expert), igual que la versión
  vigente de la especificación de autorización de MCP y los requisitos de cada
  cliente.
- **La conexión es por persona, no por hogar** (decisión del redactor tras la
  comprobación del constructor). El plugin emite tokens por usuario; una
  persona con dos casas conecta su asistente una vez y elige el hogar en cada
  herramienta (`listar_hogares` + parámetro `hogar`). La tabla de conexiones
  es por **usuario y cliente**, no por membresía; en Ajustes la administración
  ve «esta persona tiene un asistente conectado desde …», sin ver nada más.
  Revocar una membresía **no** toca el token: deniega el acceso a esa casa en
  la siguiente petición porque `withAuthorizedTransaction` ya exige membresía
  activa, y las demás casas de esa persona siguen funcionando. «Desconectar»
  en «Tu acceso» revoca el token y el refresh token de ese cliente entero.
- **El aviso de privacidad se acepta una vez por persona y cliente** (decisión
  del redactor). En 1.6.26 el endpoint `authorize` del plugin solo redirige a
  `consentPage` si el cliente envía `prompt=consent`, y con sesión viva emite
  el código directamente; ChatGPT y Claude no envían ese parámetro. La
  aplicación guarda la aceptación (persona, cliente, fecha, versión del texto)
  en su tabla de conexiones y **no deja emitir un código** sin ella:
  interponer la pantalla propia antes del `authorize` del plugin (en
  `hooks.server.ts` o envolviendo la ruta) es el camino que el spike tiene que
  probar. Cambiar el texto del aviso exige volver a aceptarlo.
- **Autorización**: el servidor MCP resuelve `userId` desde el token y llama
  a los mismos handlers que la web dentro de `withAuthorizedTransaction`
  (`packages/server/src/database.ts`): la RLS y las capacidades son las
  mismas, **sin ningún camino nuevo a la base**. Un token no otorga nada que
  la membresía no otorgue ya.
- **Ámbitos (scopes)**: pocos y honestos. Propuesta: `casa:leer`,
  `casa:escribir` y `casa:administrar` (las operaciones de accesos y
  contratos). El consentimiento enumera los módulos a los que ese papel
  llega; la decisión fina sigue siendo capacidad + RLS. Los ámbitos acotan
  por arriba, nunca amplían.
- **Varios hogares**: la misma persona puede pertenecer a varias casas.
  Herramienta `listar_hogares` y parámetro `hogar` en el resto, con valor por
  omisión cuando solo hay uno.

### 3.2 Superficie de herramientas

- **Escrituras generadas de un registro explícito de contratos.** Una
  herramienta por par (agregado, acción). **No se puede derivar del sobre**:
  en `commandEnvelopeSchema` el `payload` es `z.unknown()`; de los 24
  agregados, 16 tienen un `*CommandPayloadSchema` discriminado por `action`,
  `finance` discrimina por `kind` (y tiene dos esquemas), y `expense`,
  `diner`, `payment`, `routine`, `routine_occurrence`, `shopping_item`,
  `leave_request` y `comment` usan esquemas sueltos que su handler elige por
  agregado o por `aggregateId`. Por eso la fase 2 crea en
  `packages/contracts` un **registro** `agregado → (acción → esquema,
  descripción en castellano)`, escrito a mano una vez, con un test que exige
  que **todo agregado del sobre esté en el registro** y que ninguna entrada
  carezca de descripción. El catálogo MCP se genera de ese registro (JSON
  Schema derivado de Zod) y el gate `mcp-coverage` se define contra él. El
  servidor MCP genera `operationId` y los UUID de cliente (`couponId`,
  `useId`…), y los devuelve para que el asistente pueda encadenar. Reintentar
  no duplica, igual que en la web.
- **Lecturas que envuelven los cargadores que ya existen**
  (`apps/web/src/lib/server/*.server.ts`: hoy, rutinas, guía, menú y compra,
  recetas, contactos, calendario, contrato y conceptos, vacaciones,
  liquidaciones y pagos, finanzas, cupones, garantías si existen, personas y
  accesos, ajustes). Respuestas **paginadas y acotadas** (nunca un volcado
  entero), con fechas en palabras además de ISO. Un lector no ve lo que su
  cargador no le daría en pantalla.
- **Las form actions ya están casi extraídas; el MCP llama a los servicios.**
  `hire`, `persona` y `contrato` (`employment/alta/+page.server.ts`) delegan
  en `hireFromForm`/`hireHouseholdMember` (`$lib/server/staff-hire.server.ts`)
  y `createAgreement`; `stackVersion` (`employment/acuerdo`) en
  `stackAgreementVersion`. Lo que queda en la form action es el parseo del
  formulario. El MCP llama a esos servicios con sus tipos, **sin duplicar la
  lógica**; si algún servicio recibe hoy `request.headers` de una sesión por
  cookie (los métodos del plugin `admin` de Better Auth que crean usuarios),
  la investigación decide cómo invocarlo desde un carril de token: es un
  riesgo listado en §8. En `settings` solo existe `resetMemberPassword`, y en
  `account` solo `changePassword`: **ninguna de las dos se expone**.
- **Operaciones irreversibles en dos pasos.** Alta de contrato, versión nueva
  de contrato, cierre de liquidación, registro de pago, revocación de acceso
  y alta de persona: la primera llamada devuelve una **vista previa** legible
  y un `confirmacion` de un solo uso que caduca en pocos minutos; la segunda
  llamada con ese valor ejecuta. El asistente tiene que enseñar la vista
  previa y la persona tiene que decir que sí. Sin esto, «cierra la cuenta»
  mal entendido cierra la cuenta.
- **Adjuntos**: en v1 **no se suben ficheros por MCP** (ni fotos de cupones ni
  justificantes). Las lecturas devuelven **enlaces autenticados a la
  pantalla** (`/h/<hogar>/…`), nunca URLs públicas ni firmadas ni bytes.
- **Nombres de herramientas** en castellano, estables y predecibles
  (`rutina_crear`, `cupon_usar`, `hogar_hoy`, `contrato_version_nueva`…),
  documentados en un catálogo generado que también alimenta la ayuda en
  pantalla y el manual.

### 3.3 Cobertura obligatoria para el futuro

Una puerta en CI (test en `apps/web` o guion en `scripts/ci/`) que falla si:

- algún par (agregado, acción) de `commandEnvelopeSchema` no tiene
  herramienta registrada **y** descripción;
- algún módulo de `HOUSEHOLD_MODULES` (`apps/web/src/lib/auth/routing.ts`)
  no tiene al menos una herramienta de lectura, salvo los que una lista de
  exclusiones justifique por escrito (por ejemplo `account` y `search`;
  `emergency` y `personal` sí deben tenerla);
- el catálogo publicado en la ayuda en pantalla no coincide con el generado.

Y una línea nueva en `CONTRIBUTING.md`, en «Reglas que no se negocian»:
*«Todo módulo trae sus herramientas MCP, su descripción en castellano y su
entrada en la ayuda de «Tu acceso». El gate `mcp-coverage` falla si no.»*

### 3.4 Interfaz y documentación en la aplicación

- **«Tu acceso» (`/h/<hogar>/account`)**, para todos los papeles: sección
  «Tu asistente» con (a) la dirección del servidor y un botón «Copiar»; (b)
  pasos ilustrados **por cliente** (ChatGPT, Claude en la web y en el
  escritorio, Claude Code) con capturas sintéticas, y lo que cada cliente
  exige (plan, modo desarrollador, confirmaciones), **verificado en el
  momento** porque cambia deprisa; (c) el aviso de privacidad en lenguaje
  llano («lo que le preguntes y lo que la casa le responda pasa por los
  servidores de OpenAI o de Anthropic…»); (d) la lista de **conexiones
  autorizadas** (cliente, fecha, último uso) con «Desconectar», que revoca
  tokens y refresh tokens de ese cliente.
- **Ajustes**, para la administración: vista de qué personas de la casa tienen
  asistentes conectados y desde cuándo (sin ver sus conversaciones, que la
  casa no tiene), con la posibilidad de desconectar las de una persona cuyo
  acceso se revoca. La revocación de una membresía **revoca también sus
  conexiones**.
- **Manual** (`docs/manual/index.html`): capítulo «Habla con tu casa desde tu
  asistente», con qué se puede hacer, qué no (contraseñas, fotos), el aviso
  de privacidad y cómo desconectar.
- **Nombre que ven los asistentes**: «Homekeeping» (D-nombre), tomado de
  `APP_NAME` en `app-title.ts`, que este prompt cambia junto con el `name`
  del manifiesto y `app-title.test.ts`. Que la constante venga de allí y no se
  escriba dos veces. El comentario de `app-title.ts`, el aviso del README y
  la skill se actualizan: «Homekeeping es el producto; con sesión manda el
  hogar; Housekeeper es el repositorio».

### 3.5 Auditoría, límites y registros

- Cada petición MCP fija `app.request_id` con prefijo `mcp:` y el
  `client_id`, de modo que `audit_events` distinga lo hecho por un asistente.
  La columna y el disparador existen desde la 0004 (lee
  `current_setting('app.request_id', true)`), pero **ningún código de la
  aplicación fija hoy ese ajuste**: es fontanería nueva en
  `withAuthorizedTransaction` o en el carril MCP, y conviene que la web la
  aproveche también. Tabla propia de conexiones (usuario, cliente, aceptación
  del aviso, creado, último uso, revocado) para alimentar «Tu acceso» y la
  vista de Ajustes.
- **Límites de tasa propios para `/mcp`**, guardados en la base (las
  funciones son efímeras): el `rateLimit` de Better Auth solo cubre
  `/api/auth/*` y no sirve aquí. **Respuestas acotadas**: ninguna herramienta
  devuelve más de N elementos sin paginar.
- **Logs** con lista blanca: herramienta, código de resultado, hogar y
  membresía. Nunca argumentos ni respuestas.
- Tokens de acceso de vida corta y refresh tokens rotados; revocación
  inmediata desde la pantalla; los tokens de una membresía caducada o
  revocada dejan de valer en la siguiente petición (la comprobación de
  membresía activa ya está dentro de `withAuthorizedTransaction`).

## 4. Preguntas abiertas que la sesión cierra con el propietario antes del spec

1. **Dónde se publica la dirección del servidor** cuando la web pública
   exista: ¿en una página pública `/asistentes` con los pasos por cliente,
   además de en «Tu acceso»? Recomendación: sí, es un argumento de venta
   (así lo describe el propietario en el prompt de la web pública).
2. **Herramientas de Finanzas**: el módulo exige concesión viva además del
   papel. Recomendación: exponerlas con la **misma doble llave** (si no hay
   concesión, la herramienta no aparece en la lista para esa persona), nunca
   a través del papel solo.
3. **Importación de extractos bancarios por MCP** (multipart hoy):
   recomendación **fuera de v1**, junto con todos los adjuntos.
4. **Qué pasa con la bandeja de salida sin red**: no aplica al MCP (siempre
   hay red). Confirmar que no se espera «encolar» nada.

## 5. Fuera de alcance (v1)

Subida de ficheros por MCP · importación de extractos · contraseñas · crear
hogares · cambiar el propio papel · notificaciones push desde el asistente ·
«prompts» o «resources» MCP más allá de lo que haga falta para la ayuda (solo
herramientas en v1) · un paquete instalable para Claude Desktop · soporte
garantizado a clientes distintos de ChatGPT y Claude · facturación o límites
de uso de pago.

## 6. Lee primero (además de la lista del workflow común)

| Fichero | Qué saber |
|---|---|
| `apps/web/src/lib/server/auth-core.ts` y `auth.server.ts` | Cómo está montado Better Auth (plugins `username` y `admin`, `disableSignUp`, límites de tasa en base). Aquí se añade el plugin `mcp` sin reescribir la configuración dos veces |
| `apps/web/src/hooks.server.ts` | Orden de la petición: guardián de arranque, `/api/auth`, sesión, `guardForPath`, capacidad para lo que no es GET. El servidor MCP necesita su propio carril (token, no cookie) sin romper este orden |
| `apps/web/src/routes/api/v1/sync/+server.ts` y `packages/server/src/sync.ts` | Cómo se despachan los comandos, `processSyncBatch`, `CommandRejectedError`, códigos |
| `packages/server/src/database.ts` | `withAuthorizedTransaction`, `AuthenticatedPrincipal`, `ActiveMembership`: la única puerta a la base |
| `packages/contracts/src/schemas.ts`, `src/index.ts`, `src/capabilities.ts` | Los agregados, las acciones y los esquemas de los que se generan las herramientas |
| `apps/web/src/lib/server/*.server.ts` | Los cargadores que las herramientas de lectura envuelven |
| `apps/web/src/routes/h/[householdId]/employment/alta/+page.server.ts`, `employment/acuerdo/+page.server.ts`, `settings/+page.server.ts`, `account/+page.server.ts` | Las form actions que hay que extraer a servicios (y la que no se expone) |
| `apps/web/src/routes/h/[householdId]/account/` | La pantalla «Tu acceso», donde vive la sección nueva |
| `apps/web/svelte.config.js` | Una sola función, Node, `fra1`, `maxDuration` |
| `packages/db/migrations/0004_audit_and_jobs.sql` | `audit_events` y `request_id` |
| `docs/despliegue/opciones-de-acceso.md` | Por qué el acceso es como es; lo que este prompt cambia y lo que no |
| `docs/security/adjuntos-sin-antivirus.md` | El modelo de «riesgo asumido y cómo se revierte» para el ADR |
| `docs/adr/0003-*.md` | La regla indivisible de configuración, que afecta a cualquier variable nueva |
| `.claude/skills/operar-la-casa/referencia-operaciones.md` | El inventario completo de operaciones de administración que el MCP tiene que cubrir, operación a operación |

Documentación externa que hay que leer **en su versión vigente el día de la
sesión**, con `dependency-expert`/`document-specialist` y citando la fuente en
el spec: especificación de MCP (transporte Streamable HTTP y autorización),
plugin `mcp` de Better Auth para la versión instalada, SDK oficial de MCP para
TypeScript (versión y compatibilidad con Node 24 y Vercel), requisitos de
ChatGPT para conectores MCP (plan, modo desarrollador, herramientas de
escritura, Apps SDK) y de Claude (conectores personalizados en claude.ai y
Claude Desktop, `claude mcp add --transport http` en Claude Code).

## 7. Workflow específico

Sigue las siete fases del workflow común con estas adiciones:

### Fase 1a · Investigación (antes del spike)

`document-specialist` y `dependency-expert` producen un informe corto en
`docs/superpowers/specs/YYYY-MM-DD-webmcp-investigacion.md` con: lo que exige
cada cliente hoy (con fecha y enlace), lo que ofrece el plugin `mcp` de Better
Auth 1.6.26 (endpoints, DCR, PKCE, almacenamiento, pantalla de consentimiento
personalizable), la versión del SDK de MCP y su encaje con SvelteKit en Vercel,
y los límites conocidos (duración, tamaño de respuesta, SSE).

### Fase 1b · Spike obligatorio (desechable)

En una rama aparte y sin pruebas: un servidor MCP mínimo en `/mcp` con **una**
herramienta de lectura (`hogar_hoy`) y **una** de escritura inocua
(`rutina_marcar`), autenticado con el plugin `mcp` y la pantalla de
consentimiento por defecto, desplegado en un **preview de Vercel**. Conectarlo
desde **Claude Code**, desde **claude.ai** y desde **ChatGPT** con una cuenta
sintética. Documentar en el informe de investigación: qué funcionó, qué pidió
cada cliente, qué cabeceras y rutas hubo que abrir en `hooks.server.ts`,
cuánto tardó un arranque en frío. **Nada del spike se queda**: se reescribe en
la fase 3 a través del plan.

### Fase 1c · Spec y ADR

Spec `docs/superpowers/specs/YYYY-MM-DD-webmcp-asistentes-design.md` con las
secciones del workflow común más: catálogo de herramientas (generado y
revisado a mano, con la descripción de cada una), matriz **papel × módulo ×
herramienta** (qué ve y qué puede cada papel), flujo OAuth con diagrama de
secuencia, pantalla de consentimiento (texto completo), modelo de la tabla de
conexiones, política de dos pasos, límites, y la lista de form actions que se
extraen con su nueva firma.

ADR `docs/adr/0004-asistentes-externos-y-datos-del-hogar.md`: contexto
(datos de un hogar, incluidos los laborales de la empleada, pueden salir hacia
OpenAI o Anthropic por decisión de cada persona), decisión (se permite a
cualquier papel con consentimiento explícito y revocable; nunca contraseñas ni
ficheros), consecuencias (qué pierde la casa en control, qué gana, cómo se
revierte: desactivar el servidor con una sola variable y revocar todos los
tokens), y la relación con la revisión legal pendiente del ADR 0001.

Revisión adversarial del spec con `security-reviewer` **obligatoria**, con
una sección específica sobre: confusión de hogar (un token de una casa usado
contra otra), elevación por ámbitos, replay de la confirmación de dos pasos,
fuga por logs, y el camino `__data.json` de SvelteKit.

### Fase 2 · Plan por fases

Plan maestro `docs/superpowers/plans/YYYY-MM-DD-webmcp-asistentes.md` con al
menos estas fases, cada una con la rama en verde al cerrar:

1. **Cimientos de identidad**: plugin `mcp` en `auth-core.ts`, tablas de
   Better Auth en `casa_auth` por `runAuthMigrations`, pantalla de
   consentimiento, metadatos `.well-known`, tabla de conexiones (migración
   `00NN`) y su RLS, carril de token en `hooks.server.ts`, pruebas de
   integración del flujo OAuth con un cliente del SDK.
2. **Núcleo del servidor**: ruta `/mcp`, despacho JSON-RPC, mapeo de
   `CommandRejectedError` a errores MCP legibles, `request_id` con prefijo,
   límites de tasa, catálogo generado desde los contratos con descripciones,
   gate `mcp-coverage`.
3. **Lecturas**: una herramienta por cargador, paginación, enlaces
   autenticados, pruebas por papel bajo RLS real (`TEST_DATABASE_URL`).
4. **Escrituras de comandos**: generación desde los esquemas, ids de cliente,
   idempotencia, dos pasos para lo irreversible, pruebas por agregado.
5. **Extracción de las form actions** a servicios compartidos, con las
   pruebas de las pantallas intactas, y sus herramientas MCP con dos pasos.
6. **Interfaz**: «Tu acceso», Ajustes, manual, página pública si procede,
   capturas sintéticas, a11y, dbe2e de conectar y desconectar.
7. **Endurecimiento y entrega**: revisión de seguridad ejecutada
   (`docs/security/revision-webmcp.md`), **dbe2e** con un cliente real
   automatizado (el SDK de MCP como cliente, flujo OAuth completo con registro
   dinámico, contra la app con Postgres y Better Auth; en modo maqueta
   `getAuth()` es `null` y `/api/auth` responde 404, así que no hay e2e de
   fixtures posible para OAuth), documentación, CONTRIBUTING, producción.

### Fase 3 · Ejecución

TDD. El catálogo de herramientas se genera; las descripciones se escriben a
mano y el test exige que no falte ninguna. Cada herramienta de lectura tiene
una prueba por papel que demuestra lo que **no** ve. Cada herramienta
irreversible tiene una prueba de que la primera llamada no escribe nada.

### Fase 4 · Verificación

Lo del workflow común y, además: `pnpm test:lighthouse` **sí aplica** si el
flujo toca `/login` (es ruta medida, y el plugin redirige a `loginPage`, que
será `/login?next=…`), `verify:bundle` no ve nada del MCP en el cliente, un
cliente MCP real (SDK) completa el flujo OAuth con DCR contra la app levantada
en local con Postgres, y la matriz papel × herramienta de la revisión de
seguridad se ejecuta con las cinco cuentas sintéticas y se pega su salida.

### Fase 5 · Documentación

Manual (capítulo nuevo), skill (`referencia-operaciones.md`: una sección
«Desde el asistente» por área, y una sección nueva «Asistentes conectados»
con (a)/(b)/(c)), runbook (§5 variables si las hay; §7 humo: conectar Claude
Code con la cuenta real del propietario y listar las rutinas; una cuenta de
prueba sin permisos no ve finanzas), `.env.example`, README (mapa, suites,
documentación), `CONTRIBUTING.md` (la regla nueva), `security-baseline.md`
(la frontera nueva), ADR 0004.

### Fase 6 · Producción

Variables nuevas: idealmente **ninguna** (el emisor OAuth es `BETTER_AUTH_URL`,
que ya existe). Si el spec necesita una bandera para apagar el servidor
(`MCP_ENABLED`, recomendada como interruptor de emergencia del ADR), se
documenta y se pone **antes** del merge. Migraciones: las tablas del plugin en
`casa_auth` (por el runner de Better Auth) y la tabla de conexiones (por
`db:migrate`), ambas antes del merge y con confirmación del propietario. Humo:
el propietario conecta ChatGPT y Claude con su cuenta real, lista rutinas,
crea y descarta un cupón de prueba, cierra la conexión desde «Tu acceso» y
comprueba que el asistente deja de poder; una segunda cuenta con papel
restringido no ve lo que no debe.

## 8. Riesgos conocidos

- **Los clientes cambian deprisa.** Lo que exigen ChatGPT y Claude (planes,
  modo desarrollador, política de herramientas de escritura) se verifica el
  día de la sesión y se escribe con fecha en la ayuda en pantalla; la ayuda
  dice «comprobado el …» para que nadie la tome por eterna.
- **Vercel, una función y 60 s.** El spike mide el arranque en frío con el
  SDK cargado; si pesa, el SDK se carga bajo demanda solo en `/mcp`, como ya
  hace el SDK de S3 (`attachment-deps.server.ts`). `@modelcontextprotocol/sdk`
  no está en `pnpm-lock.yaml`: es dependencia nueva y va en commit propio.
- **Interpretación errónea del asistente.** Mitigada con los dos pasos para
  lo irreversible, descripciones precisas y vistas previas legibles. La
  revisión de seguridad incluye casos de «petición ambigua» y comprueba que
  el servidor no adivina.
- **Fuga por el consentimiento.** La pantalla de consentimiento vive fuera de
  `/h/<hogar>/…`, y `guardForPath` devuelve `null` para todo lo que no cuelga
  de ahí: **se guarda sola** (exige sesión en su `load`, redirige a `/login`
  con `next` si no la hay), pasa por la revisión de a11y y no muestra nada
  del hogar antes de autenticar.
- **El CSRF de SvelteKit y el endpoint de token.** `svelte.config.js` no
  configura `kit.csrf`, así que SvelteKit rechaza con 403, **antes de
  `handle`**, los POST `application/x-www-form-urlencoded` cuyo `Origin` no
  coincide. El intercambio de código en `/api/auth/mcp/token` llega desde los
  servidores de OpenAI o Anthropic exactamente así. Exceptuar esa ruta es una
  **decisión de seguridad** que el spec toma por escrito (qué rutas, por qué
  es seguro: PKCE y secreto de cliente), no un ajuste de cabeceras.
- **Crear usuarios desde un carril de token.** Los métodos del plugin `admin`
  de Better Auth que usa `hireHouseholdMember` reciben hoy `request.headers`
  de una sesión por cookie; desde el MCP no hay cookie. La investigación
  resuelve cómo invocarlos (sesión de servidor, llamada interna o
  reorganización del servicio). Con el acceso por enlaces mágicos ya en
  producción, el alta no genera contraseña provisional: crea la cuenta y
  dispara el correo de acceso, y eso es lo que la herramienta promete.
- **Interacción con el prompt de la web pública.** Si la web pública entra
  antes, el nombre y la página `/asistentes` ya existen y este prompt los
  rellena; si entra después, su prompt enlaza lo que este dejó.

## 9. Criterio de hecho

El propietario conecta ChatGPT y Claude desde «Tu acceso» en producción y
administra la casa desde el chat con las mismas operaciones y permisos que la
pantalla; una cuenta restringida no ve lo que no debe; las operaciones
irreversibles exigen vista previa y confirmación; desconectar revoca de
inmediato; `mcp-coverage` está en CI y falla con un agregado sin herramienta;
ADR 0004 aceptado, revisión de seguridad ejecutada, manual, skill, runbook,
CONTRIBUTING y memoria del agente al día.
