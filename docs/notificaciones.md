# Notificaciones en el dispositivo (Web Push)

> Documento de decisión. Reúne y **arbitra** tres investigaciones previas (técnica,
> de casos de uso y de encaje humano/laboral) contra el código real del repositorio.
> Fecha: 10/08/2026. No implica ningún cambio de código todavía.

---

## 0. Enmienda de 11/08/2026 — qué avisos quedan SIN canal

Decisión del propietario: **no hay correo en ninguna parte; el canal es la
aplicación.** La migración 0029 retiró la salida SMTP entera —el remitente, el
transporte, la política de destinatarios sintéticos— y, con ella, los dos únicos
trabajos que sabían usarla. Lo que este documento describía como «el aviso B ya
existe, solo le falta salida» hay que leerlo ahora al revés: **el aviso B ya no
existe; lo que queda es el hecho que lo justificaba.**

Hasta que existan las notificaciones al móvil que describe el resto de este
documento, **estos avisos no llegan a ningún sitio**:

| Aviso retirado | Qué se pierde | Dónde se ve mientras tanto |
|---|---|---|
| `notification.settlement_due` — «una liquidación vence en tres días», a quien administra, con reescalada cada 3 días | El empujón con plazo. Es el aviso **B** de §2.1 y sigue siendo el mejor candidato a push: hay fecha, hay consecuencia económica y hay una acción al otro lado | La decisión «Cuenta del mes por pagar» de **Hoy** (`today.server.ts`), que ya la pinta con su vencimiento. Nadie recibe nada si no abre la aplicación |
| `notification.routine_due` — «una rutina vence hoy», a la audiencia de la rutina | Nada que este documento echase de menos: §2.2 ya lo descartaba con tres razones para push, y por correo era peor (un correo por ocurrencia) | **Hoy** y el **calendario**, que es donde se atienden las rutinas |
| Auto-confirmación del parte semanal (`time_report.autoconfirm`) | Nada: el parte semanal se retiró entero en la misma migración. El «bloqueado, no descartado» de §2.2 pasa a **descartado** | — |

Consecuencias para el resto del documento:

- **El aviso A** (§2.1, «te han pagado: puedes confirmar el cobro») nunca tuvo
  correo, así que no pierde nada. Sigue siendo el primero que debe existir, y
  sigue sin necesitar reloj: sale del propio comando de pago.
- **El «cambio obligatorio en B»** de §2.1 —sacar a la empleada de la lista de
  destinatarios— ya se hizo antes de la retirada, y ahora es discutible por
  construcción: no hay lista.
- **El §3.1** decía que los manejadores reciben `sendEmail` inyectado y que
  bastaba con sustituir esa dependencia por un `notify`. Ya no hay dependencia
  que sustituir: cuando se implemente el push, el manejador nace nuevo, con el
  hecho que lee (vencimiento, pago) y el canal que usa (suscripción de
  dispositivo) decididos a la vez.
- **La función `app_private.settlement_reminder_state`** (0006), que le daba al
  worker las direcciones de correo de la casa, se retiró con la 0029. El push no
  la necesita —no manda a direcciones, manda a dispositivos—, así que lo que
  haga falta se declara de nuevo y con la superficie mínima del canal nuevo.

---

## 1. Respuesta directa en tres líneas

1. **¿Se puede?** Sí. Web Push con VAPID funciona en Android, escritorio y iPhone (16.4+, solo si la app se abre desde el icono de la pantalla de inicio), no cuesta nada, no exige cuenta de Apple ni de Google, y el contenido viaja cifrado de extremo a extremo por norma (RFC 8291).
2. **¿Merece la pena?** Sí, pero **poco y tarde**: el valor real son **dos avisos**, y uno de ellos ni siquiera necesita infraestructura nueva. La parte cara no es el push, es que **nadie drena `app_private.job_queue`**; hoy no hay worker desplegado ni cron configurado (no existe `vercel.json` en el repo).
3. **¿Para qué exactamente?** Para dos cosas y ninguna más al principio: avisar a la empleada de que **le han pagado y puede confirmar el cobro**, y avisar a la familia administradora de que **una liquidación vence en tres días**. Todo lo demás es ruido, está bloqueado por funcionalidad que no existe, o es una vibración que sustituye a una conversación en una casa de tres personas.

---

## 2. Qué se notifica y qué no

### 2.1 Los dos que sí

| # | Aviso | A quién | Cuándo se dispara | Por qué sí |
|---|---|---|---|---|
| **A** | «Hay una liquidación cerrada: puedes confirmar el cobro cuando quieras» | `employee_live_in` | Dentro del propio comando `payment` / record, cuando el pago deja `pending_cents` a cero | Es su dinero, es una buena noticia, es una vez al mes, hay una acción suya al otro lado (`payment.confirm.self`), y **no necesita ningún reloj**: sale del comando. Además cierra el bucle que hoy hace que el recordatorio de vencimiento siga reavisando cada 3 días |
| **B** | «Hay una liquidación pendiente de pago» | **Solo `family_admin`** | Job `notification.settlement_due`, ya encolado en producción por `settlement.ts:506-513` a `due_on − 3 días` | El hecho ya existe, el job ya existe, la escalada cada 3 días ya está implementada (`reminders.ts:115-120`). Solo le falta salida. Hay plazo y consecuencia económica |

El hecho que dispara **A** ya está calculado y pintado en pantalla: `apps/web/src/lib/server/today.server.ts:291-306` construye la decisión «Cobro de … por confirmar» con exactamente la condición `status = 'closed' AND pendingCents = 0 AND paidCents > 0 AND !receiptConfirmed`. No hay que inventar la regla, hay que copiarla.

**Cambio obligatorio en B.** Hoy `apps/worker/src/reminders.ts:100-109` mete a la empleada en la lista de destinatarios (`state.employeeEmail`). Como correo pasaba desapercibido; **como push es una escalada cada tres días recordándole que sus jefes no le han pagado, sobre algo que no está en su mano.** Se quita explícitamente. Este cambio hay que hacerlo **aunque no se implemente ningún push**: ya es un defecto del correo.

### 2.2 Los que se descartan, con la razón de cada uno

