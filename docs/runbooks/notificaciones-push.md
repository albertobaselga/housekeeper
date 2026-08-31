# Avisos en el móvil: claves, puesta en marcha y qué mirar cuando no llegan

**Qué resuelve.** Que dos hechos de la casa —el recibo del mes de quien trabaja
aquí y la cuenta del mes por pagar de quien administra— lleguen al teléfono sin
que nadie tenga que abrir la aplicación para enterarse. **Dos avisos, y ninguno
más**: lo que queda prohibido y por qué está en `docs/notificaciones.md` §6, y no
es una lista de opciones apagadas sino código que no existe.

**Qué NO resuelve, y conviene decirlo antes de encenderlo.** El push **no es un
canal de confianza**: no garantiza entrega ni latencia. Nada con consecuencia
—un plazo, un vencimiento, una confirmación— puede depender de que el aviso
llegara, y no depende: los dos hechos se ven igual en Hoy y en Empleo. Y **Casa
Clara no es un sistema de emergencia**; el 112 lo es, y está fijo y sin depender
de nada en la pantalla de Emergencias.

> **Este runbook lo aplica quien administra la instalación.** Nada de lo que hay
> aquí lo ejecuta el proyecto por su cuenta, y ninguno de estos comandos se ha
> lanzado contra producción.

---

## 0. Antes de empezar

- El planificador de la cola tiene que estar funcionando: los avisos salen de
  ella y de ningún otro sitio. Ver `docs/runbooks/planificador-cola.md`.
- La migración **0032** aplicada (`pnpm db:migrate`).
- Acceso al panel de **Vercel** del proyecto de la web.
- Un rato con cada teléfono delante. La cadena de iOS —instalar, volver a entrar,
  conceder el permiso— **se hace en persona**, y es el momento de enseñar la
  lista de lo que nunca se manda.

---

## 1. Las claves VAPID

Son un par de claves de curva elíptica P-256 que identifican a **este servidor**
ante los servicios de push de Apple, Google y Mozilla. La pública viaja al
navegador (es su función); la privada firma cada envío y **no sale del servidor
jamás**.

```bash
pnpm --filter @housekeeper/worker exec web-push generate-vapid-keys --json
```

Sale algo así, y **no se parece a ningún valor real de esta casa** —es un ejemplo
generado para esta página—:

```json
{"publicKey":"BGKLeM7xI4XSi5rjXi8VybFvws0qTEe5P4EvVPUaqWqlZR8_3Da6d0IneBzIcmevHMGHPz6LcOQoFBqmrJBEBQQ",
 "privateKey":"tHlj9jSbnSPf5ozGK4G4c3xY17UBqtOIDD33mhfWf5w"}
```

### Dónde va cada cosa

**En el repositorio no va ninguna de las dos.** Ni en un `.env` versionado, ni en
un fichero de ejemplo, ni en un comentario. `.env.example` solo lleva los nombres.

| Variable | Valor | Dónde |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | `publicKey` del comando | Vercel (Production) |
| `VAPID_PRIVATE_KEY` | `privateKey` del comando | Vercel (Production) |
| `VAPID_SUBJECT` | `mailto:` o `https:` de contacto | Vercel (Production) |

Las tres o ninguna. Con la pública puesta y la privada a medias, el navegador se
suscribiría a un servidor que jamás podrá escribirle, y el silencio se leería
como «está roto» en vez de como «no está configurado». La aplicación lo
comprueba: si falta cualquiera de las tres, «Tu cuenta» dice que esta
instalación no manda avisos y no dibuja el interruptor.

Si además corre el demonio de `apps/worker` en un host propio, las mismas tres
variables van allí. Los dos ejecutores comparten cola y catálogo.

### `VAPID_SUBJECT`: la trampa de estreno

Tiene que ser un `mailto:` o un `https:` **limpio**: sin espacios, sin corchetes
angulares, con un dominio válido.

```
VAPID_SUBJECT=mailto:avisos@ejemplo.es      ✅
VAPID_SUBJECT=<mailto:avisos@ejemplo.es>    ❌
VAPID_SUBJECT=mailto: avisos@ejemplo.es     ❌
VAPID_SUBJECT=avisos@ejemplo.es             ❌
```

