-- Schema invariants and append-only constraints over the two-household fixture.
-- Requires migrations plus fixtures/001_two_households.sql already applied.
BEGIN;
SET LOCAL row_security = off;

DO $assert_schema$
DECLARE
  missing_force_rls integer;
  settlement_total bigint;
  permanent_minutes bigint;
  pending_events integer;
BEGIN
  SELECT count(*)::integer INTO missing_force_rls
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relkind = 'r'
     AND namespace.nspname IN ('app', 'app_private')
     AND NOT (relation.relrowsecurity AND relation.relforcerowsecurity);
  IF missing_force_rls <> 0 THEN
    RAISE EXCEPTION '% tenant tables are missing FORCE RLS', missing_force_rls;
  END IF;

  SELECT transfer_total_cents INTO settlement_total
    FROM app.settlements
   WHERE id = '12b00000-0000-4000-8000-000000000001';
  IF settlement_total <> 145330 THEN
    RAISE EXCEPTION 'acceptance settlement expected 145330 cents, got %', settlement_total;
  END IF;

  SELECT balance_minutes INTO permanent_minutes
    FROM app.compensation_balances
   WHERE account_id = '12600000-0000-4000-8000-000000000001';
  IF permanent_minutes <> 1440 THEN
    RAISE EXCEPTION 'permanent compensation expected 1440 minutes, got %', permanent_minutes;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app'
       AND table_name IN ('agreement_versions', 'extra_work_events', 'compensation_ledger_entries')
       AND column_name IN ('compensation_expiry_days', 'balance_expires_on', 'expires_on')
  ) THEN
    RAISE EXCEPTION 'compensation expiry columns must not exist';
  END IF;

  SELECT count(*)::integer INTO pending_events
    FROM app.extra_work_events
   WHERE status = 'performed_pending_resolution' AND frozen_amount_cents IS NULL;
  IF pending_events <> 1 THEN
    RAISE EXCEPTION 'performed unapproved work must remain pending without a frozen rate';
  END IF;
END
$assert_schema$;

DO $assert_constraints$
BEGIN
  BEGIN
    UPDATE app.compensation_ledger_entries
       SET delta_minutes = 720
     WHERE id = '12700000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'append-only compensation update unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE app.extra_work_events
       SET frozen_amount_cents = 7100
     WHERE id = '12400000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'terminal extra-work mutation unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE app.extra_work_transitions
       SET reason = 'rewritten'
     WHERE id = '12500000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'transition-history mutation unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.command_receipts (
      household_id, operation_id, command_type, payload_hash, result, actor_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001',
      '12f00000-0000-4000-8000-000000000004',
      'fixture.duplicate', repeat('d', 64), '{}'::jsonb,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'duplicate operation id unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.employment_agreements (
      household_id, employee_membership_id, starts_on, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001',
      '21000000-0000-4000-8000-000000000002',
      '2026-01-01',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-household foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$assert_constraints$;

COMMIT;