| Descartado | Razón |
|---|---|
| **Parte semanal enviado / confirmado / disputado** | **Bloqueado, no descartado.** El único comando del agregado `time_entry` es `submit_week` (`packages/contracts/src/schemas.ts:94`); no existe `confirm` ni `dispute`, y `buildTodayDecisions` no tiene ninguna rama de parte semanal. El único `confirmed` que se produce hoy lo pone `time_report.autoconfirm` a los 3 días. Notificar «mañana se confirma solo» sería **una alarma sin botón**: no hay pantalla donde atenderla. Primero el comando y la decisión en Hoy; después, quizá, el aviso |
| **Vacaciones (solicitud / respuesta)** | **No existe el flujo.** El propio código lo dice: «el hogar decidió que no hay flujo de solicitud ni de aprobación» (`packages/server/src/commands/vacation.ts:256-260`). Las apunta la familia administradora. La capability `leave.request.self` existe en el contrato pero **no tiene comando detrás**. No hay nada que notificar |
| **Rutinas que vencen** (`notification.routine_due`) | Tres razones acumuladas, cualquiera bastaría. (a) Se encola **un job por ocurrencia** (`rhythm.ts:92-113`): una rutina diaria es una vibración diaria, la definición de entrenar a la gente a ignorar. (b) La casa **ya renunció por escrito** a poner hora de reloj a las rutinas (`docs/rutinas-y-calendario.md:322`: «poner hora convierte una guía en un fichaje»); un push es esa hora de reloj, y además suena. (c) Hacia la empleada es un recordatorio recurrente de trabajo pendiente, que es la versión-notificación de lo que el AC-26 revisado echó fuera (`docs/rutinas-y-calendario.md:1148-1153`). **Ni siquiera las mensuales, al principio** |
| **Menú sin confirmar** | Diario y recurrente. Sale en Hoy, que es donde se atiende. Es el candidato perfecto para agotar la paciencia y gastar el permiso |
| **Gastos pendientes de aprobar, jornadas extra por decidir** | Son de goteo y **no tienen reloj**. Su daño es acumulativo, no urgente. Un gasto sin aprobar hoy sigue sin aprobar la semana que viene y no pasa nada irreversible |
| **Pago parcial registrado** | Redundante: si el pago completa el total dispara **A**; si no lo completa, no pide ninguna acción a nadie |
| **Cambios en la Guía, lista de la compra, comentarios** | Tres personas bajo el mismo techo. Lo hablan. Notificar aquí es sustituir una conversación por una vibración |
| **Calendario / agenda ICS** | Son feeds externos: el móvil de cada uno ya avisa desde su propia app de calendario. Duplicarlo es el aviso doble clásico que hace que se silencien los dos |
| **«Mes por cerrar» / liquidación sin abrir** | **El hecho no existe.** `today.server.ts` solo lee liquidaciones `status = 'closed'`: un mes que nadie abrió no genera decisión ni job. Es el agujero más caro que tiene la app (es el sueldo), pero se arregla creando el hecho, no notificándolo |
| **Ajustes manuales, anticipos, membresías, presencia** | Contabilidad interna o datos de actividad. Nada que decidir, y en el caso de la presencia, prohibido (§6) |

### 2.3 El resumen diario: no, todavía

La investigación de casos proponía un **resumen diario único a la familia** («Tienes 3 cosas que decidir») a las 21:00. La idea es buena y el contenido ya está calculado por `buildTodayDecisions`. Pero:

- necesita **toda** la maquinaria de reloj (cron, ventana horaria, encolado diario por hogar), que es justo lo caro;
- su valor es difuso: no hay un plazo concreto detrás;
- y compite por el mismo permiso que los dos avisos que sí importan.

**Queda para una fase 2**, y solo si en dos meses de uso real de A y B la familia lo echa de menos. El criterio de este documento es explícito: **es mejor un aviso que llegue que cinco que se ignoren.**

---

## 3. Arquitectura mínima para esta instalación (Vercel + Supabase, sin worker)

### 3.1 Lo que hay hoy, verificado

- El service worker existe (`apps/web/src/service-worker.ts`, 131 líneas) y **no tiene ningún manejador `push` ni `notificationclick`**.
- El manifiesto declara `"display": "standalone"` (`apps/web/static/manifest.webmanifest`), que es exactamente lo que iOS exige. **Pero solo hay `icon.svg`**, y `apps/web/src/app.html` no declara `apple-touch-icon`. iOS no usa SVG para el icono de pantalla de inicio.
- `runOneJob` (`apps/worker/src/queue.ts:95-114`) **es apto tal cual para serverless**: reclama, ejecuta, cierra y devuelve `false` cuando no hay nada. No guarda estado entre llamadas.
- Los handlers de notificación reciben `sendEmail` **inyectado** (`apps/worker/src/index.ts:82,88`). Sustituir esa dependencia por un `notify` que decida canal no obliga a tocar `packages/server` en absoluto.

### 3.2 Migración 0023: la tabla y su RLS

**Discrepancia arbitrada.** La investigación técnica proponía colgar la suscripción de `user_id`; la humana, de `membership_id`. **Gana `user_id`**: el dispositivo es de la persona, no del hogar. Una persona con membresía en dos hogares no debe suscribir el mismo teléfono dos veces ni recibir dos avisos del mismo móvil. El hogar entra en la decisión de **a quién enviar**, no en la de **quién es dueño del dispositivo**. Las *preferencias por tópico* sí van por membresía, porque los tópicos dependen del rol.

**Segunda discrepancia arbitrada.** La investigación humana proponía guardar el endpoint **hasheado**, por analogía con el token de feed ICS. **No se puede**: el token ICS es un secreto que el servidor solo necesita *verificar*, mientras que el endpoint del push es la URL a la que hay que **hacer POST**. Se guarda entero, con `UNIQUE`.

```sql
-- 0023_push_subscriptions.sql
CREATE TABLE app.push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL REFERENCES app.user_profiles(user_id) ON DELETE RESTRICT,
  endpoint        text NOT NULL UNIQUE,   -- identificador natural, único global
  p256dh          text NOT NULL,          -- secreto de cifrado
  auth            text NOT NULL,          -- secreto de cifrado
  device_label    text,                   -- "el móvil de la cocina", lo pone la persona
  created_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at    timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count   integer NOT NULL DEFAULT 0,
  revoked_at      timestamptz
);

ALTER TABLE app.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_subscriptions FORCE ROW LEVEL SECURITY;

-- Solo el dueño. Nadie más, tampoco family_admin.
CREATE POLICY push_self ON app.push_subscriptions
  FOR ALL USING (user_id = app.current_user_id())
        WITH CHECK (user_id = app.current_user_id());

CREATE TABLE app.notification_preferences (
  household_id  uuid NOT NULL,
  membership_id uuid NOT NULL,
  topic         text NOT NULL CHECK (topic IN ('settlement.receipt_ready', 'settlement.due')),
  enabled       boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, membership_id, topic),
  FOREIGN KEY (household_id, membership_id)
    REFERENCES app.household_memberships (household_id, id) ON DELETE RESTRICT
);
-- RLS: membership_id = app.current_membership_id(). Igual de cerrada.
```

