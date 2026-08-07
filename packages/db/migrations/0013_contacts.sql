BEGIN;

-- Contactos reales del hogar (P2-2 de la re-auditoría UX: Contactos y
-- Emergencias servían fixtures sin marca). Visibles para los cinco roles
-- (viewer incluido: es parte de su mínimo operativo); escribe la familia.
CREATE TABLE app.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  role_label text NOT NULL DEFAULT '' CHECK (length(role_label) <= 120),
  phone text NOT NULL CHECK (phone ~ '^[0-9+][0-9 ().-]{1,24}$'),
  kind text NOT NULL DEFAULT 'otros' CHECK (kind IN ('emergency', 'health', 'home', 'service', 'school', 'otros')),
  featured boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  position integer NOT NULL DEFAULT 0,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

ALTER TABLE app.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY contacts_read ON app.contacts
  FOR SELECT USING (
    app.tenant_context_matches(household_id) AND app.current_household_role() IS NOT NULL
  );
CREATE POLICY contacts_family_write ON app.contacts
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.contacts TO casa_clara_app;

CREATE TRIGGER contacts_audit
AFTER INSERT OR UPDATE OR DELETE ON app.contacts
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

COMMIT;
