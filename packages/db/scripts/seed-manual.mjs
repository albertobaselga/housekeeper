// Siembra estructurada del «Manual de convivencia y operaciones v0.1» (Ola A):
// lo que NO es wiki — rutinas de «Rutinas generales», el contacto real del
// Anexo G y la semana tipo del Anexo D como plantilla de menú con nombre.
//
// Uso:
//   DATABASE_URL=postgresql://... node scripts/seed-manual.mjs \
//     --household <uuid> [--membership <uuid>] [--dry-run]
//
// Idempotencia al estilo de las fixtures/e2e existentes: SQL directo con
// `set local row_security = off` (rol propietario de migraciones) y un
// identificador DETERMINISTA por entidad — uuid derivado por sha-256 de
// (hogar, clave estable), que hace de operationId de la siembra: repetirla
// actualiza en el sitio (upsert por id) sin duplicar nada y sin tocar el
// estado de recurrencia (`next_due_on` solo se fija al crear la rutina).
//
// Decisiones de contenido (documentadas también en el runbook):
//   · Rutinas: los planes semanal/quincenal/periódico del Word están
//     «Pendiente de completar por la familia», así que las semanales y la
//     mensual nacen con audiencia familiar para CONCRETARLOS; las diarias y
//     la quincenal (semanal cada 2, proceso real del manual) son operativas.
//     Cada una enlaza su ficha de la Guía en «Detalles» («Ver ficha: …»).
//   · Contactos: del Anexo G solo el 112 trae datos reales; el resto de filas
//     son placeholders y NO se siembran (la familia las completa en la app).
//   · Anexo D: no contiene ni una receta ni una semana real → 0 recetas. Se
//     crea igualmente la plantilla «Semana tipo del manual (pendiente)» con
//     huecos de texto libre por día, aplicable sobre una semana vacía, para
//     que la familia la rellene; requiere al menos un grupo de comensales
//     vivo (si no existe, la plantilla se omite con aviso).

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE = 'casa-clara:manual-convivencia-v0.1';