**Dos decisiones deliberadas, con su razón:**

- **La RLS rompe a propósito el patrón de `user_profiles_admin_read`** (`0005_rls.sql:57-65`), donde el administrador sí ve los perfiles de su hogar. Aquí no debe: la lista de endpoints de una persona **es un censo de sus dispositivos**, con marcas de cuándo aparecen y desaparecen. Y `p256dh`/`auth` son claves de cifrado que nadie debería poder cosechar con una consulta ordinaria. Ver §6.
- **Sin trigger de auditoría.** La lista de `0004_audit_and_jobs.sql:264-284` es explícita y esta tabla **no entra**. El trigger copia `NEW` entero a `app.audit_events`, que es append-only e inmutable: volcaría las claves de cifrado allí para siempre.
- **El enum de `topic` es corto y cerrado a propósito.** Solo dos valores. Añadir uno debe costar una migración y una discusión.

**Lectura desde el emisor por función definer**, el patrón que ya usan `app_private.settlement_reminder_state` y `app_private.replace_ics_source_events`:

```sql
CREATE FUNCTION app_private.push_targets(hh uuid, audience_roles text[], topic text)
RETURNS TABLE (endpoint text, p256dh text, auth text)
SECURITY DEFINER ...
-- join push_subscriptions × household_memberships × notification_preferences filtrando:
--   membership.starts_at <= now() AND membership.revoked_at IS NULL
--   AND (membership.expires_at IS NULL OR membership.expires_at > now())
--   AND membership.role = ANY(audience_roles)
--   AND push_subscriptions.revoked_at IS NULL
--   AND notification_preferences.enabled
-- GRANT EXECUTE TO casa_clara_worker;
```

Los destinatarios se resuelven **en el instante del envío**, no en el del encolado. Esto arregla de paso un agujero preexistente: `enqueueRoutineDue` materializa los correos **dentro del payload del job** (`rhythm.ts:100-112`), y ese job puede ejecutarse semanas después, enviando al correo de alguien a quien se le retiró el acceso hace dos semanas.

### 3.3 Quién dispara los envíos

**Aviso A: nadie. Sale del comando.**
`recordPaymentHandler` (`packages/server/src/commands/payment.ts`) ya calcula `pending_cents` contra `app.settlement_payment_totals` antes de insertar. Si tras el pago el pendiente queda a cero, encola un job `notification.receipt_ready` con `run_at` calculado por la ventana horaria (§5.1). **Cero infraestructura nueva** más allá del drenador.

**Aviso B: ya está encolado.** `settlement.ts:506-513` lo hace en la misma transacción del cierre. Solo falta quien lo ejecute.

**El drenador: `pg_cron` + `pg_net` en Supabase llamando a un endpoint de Vercel.**

| Opción | Cadencia | Coste | Veredicto |
|---|---|---|---|
| Vercel Cron (Hobby) | Máximo 1/día, ±59 min | 0 € | Inservible |
| Vercel Cron (Pro) | 1/min | 20 USD/mes | Funciona, pero pagar por esto no se justifica |
| **`pg_cron` + `pg_net` → endpoint en Vercel** | **1/min** | **0 €** | **Recomendada** |
| Worker actual en Fly.io o máquina de casa | sondeo 1 s | ~3 USD/mes | Mejor si además importa el ICS y ClamAV |

> **No verificado.** La disponibilidad de `pg_cron` y `pg_net` en el plan **gratuito** de Supabase no se ha podido comprobar desde este entorno (no hay acceso al panel del proyecto). `docs/despliegue/plan-vercel-supabase.md:352-364` da `pg_cron` por disponible, pero no distingue plan. **Confírmese en el panel antes de planificar sobre ello**; si no estuviera, la alternativa barata es el worker actual en Fly.io sin cambios de código (`infra/docker/worker.Dockerfile`), que además resuelve el ICS.

**Tres obstáculos del camino Vercel, todos verificados y todos silenciosos:**

1. **La web no puede leer la cola.** `casa_clara_app` tiene `USAGE` sobre `app` pero **no sobre `app_private`** (`0001_identity_and_context.sql:19-20`), y `job_queue` solo tiene grant para `casa_clara_worker` (`0005_rls.sql:386-387`). El endpoint drenador necesita **un segundo pool** con un rol de login miembro de `casa_clara_worker` (ambos roles del repo son `NOLOGIN`: el rol de login se crea en el despliegue). Eso mete credenciales de esquema privado en el mismo despliegue que sirve las páginas: mitigación obligatoria es un secreto de cabecera propio y **no reutilizar jamás el pool de la aplicación**.

2. **No hay barrendero de jobs colgados.** `claimNextJob` solo mira `status = 'queued'` (`queue.ts:41-46`) y deja el job en `running` con `locked_at`. Si la función de Vercel se corta a mitad —y con tope de 60 s y cron cada minuto, **se cortará**—, ese job queda `running` para siempre. En un demonio de larga vida es improbable; aquí es una certeza estadística.

   ```sql
   update app_private.job_queue
      set status = 'queued', locked_at = null
    where status = 'running' and locked_at < now() - interval '5 minutes';
   ```

   La transición `running → queued` **está permitida** por el trigger de máquina de estados (`0004_audit_and_jobs.sql:214-217`). Verificado.

3. **`loadWorkerConfig` aborta sin SMTP ni S3.** `apps/worker/src/config.ts:46-55` exige `S3_ENDPOINT`, `S3_PRIVATE_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SMTP_HOST` y `SMTP_FROM`. Un ejecutor que solo manda push no debe exigir nada de eso para arrancar.

### 3.4 Cliente

