BEGIN;

CREATE TYPE app.agreement_status AS ENUM ('active', 'ended');
CREATE TYPE app.time_report_status AS ENUM ('draft', 'submitted', 'confirmed', 'disputed');
CREATE TYPE app.extra_work_kind AS ENUM ('overtime', 'worked_rest_day');
CREATE TYPE app.extra_work_origin AS ENUM ('employee_report', 'family_request', 'weekly_report', 'system_import');
CREATE TYPE app.extra_work_status AS ENUM (
  'requested',
  'accepted',
  'performed',
  'performed_pending_resolution',
  'resolved',
  'rejected',
  'cancelled'
);
CREATE TYPE app.extra_work_resolution AS ENUM ('money', 'time_off');

CREATE TABLE app.employment_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  employee_membership_id uuid NOT NULL,
  status app.agreement_status NOT NULL DEFAULT 'active',
  starts_on date NOT NULL,
  ends_on date,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK ((status = 'active' AND ended_at IS NULL) OR (status = 'ended' AND ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX one_active_agreement_per_employee_idx
  ON app.employment_agreements (household_id, employee_membership_id)
  WHERE status = 'active';

CREATE TABLE app.agreement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  effective_from date NOT NULL,
  monthly_salary_cents bigint NOT NULL CHECK (monthly_salary_cents >= 0),
  overtime_hourly_rate_cents bigint NOT NULL CHECK (overtime_hourly_rate_cents >= 0),
  worked_rest_day_rate_cents bigint NOT NULL CHECK (worked_rest_day_rate_cents >= 0),
  worked_rest_day_credit_minutes integer NOT NULL DEFAULT 1440
    CHECK (worked_rest_day_credit_minutes > 0),
  contracted_weekly_minutes integer NOT NULL CHECK (contracted_weekly_minutes > 0),
  currency_code text NOT NULL DEFAULT 'EUR' CHECK (currency_code = 'EUR'),
  terms jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(terms) = 'object'),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, id, agreement_id),
  UNIQUE (household_id, agreement_id, version_number),
  UNIQUE (household_id, agreement_id, effective_from),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION app.enforce_agreement_version_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  latest_version integer;
  latest_effective_from date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'agreement versions are immutable; append a new version'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.agreement_id::text, 0));
  SELECT version_number, effective_from
    INTO latest_version, latest_effective_from
    FROM app.agreement_versions
   WHERE household_id = NEW.household_id AND agreement_id = NEW.agreement_id
   ORDER BY version_number DESC
   LIMIT 1;
  IF latest_version IS NULL THEN
    IF NEW.version_number <> 1 THEN
      RAISE EXCEPTION 'the first agreement version must be version 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.version_number <> latest_version + 1 OR NEW.effective_from <= latest_effective_from THEN
    RAISE EXCEPTION 'agreement versions must append in number and effective date order'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agreement_versions_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.agreement_versions
FOR EACH ROW EXECUTE FUNCTION app.enforce_agreement_version_append_only();

