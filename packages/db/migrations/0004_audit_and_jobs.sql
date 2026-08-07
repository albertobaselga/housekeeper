BEGIN;

CREATE TABLE app.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  actor_user_id text,
  actor_membership_id uuid,
  action text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  entity_schema text NOT NULL CHECK (length(btrim(entity_schema)) > 0),
  entity_table text NOT NULL CHECK (length(btrim(entity_table)) > 0),
  entity_id uuid NOT NULL,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, actor_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK ((action = 'INSERT' AND before_data IS NULL AND after_data IS NOT NULL)
      OR (action = 'UPDATE' AND before_data IS NOT NULL AND after_data IS NOT NULL)
      OR (action = 'DELETE' AND before_data IS NOT NULL AND after_data IS NULL))
);

CREATE INDEX audit_events_entity_idx
  ON app.audit_events (household_id, entity_schema, entity_table, entity_id, occurred_at DESC);
CREATE INDEX audit_events_time_idx ON app.audit_events (household_id, occurred_at DESC);

CREATE FUNCTION app_private.write_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, app_private
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  tenant_id uuid;
  row_id uuid;
BEGIN
  old_data := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  new_data := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  tenant_id := COALESCE((new_data ->> 'household_id')::uuid, (old_data ->> 'household_id')::uuid);
  row_id := COALESCE((new_data ->> 'id')::uuid, (old_data ->> 'id')::uuid);

  INSERT INTO app.audit_events (
    household_id, actor_user_id, actor_membership_id, action,
    entity_schema, entity_table, entity_id, before_data, after_data, request_id
  ) VALUES (
    tenant_id,
    app.current_user_id(),
    CASE WHEN app.current_household_id() = tenant_id THEN app.current_membership_id() ELSE NULL END,
    TG_OP,
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    row_id,
    old_data,
    new_data,
    nullif(current_setting('app.request_id', true), '')
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

REVOKE ALL ON FUNCTION app_private.write_audit_event() FROM PUBLIC;

CREATE FUNCTION app_private.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON app.audit_events
FOR EACH ROW EXECUTE FUNCTION app_private.reject_mutation();

CREATE TRIGGER command_receipts_append_only
BEFORE UPDATE OR DELETE ON app.command_receipts
FOR EACH ROW EXECUTE FUNCTION app_private.reject_mutation();

CREATE TRIGGER settlement_receipts_append_only
BEFORE UPDATE OR DELETE ON app.settlement_receipt_confirmations
FOR EACH ROW EXECUTE FUNCTION app_private.reject_mutation();

CREATE FUNCTION app_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER user_profiles_touch_updated_at
BEFORE UPDATE ON app.user_profiles
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER memberships_touch_updated_at
BEFORE UPDATE ON app.household_memberships
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER weekly_reports_touch_updated_at
BEFORE UPDATE ON app.weekly_time_reports
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER time_entries_touch_updated_at
BEFORE UPDATE ON app.time_entries
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER extra_work_touch_updated_at
BEFORE UPDATE ON app.extra_work_events
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER expenses_touch_updated_at
BEFORE UPDATE ON app.expenses
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE FUNCTION app_private.enforce_expense_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expenses cannot be deleted; cancel or reject instead' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status = 'reimbursed')
  ) THEN
    RAISE EXCEPTION 'invalid expense transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('rejected', 'reimbursed', 'cancelled') THEN
    RAISE EXCEPTION 'terminal expenses are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER expense_state_machine
BEFORE UPDATE OR DELETE ON app.expenses
FOR EACH ROW EXECUTE FUNCTION app_private.enforce_expense_transition();

CREATE FUNCTION app_private.enforce_payment_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted; void the record instead' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'recorded' OR NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'the only payment transition is recorded to voided' USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.household_id <> OLD.household_id
     OR NEW.settlement_id <> OLD.settlement_id OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.value_on <> OLD.value_on OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'payment facts are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER payment_state_machine
BEFORE UPDATE OR DELETE ON app.payments
FOR EACH ROW EXECUTE FUNCTION app_private.enforce_payment_transition();

CREATE TYPE app_private.job_status AS ENUM ('queued', 'running', 'completed', 'dead');

CREATE TABLE app_private.job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  job_type text NOT NULL CHECK (length(btrim(job_type)) > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status app_private.job_status NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  UNIQUE (household_id, id),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'queued' AND locked_at IS NULL AND completed_at IS NULL)
    OR (status = 'running' AND locked_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
    OR (status = 'dead' AND completed_at IS NULL AND last_error IS NOT NULL)
  )
);

CREATE INDEX job_queue_claim_idx
  ON app_private.job_queue (run_at, created_at)
  WHERE status = 'queued';
CREATE INDEX job_queue_tenant_idx
  ON app_private.job_queue (household_id, status, created_at DESC);

CREATE FUNCTION app_private.enforce_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jobs are retained for audit and cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed', 'dead') THEN
    RAISE EXCEPTION 'terminal jobs are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'dead'))
    OR (OLD.status = 'running' AND NEW.status IN ('queued', 'completed', 'dead'))
  ) THEN
    RAISE EXCEPTION 'invalid job transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'job attempts cannot decrease' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER job_queue_state_machine
BEFORE UPDATE OR DELETE ON app_private.job_queue
FOR EACH ROW EXECUTE FUNCTION app_private.enforce_job_transition();

CREATE FUNCTION app.enqueue_job(
  requested_job_type text,
  requested_payload jsonb,
  requested_run_at timestamptz DEFAULT statement_timestamp()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, app_private
AS $$
DECLARE
  new_job_id uuid;
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'complete transaction context required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(requested_job_type)) = 0 OR jsonb_typeof(requested_payload) <> 'object' THEN
    RAISE EXCEPTION 'job type and object payload are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_private.job_queue (household_id, job_type, payload, run_at)
  VALUES (app.current_household_id(), requested_job_type, requested_payload, requested_run_at)
  RETURNING id INTO new_job_id;
  RETURN new_job_id;
END
$$;

REVOKE ALL ON FUNCTION app.enqueue_job(text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_job(text, jsonb, timestamptz) TO casa_clara_app;

-- Every mutable tenant table emits a durable audit event. Dedicated ledgers and
-- transition tables remain append-only in addition to this general audit trail.
DO $audit_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'household_memberships', 'employment_agreements', 'agreement_versions',
    'weekly_time_reports', 'time_entries',
    'extra_work_events', 'extra_work_transitions', 'compensation_accounts',
    'compensation_ledger_entries', 'advances', 'advance_ledger_entries', 'expenses',
    'settlements', 'settlement_lines', 'payments', 'settlement_receipt_confirmations',
    'storage_objects', 'documents', 'command_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON app.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event()',
      table_name,
      table_name
    );
  END LOOP;
END
$audit_triggers$;

CREATE TRIGGER job_queue_audit
AFTER INSERT OR UPDATE OR DELETE ON app_private.job_queue
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

COMMIT;