Apple contesta `403 BadJwtToken` a un `sub` sucio, y **solo Apple**: en Android y
en escritorio todo funciona. Es decir, un espacio de más deja los avisos rotos
únicamente en los iPhone de la casa, que es el peor fallo posible porque le pasa
a una persona y a nadie más. La aplicación valida el formato al arrancar y, si no
pasa, se comporta como si no hubiera claves — antes eso que un canal que falla en
silencio para una sola persona.

### Custodia y rotación

- **No caducan.** No hay que rotarlas por higiene, y no conviene.
- **Rotarlas invalida TODAS las suscripciones a la vez.** Si se cambia el par,
  hay que volver a suscribir a todo el mundo, con sus teléfonos delante. Las
  filas viejas de `app.push_subscriptions` quedan apuntando a endpoints que ya no
  aceptan la firma nueva; el primer envío las marcará muertas.
- **Copia offline de la privada, fuera del panel.** Si se pierde, el efecto es el
  mismo que rotarlas: re-suscribir a mano.

Para rotar de verdad: cambiar las tres variables en Vercel, redesplegar, y
después pedirle a cada persona que apague y vuelva a encender el interruptor en
**Tu cuenta**. Las filas huérfanas se limpian solas cuando el servicio de push
responda 404/410.

---

## 2. Encenderlos, persona a persona

**El interruptor está en «Tu cuenta»** (`/h/<hogar>/account`), la única pantalla
que alcanzan los cinco papeles. No está en Ajustes del hogar y no va a estarlo:
Ajustes es de quien administra, y el interruptor del teléfono de otra persona no
se toca desde el panel de nadie.

**No hay ninguna otra pantalla que ofrezca los avisos.** Ni un banner, ni una
insignia, ni un recordatorio. Quien los quiera, va y los enciende. Si alguien
dice que no al diálogo del sistema, no se le vuelve a preguntar: no hay dónde.

### En Android y en escritorio

Entrar → **Tu cuenta** → *Avisarme en este teléfono* → aceptar el diálogo del
sistema. Ya está.

### En iPhone y iPad, por orden

1. **Antes de nada, con red, vaciar la cola de cambios pendientes** desde Safari.
   iOS aísla el almacén de Safari del de la aplicación instalada: lo que quede
   sin sincronizar se queda varado en Safari y la aplicación instalada arranca
   vacía.
2. Abrir la aplicación en **Safari** (Chrome y Firefox en iOS también usan
   WebKit, pero la instalación se hace desde Safari).
3. Botón **Compartir → «Añadir a pantalla de inicio»**.
4. **Abrir la aplicación desde el icono**, no desde Safari. En pestaña,
   `PushManager` no existe y el fallo es silencioso: no hay error, sencillamente
   no está la función. La pantalla lo detecta y lo explica.
5. **Volver a iniciar sesión**: es otro almacén de cookies. Que el acceso sea por
   nombre y contraseña abarata mucho esto — es teclear y ya.
6. **Tu cuenta → Avisarme en este teléfono**, y aceptar el diálogo.

> **El diálogo de iOS es de un solo disparo.** Si se dice que no,
> `Notification.requestPermission()` devuelve `denied` para siempre y la única
> forma de que iOS vuelva a preguntar es **borrar el icono y reinstalarlo**. Por
> eso conviene explicar para qué es antes de tocar el botón, y por eso la
> aplicación no lo pide sola en ningún momento.

Requisitos de iOS: **16.4 o superior**. Y sí, funciona en la Unión Europea:
Apple anunció en febrero de 2024 que retiraba las aplicaciones de pantalla de
inicio en la UE y **revirtió la decisión** antes de publicar iOS 17.4. Circula
mucha documentación desactualizada que dice lo contrario.

---

## 3. Comprobar que llega

No hay forma de probar Web Push sin un navegador con permiso concedido: es una
comprobación manual y hay que hacerla una vez por dispositivo.

El camino más corto que no toca datos reales es **cerrar una cuenta del mes en un
entorno de pruebas** y esperar a la siguiente pasada del cron (5 minutos). Se
generan dos cosas: el PDF del recibo y, detrás, el aviso.

