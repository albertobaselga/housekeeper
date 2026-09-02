# Acceso en producción: cuentas, contraseñas y qué hacer si se pierden

Cómo entra la gente en Housekeeper cuando la aplicación deja de ser una demostración.
Esta es la implementación de la **opción A** de [opciones-de-acceso.md](opciones-de-acceso.md):
usuario y contraseña de Better Auth, **sin correo en ningún punto del recorrido**.

Va dirigido a quien administra la casa. No hace falta saber programar para seguir
los apartados 3, 4 y 5; el 1 y el 2 son para quien monta la instalación.

---

## 1. Qué hay montado

- Se entra con **nombre de usuario y contraseña** (`alberto`, `ana`, `nuria`…),
  no con un correo. Escribir `nuria` en un móvil es mucho más fácil que teclear
  un correo sin erratas.
- **Nadie puede darse de alta solo.** El endpoint de registro está apagado
  (`disableSignUp: true`) en todos los entornos: responde `400` siempre. Hay una
  prueba de regresión que lo comprueba por HTTP
  (`apps/web/tests/auth.integration.test.ts`). Las cuentas las crea siempre
  alguien que ya administra la casa, por una de estas dos puertas:
  - **Desde la aplicación**, en Personal, para el personal del hogar (empleada
    interna o apoyo). Es la vía del día a día:
    [personal-y-contratos.md](../personal-y-contratos.md).
  - **Con el guion del apartado 2**, para montar la casa y para dar de alta a
    quien vaya a administrarla. La pantalla de Personal no puede crear
    administradoras, a propósito.
- **No hay «he olvidado mi contraseña» por correo.** El endpoint de
  restablecimiento responde `400 RESET_PASSWORD_DISABLED` porque no se ha
  configurado ningún envío. Se repone en persona (apartado 4). Es una decisión,
  no un descuido: quita del camino crítico una dependencia externa y una
  superficie de ataque.
- **Mínimo 10 caracteres.** Y cinco intentos por minuto: al sexto, la aplicación
  pide esperar. El contador vive en la base de datos, no en memoria, para que
  siga contando en un despliegue sin estado.
- La contraseña **solo dice quién eres**. Lo que puedes hacer dentro lo decide tu
  membresía del hogar, que se comprueba en cada petición contra la base de datos.
  Quitarle el acceso a alguien desde Ajustes le deja fuera al instante, aunque
  tenga la sesión abierta y sepa su contraseña.

Variables de entorno necesarias para que exista todo lo anterior:

| Variable | Para qué |
|---|---|
| `DATABASE_AUTH_URL` | Base de datos de identidad (Better Auth) |
| `BETTER_AUTH_SECRET` | Secreto de firma de sesiones |
| `BETTER_AUTH_URL` | Dominio definitivo, no una URL de previsualización |
| `DATABASE_URL` | Base de datos de la aplicación (hogares, membresías) |

Si faltan `DATABASE_AUTH_URL` o `BETTER_AUTH_SECRET`, la aplicación **no monta
ninguna ruta de autenticación** y cae al selector de cuentas de demostración con
datos ficticios. Eso es lo correcto en local y en la demo; en producción, si
alguna vez vieras ese selector, la instalación está mal configurada.

---

## 2. Cómo se crean las cuentas

> **Para dar de alta a una empleada o a alguien de apoyo no hace falta nada de
> este apartado.** Se hace desde la aplicación, en Ajustes del hogar → Ver el
> personal → «Entra alguien nuevo en la casa». La contraseña se genera sola, se
> enseña una vez para dictarla, y esa persona tiene que cambiarla antes de poder
> ir a ninguna otra pantalla. Este apartado es para montar la casa y para dar de
> alta a quien vaya a **administrarla**.

Se crean con un guion, a partir de un fichero JSON que **vive fuera del
repositorio** (en el llavero de Alberto, en una carpeta cifrada, donde sea; nunca
en Git y nunca en el entorno del servidor).

```bash
pnpm --filter @housekeeper/web seed:accounts --config /ruta/fuera/del/repo/hogar.json
```

Necesita en el entorno: `DATABASE_AUTH_URL`, `BETTER_AUTH_SECRET` y
`SEED_DATABASE_URL` (el usuario propietario de las migraciones del esquema `app`).

### El fichero de configuración

```json
{
  "household": {
    "slug": "casa-ejemplo",
    "displayName": "Casa Ejemplo"
  },
  "people": [
    { "username": "alberto", "name": "Alberto", "email": "alberto@sucorreo.es", "role": "family_admin" },
    { "username": "ana",     "name": "Ana",     "email": "ana@sucorreo.es",     "role": "family_admin" },
    { "username": "nuria",  "name": "Nuria",  "email": "nuria@casa.local",   "role": "employee_live_in" }
  ]
}
```