/** uuid determinista (forma v4/variante RFC) a partir de una clave estable. */
export function deterministicUuid(householdId, key) {
  const hex = createHash('sha256')
    .update(`${NAMESPACE}:${householdId.toLowerCase()}:${key}`)
    .digest('hex');
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '4';
  bytes[16] = ['8', '9', 'a', 'b'][parseInt(bytes[16], 16) % 4];
  const s = bytes.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contenido a sembrar (claves estables → ids deterministas).
// ─────────────────────────────────────────────────────────────────────────────

const ROUTINES = [
  {
    key: 'routine:rutina-diaria-de-referencia',
    title: 'Rutina diaria de referencia',
    details:
      'Inicio, después de cada uso, antes y después de las comidas, cierre. Ver ficha: Rutina diaria de referencia.',
    audience: 'employee',
    frequency: 'daily',
    intervalCount: 1,
    nextDueOn: 'current_date',
  },
  {
    key: 'routine:ventilacion-de-la-manana',
    title: 'Ventilación de la mañana',
    details:
      'Ventilar solo de forma segura, vigilar las ventanas y cerrarlas después. Ver ficha: Ventilación, orden y residuos.',
    audience: 'employee',
    frequency: 'daily',
    intervalCount: 1,
    nextDueOn: 'current_date',
  },
  {
    key: 'routine:plan-semanal',
    title: 'Plan semanal: concretar tareas y días',
    details:
      'La tabla del manual está pendiente de completar por la familia (tareas, días, alcance). Ver ficha: Planes semanal, quincenal y periódico.',
    audience: 'family',
    frequency: 'weekly',
    intervalCount: 1,
    // Próximo lunes (o hoy si es lunes): un plan semanal se revisa al abrir semana.
    nextDueOn: "(current_date + ((8 - extract(isodow from current_date))::int % 7))",
  },
  {
    key: 'routine:compra-personal-quincenal',
    title: 'Confirmar la compra personal de alimentos',
    details:
      'Cada dos semanas: la persona interna entrega su lista y la familia confirma por escrito artículos y cantidades. Ver ficha: Compra personal de alimentos.',
    audience: 'all',
    frequency: 'weekly',
    intervalCount: 2,
    nextDueOn: "(current_date + ((8 - extract(isodow from current_date))::int % 7))",
  },
  {
    key: 'routine:plan-periodico',
    title: 'Plan periódico: confirmar frecuencias',
    details:
      'Limpiezas profundas y revisiones estacionales sin frecuencia confirmada aún. Ver ficha: Planes semanal, quincenal y periódico.',
    audience: 'family',
    frequency: 'monthly',
    intervalCount: 1,
    nextDueOn: "(date_trunc('month', current_date) + interval '1 month')::date",
  },
];

const CONTACTS = [
  {
    key: 'contact:emergencias-112',
    name: 'Emergencias Comunidad de Madrid',
    roleLabel: 'Peligro inmediato o grave',
    phone: '112',
    kind: 'emergency',
    featured: true,
    notes:
      'Protegerse y proteger a los niños; llamar directamente al 112 y después avisar a la familia.',
  },
];

const TEMPLATE = {
  key: 'menu-template:semana-tipo-manual',
  name: 'Semana tipo del manual (pendiente)',
  // El Anexo D no trae platos: cada día queda como texto libre a rellenar.
  meals: ['comida', 'cena'],
  freeText: 'Pendiente de completar por la familia (Anexo D)',
};

// ─────────────────────────────────────────────────────────────────────────────
// Siembra.
// ─────────────────────────────────────────────────────────────────────────────

export async function seedManual(client, { householdId, membershipId, dryRun = false }) {
  const report = {
    dryRun,
    routines: { created: [], updated: [] },
    contacts: { created: [], updated: [] },
    template: null,
    recipes: 0,
    warnings: [],
  };

  await client.query('begin');
  try {
    await client.query('set local row_security = off');

    const household = await client.query(`select 1 from app.households where id = $1`, [
      householdId,
    ]);
    if (household.rowCount === 0) {
      throw new Error(`el hogar ${householdId} no existe en esta base de datos`);
    }

    let actorMembershipId = membershipId;
    if (!actorMembershipId) {
      const admin = await client.query(
        `select id from app.household_memberships
          where household_id = $1 and role = 'family_admin'
            and revoked_at is null and starts_at <= now()
            and (expires_at is null or expires_at > now())
          order by created_at, id limit 1`,
        [householdId]
      );
      actorMembershipId = admin.rows[0]?.id;
      if (!actorMembershipId) {
        throw new Error(`el hogar ${householdId} no tiene family_admin activo (usa --membership)`);
      }
    }

    // Rutinas: upsert por id determinista; next_due_on SOLO al crear (repetir
    // la siembra no reinicia la recurrencia avanzada por finalizaciones).
    for (const routine of ROUTINES) {
      const id = deterministicUuid(householdId, routine.key);
      const result = await client.query(
        `insert into app.routines
           (id, household_id, title, details, audience, frequency, interval_count,
            next_due_on, created_by_membership_id)
         values ($1, $2, $3, $4, $5::app.routine_audience, $6::app.routine_frequency,
                 $7, ${routine.nextDueOn}, $8)
         on conflict (id) do update
           set title = excluded.title, details = excluded.details,
               audience = excluded.audience, frequency = excluded.frequency,
               interval_count = excluded.interval_count, archived_at = null
         returning (xmax = 0) as created`,
        [
          id,
          householdId,
          routine.title,
          routine.details,
          routine.audience,
          routine.frequency,
          routine.intervalCount,
          actorMembershipId,
        ]
      );
      (result.rows[0].created ? report.routines.created : report.routines.updated).push(
        routine.title
      );
    }

    // Contactos reales del Anexo G (las filas «Pendiente de completar» no
    // entran: la familia las da de alta en la app con datos verdaderos).
    for (const contact of CONTACTS) {
      const id = deterministicUuid(householdId, contact.key);
      const result = await client.query(
        `insert into app.contacts
           (id, household_id, name, role_label, phone, kind, featured, notes, position,
            created_by_membership_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 coalesce((select max(position) + 1 from app.contacts where household_id = $2), 0),
                 $9)
         on conflict (id) do update
           set name = excluded.name, role_label = excluded.role_label,
               phone = excluded.phone, kind = excluded.kind,
               featured = excluded.featured, notes = excluded.notes, archived_at = null
         returning (xmax = 0) as created`,
        [
          id,
          householdId,
          contact.name,
          contact.roleLabel,
          contact.phone,
          contact.kind,
          contact.featured,
          contact.notes,
          actorMembershipId,
        ]
      );
      (result.rows[0].created ? report.contacts.created : report.contacts.updated).push(
        contact.name
      );
    }

    // Plantilla de menú del Anexo D. Sin grupo de comensales vivo no hay hueco
    // válido (group_id NOT NULL): se omite con aviso en vez de fallar.
    const group = await client.query(
      `select id, name from app.menu_groups
        where household_id = $1 and archived_at is null
        order by position, name limit 1`,
      [householdId]
    );
    if (group.rowCount === 0) {
      report.warnings.push(
        'sin grupo de comensales vivo: la plantilla «Semana tipo del manual» se omite'
      );
    } else {
      const templateId = deterministicUuid(householdId, TEMPLATE.key);
      const inserted = await client.query(
        `insert into app.menu_week_templates
           (id, household_id, name, source_week_starts_on, created_by_membership_id)
         values ($1, $2, $3,
                 (current_date - ((extract(isodow from current_date))::int - 1)), $4)
         on conflict (id) do update set name = excluded.name
         returning (xmax = 0) as created`,
        [templateId, householdId, TEMPLATE.name, actorMembershipId]
      );
      for (const [dayOffset] of Array.from({ length: 7 }, (_, i) => [i])) {
        for (const meal of TEMPLATE.meals) {
          const slotId = deterministicUuid(householdId, `${TEMPLATE.key}:${dayOffset}:${meal}`);
          await client.query(
            `insert into app.menu_week_template_slots
               (id, household_id, template_id, day_offset, meal, group_id, free_text)
             values ($1, $2, $3, $4, $5::app.meal_slot, $6, $7)
             on conflict (household_id, template_id, group_id, day_offset, meal)
               do update set free_text = excluded.free_text`,
            [slotId, householdId, templateId, dayOffset, meal, group.rows[0].id, TEMPLATE.freeText]
          );
        }
      }
      report.template = {
        name: TEMPLATE.name,
        created: inserted.rows[0].created,
        group: group.rows[0].name,
        slots: 7 * TEMPLATE.meals.length,
      };
    }

    if (dryRun) {
      await client.query('rollback');
    } else {
      await client.query('commit');
    }
    return report;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--household':
        args.householdId = argv[++i];
        break;
      case '--membership':
        args.membershipId = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`argumento desconocido: ${argv[i]}`);
    }
  }
  if (!UUID_RE.test(args.householdId ?? '')) throw new Error('--household debe ser un uuid');
  if (args.membershipId && !UUID_RE.test(args.membershipId)) {
    throw new Error('--membership debe ser un uuid');
  }
  return args;
}

export function printSeedReport(report) {
  const mode = report.dryRun ? '[dry-run] ' : '';
  console.log(
    `${mode}rutinas: ${report.routines.created.length} nuevas, ${report.routines.updated.length} actualizadas` +
      (report.routines.created.length ? ` (${report.routines.created.join(' · ')})` : '')
  );
  console.log(
    `${mode}contactos: ${report.contacts.created.length} nuevos, ${report.contacts.updated.length} actualizados` +
      (report.contacts.created.length ? ` (${report.contacts.created.join(' · ')})` : '')
  );
  if (report.template) {
    console.log(
      `${mode}plantilla «${report.template.name}» ${report.template.created ? 'creada' : 'actualizada'} ` +
        `(${report.template.slots} huecos, grupo «${report.template.group}»)`
    );
  }
  console.log(`${mode}recetas del Anexo D: ${report.recipes} (el anexo llegó sin datos reales)`);
  for (const warning of report.warnings) console.warn(`${mode}AVISO: ${warning}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  let client;
  try {
    const args = parseArgs(process.argv.slice(2));
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL es obligatoria (rol admin/propietario de migraciones)');
    client = new pg.Client({ connectionString: url });
    await client.connect();
    const report = await seedManual(client, args);
    printSeedReport(report);
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}
