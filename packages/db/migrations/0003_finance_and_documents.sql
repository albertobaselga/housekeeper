BEGIN;

CREATE TYPE app.compensation_balance_type AS ENUM ('vacation', 'extra_time', 'worked_rest_day');
CREATE TYPE app.ledger_entry_kind AS ENUM ('credit', 'debit', 'adjustment', 'reversal');
CREATE TYPE app.advance_status AS ENUM ('active', 'settled', 'cancelled');
CREATE TYPE app.advance_entry_kind AS ENUM ('disbursement', 'repayment', 'adjustment', 'reversal');
CREATE TYPE app.expense_status AS ENUM ('pending', 'approved', 'rejected', 'reimbursed', 'cancelled');
CREATE TYPE app.settlement_status AS ENUM ('open', 'closed', 'void');
CREATE TYPE app.settlement_line_section AS ENUM ('salary', 'reimbursement');
CREATE TYPE app.settlement_line_kind AS ENUM (
  'base_salary',
  'extra_work',
  'time_off_compensation',
  'advance_deduction',
  'expense_reimbursement',
  'adjustment'
);
CREATE TYPE app.payment_status AS ENUM ('recorded', 'voided');
CREATE TYPE app.payment_method AS ENUM ('bank_transfer', 'cash', 'bizum', 'mixed', 'other');
CREATE TYPE app.document_visibility AS ENUM ('household', 'employment', 'private');

CREATE TABLE app.compensation_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  balance_type app.compensation_balance_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  closed_at timestamptz,
  UNIQUE (household_id, id),
  UNIQUE (household_id, employee_membership_id, balance_type),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);

CREATE TABLE app.compensation_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  account_id uuid NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  kind app.ledger_entry_kind NOT NULL,
  delta_minutes bigint NOT NULL CHECK (delta_minutes <> 0),
  effective_on date NOT NULL,
  source_type text NOT NULL CHECK (length(btrim(source_type)) > 0),
  source_id uuid NOT NULL,
  reverses_entry_id uuid,
  recorded_by_membership_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  note text NOT NULL DEFAULT '',
  UNIQUE (household_id, id),
  UNIQUE (household_id, account_id, id),
  UNIQUE (household_id, account_id, sequence_number),
  UNIQUE (household_id, account_id, source_type, source_id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES app.compensation_accounts(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, account_id, reverses_entry_id)
    REFERENCES app.compensation_ledger_entries(household_id, account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, recorded_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'credit' AND delta_minutes > 0 AND reverses_entry_id IS NULL)
    OR (kind = 'debit' AND delta_minutes < 0 AND reverses_entry_id IS NULL)
    OR (kind = 'adjustment' AND reverses_entry_id IS NULL)
    OR (kind = 'reversal' AND reverses_entry_id IS NOT NULL)
  )
);

CREATE VIEW app.compensation_balances
WITH (security_invoker = true)
AS
SELECT account.household_id,
       account.id AS account_id,
       account.agreement_id,
       account.employee_membership_id,
       account.balance_type,
       COALESCE(sum(entry.delta_minutes), 0)::bigint AS balance_minutes,
       max(entry.sequence_number) AS last_sequence_number
  FROM app.compensation_accounts AS account
  LEFT JOIN app.compensation_ledger_entries AS entry
    ON entry.household_id = account.household_id
   AND entry.account_id = account.id
 GROUP BY account.household_id, account.id, account.agreement_id,
          account.employee_membership_id, account.balance_type;

CREATE FUNCTION app.enforce_compensation_ledger_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  expected_sequence bigint;
  target_delta bigint;
  target_kind app.ledger_entry_kind;
  target_reversed boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'compensation ledger entries are append-only'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_id::text, 1));
  SELECT COALESCE(max(sequence_number), 0) + 1
    INTO expected_sequence
    FROM app.compensation_ledger_entries
   WHERE household_id = NEW.household_id AND account_id = NEW.account_id;
  IF NEW.sequence_number <> expected_sequence THEN
    RAISE EXCEPTION 'expected compensation ledger sequence %, received %', expected_sequence, NEW.sequence_number
      USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'reversal' THEN
    SELECT target.delta_minutes, target.kind,
           EXISTS (
             SELECT 1 FROM app.compensation_ledger_entries AS reversal
              WHERE reversal.household_id = target.household_id
                AND reversal.account_id = target.account_id
                AND reversal.reverses_entry_id = target.id
           )
      INTO target_delta, target_kind, target_reversed
      FROM app.compensation_ledger_entries AS target
     WHERE target.household_id = NEW.household_id
       AND target.account_id = NEW.account_id
       AND target.id = NEW.reverses_entry_id;
    IF target_delta IS NULL OR target_kind = 'reversal' OR target_reversed OR NEW.delta_minutes <> -target_delta THEN
      RAISE EXCEPTION 'invalid or duplicate compensation ledger reversal'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER compensation_ledger_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.compensation_ledger_entries
