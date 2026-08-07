BEGIN;

CREATE FUNCTION app.tenant_context_matches(row_household_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.context_is_complete() AND row_household_id = app.current_household_id()
$$;

CREATE FUNCTION app.employee_row_visible(
  row_household_id uuid,
  row_employee_membership_id uuid,
  include_family_member boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.tenant_context_matches(row_household_id) AND (
    app.current_household_role() = 'family_admin'
    OR (include_family_member AND app.current_household_role() = 'family_member')
    OR (app.current_household_role() = 'employee_live_in'
        AND row_employee_membership_id = app.current_membership_id())
  )
$$;

DO $enable_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'households', 'user_profiles', 'household_memberships',
    'employment_agreements', 'agreement_versions', 'weekly_time_reports', 'time_entries',
    'extra_work_events', 'extra_work_transitions', 'compensation_accounts',
    'compensation_ledger_entries', 'advances', 'advance_ledger_entries', 'expenses',
    'settlements', 'settlement_lines', 'payments', 'settlement_receipt_confirmations',
    'storage_objects', 'documents', 'command_receipts', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$enable_rls$;

ALTER TABLE app_private.job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.job_queue FORCE ROW LEVEL SECURITY;

-- Identity bootstrap: with only app.user_id set, a Better Auth user may discover
-- their own live memberships. No tenant or role GUC is trusted for that first read.
CREATE POLICY user_profiles_self_read ON app.user_profiles
  FOR SELECT USING (user_id = app.current_user_id());
CREATE POLICY user_profiles_admin_read ON app.user_profiles
  FOR SELECT USING (
    app.current_household_role() = 'family_admin'
    AND EXISTS (
      SELECT 1 FROM app.household_memberships AS membership
       WHERE membership.household_id = app.current_household_id()
         AND membership.user_id = user_profiles.user_id
    )
  );
CREATE POLICY user_profiles_self_insert ON app.user_profiles
  FOR INSERT WITH CHECK (user_id = app.current_user_id());
CREATE POLICY user_profiles_self_update ON app.user_profiles
  FOR UPDATE USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

CREATE POLICY memberships_discover_own ON app.household_memberships
  FOR SELECT USING (
    user_id = app.current_user_id()
    AND starts_at <= statement_timestamp()
    AND (expires_at IS NULL OR expires_at > statement_timestamp())
    AND revoked_at IS NULL
  );
CREATE POLICY memberships_admin_read ON app.household_memberships
  FOR SELECT USING (
    household_id = app.current_household_id()
    AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY memberships_admin_insert ON app.household_memberships
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY memberships_admin_update ON app.household_memberships
  FOR UPDATE USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );

CREATE POLICY households_tenant_read ON app.households
  FOR SELECT USING (
    id = app.current_household_id()
    AND app.current_household_role() IS NOT NULL
  );
CREATE POLICY households_admin_update ON app.households
  FOR UPDATE USING (
    id = app.current_household_id() AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    id = app.current_household_id() AND app.current_household_role() = 'family_admin'
  );

-- Agreements are financial. Family members may see the relationship row, but
-- salary-bearing versions remain limited to the administrator and the employee.
CREATE POLICY agreements_read ON app.employment_agreements
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, true));
CREATE POLICY agreements_admin_insert ON app.employment_agreements
  FOR INSERT WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY agreements_admin_update ON app.employment_agreements
  FOR UPDATE USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');

CREATE POLICY agreement_versions_read ON app.agreement_versions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.employment_agreements AS agreement
       WHERE agreement.household_id = agreement_versions.household_id
         AND agreement.id = agreement_versions.agreement_id
         AND app.employee_row_visible(agreement.household_id, agreement.employee_membership_id, false)
    )
  );
CREATE POLICY agreement_versions_admin_insert ON app.agreement_versions
  FOR INSERT WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');