- **Interruptor en `/h/[householdId]/account`** (§4.3), no en `/settings`.
- **Service worker**: manejadores `push` y `notificationclick`. El manejador `push` **no debe salir a la red**: el payload ya trae título, cuerpo y URL compuestos por el servidor.
- **Reconciliación en el arranque de la app**: comparar `pushManager.getSubscription()` con lo guardado y re-registrar si difiere. `pushsubscriptionchange` **no es fiable** (soporte limitado, Safari no lo implementa) y no se puede delegar en él.
- **Presupuesto de bytes intacto.** `apps/web/scripts/verify-today-bundle.mjs` solo recorre el grafo de importaciones **iniciales** de la ruta `/today` y corta en 120 000 bytes. `/account` es ruta aparte con su propio trozo de JavaScript; el service worker es un bundle distinto. Nada de esto entra en Hoy.

---

## 4. El permiso

### 4.1 Cuándo se pide

**Nunca al entrar.** Ni en el login, ni en el primer Hoy, ni con un banner permanente. Dos razones duras: Chrome mete en «UI silenciosa» a los sitios con ratio de aceptación bajo (pedir mal **quema el canal para siempre**), y en iOS el diálogo es de un solo disparo: si dice que no, `Notification.requestPermission()` devuelve `denied` para siempre y solo se recupera **borrando el icono y reinstalándolo**.

**Doble puerta:**

1. Un interruptor **en reposo** en Tu cuenta. Quien lo quiera, va y lo enciende. Con tres personas, probablemente basta con esto.
2. Un ofrecimiento **contextual, una sola vez por persona y dispositivo**, justo *después* de un momento en que el aviso habría servido: la familia acaba de **cerrar una liquidación**; la empleada acaba de **confirmar un cobro**. Es el único instante en que «te aviso la próxima vez» es una descripción y no una promesa.

**Si dice «Ahora no», no se vuelve a ofrecer jamás.** Queda el interruptor, callado.

### 4.2 Las palabras exactas

**Tarjeta de ofrecimiento (pre-permiso propio, antes del diálogo del sistema):**

> **Avisos en este teléfono**
>
> Podemos avisarte en este teléfono cuando pase algo que te toca: que se cierre una liquidación y puedas confirmar el cobro.
>
> No te avisamos de tareas pendientes, ni de lo que llevas hecho, ni por la noche, ni en tu día de descanso. Nunca.
>
> Puedes apagarlos cuando quieras. Si los dejas apagados, la app funciona igual.
>
> `[ Sí, avísame ]`  `[ Ahora no ]`

**Justo antes del diálogo del sistema** (una línea, en la misma tarjeta):

> Tu teléfono te va a preguntar ahora si permites los avisos de Casa Clara. Dile que sí.

**Al activar:**

> Listo. Te avisaremos en este teléfono. Fuera del horario acordado no suena nada.

**Al pulsar «Ahora no»** (mensaje de estado, sin insistir, y se cumple):

> Perfecto. No volvemos a preguntártelo. Si algún día los quieres, están en **Tu cuenta → Tus avisos**.

### 4.3 Qué pasa si se deniega

**No pasa nada, y eso es un requisito de diseño, no una cortesía.** Si se deniega: no se degrada ninguna función, no hay insignia de «actívalo», no hay asterisco, no hay recordatorio mensual, no hay reintento. **Nada vive solo detrás del push.** La pantalla dentro de la app sigue siendo la fuente de verdad.

**Si el navegador ya los tiene bloqueados** (`denied` — sin botón de reintento, porque técnicamente no lo hay):

> Este teléfono tiene los avisos bloqueados para Casa Clara. Se desbloquean desde los ajustes del teléfono, en la ficha de Casa Clara → Notificaciones. Si prefieres dejarlo así, no hace falta que hagas nada: la app funciona igual.

**Si es iPhone y no está instalada en la pantalla de inicio** (detectar iOS sin `display-mode: standalone` y **no ofrecer un interruptor que no puede funcionar**):

> En iPhone los avisos solo funcionan si abres Casa Clara desde el icono de la pantalla de inicio. Si quieres, añádela: botón Compartir → «Añadir a pantalla de inicio». Y si no, entra como siempre: no te pierdes nada.

### 4.4 Dónde vive el control

**En `/h/[householdId]/account`, renombrada a «Tu cuenta».** Es hoy «Tu acceso · Tu contraseña» y es **la única pantalla que alcanza a los cinco roles**: entra por `capability: 'emergency.read'`, que todos tienen (`packages/contracts/src/index.ts:48-93`). Su cabecera ya dice la frase correcta: *«Solo tú la conoces. Nadie de la casa puede verla.»* Dos secciones: **Tu contraseña** (lo que hay) y **Tus avisos** (lo nuevo).

**No en `/settings`.** «Ajustes del hogar» es de `access.manage`, o sea **solo `family_admin`**, y es donde se revocan accesos. Poner ahí las notificaciones de terceros sería poner el interruptor del teléfono de la empleada en el panel de control del jefe. (Esta es una corrección explícita a la propuesta de la investigación técnica, que ubicaba el interruptor en Ajustes.)

**Presentación: una lista de frases, no una matriz.** Cada línea es el aviso escrito tal como se recibiría:

> - Cuando se cierre una liquidación y pueda confirmar el cobro ▣
>
> *Este teléfono: iPhone de Ana · avisos activos · Apagarlos aquí*

Y debajo, **con el mismo peso tipográfico que el interruptor**, la parte que convierte un ajuste en un compromiso:

> **Lo que nunca te vamos a mandar:** recordatorios de tareas, cuentas de lo que llevas hecho o dejas por hacer, avisos por la noche, en tu día de descanso o en vacaciones. Esto no es una opción que alguien pueda cambiar: la app no sabe hacerlo.

**Si se escribe esa frase, tiene que haber prueba automatizada que la sostenga**, exactamente como se hizo con el AC-26.

---

## 5. Límites y letra pequeña

### 5.1 Horas de silencio: en el servidor, o no existen

**No hay forma de programar un aviso en el dispositivo.** `TimestampTrigger` / `showTrigger` nunca pasó de experimento de Chrome y no existe en Safari. Y **no se puede «tragar» un push en silencio**: la suscripción exige `userVisibleOnly: true`; si el service worker recibe y no muestra nada, el navegador enseña una notificación genérica suya o revoca la suscripción. Silenciar en el cliente **suena igual y encima peor**.