FOR EACH ROW EXECUTE FUNCTION app.enforce_compensation_ledger_append();

CREATE TABLE app.advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  principal_cents bigint NOT NULL CHECK (principal_cents > 0),
  currency_code text NOT NULL DEFAULT 'EUR' CHECK (currency_code = 'EUR'),
  status app.advance_status NOT NULL DEFAULT 'active',
  issued_on date NOT NULL,
  repayment_cents bigint NOT NULL CHECK (repayment_cents > 0),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  closed_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND closed_at IS NULL) OR (status <> 'active' AND closed_at IS NOT NULL))
);

CREATE TABLE app.advance_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  advance_id uuid NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  kind app.advance_entry_kind NOT NULL,
  delta_cents bigint NOT NULL CHECK (delta_cents <> 0),
  effective_on date NOT NULL,
  settlement_id uuid,
  source_type text NOT NULL CHECK (length(btrim(source_type)) > 0),
  source_id uuid NOT NULL,
  reverses_entry_id uuid,
  recorded_by_membership_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  note text NOT NULL DEFAULT '',
  UNIQUE (household_id, id),
  UNIQUE (household_id, advance_id, id),
  UNIQUE (household_id, advance_id, sequence_number),
  UNIQUE (household_id, advance_id, source_type, source_id),
  FOREIGN KEY (household_id, advance_id)
    REFERENCES app.advances(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, advance_id, reverses_entry_id)
    REFERENCES app.advance_ledger_entries(household_id, advance_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, recorded_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'disbursement' AND delta_cents > 0 AND reverses_entry_id IS NULL)
    OR (kind = 'repayment' AND delta_cents < 0 AND reverses_entry_id IS NULL)
    OR (kind = 'adjustment' AND reverses_entry_id IS NULL)
    OR (kind = 'reversal' AND reverses_entry_id IS NOT NULL)
  )
);

CREATE VIEW app.advance_balances
WITH (security_invoker = true)
AS
SELECT advance.household_id,
       advance.id AS advance_id,
       advance.employee_membership_id,
       advance.principal_cents,
       COALESCE(sum(entry.delta_cents), 0)::bigint AS outstanding_cents,
       max(entry.sequence_number) AS last_sequence_number
  FROM app.advances AS advance
  LEFT JOIN app.advance_ledger_entries AS entry
    ON entry.household_id = advance.household_id
   AND entry.advance_id = advance.id
 GROUP BY advance.household_id, advance.id, advance.employee_membership_id, advance.principal_cents;

CREATE FUNCTION app.enforce_advance_ledger_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  expected_sequence bigint;
  target_delta bigint;
  target_kind app.advance_entry_kind;
  target_reversed boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'advance ledger entries are append-only'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.advance_id::text, 2));
  SELECT COALESCE(max(sequence_number), 0) + 1
    INTO expected_sequence
    FROM app.advance_ledger_entries
   WHERE household_id = NEW.household_id AND advance_id = NEW.advance_id;
  IF NEW.sequence_number <> expected_sequence THEN
    RAISE EXCEPTION 'expected advance ledger sequence %, received %', expected_sequence, NEW.sequence_number
      USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'reversal' THEN
    SELECT target.delta_cents, target.kind,
           EXISTS (
             SELECT 1 FROM app.advance_ledger_entries AS reversal
              WHERE reversal.household_id = target.household_id
                AND reversal.advance_id = target.advance_id
                AND reversal.reverses_entry_id = target.id
           )
      INTO target_delta, target_kind, target_reversed
      FROM app.advance_ledger_entries AS target
     WHERE target.household_id = NEW.household_id
       AND target.advance_id = NEW.advance_id
       AND target.id = NEW.reverses_entry_id;
    IF target_delta IS NULL OR target_kind = 'reversal' OR target_reversed OR NEW.delta_cents <> -target_delta THEN
      RAISE EXCEPTION 'invalid or duplicate advance ledger reversal'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER advance_ledger_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.advance_ledger_entries
FOR EACH ROW EXECUTE FUNCTION app.enforce_advance_ledger_append();

