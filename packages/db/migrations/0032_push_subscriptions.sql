BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Avisos en el móvil (Web Push): el dispositivo de cada persona y nada más.
--
-- Esta migración no crea «notificaciones». Crea las TRES piezas sin las cuales
-- un aviso al móvil no se puede escribir de forma defendible en una casa donde
-- conviven quien administra y quien trabaja:
--
--   1. `app.push_subscriptions` — a qué dispositivos se puede escribir, con una
--      RLS que hace de la revocación algo instantáneo y de la lista de
--      dispositivos de una persona algo que nadie más ve.
--   2. `app.push_run_at()` — la ventana de silencio, aplicada EN EL ENCOLADO.
--      No es un adorno: en Web Push no se puede programar en el dispositivo
--      (`TimestampTrigger` no existe fuera de un experimento de Chrome) ni se
--      puede recibir un aviso y no mostrarlo (`userVisibleOnly` es obligatorio).
--      Si la hora no la decide el servidor, no la decide nadie.
--   3. `app_private.push_notice_targets()` — quién recibe, resuelto EN EL
--      INSTANTE DEL ENVÍO y no en el del encolado, más la reevaluación del
--      hecho que justificaba el aviso.
--
-- El razonamiento completo, con las alternativas descartadas, está en
-- `docs/notificaciones.md`. Lo que sigue son las decisiones que quedan
-- congeladas en el esquema, cada una con la razón por la que no se toca.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Los dispositivos ─────────────────────────────────────────────────────
--
-- **La suscripción cuelga de `user_id`, no de una membresía.** El dispositivo es
-- de la persona, no del hogar: quien tuviera membresía en dos hogares no debe
-- suscribir el mismo teléfono dos veces ni recibir dos avisos del mismo móvil.
-- El hogar entra en la decisión de A QUIÉN ENVIAR (§3, por membresía viva), no
-- en la de QUIÉN ES DUEÑO DEL APARATO.
--
-- **El endpoint se guarda ENTERO, no hasheado.** Se propuso hashearlo por
-- analogía con el token del feed ICS y no vale: aquel es un secreto que el
-- servidor solo necesita *verificar*, mientras que este es la URL a la que hay
-- que hacer POST. `UNIQUE` sobre él porque es el identificador natural que
-- devuelve el navegador: volver a suscribir el mismo dispositivo produce el
-- mismo endpoint y tiene que actualizar la fila, no duplicarla.
--
-- **No hay columna de «tópicos» ni tabla de preferencias.** Se consideró
-- (`docs/notificaciones.md` §3.2 la proponía por membresía) y sobra: hay
-- exactamente dos avisos y cada uno va a un papel distinto —el recibo, a la
-- persona del contrato; la cuenta por pagar, a quien administra—, así que el
-- papel ya decide el tópico y una matriz de dos casillas disjuntas solo añade
-- un sitio más donde desincronizarse. La suscripción ES el consentimiento:
-- encenderlo suscribe, apagarlo borra la fila. Si algún día hubiera dos avisos
-- para el mismo papel, la tabla de preferencias se añade entonces y con su
-- discusión propia.
CREATE TABLE app.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES app.user_profiles(user_id) ON DELETE RESTRICT,
  -- `https` y un tope de longitud en la propia tabla. La comprobación seria
  -- —que el host resuelva a direcciones públicas— la hace la aplicación al
  -- suscribir, con el mismo veto anti-SSRF que usan las fuentes ICS; esto es el
  -- suelo que queda aunque alguien escriba por otro camino.
  endpoint text NOT NULL UNIQUE
    CHECK (endpoint ~ '^https://' AND length(endpoint) BETWEEN 12 AND 2048),
  -- Claves de cifrado del dispositivo (RFC 8291). El cuerpo de cada aviso se
  -- cifra contra ellas: ni Apple, ni Google, ni Mozilla pueden leerlo.
  p256dh text NOT NULL CHECK (length(btrim(p256dh)) BETWEEN 1 AND 255),
  auth text NOT NULL CHECK (length(btrim(auth)) BETWEEN 1 AND 255),
  -- Lo escribe la persona para distinguir sus aparatos («el del bolsillo»).
  -- Opcional a propósito: nadie está obligado a etiquetar sus dispositivos.
  device_label text CHECK (device_label IS NULL OR length(btrim(device_label)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- Las tres marcas de entrega existen por UN motivo: el fallo silencioso es el
  -- riesgo de mantenimiento número uno de este canal. Cuando un dispositivo deja
  -- de recibir no hay error en ninguna parte, y sin estas columnas nadie se
  -- enteraría nunca. Con ellas, «Tu cuenta» puede decir la única frase útil:
  -- «este dispositivo no recibe avisos desde el 3 de marzo».
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  -- El navegador limpió los datos del sitio, se desinstaló la app o iOS rehizo
  -- el icono: el servicio de push responde 404/410 y la fila muere aquí. No se
  -- borra: la fecha es lo que permite explicar el silencio.
  revoked_at timestamptz,
  CHECK (last_seen_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

COMMENT ON TABLE app.push_subscriptions IS
  'Dispositivos a los que una persona ha pedido que se le avise. Uno por '
  'navegador y aparato. Nadie más que su dueño ve estas filas, tampoco quien '
  'administra el hogar: la lista de dispositivos de alguien es un censo de sus '
  'aparatos, y p256dh/auth son claves de cifrado que nadie debería poder '
  'cosechar con una consulta ordinaria. Ver docs/notificaciones.md §6.2.';

COMMENT ON COLUMN app.push_subscriptions.endpoint IS
  'URL del servicio de push a la que se hace POST. Identificador natural y '
  'único global: re-suscribir el mismo aparato devuelve el mismo endpoint.';

COMMENT ON COLUMN app.push_subscriptions.revoked_at IS
  'Cuándo murió el endpoint (404/410 del servicio de push, o la persona apagó '
  'los avisos). La fila se conserva para poder explicar el silencio.';

CREATE INDEX push_subscriptions_user_live_idx
  ON app.push_subscriptions (user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE app.push_subscriptions ENABLE ROW LEVEL SECURITY;
-- El FORCE va al FINAL de esta migración, no aquí. Ver el porqué junto a la
-- propia línea, después de crear `app_private.push_delivery_recorded`.

-- **Esta política rompe a propósito el patrón de `user_profiles_admin_read`**
-- (0005), donde quien administra sí ve los perfiles de su hogar. Aquí no debe, y
-- la razón no es técnica:
--
--   · La lista de endpoints de una persona es un censo de sus dispositivos, con
--     marcas de cuándo aparecen y desaparecen. En una casa donde el tiempo libre
--     de quien trabaja transcurre en el mismo edificio que el trabajo, saber si
--     tiene los avisos encendidos y cuándo se vio su móvil por última vez es un
--     detector de presencia. `convivencia/040-privacidad-reciproca.md:11` ya lo
--     prohíbe: «no abrir … dispositivos … personales».
--   · La simetría es explícita y deliberada: la empleada tampoco ve el canal de
--     quien administra. «Nadie ve el de nadie» es más fácil de defender, de
--     explicar y de probar que «nadie ve el de ella».
--
-- Sin `tenant_context_matches`: la tabla no tiene hogar, y la persona gestiona
-- sus dispositivos desde «Tu cuenta», que se alcanza con cualquier membresía.
-- Mismo patrón que `user_profiles_self_read` (0005).
CREATE POLICY push_subscriptions_own ON app.push_subscriptions
  FOR ALL
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- La persona da de alta, renombra y borra sus propios dispositivos; la RLS de
-- arriba es lo único que hace falta para que eso sea suyo y de nadie más.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.push_subscriptions TO casa_clara_app;

-- SIN GRANT para `casa_clara_worker`, a propósito: el emisor no lee esta tabla,
-- llama a `app_private.push_notice_targets` (§3), que es la única superficie por
-- la que salen `p256dh` y `auth` y que ya lleva dentro todos los filtros.

-- SIN TRIGGER DE AUDITORÍA, también a propósito. La lista de
-- `0004_audit_and_jobs.sql:264-284` es explícita y esta tabla no entra: el
-- trigger copia `NEW` entero a `app.audit_events`, que es append-only, inmutable
-- y no se poda. Auditar esta tabla sería volcar las claves de cifrado de los
-- teléfonos de la casa allí para siempre. `packages/db/tests/170_*.sql` lo pina.


-- ── 2. La ventana de silencio ───────────────────────────────────────────────
--
-- **09:00–21:30, de lunes a sábado, hora de Madrid, para los cinco papeles.**
--
-- Que aplique también a quien administra no es simetría decorativa: es lo único
-- que impide que se lea como una concesión a la empleada y que, por tanto, se
-- erosione en la primera urgencia. Una regla que protege solo a la parte débil
-- la levanta la parte fuerte el día que le estorba; una propiedad del producto,
-- no. Y no hay nada en esta aplicación tan urgente como para justificar la
-- excepción: no es un sistema de emergencia —el 112 lo es, y está fijo y sin
-- depender de nada en `emergency/+page.svelte`—.
--
-- **El domingo entero, en silencio, para todo el mundo.** Es la misma decisión y
-- por la misma razón. Nótese lo que este defecto NO afirma: no dice que el
-- domingo sea el descanso semanal de nadie. Eso lo diría el manual, y
-- `convivencia/070-parametros-de-organizacion.md` sigue con ese hueco vacío;
-- mientras lo esté, «no se delegan decisiones que dependan de él»
-- (`010-principios-generales.md:11`). Lo que se afirma es más pequeño y
-- enteramente nuestro: **este canal no escribe los domingos.** Un aviso que cae
-- en domingo se aplaza al lunes a las 09:00 y el hecho, mientras tanto, sigue
-- estando en la pantalla, que es donde se atiende.
--
-- La ventana es la razón por la que el envío pasa por la cola con `run_at` y no
-- por una llamada en caliente dentro del comando. No es un extra posterior.
CREATE FUNCTION app.push_run_at(desired timestamptz DEFAULT statement_timestamp())
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  wall timestamp := desired AT TIME ZONE 'Europe/Madrid';
  day date := wall::date;
  at_time time;
BEGIN
  IF wall::time < time '09:00' THEN
    at_time := time '09:00';
  ELSIF wall::time <= time '21:30' THEN
    -- Dentro de la ventana: sale cuando toca, sin retocar la hora.
    at_time := wall::time;
  ELSE
    day := day + 1;
    at_time := time '09:00';
  END IF;

  IF extract(isodow FROM day) = 7 THEN
    day := day + 1;
    at_time := time '09:00';
  END IF;

  RETURN (day + at_time) AT TIME ZONE 'Europe/Madrid';
END
$$;

COMMENT ON FUNCTION app.push_run_at(timestamptz) IS
  'Primer instante permitido para un aviso al móvil a partir del deseado: '
  'ventana 09:00-21:30 hora de Madrid, de lunes a sábado, igual para los cinco '
  'papeles. Ver docs/notificaciones.md §5.1.';

-- STABLE y no IMMUTABLE por lo mismo que `app.job_run_at` (0027): la conversión
-- de zona depende de la base de husos horarios, que se actualiza con el sistema.
REVOKE ALL ON FUNCTION app.push_run_at(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.push_run_at(timestamptz) TO casa_clara_app, casa_clara_worker;


-- ── 3. Los destinatarios, resueltos en el instante del envío ────────────────
--
-- Una sola función definer para los dos avisos, y hace tres cosas que NO pueden
-- separarse sin que alguna se olvide:
--
--   a) **Reevalúa el hecho.** Si la liquidación se anuló, si ella ya confirmó el
--      cobro, si la cuenta ya se pagó: cero filas, y el trabajo se completa sin
--      mandar nada. Es el patrón que esta casa ya tenía escrito y probado en los
--      recordatorios retirados («cerrada, con pendiente y sin confirmación de
--      cobro; si no, completa sin efectos»). Se copia, no se inventa otro.
--
--   b) **Resuelve la audiencia AHORA.** El defecto que se arregla de paso es
--      real y estaba en la casa: el encolado de avisos de rutina materializaba
--      la lista de destinatarios DENTRO del payload del trabajo, y ese trabajo
--      podía ejecutarse semanas después, escribiendo a alguien a quien se le
--      había retirado el acceso hacía dos. Aquí el payload lleva ids y nada más:
--      la audiencia sale de las membresías VIVAS en el momento de enviar, así
--      que **retirar el acceso apaga los avisos en el acto y no puede
--      perderse** — no hay ninguna copia de la lista en ninguna parte.
--
--   c) **Aplica lo que está prohibido**, en la única capa donde no depende de
--      que un programador se acuerde:
--        · `settlement.due` va a `family_admin` y a nadie más. La empleada no
--          entra en esta consulta por construcción. Como correo pasaba
--          desapercibido; como aviso repetido cada tres días sería recordarle
--          que sus jefes no le han pagado, sobre algo que no está en su mano.
--        · Nadie recibe nada mientras tenga vacaciones apuntadas.
--
-- Devuelve el mes, el vencimiento y el acuerdo porque el texto y el enlace se
-- componen en el envío y fuera de la cola. Lo que NO devuelve, ni por asomo, es
-- un importe o un nombre: eso se dibuja en la pantalla de bloqueo, sin sesión y
-- sin desbloquear el teléfono, delante de quien pase. Y lo que va en el payload
-- de un trabajo acaba copiado a `app.audit_events`, que es inmutable y no se
-- poda. El acuerdo es lo que permite que el enlace caiga en la persona correcta
-- cuando en la casa trabaja más de una.
CREATE FUNCTION app_private.push_notice_targets(
  notice_household uuid,
  notice_settlement uuid,
  notice_topic text
)
RETURNS TABLE (
  subscription_id uuid,
  endpoint text,
  p256dh text,
  auth text,
  agreement_id uuid,
  period_start date,
  due_on date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  -- El catálogo de avisos es cerrado y corto a propósito. Añadir uno cuesta una
  -- migración y una discusión, que es exactamente lo que debe costar.
  IF notice_topic NOT IN ('settlement.receipt_ready', 'settlement.due') THEN
    RAISE EXCEPTION 'aviso desconocido: %', notice_topic USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT device.id,
         device.endpoint,
         device.p256dh,
         device.auth,
         settlement.agreement_id,
         settlement.period_start,
         settlement.due_on
    FROM app.settlements AS settlement
    JOIN app.settlement_payment_totals AS totals
      ON totals.household_id = settlement.household_id
     AND totals.settlement_id = settlement.id
    JOIN app.household_memberships AS membership
      ON membership.household_id = settlement.household_id
     AND membership.starts_at <= now()
     AND membership.revoked_at IS NULL
     AND (membership.expires_at IS NULL OR membership.expires_at > now())
     AND CASE notice_topic
           -- El recibo es de quien lo cobra: la persona del contrato y nadie
           -- más. A quien administra no se le notifica lo que acaba de escribir.
           WHEN 'settlement.receipt_ready' THEN membership.id = settlement.employee_membership_id
           -- La cuenta por pagar, solo a quien puede pagarla.
           WHEN 'settlement.due' THEN membership.role = 'family_admin'
         END
    JOIN app.push_subscriptions AS device
      ON device.user_id = membership.user_id
     AND device.revoked_at IS NULL
   WHERE settlement.household_id = notice_household
     AND settlement.id = notice_settlement
     AND settlement.status = 'closed'
     AND CASE notice_topic
           WHEN 'settlement.receipt_ready' THEN NOT EXISTS (
             SELECT 1
               FROM app.settlement_receipt_confirmations AS confirmation
              WHERE confirmation.household_id = settlement.household_id
                AND confirmation.settlement_id = settlement.id
           )
           WHEN 'settlement.due' THEN totals.pending_cents > 0
         END
     -- Vacaciones apuntadas: silencio. `docs/notificaciones.md` §6.1.9 no admite
     -- excepciones y aquí no hay ninguna que hacer — el hecho sigue en pantalla.
     AND NOT EXISTS (
       SELECT 1
         FROM app.vacation_periods AS vacation
        WHERE vacation.household_id = membership.household_id
          AND vacation.employee_membership_id = membership.id
          AND vacation.status = 'recorded'
          AND (now() AT TIME ZONE 'Europe/Madrid')::date
                BETWEEN vacation.starts_on AND vacation.ends_on
     );
END
$$;

REVOKE ALL ON FUNCTION app_private.push_notice_targets(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.push_notice_targets(uuid, uuid, text) TO casa_clara_worker;


-- ── 4. El resultado de cada entrega ─────────────────────────────────────────
--
-- Lo escribe el emisor, que no tiene —ni debe tener— UPDATE sobre la tabla.
-- `gone` es 404/410 del servicio de push: ese endpoint no volverá a existir
-- jamás (datos del sitio limpiados, app desinstalada, icono de iOS rehecho) y
-- seguir intentándolo es ruido en el log para siempre. Cualquier otro fallo
-- —429, 500, un timeout— solo cuenta: puede ser del día.
CREATE FUNCTION app_private.push_delivery_recorded(
  subscription uuid,
  delivered boolean,
  gone boolean DEFAULT false
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  UPDATE app.push_subscriptions
     SET last_success_at = CASE WHEN delivered THEN statement_timestamp() ELSE last_success_at END,
         last_failure_at = CASE WHEN delivered THEN last_failure_at ELSE statement_timestamp() END,
         failure_count = CASE WHEN delivered THEN 0 ELSE failure_count + 1 END,
         revoked_at = CASE WHEN gone THEN coalesce(revoked_at, statement_timestamp()) ELSE revoked_at END
   WHERE id = subscription
$$;

REVOKE ALL ON FUNCTION app_private.push_delivery_recorded(uuid, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.push_delivery_recorded(uuid, boolean, boolean) TO casa_clara_worker;

-- El FORCE, aquí y no arriba, y esta es la razón exacta:
--
-- Con un propietario de esquema NOSUPERUSER + NOBYPASSRLS —Supabase, y lo que
-- reproduce `probe-supabase.mjs`—, FORCE somete al propio dueño a las
-- políticas de la tabla. El validador de funciones (`check_function_bodies`)
-- planifica el cuerpo de una función SQL al CREARLA aplicando su `proconfig`,
-- `SET row_security = off` incluido; al llegar a `app.push_subscriptions` el
-- planificador aborta con 42501. Es decir: la migración moría en el CREATE
-- FUNCTION de arriba, no al ejecutarla nunca nadie.
--
-- La compatibilidad que ya existe no alcanza: `0018_rls_force_compat.sql`
-- relaja el FORCE cuando el dueño no puede puentear RLS, pero el runner la
-- ejecuta ENTRE ficheros (migrate.mjs), y aquí el FORCE y la función viven en
-- la MISMA transacción. Poniendo el FORCE al final, la función se crea con la
-- tabla aún sin forzar y el estado final es idéntico por los dos caminos.
--
-- Consecuencia de no hacerlo: la transacción hacía ROLLBACK, el runner abortaba
-- y una instalación desde cero en Supabase se quedaba en la 0031, sin avisos.
ALTER TABLE app.push_subscriptions FORCE ROW LEVEL SECURITY;

COMMIT;