Consecuencia de diseño que conviene decir clara: **las horas de silencio son la razón por la que el envío tiene que pasar por la cola con `run_at`, y no por un `fetch` en caliente dentro del comando.** No son un extra que se añade después.

**Dos niveles:**

- **Nivel 1 — ventana universal, no negociable: 09:00–21:30 `Europe/Madrid`, para los cinco roles, incluidos los admins.** Nada en esta app es tan urgente. Que aplique también al jefe es lo que impide que se lea como una concesión a la empleada: es una propiedad del producto.
- **Nivel 2 — el descanso de cada quien.** Mientras `packages/db/content/manual/convivencia/070-parametros-de-organizacion.md` siga con sus huecos abiertos («Fin de jornada» :14, «Descanso semanal» :18, «Disponibilidad nocturna» :20), el valor por defecto para `employee_live_in` es **09:00–20:00, de lunes a sábado, y silencio total durante `app.vacation_periods`**. Es literalmente lo que manda el manual: «Mientras estos campos estén vacíos, no se delegan decisiones que dependan de ellos» (`010-principios-generales.md:11`).

**Cómo se aplica:** aplazando el `run_at` al inicio de la siguiente ventana permitida y **reevaluando el estado justo antes de enviar** — si el hecho ya no es cierto, no se manda. Ese patrón ya está escrito y probado en la casa (`reminders.ts:96-101`: «cerrada, con pendiente y sin confirmación de cobro; si no, completa sin efectos»). **Cópiese, no se invente otro.** Añádase **caducidad**: un aviso aplazado más de ~12 h se descarta.

A nivel de protocolo (RFC 8030): `TTL` corto, `Topic` para que dos avisos del mismo asunto se sustituyan en vez de acumularse, y `Urgency: low` para todo.

### 5.2 Defecto verificado que hay que arreglar ANTES de conectar nada

Dos puntos del código encolan con `::date::timestamptz`:

```
packages/server/src/commands/rhythm.ts:101    greatest($3::date::timestamptz, statement_timestamp())
packages/server/src/commands/settlement.ts:509  greatest($2::date::timestamptz - interval '3 days', ...)
```

`::date::timestamptz` se resuelve en la zona horaria **de la sesión**. No hay ningún `SET TimeZone` en el código de conexión del repo, y el valor por defecto de Supabase es **UTC**. La app trabaja en `Europe/Madrid` (`today.server.ts:25`, `calendar.server.ts:24`, y `at time zone 'Europe/Madrid'` en las consultas de calendario).

**Resultado: los avisos ya encolados están programados para las 02:00 hora de Madrid** (01:00 en invierno). Si se conecta push a la tubería tal cual, **el primer push que emita este sistema en su vida es un aviso a las dos de la mañana.** No es hipotético: está en la cola, esperando un consumidor.

*(La investigación humana detectó esto en `rhythm.ts`. La revisión para este documento encuentra el mismo patrón en `settlement.ts:509`, es decir, también afecta al **aviso B**, que es uno de los dos recomendados. Marcado como no verificable al 100 % solo en un punto: no se ha podido comprobar el `TimeZone` efectivo del proyecto Supabase real; si estuviera puesto a `Europe/Madrid`, el problema desaparece. Compruébese con `SHOW TimeZone;`.)*

### 5.3 iOS

| Cosa | Estado |
|---|---|
| Soporte | Sí, **16.4+**, **solo** si la web está añadida a la pantalla de inicio y se abre desde el icono. En pestaña de Safari, `PushManager` no existe |
| Chrome / Edge / Firefox en iOS | Igual que Safari: todos usan WebKit. La *instalación* se hace desde Safari |
| ¿La UE? | **Sí.** Apple anunció en febrero de 2024 que retiraba las web apps de pantalla de inicio en la UE y **revirtió la decisión** antes de publicar iOS 17.4. Circula mucha documentación desactualizada que dice lo contrario |
| El fallo es **silencioso** | En Safari-pestaña no hay error: sencillamente no existe la API |
| Sesión | iOS **aísla cookies, localStorage e IndexedDB** entre Safari y la app instalada: son dos almacenes distintos. Hay que **volver a iniciar sesión** dentro del icono. Que el acceso sea por contraseña y no por enlace mágico abarata esto mucho: es teclear y ya |
| **Trampa de la cola offline** | Si alguien ha estado usando la app en Safari con cambios pendientes en IndexedDB, al instalar el icono se encuentra una app vacía y **esos cambios quedan varados en el almacén de Safari**. **Vaciar la cola, con red, antes de instalar** |
| Falta en el repo | `apps/web/static/` solo tiene `icon.svg` y el manifiesto. **iOS no usa SVG para el icono de pantalla de inicio**: instalaría la app con una captura de pantalla como icono. Hace falta un PNG 180×180, `<link rel="apple-touch-icon">` en `app.html` e icono PNG en el manifiesto. *(Hay PNGs utilizables en la raíz del repo —`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`— pertenecientes a la app antigua; probablemente sirvan.)* |

Con tres personas, la cadena «Compartir → Añadir a pantalla de inicio → abrir desde el icono → volver a iniciar sesión → conceder el permiso» **se hace en persona, en una tarde**. En un producto de masas mataría el canal; aquí es un trámite.

### 5.4 Lo que NO puede ir en el texto de un aviso

**La buena noticia primero:** RFC 8291 no es opcional. El cuerpo se cifra con `aes128gcm` mediante un acuerdo ECDH P-256 entre una clave efímera del servidor y la clave pública del dispositivo (`p256dh`), combinado con el secreto `auth`. **Ni Apple, ni Google, ni Mozilla tienen ninguna de esas claves.** Cualquier biblioteca correcta lo hace por defecto.

**Lo que sí ven los terceros son los metadatos**: que existe un mensaje, cuándo, su tamaño aproximado, el endpoint (que identifica ese dispositivo de forma estable) y las cabeceras `TTL`/`Urgency`/`Topic`. Con dos avisos al mes eso es ruido de fondo, pero conviene decirlo: **el patrón temporal no está cifrado.**

**El riesgo real no es Apple. Es la pantalla de bloqueo.** El texto de un aviso se dibuja sin sesión y sin desbloquear el móvil, delante de cualquiera que pase. En un piso donde la administración y la empleada comparten cocina, ese es el canal de fuga, y es asimétrico: ella vive en la casa, y el móvil de la familia está a su vista tanto como el suyo al de ellos.