```sql
-- 1. ¿Se encoló el aviso, y para cuándo?
select job_type,
       payload ->> 'topic' as aviso,
       status,
       run_at at time zone 'Europe/Madrid' as sale_a_las
  from app_private.job_queue
 where job_type = 'notification.push'
 order by created_at desc limit 10;

-- 2. ¿Llegó al servicio de push? (esto no dice que llegara AL TELÉFONO:
--    eso no lo sabe nadie, y es una propiedad del canal, no una avería.)
--    Se mira desde una sesión con el rol propietario.
select device_label, last_success_at, last_failure_at, failure_count, revoked_at
  from app.push_subscriptions;
```

`run_at` **siempre** cae entre las 09:00 y las 21:30 hora de Madrid y **nunca en
domingo**. Si ve un `run_at` fuera de esa ventana, es un defecto: la ventana la
aplica `app.push_run_at` en el encolado, que es el único sitio donde puede
aplicarse (en Web Push no se puede programar en el dispositivo ni recibir un
aviso y no mostrarlo).

---

## 4. Qué mirar cuando no llegan

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| «Tu cuenta» dice que esta instalación no manda avisos | Falta alguna de las tres `VAPID_*` en Vercel | §1 |
| Los avisos de la cola pasan a `dead` con «tipo de trabajo no soportado» | Igual: sin claves no se registra el manejador. La cola lo dice en `last_error` en vez de callarse | §1 |
| En iPhone no aparece el interruptor | La aplicación no se abrió desde el icono de la pantalla de inicio | §2 |
| Falla **solo** en los iPhone, y en Android va | `VAPID_SUBJECT` sucio → `403 BadJwtToken` | §1 |
| Un dispositivo dejó de recibir y nadie se enteró | **Es el riesgo de mantenimiento nº 1 de este canal.** Mirar `last_success_at`: «Tu cuenta» enseña esa fecha a su dueña, y a nadie más | §3 |
| `revoked_at` con fecha | El servicio de push respondió 404/410: datos del sitio limpiados, aplicación desinstalada, icono de iOS rehecho. Volver a encender el interruptor lo revive | §2 |
| Se le retiró el acceso a alguien y quiere dejar de recibir | Ya dejó: la audiencia se resuelve en el instante del envío contra membresías vivas. No hay ninguna copia de la lista en ningún sitio | — |
| Llegan tarde, o no llegan con el móvil en ahorro de batería | Los avisos van con `Urgency: low` y `TTL` de 4 horas, a propósito. Un aviso que no llegó en cuatro horas se pierde antes que sonar de madrugada | — |

### Lo que NO se puede diagnosticar, y no por falta de herramientas

**Nadie puede ver si otra persona tiene los avisos encendidos.** Ni quien
administra el hogar, ni desde Ajustes, ni con una consulta ordinaria: lo impide
la RLS de `app.push_subscriptions`, no la interfaz. El estado de notificaciones
de una persona es presencia, y esto es una relación laboral en una casa.

Es una consecuencia incómoda y hay que aceptarla: **es posible que alguien no los
active, está en su derecho, y no se puede saber ni preguntar sin que sea
presión.** La forma limpia de vivir con eso es no depender del canal para nada
operativo — y no se depende.

Si hace falta saber «¿se ha enterado?», la respuesta no está en el canal: está en
el hecho. Confirmar el cobro es una acción en la aplicación, es un hecho de la
relación laboral y **eso sí lo ven las dos partes**.

---

## 5. Apagar el canal entero

Borrar las tres `VAPID_*` de Vercel y redesplegar. A partir de ahí no se encola
ningún aviso, no se registra el manejador y «Tu cuenta» dice la verdad. Las filas
de `app.push_subscriptions` se quedan quietas y no molestan; si se quiere limpiar
de verdad, cada persona apaga su interruptor.

Los recibos se siguen generando y todo lo demás de la cola se sigue vaciando: el
canal de avisos nunca ha sido un requisito para que la aplicación funcione, y esa
es la propiedad que hace que apagarlo sea barato.
