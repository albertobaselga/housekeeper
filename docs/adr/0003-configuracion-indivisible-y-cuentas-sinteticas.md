# ADR 0003: configuración indivisible y cuentas sintéticas fuera del paquete

## Estado

Aceptado el 10 de agosto de 2026.

## Contexto

La auditoría de la puesta en producción de Casa EG112
(`docs/despliegue/puesta-en-produccion-eg112.md`) midió un peligro que no era
hipotético, porque el propio repositorio lo ejercitaba en una suite:

> `DATABASE_URL` = base real de la casa · `DATABASE_AUTH_URL` ausente
> → selector de cuentas sintéticas vivo sobre datos reales, con identidades que
> operan bajo RLS.

Tres hechos lo hacían alcanzable por descuido:

1. **El selector no dependía de la base, sino de la identidad.** `getAuth()`
   devuelve `null` sin `DATABASE_AUTH_URL` ni `BETTER_AUTH_SECRET`
   (`auth.server.ts`), y `resolveMode()` colgaba de eso. Poner la base sin la
   identidad no era «la mitad de la configuración»: era la peor de las tres.
2. **La única reja era un `if` sobre una cabecera.** La acción `demo` existía
   siempre y se defendía con `url.hostname`, es decir, con cómo la plataforma
   normaliza el `Host`. Una puerta de administración no descansa en eso.
3. **Los identificadores sintéticos son principales reales.** `fixture:roble:*`
   son los mismos que `packages/db/fixtures/001_two_households.sql` inserta en
   `app.user_profiles.user_id`, y `hooks.server.ts` los metía tal cual en
   `locals.user.id`, de donde van a `set_config('app.user_id', …)`.

Y, aparte, `ALLOW_SYNTHETIC_DATA_ONLY` figuraba como control 9 del baseline de
seguridad sin gobernar ninguna decisión: se leía una vez y terminaba pintando un
párrafo. Una casilla marcada en una lista que no protegía nada.

## Decisión

### 1. El selector de cuentas sintéticas no se apaga: no se compila

`__FIXTURE_LOGIN__` es una constante de compilación (`vite.config.ts`, `define`)
resuelta en `src/lib/server/fixture-login-flag.js`. De ella cuelgan la acción
`demo` de `/login`, la lista de cuentas del `load`, la rama de sesión de maqueta
de `hooks.server.ts` y el borrado de cookie de `/logout`. Con la constante en
`false`, Rollup se lleva las cuatro: `actions` queda con una sola entrada y
`?/demo` responde 404 porque no hay ninguna acción con ese nombre, igual que con
cualquier nombre inventado.

**La regla de resolución, y por qué esa:**

| `CASA_CLARA_FIXTURE_LOGIN` | `vite dev` | `vite build` |
| --- | --- | --- |
| sin declarar | dentro | **fuera** |
| `true` | dentro | dentro |
| `false` | fuera | fuera |
| cualquier otra cosa | error | error |

Sostiene las dos promesas a la vez. **Olvidarla cae del lado seguro**: una build
que no la declara —cualquier build de Vercel— no lleva el selector dentro. Y **el
desarrollo local sin base de datos no se rompe**, que es como corren las suites
de maqueta: el servidor de desarrollo sí lo lleva, sin exportar nada. Los dos
únicos consumidores legítimos son las dos configuraciones de Playwright, que la
declaran en su comando de build.

Un valor que no sea `true` ni `false` mata la build en vez de adivinar.
Interpretar `1` como falso sería un fallo silencioso justo en la variable que no
los admite, y como cierto sería peor.

**No se promete: se comprueba.** `scripts/verify-fixture-login.mjs` corre después
de `vite build`, recorre la salida y exige que no aparezca ninguna de las tres
marcas del camino sintético —la cookie `cc_demo_session`, `listDemoUsers` y
`getDemoUser`—, que entre las tres cubren las dos únicas formas que tenía un
identificador sintético de llegar a `locals.user.id`. Con la constante encendida
exige lo contrario: sin esa mitad, una comprobación que mirase al directorio
equivocado pasaría en verde para siempre. CI ejercita las dos direcciones sin
tocar el flujo de trabajo: el trabajo de `build` construye la forma de
producción y los de e2e la de maqueta.

### 2. Base e identidad entran juntas, o no se sirve

La regla vive en un solo sitio, `src/lib/server/deployment-config.js`, y se
aplica en dos momentos:

- **Antes de `vite build`** (`scripts/check-deployment-config.mjs`). Es el momento
  barato: una build que falla no deja fuera a nadie, porque el despliegue
  anterior sigue sirviendo la casa mientras se corrigen las variables.
- **En el arranque del servidor** (`src/lib/server/boot-guard.server.ts`, primera
  línea de `handle`). Es la red de abajo, porque el paquete y su entorno se
  separan: un `vercel deploy --prebuilt`, una promoción de un despliegue viejo o
  una variable retirada del panel dejan corriendo un artefacto construido bajo
  otras condiciones.

Con `DATABASE_URL` presente se exigen `DATABASE_AUTH_URL`,
`BETTER_AUTH_SECRET` y `BETTER_AUTH_URL`, y esta última tiene que ser `https`
(o local). Sin `DATABASE_URL` no se exige nada.

**Por qué esto no deja la casa fuera por un error de configuración.** Tres
decisiones, todas deliberadas:

1. **La regla sólo se despierta si hay base de datos.** Sin `DATABASE_URL` no hay
   nada real que proteger. El desarrollo local y las suites de maqueta no ven
   ninguna diferencia.
2. **La negativa no quita ningún acceso que existiera.** En el estado que
   rechaza —base sí, identidad no— `getAuth()` es nulo, `/api/auth` responde 404
   y nadie puede entrar con su contraseña. No hay puerta buena que cerrar: lo
   único que la aplicación sabría hacer ahí es lo que no debe.
3. **La reparación nunca está dentro de la aplicación.** Se arregla en el panel
   de variables y con un despliegue, así que quien tiene que arreglarlo no
   depende de poder entrar. Por eso la respuesta nombra las variables que faltan
   una a una, sin filtrar ningún valor: es una instrucción, no un muro.

El guardián de la build distingue **tres** desenlaces, no dos. Lo incoherente
muere; lo **vacío** (ninguna variable de base) avisa y deja construir, porque un
despliegue sin base no tiene nada que filtrar y matar la build ahí bloquearía el
despliegue de arranque, que es justo el que hay que poder hacer.

`SNAPSHOT_SIGNING_KEY_B64` queda fuera de la negativa de ejecución y sólo se
avisa en la build. Su ausencia genera una clave efímera por proceso: rompe la
durabilidad de los snapshots firmados entre arranques en frío, no la identidad.
Tumbar la casa por ella sería desproporcionado.

### 3. `ALLOW_SYNTHETIC_DATA_ONLY` deja de ser un cartel

Lo primero es reconocer lo que esta variable **no puede hacer nunca** en la web:
distinguir un dato real de uno inventado. Nadie puede, desde dentro del proceso.
Un guardián que pretenda «impedir que entren datos reales» es necesariamente
teatro, y el teatro en una casilla de seguridad es peor que la casilla vacía,
porque alguien lo tacha en una lista y sigue.

Lo que sí es: **una afirmación que el despliegue hace sobre sí mismo** —«yo no
soy la casa de nadie»—. Y una afirmación se convierte en cerrojo del único modo
honesto: **haciendo que sea cara si es falsa**.

- Declararla y ser producción (`VERCEL_ENV=production`) son incompatibles, y
  **gana la negativa**: el despliegue no arranca y dice exactamente esa
  contradicción. Colarla en producción ya no sirve un banner mentiroso sobre la
  casa real; tumba el despliegue antes de servir nada. El fallo pasa de
  silencioso y permanente a ruidoso e inmediato.
- La build de producción la rechaza **por existir**, no por su valor. Ni siquiera
  a `"false"`: una variable presente en el panel es una variable que alguien
  puede voltear un martes por la tarde, y la ausencia es el único estado que no
  se voltea por accidente.
- El banner se queda, y ahora hay código que impide que se pronuncie donde sería
  mentira.

**Lo que se deja fuera a propósito.** No se le cuelga ninguna prohibición de
escritura ni de exportación. Staging es un entorno de pruebas de la aplicación
entera: prohibirle escribir lo volvería inútil, y una variable que hay que apagar
para trabajar acaba apagada en todas partes. El único cerrojo *de datos* que esta
variable tiene y merece seguir teniendo es el del worker, que rechaza cualquier
destinatario de correo fuera de los TLD reservados
(`apps/worker/src/integrations.ts`): ahí sí hay algo concreto que sale del
sistema y se puede parar.

### 4. Las dos afirmaciones son auditables desde fuera

`/api/health` publica `synthetic` y `fixtureLogin`. Las dos verificaciones del
runbook —«comprobar que `ALLOW_SYNTHETIC_DATA_ONLY` no está definida» y
«comprobar que el selector no está en la función desplegada»— pasan de ser una
inspección visual del banner y un `grep` sobre `.vercel/output` a ser un `curl`
que puede hacer cualquiera.

## Consecuencias

- Para Casa EG112: **no se define** `ALLOW_SYNTHETIC_DATA_ONLY`, ni a `true` ni a
  `false`; **no se define** `CASA_CLARA_FIXTURE_LOGIN`; y `DATABASE_URL`,
  `DATABASE_AUTH_URL`, `BETTER_AUTH_SECRET` y `BETTER_AUTH_URL` entran en la
  misma operación.
- `playwright.db.config.ts` sigue ejercitando la combinación «selector + base
  real», que es legítima con fixtures y fuera de la plataforma. Deja de ser
  alcanzable por descuido: exige declarar `CASA_CLARA_FIXTURE_LOGIN`, y con ella
  el paquete se niega a arrancar en cualquier despliegue de Vercel que tenga base
  de datos.
- `ENABLE_DEMO_PASSWORD_AUTH` no existe en el código desde hace tiempo. Se retira
  de `.env.example` para que nadie crea que ha cerrado una puerta que no existe.

## Lo que este ADR NO arregla

La degradación silenciosa a datos inventados de los `+page.server.ts` (R2 del
expediente) es un problema distinto y sigue abierto: `fixtures.server.ts` viaja
entero en el paquete de producción porque cada pantalla lo usa como respaldo
ante cualquier fallo de base de datos. Por eso `fixture:roble:` **no** está entre
las marcas que audita `verify-fixture-login.mjs`: poner ahí una marca que hoy no
puede estar limpia convertiría el guion en un fallo permanente que alguien
acabaría desactivando. Cuando R2 se cierre, esa marca debería añadirse.