- `slug` identifica el hogar y es la clave de idempotencia: el mismo `slug`
  siempre apunta al mismo hogar. `id` es opcional; si no está, se genera uno.
- `email` es solo un **identificador único**, nunca un buzón: **a nadie se le
  escribe jamás**. Quien tenga correo puede poner el suyo; quien no, algo como
  `nuria@casa.local` sirve perfectamente.
- `role`: `family_admin`, `family_member`, `employee_live_in`, `helper` o
  `viewer`.
- `password` es opcional. Si no está, el guion **genera una fuerte** y la imprime
  una sola vez por pantalla. Si la pones tú, tiene que ser sólida: al menos 10
  caracteres, y o bien 16 o más, o bien mezclar tres tipos distintos
  (minúsculas, mayúsculas, cifras, signos). No puede contener el nombre de
  usuario.

### Qué imprime

```
Hogar Casa Ejemplo (casa-ejemplo) → e561d89e-…
  creada    alberto        family_admin       alberto@sucorreo.es
  creada    ana            family_admin       ana@sucorreo.es
  creada    nuria         employee_live_in   nuria@casa.local

Contraseñas generadas. Se muestran UNA sola vez: apúntalas ahora y
entrégalas en persona. Cada quien debe cambiarla desde «Tu contraseña» al entrar.

  alberto        vd3tm-e2bwd-3qhp6-xjpzn
  ana            prukg-b8ybe-g7zm2-gu4r2
  nuria         rjdxn-9k4ch-s68xj-25atw
```

Las contraseñas generadas van en cuatro grupos de cinco letras y cifras, sin
caracteres que se confundan al dictar. **No vuelven a mostrarse.** Si se pierden
antes de repartirlas, se repone la que falte (apartado 4) o se vuelve a ejecutar
el guion con `--reset-passwords`.

### Volver a ejecutarlo es inofensivo

El guion es idempotente. Sin banderas, **no toca ninguna contraseña en marcha**:
se limita a poner al día nombres, roles y membresías. Para reponer contraseñas
hay que pedirlo explícitamente:

```bash
# Ver qué haría, sin escribir nada
pnpm --filter @housekeeper/web seed:accounts --config /ruta/hogar.json --dry-run

# Reponer TODAS las contraseñas del fichero (cierra todas las sesiones)
pnpm --filter @housekeeper/web seed:accounts --config /ruta/hogar.json --reset-passwords
```

### Ana también es administradora, y eso es a propósito

El guion avisa si el hogar se queda con **una sola** `family_admin`. Dos
administradoras es la red de seguridad del apartado 5: se reponen mutuamente la
contraseña sin depender de nada externo.

---

## 3. Cambiar tu propia contraseña

Cualquiera, sea cual sea su papel en la casa, puede cambiar la suya:

1. En la barra lateral (o en «Más», en el móvil), **«Tu contraseña»**.
2. Escribe la de ahora, la nueva dos veces, y **«Cambiar mi contraseña»**.

Al cambiarla **se cierran tus sesiones en los demás dispositivos**. Es
deliberado: si alguien la sabía o se te quedó abierta en un móvil prestado, deja
de servir en el momento. Tendrás que volver a entrar en esos dispositivos con la
nueva.

---

## 4. Reponer la contraseña de otra persona

Solo puede hacerlo quien administra la casa (`family_admin`).

1. **Ajustes del hogar** → «Accesos del hogar».
2. En la tarjeta de esa persona, **«Poner una contraseña nueva»**.
3. Escribe la contraseña nueva dos veces y la palabra **REPONER** para confirmar.
4. **Díctasela en persona.** No hace falta que le pidas que la cambie: la
   aplicación se lo va a exigir.

La reposición **cierra todas las sesiones de esa persona**: si tenía la
aplicación abierta en el móvil, se le pedirá entrar de nuevo. Es lo que se quiere
cuando se repone una contraseña.

La contraseña que acabas de teclear queda marcada como **provisional**: la
próxima vez que esa persona entre, la aplicación la lleva a «Tu contraseña» y no
la deja ir a ninguna otra pantalla del hogar hasta que elija una suya. Es la
misma regla que se aplica a las contraseñas del alta.

No se puede reponer la propia (para eso está el apartado 3) ni la de alguien a
quien ya se le retiró el acceso.

