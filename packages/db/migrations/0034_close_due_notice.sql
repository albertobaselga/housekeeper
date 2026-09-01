BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- El tercer aviso: «el mes está por cerrar».
--
-- Los dos avisos de la 0032 hablan de una liquidación concreta —el recibo que
-- ya existe, la cuenta que sigue sin pagar—. Este es distinto: no hay ninguna
-- liquidación todavía. Es un recordatorio de que TOCA abrir y cerrar la del mes
-- que se acaba, dirigido a quien administra, una vez al mes, el penúltimo día.
--
-- Dos piezas, mismo patrón que la 0032:
--
--   1. `app_private.close_due_households(reference date)` — qué hogares tienen
--      algo por cerrar: al menos un acuerdo activo sin liquidación CERRADA del
--      mes natural de `reference`. Reevaluable en cualquier instante: es una
--      SELECT pura, sin estado propio.
--   2. `app_private.push_close_due_targets(notice_household uuid)` — a quién,
--      con las mismas reglas de audiencia y silencio que `push_notice_targets`
--      (0032): `family_admin` con membresía viva, nadie con vacaciones
--      `recorded` cubriendo hoy, y el hecho reevaluado en el instante del envío
--      (si el hogar ya no tiene nada por cerrar, cero filas).
--
-- El payload de este aviso no lleva `settlementId` —no hay liquidación de la
-- que colgar el hecho, es del HOGAR y del MES— así que la reevaluación no
-- puede apoyarse en `app.settlements`/`app.settlement_payment_totals` como
-- hacía `push_notice_targets`: aquí reevaluar ES volver a preguntarle a
-- `close_due_households`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Qué hogares tienen algo por cerrar ───────────────────────────────────
--
-- «Algo por cerrar» = al menos un acuerdo de empleo ACTIVO sin que exista ya
-- una liquidación CERRADA cuyo periodo sea exactamente el mes natural de
-- `reference` (primer día a último día). Una liquidación abierta, o ninguna en
-- absoluto, cuenta como «por cerrar»; solo una cerrada con ese periodo exacto
-- lo descarta — es el mismo criterio de mes natural que exige el cierre real
-- (`closeSettlement`, `packages/server/src/commands/settlement.ts`), así que
-- una liquidación con un periodo parcial no calla este aviso por error.
CREATE FUNCTION app_private.close_due_households(reference date)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT DISTINCT agreement.household_id
    FROM app.employment_agreements AS agreement
   WHERE agreement.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM app.settlements AS settlement
        WHERE settlement.household_id = agreement.household_id
          AND settlement.agreement_id = agreement.id
          AND settlement.status = 'closed'
          AND settlement.period_start = date_trunc('month', reference)::date
          AND settlement.period_end
                = (date_trunc('month', reference) + interval '1 month' - interval '1 day')::date
     )
$$;

COMMENT ON FUNCTION app_private.close_due_households(date) IS
  'Hogares con algún acuerdo activo sin liquidación CERRADA del mes natural de '
  '`reference`. Reevaluable: es una SELECT pura sobre el estado actual, la '
  'llama tanto el barrido periódico como push_close_due_targets al enviar.';

REVOKE ALL ON FUNCTION app_private.close_due_households(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.close_due_households(date) TO casa_clara_worker;


-- ── 2. A quién avisar, resuelto en el instante del envío ────────────────────
--
-- Mismas tres garantías que `push_notice_targets` (0032, ver su cabecera): el
-- hecho se reevalúa, la audiencia sale de membresías VIVAS en el momento de
-- enviar (retirar el acceso apaga el aviso en el acto) y nadie con vacaciones
-- apuntadas recibe nada. La audiencia es SIEMPRE `family_admin`: este aviso no
-- tiene destinatario individual —no hay empleada de la que hablar todavía—.
CREATE FUNCTION app_private.push_close_due_targets(notice_household uuid)
RETURNS TABLE (
  subscription_id uuid,
  endpoint text,
  p256dh text,
  auth text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  -- Reevaluación del hecho: si para HOY ya no queda nada por cerrar en este
  -- hogar (se cerró todo, o ya no hay ningún acuerdo activo), cero filas y el
  -- trabajo se completa sin mandar nada.
  IF NOT EXISTS (
    SELECT 1
      FROM app_private.close_due_households((now() AT TIME ZONE 'Europe/Madrid')::date) AS due
     WHERE due = notice_household
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT device.id, device.endpoint, device.p256dh, device.auth
    FROM app.household_memberships AS membership
    JOIN app.push_subscriptions AS device
      ON device.user_id = membership.user_id
     AND device.revoked_at IS NULL
   WHERE membership.household_id = notice_household
     AND membership.role = 'family_admin'
     AND membership.starts_at <= now()
     AND membership.revoked_at IS NULL
     AND (membership.expires_at IS NULL OR membership.expires_at > now())
     -- Vacaciones apuntadas: silencio, igual que en push_notice_targets. En la
     -- práctica esto rara vez alcanza a quien administra —las vacaciones se
     -- registran sobre la membresía de la empleada— pero la regla es la misma
     -- para los cinco papeles y no se hace una excepción aquí tampoco.
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

COMMENT ON FUNCTION app_private.push_close_due_targets(uuid) IS
  'A quién avisar de que el mes está por cerrar: family_admin con membresía '
  'viva, sin vacaciones apuntadas hoy, y solo si close_due_households sigue '
  'incluyendo el hogar en el instante del envío. Ver docs/notificaciones.md.';

REVOKE ALL ON FUNCTION app_private.push_close_due_targets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.push_close_due_targets(uuid) TO casa_clara_worker;


-- ── 3. Como mucho un aviso de cierre pendiente por hogar ─────────────────────
--
-- El barrido (`notification.close_due_sweep`, apps/worker/src/close-due.ts)
-- encola un `notification.push {topic:'settlement.close_due'}` por cada hogar
-- de `close_due_households`. Si ese trabajo se reintentara a medias —falló al
-- encolar el cuarto hogar de cinco y el intento siguiente vuelve a recorrer la
-- lista entera— los tres primeros recibirían un segundo aviso del mismo
-- cierre. Este índice único parcial es quien de verdad lo impide, no la
-- aplicación: mientras un hogar tenga un `notification.push` de este tópico
-- `queued` o `running`, un segundo INSERT choca aquí (23505) y
-- `close-due.ts` lo trata como éxito silencioso — el primero ya está en
-- camino, que es justamente lo que se quería.
CREATE UNIQUE INDEX close_due_push_pending_idx
  ON app_private.job_queue (household_id)
  WHERE job_type = 'notification.push'
    AND (payload->>'topic') = 'settlement.close_due'
    AND status IN ('queued', 'running');

COMMENT ON INDEX app_private.close_due_push_pending_idx IS
  'Como mucho un aviso de cierre de mes pendiente por hogar: un segundo intento '
  'de encolarlo mientras el primero sigue vivo choca aquí, y close-due.ts lo '
  'trata como éxito (el primero ya está en camino). Ver su cabecera.';

COMMIT;
