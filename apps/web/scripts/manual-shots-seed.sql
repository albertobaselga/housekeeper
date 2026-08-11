-- ───────────────────────────────────────────────────────────────────────────
-- Contenido sintético para las capturas del manual de usuario.
--
-- Se aplica DESPUÉS de:
--   1. packages/db/scripts/bootstrap.mjs + migrate.mjs
--   2. packages/db/fixtures/*.sql
--   3. la siembra de apps/web/e2e/db-global-setup.ts
--   4. packages/db/scripts/import-manual.mjs (la Guía completa)
--
-- Hace dos cosas:
--   · Presenta lo que ya hay: quita los sufijos «Fixture» y «E2E» de todo lo
--     que sale en pantalla y fecha las altas en el pasado, para que una captura
--     no enseñe nombres de banco de pruebas.
--   · Rellena lo que las fixtures dejan vacío y el manual necesita enseñar:
--     menú de la semana, lista de la compra, rutinas de las cinco clases de
--     ritmo, calendario enlazado, vacaciones (incluidas anuladas), avance de
--     lectura de la Guía y una persona que ya no trabaja en la casa.
--
-- TODO es inventado. Ni un dato de nadie. Se ejecuta con el rol propietario de
-- las migraciones (casa_admin), que es quien puede saltarse la RLS.
--
-- Uso:
--   psql -d <base> -v ON_ERROR_STOP=1 -f apps/web/scripts/manual-shots-seed.sql
-- ───────────────────────────────────────────────────────────────────────────

BEGIN;
SET LOCAL row_security = off;

-- La semana y el día que se retratan. `current_date` manda: las capturas se
-- rehacen cuando toque y ninguna fecha se queda vieja dentro del PNG.
CREATE TEMP TABLE _hoy ON COMMIT DROP AS
SELECT
  current_date                                                   AS hoy,
  (current_date - ((EXTRACT(isodow FROM current_date)::int) - 1)) AS lunes;

-- ── 1 · Nombres presentables ───────────────────────────────────────────────

UPDATE app.households SET display_name = 'Casa Roble'
 WHERE id = '10000000-0000-4000-8000-000000000001';

UPDATE app.user_profiles SET display_name = v.nombre, email = v.correo
  FROM (VALUES
    ('fixture:roble:admin',     'Alberto', 'alberto@casaroble.invalid'),
    ('fixture:roble:family',    'Marta',   'marta@casaroble.invalid'),
    ('fixture:roble:employee',  'Ana',     'ana@casaroble.invalid'),
    ('fixture:roble:helper',    'Lucía',   'lucia@casaroble.invalid'),
    ('fixture:roble:viewer',    'Diego',   'diego@casaroble.invalid'),
    ('fixture:roble:employee2', 'Nuria',   'nuria@casaroble.invalid')
  ) AS v(uid, nombre, correo)
 WHERE app.user_profiles.user_id = v.uid;

-- Las altas no fueron todas hoy: cada persona lleva su tiempo en la casa.
UPDATE app.household_memberships SET starts_at = v.desde
  FROM (VALUES
    ('fixture:roble:admin',     '2024-09-02'::date),
    ('fixture:roble:family',    '2024-09-02'::date),
    ('fixture:roble:employee',  '2025-02-03'::date),
    ('fixture:roble:helper',    '2025-06-16'::date),
    ('fixture:roble:viewer',    '2026-03-09'::date),
    ('fixture:roble:employee2', '2025-01-07'::date)
  ) AS v(uid, desde)
 WHERE app.household_memberships.user_id = v.uid
   AND app.household_memberships.household_id = '10000000-0000-4000-8000-000000000001';

UPDATE app.routines SET title = replace(title, ' (E2E)', '');
UPDATE app.foods   SET name  = replace(name, ' E2E', '');
UPDATE app.diners  SET name  = replace(name, ' (comensal E2E)', '');

UPDATE app.wiki_spaces SET name = 'Recetario', slug = 'recetario',
       description = 'Las recetas de casa, con sus ingredientes'
 WHERE slug = 'cocina-e2e';

-- Las revisiones de la Guía son inmutables (disparador `wiki_revision_append`):
-- para quitarle el «(E2E)» al título de las dos recetas se añade una revisión
-- nueva, que es como lo haría la propia aplicación.
INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown,
                                summary, tags, aliases, authored_by_membership_id)
SELECT v.nueva, r.household_id, r.page_id, r.revision_number + 1,
       replace(r.title, ' (E2E)', ''), r.body_markdown, r.summary, r.tags, r.aliases,
       r.authored_by_membership_id
  FROM app.wiki_revisions r
  JOIN (VALUES
    ('aa411000-0000-4000-8000-000000000001'::uuid, 'c7000000-0000-4000-8000-000000000001'::uuid),
    ('aa421000-0000-4000-8000-000000000001'::uuid, 'c7000000-0000-4000-8000-000000000002'::uuid)
  ) AS v(vieja, nueva) ON v.vieja = r.id;

UPDATE app.wiki_pages SET current_revision_id = 'c7000000-0000-4000-8000-000000000001',
                          current_slug = 'arroz-con-leche'
 WHERE id = 'aa410000-0000-4000-8000-000000000001';
UPDATE app.wiki_pages SET current_revision_id = 'c7000000-0000-4000-8000-000000000002',
                          current_slug = 'pollo-asado'
 WHERE id = 'aa420000-0000-4000-8000-000000000001';
UPDATE app.wiki_page_slugs SET slug = 'arroz-con-leche' WHERE slug = 'arroz-con-leche-e2e';
UPDATE app.wiki_page_slugs SET slug = 'pollo-asado'     WHERE slug = 'pollo-asado-e2e';

UPDATE app.expenses SET description = 'Farmacia · jarabe para Leo'
 WHERE description = 'Farmacia E2E pendiente';
UPDATE app.expenses SET description = 'Compra de la farmacia'  WHERE description = 'Fixture pharmacy purchase';
UPDATE app.expenses SET description = 'Compra del súper'       WHERE description = 'Fixture grocery purchase';

-- ── Traducción de las notas del expediente laboral ────────────────────────
--
-- `agreement_versions`, `extra_work_events` y sus transiciones son append-only
-- por disparador, y con razón: un histórico laboral no se reescribe. Aquí no se
-- está corrigiendo un histórico de nadie —son fixtures sintéticas sobre una base
-- desechable— sino traduciendo su texto para que una captura del manual no
-- enseñe «Fixture overtime». Los disparadores se apartan solo para esto y se
-- vuelven a poner tres sentencias más abajo.
ALTER TABLE app.agreement_versions DISABLE TRIGGER USER;
ALTER TABLE app.extra_work_events  DISABLE TRIGGER USER;

UPDATE app.extra_work_events SET note = CASE
         WHEN note = 'Plancha del sábado E2E'        THEN 'Plancha del sábado'
         WHEN note = 'Festivo trabajado E2E'         THEN 'Festivo trabajado en agosto'
         WHEN note = 'Unapproved performed fixture'  THEN 'Tarde de más por la mudanza'
         WHEN note LIKE 'Fixture overtime%'          THEN 'Dos horas de más'
         WHEN note = 'Fixture worked Sunday'         THEN 'Domingo trabajado'
         WHEN note = 'Fixture permanent day credit'  THEN 'Día compensado'
         WHEN note LIKE 'Fixture report%'            THEN 'Jornada de 8 a 19'
         ELSE note END;
-- El historial de transiciones es solo-añadir (`enforce_extra_work_transition_append`):
-- sus motivos no se reescriben. No salen en ninguna captura del manual.

UPDATE app.agreement_versions SET reason = 'Alta del contrato'
 WHERE reason = 'Initial fixture agreement';
UPDATE app.agreement_versions SET reason = 'Subida de salario y complementos'
 WHERE reason = 'Future fixture agreement';
UPDATE app.agreement_versions SET reason = 'Alta del contrato de media jornada'
 WHERE reason = 'Second Roble employee fixture';

ALTER TABLE app.extra_work_events  ENABLE TRIGGER USER;
ALTER TABLE app.agreement_versions ENABLE TRIGGER USER;

-- Misma razón, mismo apaño acotado: las líneas de una cuenta cerrada y sus
-- pagos tampoco se reescriben nunca en una casa de verdad.
ALTER TABLE app.settlement_lines DISABLE TRIGGER USER;
ALTER TABLE app.payments         DISABLE TRIGGER USER;

UPDATE app.settlement_lines SET concept = CASE concept
         WHEN 'Fixture base salary'            THEN 'Salario acordado'
         WHEN 'Fixture worked rest day'        THEN 'Domingo trabajado'
         WHEN 'Fixture overtime'               THEN 'Horas de más'
         WHEN 'Fixture permanent time credit'  THEN 'Día de descanso a cuenta'
         WHEN 'Fixture advance installment'    THEN 'Anticipo · cuota del mes'
         WHEN 'Fixture pharmacy reimbursement' THEN 'Reembolso de la farmacia'
         WHEN 'Fixture grocery reimbursement'  THEN 'Reembolso del súper'
         ELSE concept END;

UPDATE app.payments SET reference = 'Primer pago del mes' WHERE reference = 'Fixture part one';
UPDATE app.payments SET reference = 'Resto del mes'       WHERE reference = 'Fixture part two';
ALTER TABLE app.settlement_receipt_confirmations DISABLE TRIGGER USER;
UPDATE app.settlement_receipt_confirmations SET note = 'Recibido, gracias'
 WHERE note = 'Fixture total received';
ALTER TABLE app.settlement_receipt_confirmations ENABLE TRIGGER USER;

ALTER TABLE app.payments         ENABLE TRIGGER USER;
ALTER TABLE app.settlement_lines ENABLE TRIGGER USER;

UPDATE app.documents SET title = 'Recibo de marzo de 2025'
 WHERE title LIKE 'Fixture%' OR title LIKE '%fixture%';

-- ── 2 · Rutinas: las cinco clases de ritmo, con su «Cómo se hace» ──────────

UPDATE app.routines SET details = 'Aclarar el filtro de la jarra bajo el grifo y volver a montarlo. El repuesto está en el cajón de abajo del office.'
 WHERE id = 'aa500000-0000-4000-8000-000000000001';
UPDATE app.routines SET details = 'Mirar caducidades y reponer lo que falte. El botiquín está en el baño de la entrada, balda de arriba.'
 WHERE id = 'aa500000-0000-4000-8000-000000000002';

INSERT INTO app.routines (id, household_id, title, details, audience, next_due_hint,
                          created_by_membership_id, pattern, anchor_on, repeat_every, weekdays, month_day, months)
SELECT v.id, '10000000-0000-4000-8000-000000000001', v.titulo, v.detalle, v.audiencia::app.routine_audience,
       v.proxima, '11000000-0000-4000-8000-000000000001',
       v.patron::app.routine_pattern, v.ancla, v.cada, v.dias, v.dia_mes, v.meses
  FROM (VALUES
    -- Días fijos de la semana
    ('c0000000-0000-4000-8000-000000000001'::uuid, 'Sacar los cubos al portal',
     'Orgánico y envases los lunes y los jueves; el vidrio, cuando se llene el cubo verde.',
     'employee', (SELECT lunes + 3 FROM _hoy), 'days_of_week', (SELECT lunes FROM _hoy), 1,
     ARRAY[1,4]::smallint[], NULL::int, NULL::smallint[]),
    ('c0000000-0000-4000-8000-000000000002'::uuid, 'Cambiar las sábanas',
     'Todas las camas. La ropa de cama limpia está en el armario del pasillo.',
     'employee', (SELECT lunes + 5 FROM _hoy), 'days_of_week', (SELECT lunes FROM _hoy), 1,
     ARRAY[6]::smallint[], NULL::int, NULL::smallint[]),
    -- Por temporada
    ('c0000000-0000-4000-8000-000000000003'::uuid, 'Revisión de la caldera',
     'Llamar a Clima Norte antes de que empiece el frío. El contrato de mantenimiento está en la carpeta azul.',
     'family', NULL::date, 'months_of_year', '2026-10-01'::date, NULL::int,
     NULL::smallint[], 1, ARRAY[10]::smallint[]),
    ('c0000000-0000-4000-8000-000000000004'::uuid, 'Cambio de armario',
     'Bajar las cajas del altillo, ventilar la ropa un día y guardar la de la temporada anterior con las bolsas de lavanda.',
     'all', NULL::date, 'months_of_year', '2026-10-01'::date, NULL::int,
     NULL::smallint[], 1, ARRAY[4,10]::smallint[]),
    -- Cada cierto tiempo (meses)
    ('c0000000-0000-4000-8000-000000000005'::uuid, 'Limpiar los filtros del aire acondicionado',
     'Se sacan tirando hacia abajo, se aclaran con agua y se dejan secar antes de montarlos.',
     'employee', (SELECT hoy + 19 FROM _hoy), 'day_of_month', '2026-02-01'::date, 3, NULL::smallint[], 1, NULL::smallint[])
  ) AS v(id, titulo, detalle, audiencia, proxima, patron, ancla, cada, dias, dia_mes, meses);

-- «Todavía no lo sabemos»: sin patrón, sin fecha y sin salir en Hoy.
INSERT INTO app.routines (id, household_id, title, details, audience, next_due_hint, created_by_membership_id)
VALUES
  ('c0000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001',
   'Repasar el toldo de la terraza',
   'Hay que decidir cada cuánto. De momento queda apuntado para no perderlo.',
   'family', NULL, '11000000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001',
   'Descalcificar la cafetera',
   'Pendiente de mirar el manual del aparato para saber cada cuántos cafés toca.',
   'all', NULL, '11000000-0000-4000-8000-000000000001');

-- ── 3 · Comida: comensales, alimentos, menú de la semana y compra ──────────

UPDATE app.diners SET notes = 'Revisar siempre las etiquetas: alergia a la proteína de la leche.'
 WHERE name = 'Leo';

INSERT INTO app.foods (id, household_id, name, shopping_section, allergens_reviewed,
                       package_size, package_unit, created_by_membership_id)
VALUES
  ('c1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Lenteja pardina',   'despensa',   true, 500, 'g', '11000000-0000-4000-8000-000000000001'),
  ('c1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Calabaza',          'verdulería', true, NULL, NULL, '11000000-0000-4000-8000-000000000001'),
  ('c1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Merluza en lomos',  'pescadería', true, NULL, NULL, '11000000-0000-4000-8000-000000000001'),
  ('c1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Bebida de avena',   'lácteos',    true, 1, 'l',   '11000000-0000-4000-8000-000000000001'),
  ('c1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Huevos camperos',   'huevería',   true, 12, 'ud', '11000000-0000-4000-8000-000000000001');

-- El menú de la semana: comida y cena todos los días, más el desayuno de la
-- casa. Las notas son las que la familia escribiría de verdad.
INSERT INTO app.menu_slots (household_id, group_id, on_date, meal, recipe_page_id, free_text, notes, updated_by_membership_id)
SELECT '10000000-0000-4000-8000-000000000001', 'aa300000-0000-4000-8000-000000000001',
       (SELECT lunes FROM _hoy) + v.dia, v.comida::app.meal_slot, v.receta, v.plato, v.nota,
       '11000000-0000-4000-8000-000000000001'
  FROM (VALUES
    (0, 'desayuno', NULL::uuid, 'Tostadas, fruta y bebida de avena', ''),
    (0, 'comida',   NULL::uuid, 'Lentejas con verduras',             'Apartar una ración sin chorizo'),
    (0, 'cena',     NULL::uuid, 'Tortilla francesa y tomate',        ''),
    (1, 'desayuno', NULL::uuid, 'Tostadas, fruta y bebida de avena', ''),
    (1, 'comida',   'aa410000-0000-4000-8000-000000000001'::uuid, '', 'Para Leo, el suyo con bebida de avena'),
    (1, 'cena',     NULL::uuid, 'Merluza al horno con patata',       ''),
    (2, 'desayuno', NULL::uuid, 'Tostadas, fruta y bebida de avena', ''),
    (2, 'comida',   NULL::uuid, 'Pasta con tomate',                  'Triturar una ración para Leo'),
    (2, 'cena',     NULL::uuid, 'Crema de calabaza',                 'Sin nata: lleva bebida de avena'),
    (3, 'desayuno', NULL::uuid, 'Tostadas, fruta y bebida de avena', ''),
    (3, 'comida',   NULL::uuid, 'Garbanzos con espinacas',           ''),
    (3, 'merienda', NULL::uuid, 'Fruta y pan con aceite',            'Leo merienda al volver de la piscina'),
    (3, 'cena',     NULL::uuid, 'Pollo y verduras al horno',         ''),
    (4, 'desayuno', NULL::uuid, 'Tostadas, fruta y bebida de avena', ''),
    (4, 'comida',   'aa420000-0000-4000-8000-000000000001'::uuid, '', 'Doblar cantidad: se queda a comer la abuela'),
    (4, 'cena',     NULL::uuid, 'Pizza casera',                      'La base, sin queso en media pizza'),
    (5, 'comida',   NULL::uuid, 'Comida fuera',                      'Confirmar comensales el viernes'),
    (5, 'cena',     NULL::uuid, 'Sopa y sándwiches',                 ''),
    (6, 'comida',   NULL::uuid, 'Cocido familiar',                   'Guardar dos raciones para el lunes'),
    (6, 'cena',     NULL::uuid, 'Restos y fruta',                    '')
  ) AS v(dia, comida, receta, plato, nota);

-- Semana plantilla: la que la familia guardó para reutilizarla.
INSERT INTO app.menu_week_templates (id, household_id, name, source_week_starts_on, created_by_membership_id)
VALUES ('c2000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'Semana de siempre', (SELECT lunes - 7 FROM _hoy), '11000000-0000-4000-8000-000000000001');

INSERT INTO app.menu_week_template_slots (household_id, template_id, day_offset, meal, group_id, recipe_title, free_text, notes)
SELECT '10000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
       v.dia, v.comida::app.meal_slot, 'aa300000-0000-4000-8000-000000000001', '', v.plato, v.nota
  FROM (VALUES
    (0, 'comida', 'Lentejas con verduras',   'Apartar una ración sin chorizo'),
    (0, 'cena',   'Tortilla francesa',       ''),
    (1, 'comida', 'Arroz con pollo',         ''),
    (1, 'cena',   'Merluza al horno',        ''),
    (2, 'comida', 'Pasta con tomate',        'Triturar una ración para Leo'),
    (2, 'cena',   'Crema de calabaza',       'Sin nata'),
    (3, 'comida', 'Garbanzos con espinacas', ''),
    (3, 'cena',   'Pollo y verduras',        ''),
    (4, 'comida', 'Pescado del día',         ''),
    (4, 'cena',   'Pizza casera',            'Media, sin queso'),
    (5, 'comida', 'Comida fuera',            ''),
    (5, 'cena',   'Sopa y sándwiches',       ''),
    (6, 'comida', 'Cocido familiar',         ''),
    (6, 'cena',   'Restos y fruta',          '')
  ) AS v(dia, comida, plato, nota);

-- Lista de la compra: lo que no viene del menú, en sus secciones, y la lista
-- «Personal» —la compra de ella, que la casa paga aparte y nadie mezcla—.
INSERT INTO app.shopping_items (household_id, food_id, custom_name, quantity, unit, section,
                                week_starts_on, list_kind, created_by_membership_id, checked_at)
SELECT '10000000-0000-4000-8000-000000000001', v.food, v.nombre, v.cantidad, v.unidad, v.seccion,
       (SELECT lunes FROM _hoy), v.lista, '11000000-0000-4000-8000-000000000001', v.marcado
  FROM (VALUES
    (NULL::uuid, 'Papel de cocina',        2::numeric, 'ud',  'droguería',  'casa',     NULL::timestamptz),
    (NULL::uuid, 'Detergente de la ropa',  1::numeric, 'ud',  'droguería',  'casa',     NULL::timestamptz),
    (NULL::uuid, 'Fruta de temporada',     3::numeric, 'kg',  'frutería',   'casa',     NULL::timestamptz),
    ('c1000000-0000-4000-8000-000000000004'::uuid, NULL, 4::numeric, 'l', 'lácteos',    'casa', NULL::timestamptz),
    ('c1000000-0000-4000-8000-000000000005'::uuid, NULL, 12::numeric, 'ud', 'huevería', 'casa', now() - interval '2 hours'),
    (NULL::uuid, 'Café molido',            1::numeric, 'ud',  'despensa',   'personal', NULL::timestamptz),
    (NULL::uuid, 'Yogur natural',          6::numeric, 'ud',  'lácteos',    'personal', NULL::timestamptz),
    (NULL::uuid, 'Champú',                 1::numeric, 'ud',  'droguería',  'personal', NULL::timestamptz)
  ) AS v(food, nombre, cantidad, unidad, seccion, lista, marcado);

-- ── 4 · Calendario enlazado ────────────────────────────────────────────────

INSERT INTO app.ics_sources (id, household_id, url, label, enabled, last_fetched_at, created_by_membership_id)
VALUES ('c3000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'https://calendario.example/roble/familia.ics', 'Calendario de la familia', true,
        now() - interval '20 minutes', '11000000-0000-4000-8000-000000000001'),
       ('c3000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
        'https://calendario.example/roble/colegio.ics', 'Colegio Las Encinas', true,
        now() - interval '3 hours', '11000000-0000-4000-8000-000000000001');

INSERT INTO app.ics_source_events (household_id, source_id, uid, starts_at, ends_at, all_day,
                                   summary, location, source_label, content_hash)
SELECT '10000000-0000-4000-8000-000000000001', v.fuente, v.uid,
       ((SELECT lunes FROM _hoy) + v.dia)::timestamp + v.hora,
       ((SELECT lunes FROM _hoy) + v.dia)::timestamp + v.hora + interval '1 hour',
       false, v.titulo, v.lugar, v.etiqueta, encode(sha256(v.uid::bytea), 'hex')
  FROM (VALUES
    ('c3000000-0000-4000-8000-000000000002'::uuid, 'ev-recoger-leo-1', 0, interval '16 hours 45 minutes', 'Recoger a Leo', 'Colegio Las Encinas', 'Colegio Las Encinas'),
    ('c3000000-0000-4000-8000-000000000001'::uuid, 'ev-natacion-1',    1, interval '18 hours 30 minutes', 'Natación de Leo', 'Piscina municipal', 'Calendario de la familia'),
    ('c3000000-0000-4000-8000-000000000001'::uuid, 'ev-caldera',       1, interval '9 hours 30 minutes',  'Revisión de la caldera', 'En casa', 'Calendario de la familia'),
    ('c3000000-0000-4000-8000-000000000002'::uuid, 'ev-tutoria',       2, interval '17 hours',            'Tutoría con el colegio', 'Colegio Las Encinas', 'Colegio Las Encinas'),
    ('c3000000-0000-4000-8000-000000000001'::uuid, 'ev-pediatra',      3, interval '17 hours',            'Pediatra · revisión', 'Centro Pediátrico Olmo', 'Calendario de la familia'),
    ('c3000000-0000-4000-8000-000000000001'::uuid, 'ev-cena-amigos',   5, interval '21 hours',            'Cena con los Prado', 'Fuera', 'Calendario de la familia'),
    ('c3000000-0000-4000-8000-000000000001'::uuid, 'ev-dentista',      9, interval '10 hours',            'Dentista de Marta', 'Clínica Sierra', 'Calendario de la familia'),
    ('c3000000-0000-4000-8000-000000000002'::uuid, 'ev-excursion',    12, interval '9 hours',             'Excursión del colegio', 'Sierra de Guadarrama', 'Colegio Las Encinas'),
    ('c3000000-0000-4000-8000-000000000001'::uuid, 'ev-revision-coche', 18, interval '11 hours',          'Revisión del coche', 'Taller Nogal', 'Calendario de la familia')
  ) AS v(fuente, uid, dia, hora, titulo, lugar, etiqueta);

-- ── 5 · Contactos: un directorio con grupos de verdad ──────────────────────

INSERT INTO app.contacts (id, household_id, name, role_label, phone, kind, featured, notes, position, created_by_membership_id)
VALUES
  ('c4000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Clima Norte',           'Caldera y aire',        '910 000 233', 'service', false, 'Contrato de mantenimiento anual', 3, '11000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Colegio Las Encinas',   'Secretaría',            '910 000 455', 'school',  false, 'De 9:00 a 14:00', 4, '11000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Farmacia de la plaza',  'Guardia los domingos',  '910 000 512', 'health',  false, '', 5, '11000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Portería del edificio', 'Rafa · de 8:00 a 15:00','910 000 600', 'home',    false, 'Tiene una llave de la puerta de servicio', 6, '11000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Seguro del hogar',      'Parte de siniestros',   '900 000 780', 'service', false, 'Póliza 4471-B', 7, '11000000-0000-4000-8000-000000000001');

UPDATE app.contacts SET notes = 'Urgencias pediátricas 24 h' WHERE id = 'aa800000-0000-4000-8000-000000000001';

-- ── 6 · Vacaciones: años, prorrateo y un periodo anulado ───────────────────

-- `calendar_days` es columna generada: la cuenta la base, no la siembra.
INSERT INTO app.vacation_periods (id, household_id, agreement_id, employee_membership_id,
                                  starts_on, ends_on, note, status,
                                  recorded_by_membership_id, recorded_at,
                                  voided_by_membership_id, voided_at, void_reason)
VALUES
  ('c5000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2026-04-01', '2026-04-12', 'Semana Santa en el pueblo', 'recorded',
   '11000000-0000-4000-8000-000000000001', '2026-03-02T10:00:00Z', NULL, NULL, NULL),
  ('c5000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2026-08-24', '2026-08-31', 'Última semana de agosto', 'recorded',
   '11000000-0000-4000-8000-000000000001', '2026-07-20T09:00:00Z', NULL, NULL, NULL),
  ('c5000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2026-06-15', '2026-06-19', 'Se apuntó dos veces por error', 'voided',
   '11000000-0000-4000-8000-000000000001', '2026-06-01T09:00:00Z',
   '11000000-0000-4000-8000-000000000001', '2026-06-02T11:30:00Z', 'Duplicado'),
  ('c5000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2025-08-01', '2025-08-20', 'Agosto en casa de su familia', 'recorded',
   '11000000-0000-4000-8000-000000000001', '2025-07-04T09:00:00Z', NULL, NULL, NULL),
  ('c5000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2025-12-24', '2025-12-31', 'Navidad', 'recorded',
   '11000000-0000-4000-8000-000000000001', '2025-11-30T09:00:00Z', NULL, NULL, NULL),
  ('c5000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000006',
   '2026-07-06', '2026-07-19', 'Julio', 'recorded',
   '11000000-0000-4000-8000-000000000001', '2026-06-10T09:00:00Z', NULL, NULL, NULL);

-- Ana todavía no ha mirado el aviso de novedad: la sección se lo enseña.
DELETE FROM app.vacation_notice_marks
 WHERE membership_id = '11000000-0000-4000-8000-000000000003';

-- ── 7 · Avance de lectura de la Guía ───────────────────────────────────────
--
-- Ana lleva leída la mitad larga; Marta y Lucía, menos. Una nota que Ana leyó
-- cambió después: su huella guardada ya no es la de la revisión vigente, y la
-- Guía lo dice sin acusar a nadie.

INSERT INTO app.wiki_reading_progress (household_id, membership_id, page_id, content_fingerprint)
SELECT p.household_id, m.membership_id, p.id, r.reading_fingerprint
  FROM app.wiki_pages p
  JOIN app.wiki_revisions r ON r.id = p.current_revision_id
  JOIN app.wiki_spaces s ON s.id = p.space_id
  CROSS JOIN (VALUES
    ('11000000-0000-4000-8000-000000000003'::uuid, 34),
    ('11000000-0000-4000-8000-000000000002'::uuid, 12),
    ('11000000-0000-4000-8000-000000000004'::uuid, 7),
    ('11000000-0000-4000-8000-000000000001'::uuid, 46),
    ('11000000-0000-4000-8000-000000000006'::uuid, 19)
  ) AS m(membership_id, cuantas)
 WHERE s.kind = 'guide' AND p.status = 'published' AND p.archived_at IS NULL
   AND (
     SELECT count(*) FROM app.wiki_pages q
      JOIN app.wiki_spaces t ON t.id = q.space_id
     WHERE t.kind = 'guide' AND q.status = 'published' AND q.archived_at IS NULL
       AND (q.created_at, q.id) <= (p.created_at, p.id)
   ) <= m.cuantas
ON CONFLICT DO NOTHING;

-- La nota que cambió después de leerla (huella antigua a propósito).
UPDATE app.wiki_reading_progress SET content_fingerprint = md5('huella anterior')
 WHERE membership_id = '11000000-0000-4000-8000-000000000003'
   AND page_id IN (
     SELECT p.id FROM app.wiki_pages p
      JOIN app.wiki_spaces s ON s.id = p.space_id
     WHERE s.slug = 'convivencia' AND p.status = 'published'
     ORDER BY p.position LIMIT 2
   );

-- ── 8 · Personal: alguien que ya no trabaja aquí ───────────────────────────

INSERT INTO app.user_profiles (user_id, display_name, email, must_change_password)
VALUES ('fixture:roble:antigua', 'Rosa', 'rosa@casaroble.invalid', false)
ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name;

INSERT INTO app.household_memberships (id, household_id, user_id, role, starts_at, revoked_at)
VALUES ('c6000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'fixture:roble:antigua', 'employee_live_in', '2023-01-09', '2025-01-31T12:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.employment_agreements (id, household_id, employee_membership_id, starts_on, ends_on,
                                       status, ended_at, created_by_membership_id)
VALUES ('c6100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'c6000000-0000-4000-8000-000000000001', '2023-01-09', '2025-01-31', 'ended',
        '2025-01-31T12:00:00Z', '11000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.agreement_versions (id, household_id, agreement_id, version_number, effective_from,
                                    monthly_salary_cents, overtime_hourly_rate_cents,
                                    worked_rest_day_rate_cents, worked_rest_day_credit_minutes,
                                    contracted_weekly_minutes, currency_code, terms, reason,
                                    annual_vacation_days, created_by_membership_id)
VALUES ('c6200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'c6100000-0000-4000-8000-000000000001', 1, '2023-01-09',
        125000, 1200, 6000, 480, 2400, 'EUR', '{}'::jsonb, 'Alta del contrato', 30,
        '11000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

COMMIT;
