BEGIN;

-- Correo de contacto del perfil de aplicación. Lo rellenan las semillas o el
-- alta de membresías; los avisos del worker lo leen mediante una función de
-- alcance mínimo, nunca consultando tablas de dominio directamente.
ALTER TABLE app.user_profiles
  ADD COLUMN email text CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- Confirmación automática de la semana tras tres días de silencio de la
-- familia (regla del brief). Un parte auto-confirmado no tiene actor humano,
-- así que el estado `confirmed` pasa a admitir confirmed_by nulo solo cuando
-- auto_confirmed es verdadero.
ALTER TABLE app.weekly_time_reports
  ADD COLUMN auto_confirmed boolean NOT NULL DEFAULT false;

DO $replace_status_check$
DECLARE
  status_constraint text;
BEGIN
  SELECT conname INTO status_constraint
    FROM pg_catalog.pg_constraint
   WHERE conrelid = 'app.weekly_time_reports'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%confirmed_by_membership_id%';
  IF status_constraint IS NULL THEN
    RAISE EXCEPTION 'no se encontró la restricción de estados de weekly_time_reports';
  END IF;
  EXECUTE format('ALTER TABLE app.weekly_time_reports DROP CONSTRAINT %I', status_constraint);
END
$replace_status_check$;

ALTER TABLE app.weekly_time_reports
  ADD CONSTRAINT weekly_reports_status_state CHECK (
    (status = 'draft' AND submitted_at IS NULL AND confirmed_at IS NULL AND dispute_reason IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL AND submitted_by_membership_id IS NOT NULL
        AND confirmed_at IS NULL AND confirmed_by_membership_id IS NULL AND dispute_reason IS NULL)
    OR (status = 'confirmed' AND submitted_at IS NOT NULL AND submitted_by_membership_id IS NOT NULL
        AND confirmed_at IS NOT NULL
        AND (confirmed_by_membership_id IS NOT NULL OR auto_confirmed)
        AND dispute_reason IS NULL)
    OR (status = 'disputed' AND submitted_at IS NOT NULL AND submitted_by_membership_id IS NOT NULL
        AND confirmed_at IS NULL AND confirmed_by_membership_id IS NULL
        AND dispute_reason IS NOT NULL AND length(btrim(dispute_reason)) > 0)
  );

-- Estado mínimo de recordatorio de una liquidación para el worker: fechas,
-- pendiente y destinatarios. SECURITY DEFINER con row_security off porque el
-- worker no tiene (ni debe tener) lectura de tablas de dominio; la superficie
-- expuesta se limita a lo imprescindible para el aviso.
CREATE FUNCTION app_private.settlement_reminder_state(
  target_household uuid,
  target_settlement uuid
)
RETURNS TABLE (
  due_on date,
  period_start date,
  period_end date,
  status text,
  pending_cents bigint,
  receipt_confirmed boolean,
  employee_email text,
  admin_emails text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT settlement.due_on,
         settlement.period_start,
         settlement.period_end,
         settlement.status::text,
         totals.pending_cents,
         EXISTS (
           SELECT 1 FROM app.settlement_receipt_confirmations AS confirmation
            WHERE confirmation.household_id = settlement.household_id
              AND confirmation.settlement_id = settlement.id
         ) AS receipt_confirmed,
         (SELECT profile.email
            FROM app.household_memberships AS membership
            JOIN app.user_profiles AS profile ON profile.user_id = membership.user_id
           WHERE membership.household_id = settlement.household_id
             AND membership.id = settlement.employee_membership_id) AS employee_email,
         ARRAY(
           SELECT profile.email
             FROM app.household_memberships AS membership
             JOIN app.user_profiles AS profile ON profile.user_id = membership.user_id
            WHERE membership.household_id = settlement.household_id
              AND membership.role = 'family_admin'
              AND membership.revoked_at IS NULL
              AND (membership.expires_at IS NULL OR membership.expires_at > statement_timestamp())
              AND profile.email IS NOT NULL
         ) AS admin_emails
    FROM app.settlements AS settlement
    JOIN app.settlement_payment_totals AS totals
      ON totals.household_id = settlement.household_id AND totals.settlement_id = settlement.id
   WHERE settlement.household_id = target_household
     AND settlement.id = target_settlement
$$;

REVOKE ALL ON FUNCTION app_private.settlement_reminder_state(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.settlement_reminder_state(uuid, uuid) TO casa_clara_worker;

-- Auto-confirmación: solo actúa sobre partes `submitted` con tres días de
-- antigüedad; devuelve si confirmó. Idempotente por construcción.
CREATE FUNCTION app_private.autoconfirm_weekly_report(
  target_household uuid,
  target_report uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  confirmed boolean;
BEGIN
  UPDATE app.weekly_time_reports
     SET status = 'confirmed',
         confirmed_at = statement_timestamp(),
         auto_confirmed = true
   WHERE household_id = target_household
     AND id = target_report
     AND status = 'submitted'
     AND submitted_at <= statement_timestamp() - interval '3 days'
  RETURNING true INTO confirmed;
  RETURN COALESCE(confirmed, false);
END
$$;

REVOKE ALL ON FUNCTION app_private.autoconfirm_weekly_report(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.autoconfirm_weekly_report(uuid, uuid) TO casa_clara_worker;

COMMIT;