CREATE TABLE app.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  incurred_on date NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency_code text NOT NULL DEFAULT 'EUR' CHECK (currency_code = 'EUR'),
  status app.expense_status NOT NULL DEFAULT 'pending',
  receipt_document_id uuid,
  submitted_by_membership_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  resolved_by_membership_id uuid,
  resolved_at timestamptz,
  resolution_reason text,
  reimbursed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, submitted_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, resolved_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND resolved_by_membership_id IS NULL AND resolved_at IS NULL
      AND resolution_reason IS NULL AND reimbursed_at IS NULL)
    OR (status = 'approved' AND resolved_by_membership_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) > 0 AND reimbursed_at IS NULL)
    OR (status IN ('rejected', 'cancelled') AND resolved_by_membership_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) > 0 AND reimbursed_at IS NULL)
    OR (status = 'reimbursed' AND resolved_by_membership_id IS NOT NULL AND resolved_at IS NOT NULL
      AND reimbursed_at IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX expenses_pending_idx
  ON app.expenses (household_id, employee_membership_id, incurred_on)
  WHERE status IN ('pending', 'approved');

CREATE TABLE app.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  due_on date NOT NULL,
  status app.settlement_status NOT NULL DEFAULT 'open',
  salary_total_cents bigint NOT NULL DEFAULT 0,
  reimbursement_total_cents bigint NOT NULL DEFAULT 0,
  transfer_total_cents bigint NOT NULL DEFAULT 0,
  currency_code text NOT NULL DEFAULT 'EUR' CHECK (currency_code = 'EUR'),
  snapshot_hash text CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  closed_by_membership_id uuid,
  closed_at timestamptz,
  UNIQUE (household_id, id),
  UNIQUE (household_id, id, employee_membership_id),
  UNIQUE (household_id, id, agreement_id, employee_membership_id),
  UNIQUE (household_id, employee_membership_id, period_start, period_end),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, closed_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start),
  CHECK (due_on >= period_end),
  CHECK (
    (status = 'open' AND closed_by_membership_id IS NULL AND closed_at IS NULL AND snapshot_hash IS NULL)
    OR (status = 'closed' AND closed_by_membership_id IS NOT NULL AND closed_at IS NOT NULL
        AND snapshot_hash IS NOT NULL)
    OR (status = 'void' AND closed_by_membership_id IS NOT NULL AND closed_at IS NOT NULL)
  ),
  CHECK (transfer_total_cents = salary_total_cents + reimbursement_total_cents)
);

CREATE TABLE app.settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  section app.settlement_line_section NOT NULL,
  kind app.settlement_line_kind NOT NULL,
  occurred_on date NOT NULL,
  concept text NOT NULL CHECK (length(btrim(concept)) > 0),
  amount_cents bigint NOT NULL,
  agreement_version_id uuid,
  extra_work_event_id uuid,
  advance_ledger_entry_id uuid,
  expense_id uuid,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, settlement_id, line_number),
  FOREIGN KEY (household_id, settlement_id, agreement_id, employee_membership_id)
    REFERENCES app.settlements(household_id, id, agreement_id, employee_membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, agreement_version_id)
    REFERENCES app.agreement_versions(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, extra_work_event_id)
    REFERENCES app.extra_work_events(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, advance_ledger_entry_id)
    REFERENCES app.advance_ledger_entries(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, expense_id)
    REFERENCES app.expenses(household_id, id) ON DELETE RESTRICT,
  CHECK (
    (kind = 'base_salary' AND agreement_version_id IS NOT NULL
      AND extra_work_event_id IS NULL AND advance_ledger_entry_id IS NULL AND expense_id IS NULL)
    OR (kind IN ('extra_work', 'time_off_compensation') AND extra_work_event_id IS NOT NULL
      AND advance_ledger_entry_id IS NULL AND expense_id IS NULL)
    OR (kind = 'advance_deduction' AND advance_ledger_entry_id IS NOT NULL
      AND agreement_version_id IS NULL AND extra_work_event_id IS NULL AND expense_id IS NULL)
    OR (kind = 'expense_reimbursement' AND expense_id IS NOT NULL
      AND agreement_version_id IS NULL AND extra_work_event_id IS NULL AND advance_ledger_entry_id IS NULL)
    OR (kind = 'adjustment' AND agreement_version_id IS NULL AND extra_work_event_id IS NULL
      AND advance_ledger_entry_id IS NULL AND expense_id IS NULL)
  ),
  CHECK ((section = 'reimbursement') = (kind = 'expense_reimbursement')),
  CHECK (kind <> 'advance_deduction' OR amount_cents < 0),
  CHECK (kind NOT IN ('base_salary', 'extra_work', 'expense_reimbursement') OR amount_cents >= 0),
  CHECK (kind <> 'time_off_compensation' OR amount_cents = 0)
);

CREATE FUNCTION app.enforce_settlement_line_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  parent_status app.settlement_status;
  target_household_id uuid;
  target_settlement_id uuid;
BEGIN
  target_household_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.household_id ELSE NEW.household_id END;
  target_settlement_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.settlement_id ELSE NEW.settlement_id END;
  SELECT status INTO parent_status
    FROM app.settlements
   WHERE household_id = target_household_id AND id = target_settlement_id;
  IF parent_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'settlement lines are immutable after settlement closure'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER settlement_lines_open_only