**Regla dura: el aviso dice de QUÉ tipo es y DÓNDE mirar. Nunca el dato.**

| Nunca | En su lugar |
|---|---|
| «Se te han pagado 1.240,00 €» | «Hay una liquidación cerrada: puedes confirmar el cobro cuando quieras» |
| «Te deben 342,50 €» | «Hay una liquidación pendiente de pago» |
| «Marta ha registrado 3 h extra el sábado» | «Hay un parte semanal esperando revisión» |
| Cualquier nombre propio, importe, hora trabajada, dato de salud, medicación, motivo de una ausencia, contenido del wiki | — |

**Regla de redacción**: el sujeto es el hecho o la casa, nunca «tú» en imperativo. «Hay una liquidación cerrada» sí; «Confirma el cobro» no.

**Y una tercera fuga, menos obvia.** El trigger `job_queue_audit` (`0004_audit_and_jobs.sql:286-288`) copia **el payload de todos los jobs** a `app.audit_events`, que es inmutable y no se poda. Hoy eso ya significa que el título de cada rutina y los correos de todos los destinatarios están archivados a perpetuidad. **No ampliar ese patrón**: el payload debe ser referencial (ids + audiencia) y el texto del aviso se compone en el momento del envío, fuera de la cola.

### 5.5 Qué se rompe con el tiempo

| Qué | Cuándo | Consecuencia |
|---|---|---|
| **Claves VAPID** | No caducan | Pero **rotarlas invalida TODAS las suscripciones a la vez**. Secreto de larga vida: copia offline fuera del panel, y no rotar por higiene. Si se pierde la privada, hay que re-suscribir a las tres personas a mano, con sus tres móviles delante |
| **Reinstalar el icono en iOS** | Cambio de móvil, restauración | Suscripción nueva; la vieja muere. Silencio total sin ningún error |
| **Permiso denegado en iOS** | Un toque equivocado | Hay que **borrar el icono y reinstalarlo** para que iOS vuelva a preguntar. No hay forma de reabrir el diálogo |
| **Endpoint muerto** | Datos del sitio limpiados, app desinstalada | El push service responde **404 o 410 Gone** → marcar `revoked_at`. **429** → respetar `Retry-After`. **413** → payload demasiado grande (el límite práctico son ~3993 octetos de texto plano) |
| **Revocación automática de Chrome** | Sitios con baja interacción y alto volumen | Con dos avisos al mes es improbable; con avisos de rutina diarios sería el perfil exacto que lo dispara. Otra razón para no hacerlos |
| **El JWT de Apple** | Trampa de estreno | El claim `sub` debe ser un `mailto:` o `https:` limpio; Apple devuelve `403 BadJwtToken` con espacios, corchetes angulares o dominios inválidos. **Falla solo en iPhone**, lo que lo hace difícil de diagnosticar |
| **Fallo silencioso** | Siempre | **Es el riesgo de mantenimiento nº 1.** Cuando un dispositivo deja de recibir, nadie se entera. Por eso `last_success_at` en la tabla, y una línea en Tu cuenta: *«Este dispositivo no recibe avisos desde el 3 de marzo»* |

**La consecuencia de diseño, otra vez y en voz alta:** el push **no es un canal de confianza**. Nada con consecuencia laboral —un plazo de disputa, la autoconfirmación de un parte, el vencimiento de un pago— puede depender de que el aviso llegara. Y **Casa Clara no es un sistema de emergencia**: el web push no garantiza entrega ni latencia. El 112 y el teléfono lo son, y el 112 ya está fijo y sin depender de nada en `emergency/+page.svelte`.

---

## 6. La dimensión laboral: lo que queda prohibido por escrito

La doctrina no hay que inventarla: **ya está escrita en esta casa**, y un push es exactamente el caso que contempla.

- `convivencia/030-jornada-descansos-y-ruido.md:10`: «Residir en la casa no equivale a estar trabajando.»
- `030:13`: «Una tarea ordinaria pendiente no justifica invadir un descanso.»
- `030:23`: «Programar aspirado, lavadora, secadora y otras tareas ruidosas fuera de los periodos de descanso confirmados.» — **Un push es ruido. La regla del aspirador es, literalmente, la regla del push.**
- `040-privacidad-reciproca.md:11`: «No abrir correspondencia, documentos, cajones, **dispositivos**, mensajes o recipientes personales.» El teléfono de la interna es un dispositivo personal. La app entra ahí **invitada**, para lo que se la invitó, y sale cuando se le dice.
- `docs/rutinas-y-calendario.md:1148-1153` (AC-26 revisado, 10/08/2026): **hechos con autoría sí, indicadores de cumplimiento no.** La versión-notificación de un indicador de cumplimiento es el recordatorio recurrente de trabajo pendiente.

### 6.1 Lista de lo prohibido

**Prohibido significa que no se construye el emisor**, no que venga apagado por defecto. Un interruptor apagado es una promesa; la ausencia de código es un hecho.

1. **Recordatorios de tareas o rutinas hacia la empleada.** `notification.routine_due` con audiencia `employee` o `all` no genera push a `employee_live_in`. La rutina se ve en Hoy cuando ella abre la app: ese es el diseño y funciona. *(Matiz honesto: ella misma podría querer un recordatorio propio. Se admitiría solo como **alarma que se pone a sí misma** —la crea ella, la apaga ella, invisible para la administración, nadie más puede crearla—. Si no se puede garantizar esa asimetría en la RLS, no se hace.)*
2. **Cualquier recuento de trabajo.** «Te quedan 3», «llevas 2 días sin marcar», rachas, medias, porcentajes. En pantalla es una cuenta; en el bolsillo es una nota.
3. **Avisos disparados por ausencia de acción.** El silencio no es notificable: no envió el parte, no marcó, no abrió la app, no confirmó el cobro. La casa ya resolvió esto bien **y al revés**: `time_report.autoconfirm` (`time-entry.ts:78-88`) confirma sola a los tres días **en vez de** dar la lata. Consérvese.
4. **Repetición y escalada hacia la empleada.** `notification.settlement_due` se reencola cada 3 días mientras siga pendiente y hoy va a admins **y a ella** (`reminders.ts:100-109`). Como correo a la familia es correcto: es su deuda y ellos pueden pagarla. Como push repetido a ella es acoso de bajo nivel sobre algo que no está en su mano. **Regla: el push nunca repite hacia quien no puede resolverlo. Una vez y calla.**
5. **Presencia y actividad.** «X ha entrado», «X marcó a las 23:14», «visto por última vez». Nada.
6. **Avisos sobre el desempeño de una persona, aunque el destinatario sea el jefe.** «Ana no ha completado…». Lo prohibido es que **el mensaje exista**, no quién lo recibe.
7. **El dato sensible en el texto visible** (§5.4).
8. **Producto y relleno.** Novedades, resúmenes semanales, «hace tiempo que no entras». Cero.
9. **Cualquier cosa fuera de la ventana horaria, en día libre o en vacaciones.** Sin excepciones: no se construye una urgencia automática. Si algo es tan urgente, **se le dice**.