> **Nota técnica.** Quien repone necesita ser `family_admin` del hogar *y* tener
> el rol `admin` en la base de identidad. El guion de alta mantiene las dos cosas
> alineadas automáticamente. Si el botón devuelve un error hablando de permisos,
> es que alguien cambió el rol a mano en la base de datos: vuelve a ejecutar el
> guion de alta (sin banderas) y quedará arreglado.

---

## 5. Si Alberto pierde su contraseña

Aquí no hay autoservicio, y es lo correcto: si lo hubiera, sería una puerta
trasera. Hay tres redes, en este orden.

### Red 1 — Ana (la que se usa)

**Ana es la segunda administradora.** Entra con su cuenta, va a Ajustes →
«Accesos del hogar» → tarjeta de Alberto → «Poner una contraseña nueva», y se la
dice. Un minuto, sin correo, sin esperas, sin nadie de fuera.

Por eso Ana es `family_admin` y no `family_member`: **es parte del diseño de
recuperación, no una comodidad**. Si algún día se le rebajara el rol, la casa se
quedaría con un único juego de llaves.

### Red 2 — El panel de la base de datos

Si por lo que fuera ninguna de las dos personas administradoras puede entrar,
Alberto es el dueño del proyecto de base de datos y puede ejecutar el guion de
alta con `--reset-passwords` desde una máquina con acceso:

```bash
pnpm --filter @housekeeper/web seed:accounts --config /ruta/hogar.json --reset-passwords
```

Eso repone todas las contraseñas del fichero y las imprime. Es el último recurso
y conviene tenerlo probado antes de necesitarlo, no descubrirlo en una urgencia.

**Quien tenga acceso al panel de la base de datos puede entrar en la aplicación.**
Esa cuenta debe tener verificación en dos pasos activada. Sin excepción.

### Red 3 — Lo que nunca hay que hacer

- **Ninguna «contraseña maestra» en variables de entorno.** Ni de emergencia.
- **Ningún atajo de demostración** encendido en producción. El selector de
  cuentas sin contraseña solo existe cuando no hay base de datos de identidad, y
  ahí no hay nada real que proteger.
- **Ninguna contraseña por WhatsApp, correo o nota en la nevera.** Se dictan en
  persona y se cambian al entrar.

---

## 6. Consejos para las tres personas

- **Cada quien la suya.** Una contraseña compartida no es una contraseña: nadie
  puede saber quién hizo qué, y retirar un acceso deja de significar nada.
- **Larga antes que rara.** Tres o cuatro palabras que solo signifiquen algo para
  ti («la-parra-del-abuelo-2019») valen más que `Xk9$m` y se recuerdan mejor.
- **Que la guarde el móvil.** Los campos están marcados para que el gestor de
  contraseñas del teléfono la ofrezca y la rellene. Es la forma más cómoda y la
  más segura de no tener que recordarla.
- **Si la dictaste, cámbiala.** Una contraseña provisional que lleva meses en pie
  es una contraseña que sabe más de una persona.

---

## 7. Comprobaciones antes de dar por buena una instalación

```bash
# El alta pública responde 400 y no crea nada
curl -s -X POST https://<dominio>/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"x","email":"x@ejemplo.test","password":"una-contrasena-larga-2026"}'
# → {"message":"Email and password sign up is not enabled","code":"EMAIL_PASSWORD_SIGN_UP_DISABLED"}

# El restablecimiento por correo está deshabilitado
curl -s -X POST https://<dominio>/api/auth/request-password-reset \
  -H 'content-type: application/json' -d '{"email":"alberto@sucorreo.es"}'
# → {"message":"Reset password isn't enabled","code":"RESET_PASSWORD_DISABLED"}
```

Y en la propia pantalla de entrada: debe pedir **usuario y contraseña**. Si
muestra tarjetas de cuentas para elegir, faltan `DATABASE_AUTH_URL` o
`BETTER_AUTH_SECRET` y la instalación **no está sirviendo datos reales**.

Además: `ALLOW_SYNTHETIC_DATA_ONLY` sin definir o a `false` en producción, y
ningún banner de datos sintéticos visible.

---

## Qué queda fuera de este documento

- **Passkeys** (entrar con huella o cara) como atajo voluntario sobre la
  contraseña: es el paso 8 de [opciones-de-acceso.md](opciones-de-acceso.md) y no
  está implementado.
- **Verificación en dos pasos** dentro de la aplicación. Para tres personas de una
  casa, con las contraseñas bien puestas, se consideró desproporcionado.
- **Códigos de recuperación impresos**: sobreingeniería mientras haya dos
  administradoras.