BEFORE INSERT OR UPDATE OR DELETE ON app.settlement_lines
FOR EACH ROW EXECUTE FUNCTION app.enforce_settlement_line_open();

CREATE FUNCTION app.enforce_settlement_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  calculated_salary bigint;
  calculated_reimbursement bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlements cannot be deleted; create a correcting settlement'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'closed or void settlements are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'closed' THEN
    SELECT COALESCE(sum(amount_cents) FILTER (WHERE section = 'salary'), 0),
           COALESCE(sum(amount_cents) FILTER (WHERE section = 'reimbursement'), 0)
      INTO calculated_salary, calculated_reimbursement
      FROM app.settlement_lines
     WHERE household_id = OLD.household_id AND settlement_id = OLD.id;
    NEW.salary_total_cents := calculated_salary;
    NEW.reimbursement_total_cents := calculated_reimbursement;
    NEW.transfer_total_cents := calculated_salary + calculated_reimbursement;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER settlement_state_machine
BEFORE UPDATE OR DELETE ON app.settlements
FOR EACH ROW EXECUTE FUNCTION app.enforce_settlement_transition();

CREATE TABLE app.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency_code text NOT NULL DEFAULT 'EUR' CHECK (currency_code = 'EUR'),
  method app.payment_method NOT NULL,
  value_on date NOT NULL,
  reference text NOT NULL DEFAULT '',
  status app.payment_status NOT NULL DEFAULT 'recorded',
  proof_document_id uuid,
  recorded_by_membership_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  voided_by_membership_id uuid,
  voided_at timestamptz,
  void_reason text,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, settlement_id, employee_membership_id)
    REFERENCES app.settlements(household_id, id, employee_membership_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, recorded_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, voided_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'recorded' AND voided_by_membership_id IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'voided' AND voided_by_membership_id IS NOT NULL AND voided_at IS NOT NULL
        AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
  )
);

CREATE TABLE app.settlement_receipt_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  note text NOT NULL DEFAULT '',
  UNIQUE (household_id, id),
  UNIQUE (household_id, settlement_id),
  FOREIGN KEY (household_id, settlement_id, employee_membership_id)
    REFERENCES app.settlements(household_id, id, employee_membership_id) ON DELETE RESTRICT
);

CREATE VIEW app.settlement_payment_totals
WITH (security_invoker = true)
AS
SELECT settlement.household_id,
       settlement.id AS settlement_id,
       settlement.transfer_total_cents,
       COALESCE(sum(payment.amount_cents) FILTER (WHERE payment.status = 'recorded'), 0)::bigint AS paid_cents,
       greatest(settlement.transfer_total_cents
                - COALESCE(sum(payment.amount_cents) FILTER (WHERE payment.status = 'recorded'), 0), 0)::bigint
         AS pending_cents
  FROM app.settlements AS settlement
  LEFT JOIN app.payments AS payment
    ON payment.household_id = settlement.household_id
   AND payment.settlement_id = settlement.id
 GROUP BY settlement.household_id, settlement.id, settlement.transfer_total_cents;

CREATE TABLE app.storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  bucket text NOT NULL CHECK (length(btrim(bucket)) > 0),
  object_key text NOT NULL CHECK (length(btrim(object_key)) > 0 AND object_key !~ '(^|/)\.\.(/|$)'),
  media_type text NOT NULL CHECK (length(btrim(media_type)) > 0),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  deleted_at timestamptz,
  UNIQUE (household_id, id),
  UNIQUE (bucket, object_key),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE TABLE app.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  storage_object_id uuid NOT NULL,
  owner_membership_id uuid,
  visibility app.document_visibility NOT NULL,
  document_type text NOT NULL CHECK (length(btrim(document_type)) > 0),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, storage_object_id)
    REFERENCES app.storage_objects(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, owner_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (visibility <> 'private' OR owner_membership_id IS NOT NULL),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

ALTER TABLE app.expenses
  ADD CONSTRAINT expenses_receipt_document_fk
  FOREIGN KEY (household_id, receipt_document_id)
  REFERENCES app.documents(household_id, id) ON DELETE RESTRICT;

ALTER TABLE app.payments
  ADD CONSTRAINT payments_proof_document_fk
  FOREIGN KEY (household_id, proof_document_id)
  REFERENCES app.documents(household_id, id) ON DELETE RESTRICT;

CREATE TABLE app.command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  command_type text NOT NULL CHECK (length(btrim(command_type)) > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) IN ('object', 'array')),
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, operation_id),
  FOREIGN KEY (household_id, actor_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

COMMIT;