### 6.2 Asimetría de poder: no, y no

**¿Puede la administración forzar las notificaciones de otra persona?** No. No existe `notification.manage.others` en `capabilities` y **no se añade**. No es que el navegador no lo permita (que tampoco): es que **el comando no debe existir**.

**¿Puede ver si las tiene activadas?** No. Aquí es donde es tentador ceder, porque parece inofensivo —«solo un iconito gris»—. No lo es. **El estado de notificaciones de una persona es presencia.** Un panel que diga «Ana: avisos activos · visto hace 4 h» es un detector de si está mirando el teléfono en su tiempo libre, en una casa donde ese tiempo libre transcurre en el mismo edificio que el trabajo. Es exactamente lo que prohíbe `040:11` sobre dispositivos personales. **Debe impedirlo la RLS de `app.push_subscriptions` (§3.2), no la interfaz.**

**Simetría explícita**: nadie ve el canal de nadie. La empleada tampoco ve si los admins tienen avisos. Esa regla es más fácil de defender, de explicar y de probar que «nadie ve el de ella».

**El problema real que hay detrás sí existe**: la familia quiere saber «¿se ha enterado?». Eso no se resuelve mirando el canal, se resuelve **con el hecho**: si un aviso necesita acuse, el acuse es una acción en la app —confirmar el cobro— y **eso sí es visible para ambos**, porque es un hecho de la relación laboral y no un dato del teléfono.

Lo único que puede ver la administración, en Ajustes del hogar, es **salud del sistema sin nombres**: «Los avisos están funcionando» / «Última entrega fallida: …». Diagnóstico, no plantilla.

Y hay que aceptar la consecuencia incómoda: **es posible que ella no los active, está en su derecho, y no se puede saber ni preguntar sin que sea presión.** La forma limpia de vivir con eso es no depender del canal para nada operativo. Si el sistema deja de funcionar porque alguien no aceptó notificaciones, el sistema estaba mal diseñado.

### 6.3 Si se escribe, se prueba

La frase «la app no sabe hacerlo» (§4.4) es un compromiso, no una promesa de interfaz. Debe haber prueba automatizada que impida:

- que exista un tipo de aviso hacia `employee_live_in` fuera del enum cerrado de `topic`;
- que `family_admin` pueda leer una fila de `app.push_subscriptions` que no sea suya;
- que se encole cualquier envío con `run_at` fuera de la ventana horaria.

Exactamente el mismo trato que se le dio al AC-26.

---

## 7. Recomendación final

### Veredicto: **hacerlo después**, en tres pasos, y no antes del paso 0

**No es que no merezca la pena. Es que hoy la app no tiene dónde apoyarlo.** No hay worker desplegado ni cron configurado (no existe `vercel.json`), y los dos avisos con más valor económico —el parte semanal y el mes sin cerrar— **no se pueden notificar porque las funciones que notificarían no existen**.

| Paso | Qué | Esfuerzo | Bloquea a |
|---|---|---|---|
| **0. Arreglos que hay que hacer igualmente** | (a) Quitar a la empleada de los destinatarios de `settlement_due` (`reminders.ts:100-109`). (b) Corregir `::date::timestamptz` en `rhythm.ts:101` y `settlement.ts:509` para que no dispare a las 02:00. (c) PNG 180×180 + `apple-touch-icon` + icono en el manifiesto | **0,5 j** | Todo |
| **1. El ejecutor de la cola** | `buildHandlers(pool, config)` extraído de `index.ts:74-110`; ruta `/api/internal/queue/drain` con secreto de cabecera y pool propio; **barrendero de `running` colgados**; bucle acotado a ~50 s; `loadWorkerConfig` sin exigir SMTP/S3. Disparo desde `pg_cron` + `pg_net` | **2 j** | Aviso B, y de paso arregla el ICS, la autoconfirmación de partes y la poda de retención |
| **2. El canal** | Migración 0023 + `push_targets` definer; VAPID; manejadores `push`/`notificationclick` en el SW; interruptor en `/account`; ventana horaria en el encolado; sustituir `sendEmail` por `notify` en `index.ts:82,88` | **2–2,5 j** | — |
| **3. Los dos avisos** | Aviso A desde `payment/record`; aviso B con destinatarios resueltos en el envío | **0,5 j** | — |

**Total: 5–5,5 jornadas.** De ellas, **2,5 (pasos 0 y 1) hay que gastarlas de todos modos**, se hagan o no las notificaciones: el paso 0 son defectos y el paso 1 es la pieza que hoy le falta a la aplicación entera.

**El coste marginal recurrente es 0 €/mes**, siempre que se confirme `pg_cron` + `pg_net` (§3.3).

### Lo que hay que decidir antes de empezar

1. **¿`pg_cron` + `pg_net` están disponibles en el plan actual de Supabase?** Si no lo están: ¿Vercel Pro (20 USD/mes) o el worker actual en Fly.io (~3 USD/mes, cero cambios de código, y de regalo el ICS y ClamAV)? **Esta es la única pregunta que cambia la arquitectura.**
2. **¿La ventana universal es 09:00–21:30 y aplica también a la familia?** Si aplica solo a la empleada, se lee como concesión y se erosionará. Si aplica a todos, es una propiedad del producto.
3. **¿Se le ofrece push a la empleada, o solo a la familia?** Postura defendible: **empezar solo con la familia**, dos semanas. Que la primera persona en probar el canal sea quien tiene poder y no quien no lo tiene es higiene básica: si molesta, molestó al jefe primero. Después, ofrecérselo a ella **en persona, con la lista de lo que nunca se manda por delante**. Y con dos avisos al mes, **«no se lo ofrecemos; si lo pide, se le da» también es defendible**. Lo que no lo es: «se lo activamos porque es útil para la casa».
4. **¿Se acepta que el interruptor viva en `/account` y que ni siquiera `family_admin` pueda ver quién lo tiene encendido?** Es la decisión que hace el canal aceptable en esta casa. Si se cede aquí, el resto del documento no se sostiene.
5. **¿Se van a construir `confirm`/`dispute` del parte semanal?** Es el aviso de mayor valor económico de toda la app y hoy es imposible. Si la respuesta es sí, el orden cambia: primero el comando, después el push.

