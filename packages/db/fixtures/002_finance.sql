BEGIN;

-- Datos de finanzas deterministas y ENTERAMENTE inventados para los dos
-- hogares fixture, y la concesión viva SOLO para la administración del roble
-- (spec §4). Prefijos de UUID f1* (roble) y f2* (olivo), exclusivos de este
-- fichero. Requiere el propietario de las migraciones (bootstrap con RLS off).
SET LOCAL row_security = off;

-- Concesión: solo el admin del roble tiene Finanzas encendido.
INSERT INTO app.finance_module_grants (id, household_id, membership_id, granted_by_membership_id) VALUES
  ('f1900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');

INSERT INTO app.finance_accounts (id, household_id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('f1a00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Cuenta común fixture', 'caixabank', 'comun', 'familia',
   'ES0000000000000000000001', '["FAMILIA FIXTURE"]', '[]'),
  ('f1a00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'Fondo indexado fixture', 'openbank', 'inversion', 'familia',
   'ES0000000000000000000002', '[]', '["FIXTURE FONDO"]'),
  ('f2a00000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Cuenta del olivo', 'deutsche_bank', 'comun', 'familia',
   'ES0000000000000000000003', '[]', '[]');

-- Árbol de 2 niveles; exactamente UNA raíz `transferencia` por hogar.
INSERT INTO app.finance_categories (id, household_id, parent_id, name, kind) VALUES
  ('f1c00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', NULL, 'Casa', 'gasto'),
  ('f1c00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'f1c00000-0000-4000-8000-000000000001', 'Supermercado', 'gasto'),
  ('f1c00000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', NULL, 'Nómina', 'ingreso'),
  ('f1c00000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', NULL, 'Transferencias', 'transferencia'),
  ('f2c00000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', NULL, 'Gastos del olivo', 'gasto'),
  ('f2c00000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', NULL, 'Transferencias', 'transferencia');

INSERT INTO app.finance_rules (id, household_id, rule_type, pattern, category_id, priority, origin) VALUES
  ('f1b00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'proveedor_exacto', 'MERCADO EJEMPLO', 'f1c00000-0000-4000-8000-000000000002', 10, 'manual');

INSERT INTO app.finance_import_batches (id, household_id, filename, bank, new_count, dup_count) VALUES
  ('f1800000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'extracto-fixture.xls', 'caixabank', 2, 0);

INSERT INTO app.finance_transactions (
  id, household_id, account_id, batch_id, op_date, value_date, concept,
  provider, provider_norm, amount_cents, balance_cents, category_id, status,
  dedup_hash, raw
) VALUES
  ('f1e00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'f1a00000-0000-4000-8000-000000000001', 'f1800000-0000-4000-8000-000000000001',
   '2026-01-10', '2026-01-10', 'COMPRA MERCADO EJEMPLO',
   'Mercado Ejemplo', 'MERCADO EJEMPLO', -2350, 100000,
   'f1c00000-0000-4000-8000-000000000002', 'confirmada',
   'fixture-roble-tx-0001', '{"concepto": "COMPRA MERCADO EJEMPLO"}'),
  ('f1e00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'f1a00000-0000-4000-8000-000000000001', 'f1800000-0000-4000-8000-000000000001',
   '2026-01-25', '2026-01-25', 'NOMINA EMPRESA FIXTURE',
   'Empresa Fixture', 'EMPRESA FIXTURE', 180000, 280000,
   NULL, 'pendiente',
   'fixture-roble-tx-0002', '{"concepto": "NOMINA EMPRESA FIXTURE"}'),
  ('f2e00000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'f2a00000-0000-4000-8000-000000000001', NULL,
   '2026-02-05', NULL, 'GASTO DEL OLIVO',
   NULL, NULL, -1500, NULL,
   NULL, 'pendiente',
   'fixture-olivo-tx-0001', '{}');

INSERT INTO app.finance_provider_aliases (id, household_id, provider_norm, display) VALUES
  ('f1d00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'MERCADO EJEMPLO', 'Mercado Ejemplo');

INSERT INTO app.finance_events (id, household_id, name) VALUES
  ('f1f00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Semana Santa 2026');

INSERT INTO app.finance_transaction_events (id, household_id, transaction_id, event_id) VALUES
  ('f1f10000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'f1e00000-0000-4000-8000-000000000001', 'f1f00000-0000-4000-8000-000000000001');

INSERT INTO app.finance_event_rules (id, household_id, event_id, provider_norm, concept_norm, category_id) VALUES
  ('f1f20000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'f1f00000-0000-4000-8000-000000000001', 'MERCADO EJEMPLO', NULL, NULL);

COMMIT;
