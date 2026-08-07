-- Negative RLS matrix across the two fixture households and the runtime roles.
-- Requires migrations plus fixtures/001_two_households.sql already applied, and a
-- connection allowed to SET ROLE casa_clara_app / casa_clara_worker.
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);

DO $assert_membership_discovery$
DECLARE
  visible_memberships integer;
BEGIN
  SELECT count(*)::integer INTO visible_memberships FROM app.household_memberships;
  IF visible_memberships <> 1 THEN
    RAISE EXCEPTION 'user-id-only membership discovery expected 1 row, got %', visible_memberships;
  END IF;
END
$assert_membership_discovery$;

SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_rls$
DECLARE
  visible_households integer;
  visible_settlements integer;
  leaked_settlements integer;
  visible_total bigint;
BEGIN
  SELECT count(*)::integer INTO visible_households FROM app.households;
  SELECT count(*)::integer, max(transfer_total_cents)
    INTO visible_settlements, visible_total FROM app.settlements;
  SELECT count(*)::integer INTO leaked_settlements
    FROM app.settlements
   WHERE household_id = '20000000-0000-4000-8000-000000000001';
  IF visible_households <> 1 OR visible_settlements <> 1
     OR visible_total <> 145330 OR leaked_settlements <> 0 THEN
    RAISE EXCEPTION 'admin tenant isolation failed';
  END IF;

  BEGIN
    INSERT INTO app.command_receipts (
      household_id, operation_id, command_type, payload_hash, result, actor_membership_id
    ) VALUES (
      '20000000-0000-4000-8000-000000000001', gen_random_uuid(),
      'fixture.cross_tenant', repeat('e', 64), '{}'::jsonb,
      '21000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-tenant RLS insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin_rls$;

SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer_rls$
BEGIN
  IF (SELECT count(*) FROM app.households) <> 1
     OR (SELECT count(*) FROM app.employment_agreements) <> 0
     OR (SELECT count(*) FROM app.settlements) <> 0 THEN
    RAISE EXCEPTION 'viewer access matrix failed';
  END IF;
END
$assert_viewer_rls$;

SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);

DO $assert_context_spoofing$
BEGIN
  BEGIN
    PERFORM app.set_household_context(
      '20000000-0000-4000-8000-000000000001',
      '21000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-user context selection unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_context_spoofing$;

COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_worker;
DO $assert_worker_contract$
DECLARE
  jobs integer;
BEGIN
  SELECT count(*)::integer INTO jobs FROM app_private.job_queue;
  IF jobs <> 1 THEN
    RAISE EXCEPTION 'worker expected one fixture job, got %', jobs;
  END IF;
  BEGIN
    PERFORM 1 FROM app.settlements;
    RAISE EXCEPTION 'worker unexpectedly read settlement data directly';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_worker_contract$;
COMMIT;