CREATE TABLE app.weekly_time_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  week_starts_on date NOT NULL,
  week_ends_on date GENERATED ALWAYS AS (week_starts_on + 6) STORED,
  status app.time_report_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  submitted_by_membership_id uuid,
  confirmed_at timestamptz,
  confirmed_by_membership_id uuid,
  dispute_reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, id, employee_membership_id),
  UNIQUE (household_id, employee_membership_id, week_starts_on),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, submitted_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, confirmed_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (extract(isodow FROM week_starts_on) = 1),
  CHECK (
    (status = 'draft' AND submitted_at IS NULL AND confirmed_at IS NULL AND dispute_reason IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL AND submitted_by_membership_id IS NOT NULL
        AND confirmed_at IS NULL AND confirmed_by_membership_id IS NULL AND dispute_reason IS NULL)
    OR (status = 'confirmed' AND submitted_at IS NOT NULL AND submitted_by_membership_id IS NOT NULL
        AND confirmed_at IS NOT NULL AND confirmed_by_membership_id IS NOT NULL AND dispute_reason IS NULL)
    OR (status = 'disputed' AND submitted_at IS NOT NULL AND submitted_by_membership_id IS NOT NULL
        AND confirmed_at IS NULL AND confirmed_by_membership_id IS NULL
        AND dispute_reason IS NOT NULL AND length(btrim(dispute_reason)) > 0)
  ),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  report_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  worked_on date NOT NULL,
  started_at time,
  ended_at time,
  regular_minutes integer NOT NULL DEFAULT 0 CHECK (regular_minutes >= 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, report_id, employee_membership_id)
    REFERENCES app.weekly_time_reports(household_id, id, employee_membership_id) ON DELETE RESTRICT,
  CHECK ((started_at IS NULL) = (ended_at IS NULL)),
  CHECK (ended_at IS NULL OR ended_at > started_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX time_entries_report_idx ON app.time_entries (household_id, report_id, worked_on);

CREATE TABLE app.extra_work_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  report_id uuid,
  kind app.extra_work_kind NOT NULL,
  worked_on date NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  note text NOT NULL DEFAULT '',
  origin app.extra_work_origin NOT NULL,
  status app.extra_work_status NOT NULL DEFAULT 'requested',
  resolution app.extra_work_resolution,
  resolved_agreement_version_id uuid,
  frozen_unit_rate_cents bigint,
  frozen_amount_cents bigint,
  balance_minutes integer,
  requested_by_membership_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  approved_by_membership_id uuid,
  approved_at timestamptz,
  performed_by_membership_id uuid,
  performed_at timestamptz,
  resolved_by_membership_id uuid,
  resolved_at timestamptz,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, report_id, employee_membership_id)
    REFERENCES app.weekly_time_reports(household_id, id, employee_membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, resolved_agreement_version_id, agreement_id)
    REFERENCES app.agreement_versions(household_id, id, agreement_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, requested_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, approved_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, performed_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, resolved_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (frozen_unit_rate_cents IS NULL OR frozen_unit_rate_cents >= 0),
  CHECK (frozen_amount_cents IS NULL OR frozen_amount_cents >= 0),
  CHECK (balance_minutes IS NULL OR balance_minutes >= 0),
  CHECK (
    (status = 'requested'
      AND resolution IS NULL AND resolved_agreement_version_id IS NULL
      AND frozen_unit_rate_cents IS NULL AND frozen_amount_cents IS NULL AND balance_minutes IS NULL
      AND approved_by_membership_id IS NULL AND approved_at IS NULL
      AND performed_by_membership_id IS NULL AND performed_at IS NULL
      AND resolved_by_membership_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
    OR (status = 'accepted'
      AND resolution IS NULL AND resolved_agreement_version_id IS NULL
      AND frozen_unit_rate_cents IS NULL AND frozen_amount_cents IS NULL AND balance_minutes IS NULL
      AND approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL
      AND performed_by_membership_id IS NULL AND performed_at IS NULL
      AND resolved_by_membership_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
    OR (status = 'performed'
      AND resolution IS NULL AND resolved_agreement_version_id IS NULL
      AND frozen_unit_rate_cents IS NULL AND frozen_amount_cents IS NULL AND balance_minutes IS NULL
      AND approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL
      AND performed_by_membership_id IS NOT NULL AND performed_at IS NOT NULL
      AND resolved_by_membership_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
    OR (status = 'performed_pending_resolution'
      AND resolution IS NULL AND resolved_agreement_version_id IS NULL
      AND frozen_unit_rate_cents IS NULL AND frozen_amount_cents IS NULL AND balance_minutes IS NULL
      AND approved_by_membership_id IS NULL AND approved_at IS NULL
      AND performed_by_membership_id IS NOT NULL AND performed_at IS NOT NULL
      AND resolved_by_membership_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
    OR (status = 'resolved' AND resolution IS NOT NULL
      AND resolved_agreement_version_id IS NOT NULL AND frozen_unit_rate_cents IS NOT NULL
      AND frozen_amount_cents IS NOT NULL AND balance_minutes IS NOT NULL
      AND approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL
      AND performed_by_membership_id IS NOT NULL AND performed_at IS NOT NULL
      AND resolved_by_membership_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) > 0
      AND ((resolution = 'money' AND balance_minutes = 0)
        OR (resolution = 'time_off' AND frozen_amount_cents = 0 AND balance_minutes > 0)))
    OR (status = 'rejected'
      AND resolution IS NULL AND resolved_agreement_version_id IS NULL
      AND frozen_unit_rate_cents IS NULL AND frozen_amount_cents IS NULL AND balance_minutes IS NULL
      AND resolved_by_membership_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) > 0)
    OR (status = 'cancelled'
      AND resolution IS NULL AND resolved_agreement_version_id IS NULL
      AND frozen_unit_rate_cents IS NULL AND frozen_amount_cents IS NULL AND balance_minutes IS NULL
      AND performed_by_membership_id IS NULL AND performed_at IS NULL
      AND resolved_by_membership_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) > 0)
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX extra_work_events_period_idx
  ON app.extra_work_events (household_id, employee_membership_id, worked_on, status);

CREATE FUNCTION app.enforce_extra_work_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extra-work events cannot be deleted; cancel or append a correction'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('resolved', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'terminal extra-work events are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'requested' AND NEW.status IN ('accepted', 'performed_pending_resolution', 'rejected', 'cancelled'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('performed', 'cancelled'))
    OR (OLD.status = 'performed' AND NEW.status = 'resolved')
    OR (OLD.status = 'performed_pending_resolution' AND NEW.status IN ('resolved', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'invalid extra-work transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.household_id <> OLD.household_id
     OR NEW.agreement_id <> OLD.agreement_id
     OR NEW.employee_membership_id <> OLD.employee_membership_id
     OR NEW.requested_by_membership_id <> OLD.requested_by_membership_id
     OR NEW.requested_at <> OLD.requested_at
     OR NEW.origin <> OLD.origin THEN
    RAISE EXCEPTION 'extra-work identity, origin, and request facts are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER extra_work_state_machine
BEFORE UPDATE OR DELETE ON app.extra_work_events
FOR EACH ROW EXECUTE FUNCTION app.enforce_extra_work_transition();

CREATE TABLE app.extra_work_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  extra_work_event_id uuid NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  from_status app.extra_work_status,
  to_status app.extra_work_status NOT NULL,
  actor_membership_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  reason text NOT NULL DEFAULT '',
  UNIQUE (household_id, id),
  UNIQUE (household_id, extra_work_event_id, sequence_number),
  FOREIGN KEY (household_id, extra_work_event_id)
    REFERENCES app.extra_work_events(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, actor_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK ((sequence_number = 1 AND from_status IS NULL AND to_status = 'requested')
      OR (sequence_number > 1 AND from_status IS NOT NULL))
);

CREATE FUNCTION app.enforce_extra_work_transition_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  expected_sequence integer;
  prior_status app.extra_work_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'extra-work transition history is append-only' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.extra_work_event_id::text, 3));
  SELECT COALESCE(max(sequence_number), 0) + 1
    INTO expected_sequence
    FROM app.extra_work_transitions
   WHERE household_id = NEW.household_id AND extra_work_event_id = NEW.extra_work_event_id;
  SELECT to_status INTO prior_status
    FROM app.extra_work_transitions
   WHERE household_id = NEW.household_id AND extra_work_event_id = NEW.extra_work_event_id
   ORDER BY sequence_number DESC LIMIT 1;
  IF NEW.sequence_number <> expected_sequence
     OR (NEW.sequence_number = 1 AND (NEW.from_status IS NOT NULL OR NEW.to_status <> 'requested'))
     OR (NEW.sequence_number > 1 AND NEW.from_status IS DISTINCT FROM prior_status) THEN
    RAISE EXCEPTION 'extra-work transition does not append to current history' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER extra_work_transitions_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.extra_work_transitions
FOR EACH ROW EXECUTE FUNCTION app.enforce_extra_work_transition_append();

CREATE FUNCTION app.require_extra_work_transition_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  latest_status app.extra_work_status;
BEGIN
  SELECT transition.to_status INTO latest_status
    FROM app.extra_work_transitions AS transition
   WHERE transition.household_id = NEW.household_id
     AND transition.extra_work_event_id = NEW.id
   ORDER BY transition.sequence_number DESC
   LIMIT 1;
  IF latest_status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'extra-work state % must have a matching appended transition', NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER extra_work_requires_transition_history
AFTER INSERT OR UPDATE ON app.extra_work_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.require_extra_work_transition_history();

COMMIT;