CREATE POLICY weekly_reports_read ON app.weekly_time_reports
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, true));
CREATE POLICY weekly_reports_admin_all ON app.weekly_time_reports
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY weekly_reports_employee_insert ON app.weekly_time_reports
  FOR INSERT WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
  );
CREATE POLICY weekly_reports_employee_update ON app.weekly_time_reports
  FOR UPDATE USING (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
  ) WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
  );

CREATE POLICY time_entries_read ON app.time_entries
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, true));
CREATE POLICY time_entries_admin_all ON app.time_entries
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY time_entries_employee_all ON app.time_entries
  FOR ALL USING (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
  ) WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
  );

CREATE POLICY extra_work_read ON app.extra_work_events
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, true));
CREATE POLICY extra_work_admin_insert ON app.extra_work_events
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
    AND status = 'requested'
  );
CREATE POLICY extra_work_admin_update ON app.extra_work_events
  FOR UPDATE USING (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY extra_work_employee_insert ON app.extra_work_events
  FOR INSERT WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
    AND status = 'requested'
    AND requested_by_membership_id = app.current_membership_id()
  );
CREATE POLICY extra_work_employee_update ON app.extra_work_events
  FOR UPDATE USING (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
    AND status IN ('requested', 'accepted')
  ) WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
    AND status IN ('requested', 'performed', 'performed_pending_resolution')
  );

CREATE POLICY extra_work_transitions_read ON app.extra_work_transitions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.extra_work_events AS event
       WHERE event.household_id = extra_work_transitions.household_id
         AND event.id = extra_work_transitions.extra_work_event_id
    )
  );
CREATE POLICY extra_work_transitions_insert ON app.extra_work_transitions
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND actor_membership_id = app.current_membership_id()
    AND app.current_household_role() IN ('family_admin', 'employee_live_in')
  );

-- Permanent compensation and advance balances use append-only entries. No date
-- causes a balance to disappear; expiration/correction is always an explicit entry.
CREATE POLICY compensation_accounts_read ON app.compensation_accounts
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, false));
CREATE POLICY compensation_accounts_admin_all ON app.compensation_accounts
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY compensation_entries_read ON app.compensation_ledger_entries
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.compensation_accounts AS account
       WHERE account.household_id = compensation_ledger_entries.household_id
         AND account.id = compensation_ledger_entries.account_id
    )
  );
CREATE POLICY compensation_entries_admin_insert ON app.compensation_ledger_entries
  FOR INSERT WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');

CREATE POLICY advances_read ON app.advances
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, false));
CREATE POLICY advances_admin_all ON app.advances
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY advance_entries_read ON app.advance_ledger_entries
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.advances AS advance
       WHERE advance.household_id = advance_ledger_entries.household_id
         AND advance.id = advance_ledger_entries.advance_id
    )
  );
CREATE POLICY advance_entries_admin_insert ON app.advance_ledger_entries
  FOR INSERT WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');

CREATE POLICY expenses_read ON app.expenses
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, true));
CREATE POLICY expenses_admin_all ON app.expenses
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY expenses_employee_insert ON app.expenses
  FOR INSERT WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
    AND submitted_by_membership_id = app.current_membership_id()
    AND status = 'pending'
  );
CREATE POLICY expenses_employee_update ON app.expenses
  FOR UPDATE USING (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in' AND status = 'pending'
  ) WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in' AND status = 'pending'
  );

CREATE POLICY settlements_read ON app.settlements
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, false));
CREATE POLICY settlements_admin_all ON app.settlements
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY settlement_lines_read ON app.settlement_lines
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.settlements AS settlement
       WHERE settlement.household_id = settlement_lines.household_id
         AND settlement.id = settlement_lines.settlement_id
    )
  );
CREATE POLICY settlement_lines_admin_all ON app.settlement_lines
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY payments_read ON app.payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.settlements AS settlement
       WHERE settlement.household_id = payments.household_id AND settlement.id = payments.settlement_id
    )
  );