### Discrepancias entre las tres investigaciones, arbitradas

| Discrepancia | Resolución | Verificación |
|---|---|---|
| Push de «respuesta a solicitud de vacaciones» | **Fuera.** No existe flujo de solicitud ni aprobación | `vacation.ts:256-260`, comentario explícito; `leave.request.self` es capability sin comando |
| Push de «tu parte de la semana está confirmado» | **Fuera por ahora.** No existe `confirm`/`dispute` | `schemas.ts:94` (única acción `submit_week`); `canConfirmWork` en la página de Empleo alimenta `ExtraWorkPendingCard`, no el parte |
| Suscripción por `user_id` vs `membership_id` | **`user_id`** para la suscripción (el dispositivo es de la persona); **`membership_id`** para las preferencias por tópico (dependen del rol) | `app.user_profiles.user_id` es `text PK`; `household_memberships` tiene `UNIQUE (household_id, id)` que permite la FK compuesta |
| Guardar el endpoint hasheado | **No.** El endpoint es la URL de destino, hay que poder recuperarlo. La analogía con el token ICS no aplica | — |
| Interruptor en `/settings` vs `/account` | **`/account`.** `/settings` es `access.manage` = solo `family_admin` | `packages/contracts/src/index.ts:48-93`: `emergency.read` es la única capability de los cinco roles |
| Resumen diario a la familia | **Fase 2.** Necesita toda la maquinaria de reloj y su valor es difuso | — |
| «El push nunca repite» vs «la escalada de B cada 3 días» | Compatibles: la escalada se conserva **hacia `family_admin`**, que puede resolverlo; se elimina hacia la empleada, que no | `reminders.ts:100-120` |
| ¿Hace falta cron para todo? | **No para el aviso A**, que sale del comando `payment/record`. Sí para B | `payment.ts` calcula ya `pending_cents` antes de insertar |

### Lo que no se pudo verificar

- **Disponibilidad de `pg_cron` y `pg_net` en el plan gratuito de Supabase**: sin acceso al panel del proyecto. `docs/despliegue/plan-vercel-supabase.md:352-364` da `pg_cron` por disponible pero no distingue plan.
- **`TimeZone` efectivo del proyecto Supabase real**: el análisis de §5.2 asume el valor por defecto (`UTC`), porque no hay ningún `SET TimeZone` en el código. Compruébese con `SHOW TimeZone;` antes de dar el defecto por cierto.
- **Comportamiento real de Web Push en los tres dispositivos concretos de esta casa**: no se han probado. Los datos de soporte por plataforma proceden de las investigaciones previas, no de una prueba en este entorno.

---

## Fuentes

**Del repositorio (verificadas para este documento):** `apps/web/src/service-worker.ts` · `apps/web/src/app.html` · `apps/web/static/manifest.webmanifest` · `apps/web/scripts/verify-today-bundle.mjs` · `apps/web/src/lib/server/today.server.ts:25,291-306` · `apps/web/src/routes/h/[householdId]/account/+page.svelte` · `apps/web/src/lib/components/employment/WeeklyReportCard.svelte` · `apps/worker/src/queue.ts:33-114` · `apps/worker/src/config.ts:40-58` · `apps/worker/src/reminders.ts:96-120` · `packages/contracts/src/index.ts:16-93` · `packages/contracts/src/schemas.ts:94` · `packages/server/src/commands/payment.ts` · `packages/server/src/commands/rhythm.ts:23-31,92-113` · `packages/server/src/commands/settlement.ts:500-513` · `packages/server/src/commands/time-entry.ts:78-88` · `packages/server/src/commands/vacation.ts:256-260` · `packages/db/migrations/0001_identity_and_context.sql:3-20,42-65,71-109` · `packages/db/migrations/0004_audit_and_jobs.sql:202-288` · `packages/db/migrations/0005_rls.sql:50-70,380-388` · `packages/db/content/manual/convivencia/010-principios-generales.md:11`, `030-jornada-descansos-y-ruido.md:10,13,23`, `040-privacidad-reciproca.md:11`, `070-parametros-de-organizacion.md:14,18,20,24` · `docs/rutinas-y-calendario.md:322,917-918,1140-1153` · `docs/despliegue/plan-vercel-supabase.md:300-364`

**Web:** [Apple — DMA and apps in the EU](https://developer.apple.com/support/dma-and-apps-in-the-eu) · [WebKit — Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) · [WebKit — Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/) · [RFC 8291 — Message Encryption for Web Push](https://www.rfc-editor.org/rfc/rfc8291) · [RFC 8030 — Generic Event Delivery Using HTTP Push](https://www.rfc-editor.org/rfc/rfc8030) · [caniuse — Push API](https://caniuse.com/push-api) · [Vercel — Cron Jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Supabase — pg_cron](https://supabase.com/docs/guides/database/extensions/pg_cron) · [Supabase — pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) · [w3c/push-api #313 — userVisibleOnly](https://github.com/w3c/push-api/issues/313) · [Chrome for Developers — Notification permission data in CrUX](https://developer.chrome.com/blog/notification-permission-data-in-crux) · [Chrome for Developers — Notification Triggers API](https://developer.chrome.com/docs/web-platform/notification-triggers) · [BleepingComputer — Chrome revoca notificaciones de sitios inactivos](https://www.bleepingcomputer.com/news/google/google-chrome-to-revoke-notification-access-for-inactive-sites/) · [web-push-php #406 — BadJwtToken de Apple](https://github.com/web-push-libs/web-push-php/issues/406) · [Netguru — almacenamiento aislado PWA/Safari en iOS](https://www.netguru.com/blog/how-to-share-session-cookie-or-state-between-pwa-in-standalone-mode-and-safari-on-ios)
