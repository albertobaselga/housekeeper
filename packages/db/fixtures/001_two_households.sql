BEGIN;

-- Deterministic, wholly fictitious acceptance data. Fixtures require the migration
-- owner or another BYPASSRLS role because they bootstrap households and memberships.
SET LOCAL row_security = off;

INSERT INTO app.households (id, slug, display_name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'fixture-casa-roble', 'Fixture Casa Roble'),
  ('20000000-0000-4000-8000-000000000001', 'fixture-casa-olivo', 'Fixture Casa Olivo');

INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('fixture:roble:admin', 'Fixture Admin Roble'),
  ('fixture:roble:family', 'Fixture Familiar Roble'),
  ('fixture:roble:employee', 'Fixture Empleada Roble'),
  ('fixture:roble:helper', 'Fixture Apoyo Roble'),
  ('fixture:roble:viewer', 'Fixture Visor Roble'),
  ('fixture:roble:employee2', 'Fixture Segunda Empleada Roble'),
  ('fixture:olivo:admin', 'Fixture Admin Olivo'),
  ('fixture:olivo:employee', 'Fixture Empleada Olivo');

INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'fixture:roble:admin', 'family_admin'),
  ('11000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'fixture:roble:family', 'family_member'),
  ('11000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'fixture:roble:employee', 'employee_live_in'),
  ('11000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'fixture:roble:helper', 'helper'),
  ('11000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'fixture:roble:viewer', 'viewer'),
  -- Segunda empleada del MISMO hogar: el modelo admite varios acuerdos activos
  -- a la vez y la administración tiene que poder elegir a quién apunta cada
  -- cosa. Aquí está para que eso se pruebe de verdad, no de palabra.
  ('11000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', 'fixture:roble:employee2', 'employee_live_in'),
  ('21000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'fixture:olivo:admin', 'family_admin'),
  ('21000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'fixture:olivo:employee', 'employee_live_in');

INSERT INTO app.employment_agreements (
  id, household_id, employee_membership_id, starts_on, created_by_membership_id
) VALUES
  ('12000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '11000000-0000-4000-8000-000000000003', '2025-02-03', '11000000-0000-4000-8000-000000000001'),
  -- Empieza ANTES que el primero a propósito: el orden por defecto del
  -- expediente (activo primero, luego `starts_on desc`) no debe cambiar por
  -- añadir una compañera, y quien administra la alcanza eligiéndola.
  ('12000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '11000000-0000-4000-8000-000000000006', '2025-01-07', '11000000-0000-4000-8000-000000000001'),
  ('22000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '21000000-0000-4000-8000-000000000002', '2025-01-01', '21000000-0000-4000-8000-000000000001');

INSERT INTO app.agreement_versions (
  id, household_id, agreement_id, version_number, effective_from,
  monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
  worked_rest_day_credit_minutes, contracted_weekly_minutes, reason,
  created_by_membership_id, created_at
) VALUES
  ('12100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', 1, '2025-02-03',
   140000, 1200, 7000, 1440, 2400, 'Initial fixture agreement',
   '11000000-0000-4000-8000-000000000001', '2025-02-01T10:00:00Z'),
  ('12100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', 2, '2025-04-01',
   150000, 1400, 8000, 1440, 2400, 'Future fixture agreement',
   '11000000-0000-4000-8000-000000000001', '2025-03-20T10:00:00Z'),
  ('12100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000002', 1, '2025-01-07',
   90000, 0, 4000, 1440, 1200, 'Second Roble employee fixture',
   '11000000-0000-4000-8000-000000000001', '2025-01-05T10:00:00Z'),
  ('22100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', 1, '2025-01-01',
   130000, 1100, 6500, 1440, 2400, 'Independent second-household fixture',
   '21000000-0000-4000-8000-000000000001', '2024-12-20T10:00:00Z');

-- Catálogo de condiciones (migración 0021).
--
-- El escenario es el que pidió el propietario: a ESTA empleada se le permiten
-- JORNADAS pero NO horas extra, y por tanto no debe poder ver una tarifa
-- horaria por ninguna vía. Para que eso sea cierto de verdad —no solo en la
-- versión vigente— el acuerdo del roble no cataloga ninguna hora en NINGUNA de
-- sus versiones: la v2 tiene el concepto desactivado y la v1 ni siquiera lo
-- tiene. Sus horas extra de 2025 son historia anterior al catálogo y por eso
-- llevan `extra_work_type_id` nulo, valoradas con las columnas de 0002; es
-- exactamente lo que verá un hogar real recién migrado.
--
-- 'sin_tarifa' existe pactado pero sin precio: tampoco lo ve.
--
-- El olivo sí conserva el par equivalente a las columnas de 0002 en su única
-- versión, y allí las horas están permitidas: la invisibilidad del roble es una
-- decisión de su acuerdo, no un efecto del modelo.
INSERT INTO app.extra_work_types (
  id, household_id, agreement_id, agreement_version_id, code, name, unit,
  rate_cents, reference_minutes, active, sort_order, created_by_membership_id
) VALUES
  ('13000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000001',
   'worked_rest_day', 'Festivo o descanso trabajado', 'per_shift', 7000, 1440, true, 20,
   '11000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'overtime', 'Hora extraordinaria', 'per_hour', 1400, NULL, false, 10,
   '11000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'worked_rest_day', 'Festivo o descanso trabajado', 'per_shift', 8000, 1440, true, 20,
   '11000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'jornada_extra', 'Jornada extra', 'per_shift', 5000, 600, true, 30,
   '11000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'noche_de_guardia', 'Noche de guardia', 'fixed_amount', 5000, 720, true, 40,
   '11000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'sin_tarifa', 'Acompañamiento a médico', 'fixed_amount', NULL, NULL, true, 50,
   '11000000-0000-4000-8000-000000000001'),
  -- Catálogo de la segunda empleada del roble: dos jornadas y ninguna hora,
  -- que es como se pacta de verdad en una casa. Sus conceptos son SUYOS: la
  -- administración no puede apuntarle un concepto del acuerdo de su compañera
  -- (el servidor lo rechaza) ni ella ve los de nadie más (la RLS lo impide).
  ('13000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000002', '12100000-0000-4000-8000-000000000003',
   'jornada_completa', 'Jornada completa', 'per_shift', 6000, 600, true, 10,
   '11000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000002', '12100000-0000-4000-8000-000000000003',
   'media_jornada', 'Media jornada', 'per_shift', 3000, 300, true, 20,
   '11000000-0000-4000-8000-000000000001'),
  ('23000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000001',
   'overtime', 'Hora extraordinaria', 'per_hour', 1100, NULL, true, 10,
   '21000000-0000-4000-8000-000000000001'),
  ('23000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000001',
   'worked_rest_day', 'Festivo o descanso trabajado', 'per_shift', 6500, 1440, true, 20,
   '21000000-0000-4000-8000-000000000001');

-- Complementos: la antigüedad es dinero para ella y suma al mes; el seguro
-- médico lo paga la casa aparte y solo consta como condición. El plus de
-- transporte quedó retirado en esta versión y no debe verlo nadie salvo quien
-- administra.
INSERT INTO app.recurring_supplements (
  id, household_id, agreement_id, agreement_version_id, code, name, amount_cents,
  periodicity, adds_to_pay, starts_on, ends_on, active, sort_order, created_by_membership_id
) VALUES
  ('14000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'antiguedad', 'Complemento de antigüedad', 3000, 'monthly', true, NULL, NULL, true, 10,
   '11000000-0000-4000-8000-000000000001'),
  ('14000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'seguro_medico', 'Seguro médico privado', 4500, 'monthly', false, NULL, NULL, true, 20,
   '11000000-0000-4000-8000-000000000001'),
  ('14000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   'plus_transporte', 'Plus de transporte', 2000, 'monthly', true, NULL, NULL, false, 30,
   '11000000-0000-4000-8000-000000000001');

-- Horario pactado (migración 0025). Tres casos a propósito, uno por versión:
--
--   · Roble v1 — NINGÚN horario. Es el «si aplica» del encargo puesto en los
--     datos: hay contratos que no lo declaran, y entonces la empleada no debe
--     ver una sección vacía ni un hueco con guiones. También es lo que verá
--     cualquier hogar ya dado de alta antes de esta migración.
--
--   · Roble v2 — el caso completo y COHERENTE. Jornada tipo de 08:00 a 16:30
--     con hora y media de descanso al mediodía (7 h efectivas), el sábado se
--     termina a las 14:30 (5 h efectivas) y el domingo se libra. Suma
--     5×420 + 300 = 2400 minutos a la semana, exactamente los
--     `contracted_weekly_minutes` de esa versión: la pantalla no debe avisar de
--     nada.
--
--     El sábado es UNA fila que solo cambia `ends_at`: ni repite la hora de
--     entrada ni el descanso, porque no cambian. Es la forma que pedía el
--     encargo, «excepciones por día sin obligar a rellenar los siete».
--
--   · Olivo v1 — el caso INCOHERENTE, que existe para que la comparación con la
--     jornada contratada tenga algo que denunciar. De 08:00 a 20:00 con dos
--     horas de descanso (10 h efectivas) y solo el domingo libre suman 3600
--     minutos frente a los 2400 contratados. No es un descuido de la fixture:
--     es el hecho que la pantalla tiene que decir en voz alta en vez de callar.
INSERT INTO app.agreement_schedules (
  id, household_id, agreement_id, agreement_version_id,
  starts_at, ends_at, long_break_minutes, note, created_by_membership_id
) VALUES
  ('15000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000002',
   '08:00', '16:30', 90, 'El descanso largo se toma al mediodía, después de comer.',
   '11000000-0000-4000-8000-000000000001'),
  ('25000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000001',
   '08:00', '20:00', 120, '', '21000000-0000-4000-8000-000000000001');

INSERT INTO app.agreement_schedule_days (
  id, household_id, agreement_id, schedule_id,
  weekday, works, starts_at, ends_at, long_break_minutes, note, created_by_membership_id
) VALUES
  -- Sábado: se termina antes. Solo cambia la hora de salida.
  ('16000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001',
   6, true, NULL, '14:30', NULL, '', '11000000-0000-4000-8000-000000000001'),
  -- Domingo: libranza. Un día libre no declara horas.
  ('16000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001',
   7, false, NULL, NULL, NULL, '', '11000000-0000-4000-8000-000000000001'),
  ('26000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001',
   7, false, NULL, NULL, NULL, '', '21000000-0000-4000-8000-000000000001');

INSERT INTO app.weekly_time_reports (
  id, household_id, agreement_id, employee_membership_id, week_starts_on,
  status, submitted_at, submitted_by_membership_id, confirmed_at, confirmed_by_membership_id
) VALUES (
  '12200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
  '2025-03-10', 'confirmed', '2025-03-16T18:00:00Z', '11000000-0000-4000-8000-000000000003',
  '2025-03-17T09:00:00Z', '11000000-0000-4000-8000-000000000001'
);

INSERT INTO app.time_entries (
  id, household_id, report_id, employee_membership_id, worked_on,
  started_at, ended_at, regular_minutes, note
) VALUES
  ('12300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12200000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2025-03-12', '09:00', '19:00', 480, 'Fixture report with two extra hours');

-- `extra_work_type_id` apunta siempre al tipo de la versión vigente el día
-- trabajado (marzo de 2025 → v1), y su tarifa coincide con la congelada: el
-- disparador `extra_work_events_type_freeze` de 0021 rechazaría lo contrario.
INSERT INTO app.extra_work_events (
  id, household_id, agreement_id, employee_membership_id, extra_work_type_id, kind, worked_on,
  duration_minutes, note, origin, status, resolution, resolved_agreement_version_id,
  frozen_unit_rate_cents, frozen_amount_cents, balance_minutes,
  requested_by_membership_id, requested_at, approved_by_membership_id, approved_at,
  performed_by_membership_id, performed_at, resolved_by_membership_id, resolved_at,
  resolution_reason
) VALUES
  ('12400000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', '13000000-0000-4000-8000-000000000002',
   'worked_rest_day', '2025-03-09', 480, 'Fixture worked Sunday', 'employee_report',
   'resolved', 'money', '12100000-0000-4000-8000-000000000001', 7000, 7000, 0,
   '11000000-0000-4000-8000-000000000003', '2025-03-09T18:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-09T19:00:00Z',
   '11000000-0000-4000-8000-000000000003', '2025-03-09T20:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-10T09:00:00Z', 'Fixture weekly report confirmed'),
  ('12400000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', NULL,
   'overtime', '2025-03-12', 120, 'Fixture overtime', 'weekly_report',
   'resolved', 'money', '12100000-0000-4000-8000-000000000001', 1200, 2400, 0,
   '11000000-0000-4000-8000-000000000003', '2025-03-12T19:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-13T09:00:00Z',
   '11000000-0000-4000-8000-000000000003', '2025-03-12T19:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-13T09:00:00Z', 'Fixture weekly report confirmed'),
  ('12400000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', NULL,
   'overtime', '2025-03-18', 60, 'Fixture overtime', 'weekly_report',
   'resolved', 'money', '12100000-0000-4000-8000-000000000001', 1200, 1200, 0,
   '11000000-0000-4000-8000-000000000003', '2025-03-18T19:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-19T09:00:00Z',
   '11000000-0000-4000-8000-000000000003', '2025-03-18T19:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-19T09:00:00Z', 'Fixture weekly report confirmed'),
  ('12400000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', '13000000-0000-4000-8000-000000000002',
   'worked_rest_day', '2025-03-23', 480, 'Fixture permanent day credit', 'employee_report',
   'resolved', 'time_off', '12100000-0000-4000-8000-000000000001', 7000, 0, 1440,
   '11000000-0000-4000-8000-000000000003', '2025-03-23T18:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-24T09:00:00Z',
   '11000000-0000-4000-8000-000000000003', '2025-03-23T20:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2025-03-24T09:00:00Z', 'Permanent credit selected'),
  ('12400000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', NULL,
   'overtime', '2025-03-27', 45, 'Unapproved performed fixture', 'employee_report',
   'performed_pending_resolution', NULL, NULL, NULL, NULL, NULL,
   '11000000-0000-4000-8000-000000000003', '2025-03-27T18:00:00Z',
   NULL, NULL, '11000000-0000-4000-8000-000000000003', '2025-03-27T19:00:00Z',
   NULL, NULL, NULL);

INSERT INTO app.extra_work_transitions (
  id, household_id, extra_work_event_id, sequence_number, from_status, to_status,
  actor_membership_id, occurred_at, reason
) VALUES
  ('12500000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000001', 1, NULL, 'requested', '11000000-0000-4000-8000-000000000003', '2025-03-09T18:00:00Z', 'Requested'),
  ('12500000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000001', 2, 'requested', 'accepted', '11000000-0000-4000-8000-000000000001', '2025-03-09T19:00:00Z', 'Accepted'),
  ('12500000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000001', 3, 'accepted', 'performed', '11000000-0000-4000-8000-000000000003', '2025-03-09T20:00:00Z', 'Performed'),
  ('12500000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000001', 4, 'performed', 'resolved', '11000000-0000-4000-8000-000000000001', '2025-03-10T09:00:00Z', 'Resolved'),
  ('12500000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000005', 1, NULL, 'requested', '11000000-0000-4000-8000-000000000003', '2025-03-27T18:00:00Z', 'Requested'),
  ('12500000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000005', 2, 'requested', 'performed_pending_resolution', '11000000-0000-4000-8000-000000000003', '2025-03-27T19:00:00Z', 'Performed without prior approval'),
  ('12500000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000002', 1, NULL, 'requested', '11000000-0000-4000-8000-000000000003', '2025-03-12T19:00:00Z', 'Requested'),
  ('12500000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000002', 2, 'requested', 'performed_pending_resolution', '11000000-0000-4000-8000-000000000003', '2025-03-12T19:00:00Z', 'Performed without prior approval'),
  ('12500000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000002', 3, 'performed_pending_resolution', 'resolved', '11000000-0000-4000-8000-000000000001', '2025-03-13T09:00:00Z', 'Resolved'),
  ('12500000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000003', 1, NULL, 'requested', '11000000-0000-4000-8000-000000000003', '2025-03-18T19:00:00Z', 'Requested'),
  ('12500000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000003', 2, 'requested', 'performed_pending_resolution', '11000000-0000-4000-8000-000000000003', '2025-03-18T19:00:00Z', 'Performed without prior approval'),
  ('12500000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000003', 3, 'performed_pending_resolution', 'resolved', '11000000-0000-4000-8000-000000000001', '2025-03-19T09:00:00Z', 'Resolved'),
  ('12500000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000004', 1, NULL, 'requested', '11000000-0000-4000-8000-000000000003', '2025-03-23T18:00:00Z', 'Requested'),
  ('12500000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000004', 2, 'requested', 'performed_pending_resolution', '11000000-0000-4000-8000-000000000003', '2025-03-23T20:00:00Z', 'Performed without prior approval'),
  ('12500000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000004', 3, 'performed_pending_resolution', 'resolved', '11000000-0000-4000-8000-000000000001', '2025-03-24T09:00:00Z', 'Resolved as permanent time credit');

INSERT INTO app.compensation_accounts (
  id, household_id, agreement_id, employee_membership_id, balance_type
) VALUES (
  '12600000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
  'worked_rest_day'
);

INSERT INTO app.compensation_ledger_entries (
  id, household_id, account_id, sequence_number, kind, delta_minutes, effective_on,
  source_type, source_id, recorded_by_membership_id, recorded_at, note
) VALUES (
  '12700000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12600000-0000-4000-8000-000000000001', 1, 'credit', 1440, '2025-03-23',
  'extra_work_event', '12400000-0000-4000-8000-000000000004',
  '11000000-0000-4000-8000-000000000001', '2025-03-24T09:01:00Z', 'Permanent credit; no expiry');

INSERT INTO app.advances (
  id, household_id, agreement_id, employee_membership_id, principal_cents,
  issued_on, repayment_cents, created_by_membership_id
) VALUES (
  '12800000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
  40000, '2025-01-01', 10000, '11000000-0000-4000-8000-000000000001'
);

INSERT INTO app.advance_ledger_entries (
  id, household_id, advance_id, sequence_number, kind, delta_cents, effective_on,
  source_type, source_id, recorded_by_membership_id
) VALUES
  ('12900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '12800000-0000-4000-8000-000000000001', 1, 'disbursement', 40000, '2025-01-01', 'advance', '12800000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
  ('12900000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '12800000-0000-4000-8000-000000000001', 2, 'repayment', -10000, '2025-02-28', 'repayment', '12900000-0000-4000-8000-000000000012', '11000000-0000-4000-8000-000000000001'),
  ('12900000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '12800000-0000-4000-8000-000000000001', 3, 'repayment', -10000, '2025-03-31', 'settlement_installment', '12900000-0000-4000-8000-000000000013', '11000000-0000-4000-8000-000000000001');

INSERT INTO app.expenses (
  id, household_id, agreement_id, employee_membership_id, incurred_on,
  description, amount_cents, status, submitted_by_membership_id, submitted_at,
  resolved_by_membership_id, resolved_at, resolution_reason
) VALUES
  ('12a00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', '2025-03-15', 'Fixture pharmacy purchase', 1850, 'approved', '11000000-0000-4000-8000-000000000003', '2025-03-15T18:00:00Z', '11000000-0000-4000-8000-000000000001', '2025-03-26T09:00:00Z', 'Fixture household expense'),
  ('12a00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', '2025-03-22', 'Fixture grocery purchase', 2880, 'approved', '11000000-0000-4000-8000-000000000003', '2025-03-22T18:00:00Z', '11000000-0000-4000-8000-000000000001', '2025-03-26T09:00:00Z', 'Fixture household expense');

INSERT INTO app.settlements (
  id, household_id, agreement_id, employee_membership_id, period_start,
  period_end, due_on, created_by_membership_id
) VALUES (
  '12b00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
  '2025-03-01', '2025-03-31', '2025-03-31', '11000000-0000-4000-8000-000000000001'
);

INSERT INTO app.settlement_lines (
  id, household_id, settlement_id, agreement_id, employee_membership_id,
  line_number, section, kind, occurred_on, concept, amount_cents,
  agreement_version_id, extra_work_event_id, advance_ledger_entry_id, expense_id
) VALUES
  ('12c00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 1, 'salary', 'base_salary', '2025-03-01', 'Fixture base salary', 140000, '12100000-0000-4000-8000-000000000001', NULL, NULL, NULL),
  ('12c00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 2, 'salary', 'extra_work', '2025-03-09', 'Fixture worked rest day', 7000, '12100000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000001', NULL, NULL),
  ('12c00000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 3, 'salary', 'extra_work', '2025-03-12', 'Fixture overtime', 2400, '12100000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000002', NULL, NULL),
  ('12c00000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 4, 'salary', 'extra_work', '2025-03-18', 'Fixture overtime', 1200, '12100000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000003', NULL, NULL),
  ('12c00000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 5, 'salary', 'time_off_compensation', '2025-03-23', 'Fixture permanent time credit', 0, '12100000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000004', NULL, NULL),
  ('12c00000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 6, 'salary', 'advance_deduction', '2025-03-31', 'Fixture advance installment', -10000, NULL, NULL, '12900000-0000-4000-8000-000000000003', NULL),
  ('12c00000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 7, 'reimbursement', 'expense_reimbursement', '2025-03-15', 'Fixture pharmacy reimbursement', 1850, NULL, NULL, NULL, '12a00000-0000-4000-8000-000000000001'),
  ('12c00000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 8, 'reimbursement', 'expense_reimbursement', '2025-03-22', 'Fixture grocery reimbursement', 2880, NULL, NULL, NULL, '12a00000-0000-4000-8000-000000000002');

UPDATE app.settlements
   SET status = 'closed',
       closed_by_membership_id = '11000000-0000-4000-8000-000000000001',
       closed_at = '2025-03-28T18:00:00Z',
       snapshot_hash = repeat('a', 64)
 WHERE id = '12b00000-0000-4000-8000-000000000001';

INSERT INTO app.payments (
  id, household_id, settlement_id, employee_membership_id, amount_cents,
  method, value_on, reference, recorded_by_membership_id, recorded_at
) VALUES
  ('12d00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 80000, 'bank_transfer', '2025-03-29', 'Fixture part one', '11000000-0000-4000-8000-000000000001', '2025-03-29T10:00:00Z'),
  ('12d00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '12b00000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 65330, 'bank_transfer', '2025-03-31', 'Fixture part two', '11000000-0000-4000-8000-000000000001', '2025-03-31T10:00:00Z');

INSERT INTO app.settlement_receipt_confirmations (
  id, household_id, settlement_id, employee_membership_id, confirmed_at, note
) VALUES (
  '12e00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12b00000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
  '2025-03-31T18:42:00Z', 'Fixture total received'
);

INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
) VALUES (
  '12f00000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'fixture-documents', 'fixture/casa-roble/receipt.txt', 'text/plain', 24, repeat('b', 64),
  '11000000-0000-4000-8000-000000000001'
);
INSERT INTO app.documents (
  id, household_id, storage_object_id, visibility, document_type, title,
  created_by_membership_id, metadata
) VALUES (
  '12f00000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  '12f00000-0000-4000-8000-000000000001', 'employment', 'fixture_receipt',
  'Fixture receipt metadata', '11000000-0000-4000-8000-000000000001', '{"fixture": true}'
);

INSERT INTO app.command_receipts (
  id, household_id, operation_id, command_type, payload_hash, result, actor_membership_id
) VALUES (
  '12f00000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
  '12f00000-0000-4000-8000-000000000004', 'fixture.settlement.close', repeat('c', 64),
  '{"settlementId": "12b00000-0000-4000-8000-000000000001", "totalCents": 145330}',
  '11000000-0000-4000-8000-000000000001'
);

INSERT INTO app_private.job_queue (
  id, household_id, job_type, payload, run_at
) VALUES (
  '12f00000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
  'fixture.document.render', '{"documentId": "12f00000-0000-4000-8000-000000000002"}',
  '2099-01-01T00:00:00Z'
);

COMMIT;