CREATE POLICY payments_admin_all ON app.payments
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY receipt_confirmations_read ON app.settlement_receipt_confirmations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.settlements AS settlement
       WHERE settlement.household_id = settlement_receipt_confirmations.household_id
         AND settlement.id = settlement_receipt_confirmations.settlement_id
    )
  );
CREATE POLICY receipt_confirmations_employee_insert ON app.settlement_receipt_confirmations
  FOR INSERT WITH CHECK (
    app.employee_row_visible(household_id, employee_membership_id, false)
    AND app.current_household_role() = 'employee_live_in'
    AND employee_membership_id = app.current_membership_id()
  );

CREATE POLICY documents_read ON app.documents
  FOR SELECT USING (
    app.tenant_context_matches(household_id) AND (
      visibility = 'household'
      OR (visibility = 'employment' AND app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in'))
      OR (visibility = 'private' AND (owner_membership_id = app.current_membership_id()
          OR app.current_household_role() = 'family_admin'))
    )
  );
CREATE POLICY documents_write ON app.documents
  FOR ALL USING (
    app.tenant_context_matches(household_id)
    AND (created_by_membership_id = app.current_membership_id() OR app.current_household_role() = 'family_admin')
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND created_by_membership_id = app.current_membership_id()
  );
CREATE POLICY storage_objects_read ON app.storage_objects
  FOR SELECT USING (
    app.tenant_context_matches(household_id) AND (
      created_by_membership_id = app.current_membership_id()
      OR app.current_household_role() = 'family_admin'
      OR EXISTS (
        SELECT 1 FROM app.documents AS document
         WHERE document.household_id = storage_objects.household_id
           AND document.storage_object_id = storage_objects.id
      )
    )
  );
CREATE POLICY storage_objects_write ON app.storage_objects
  FOR ALL USING (
    app.tenant_context_matches(household_id)
    AND (created_by_membership_id = app.current_membership_id() OR app.current_household_role() = 'family_admin')
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND created_by_membership_id = app.current_membership_id()
  );

CREATE POLICY command_receipts_read ON app.command_receipts
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND actor_membership_id = app.current_membership_id()
  );
CREATE POLICY command_receipts_insert ON app.command_receipts
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND actor_membership_id = app.current_membership_id()
  );

CREATE POLICY audit_events_read ON app.audit_events
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND (app.current_household_role() = 'family_admin'
      OR actor_membership_id = app.current_membership_id())
  );
CREATE POLICY audit_events_trigger_insert ON app.audit_events
  FOR INSERT WITH CHECK (
    (app.tenant_context_matches(household_id) AND app.current_household_role() IS NOT NULL)
    OR pg_has_role(session_user, 'casa_clara_worker', 'member')
  );

CREATE POLICY job_queue_worker_read ON app_private.job_queue
  FOR SELECT USING (pg_has_role(session_user, 'casa_clara_worker', 'member'));
CREATE POLICY job_queue_worker_insert ON app_private.job_queue
  FOR INSERT WITH CHECK (
    pg_has_role(session_user, 'casa_clara_worker', 'member')
    OR app.tenant_context_matches(household_id)
  );
CREATE POLICY job_queue_worker_update ON app_private.job_queue
  FOR UPDATE USING (pg_has_role(session_user, 'casa_clara_worker', 'member'))
  WITH CHECK (pg_has_role(session_user, 'casa_clara_worker', 'member'));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO casa_clara_app;
REVOKE INSERT, UPDATE, DELETE ON app.audit_events FROM casa_clara_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO casa_clara_app;
GRANT SELECT ON app.compensation_balances, app.advance_balances,
  app.settlement_payment_totals TO casa_clara_app;

-- The queue has no direct application-role grant. BFF code enqueues only through
-- app.enqueue_job; the worker group alone can claim and mutate queue rows.
GRANT SELECT, INSERT, UPDATE ON app_private.job_queue TO casa_clara_worker;
GRANT SELECT ON app.audit_events TO casa_clara_worker;

COMMIT;
