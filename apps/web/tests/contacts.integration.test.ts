import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contactCommandHandlers, processSyncBatch, withAuthorizedTransaction } from '@casa-clara/server';

import { archiveContact, upsertContact } from '../src/lib/contacts/commands';
import {
  loadContacts,
  loadEmergencyContacts,
  loadSnapshotContacts
} from '../src/lib/server/contacts.server';
import { getCriticalSnapshotPayload } from '../src/lib/server/fixtures.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_contacts_login';
// Base de datos propia (patrón de la suite de comida): las otras suites
// recrean el esquema entero en paralelo y ninguna puede compartir instancia.
const CONTACTS_DB = 'casaclara_contacts_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';

const CONTACT_PEDIATRA = '51000000-0000-4000-8000-000000000001';
const CONTACT_VECINA = '51000000-0000-4000-8000-000000000002';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };

function contactsUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${CONTACTS_DB}`;
  return url.toString();
}

const CONTACTS_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.contacts (id, household_id, name, role_label, phone, kind, featured, notes, position, created_by_membership_id) VALUES
  ('${CONTACT_PEDIATRA}', '${FIXTURE_HOUSEHOLD}', 'Centro Pediátrico Olmo', 'Pediatría', '910 000 111', 'health', true, '', 0, '${ADMIN_MEMBERSHIP}'),
  ('${CONTACT_VECINA}', '${FIXTURE_HOUSEHOLD}', 'Carmen · 2.º B', 'Vecina de confianza', '600 000 344', 'home', false, 'Tiene llaves', 1, '${ADMIN_MEMBERSHIP}');

COMMIT;
`;

let operationCounter = 0;
function nextOperation(): { operationId: string; occurredAt: string } {
  operationCounter += 1;
  return {
    operationId: `99999999-0000-4000-8000-${String(operationCounter).padStart(12, '0')}`,
    occurredAt: '2026-08-07T10:00:00.000Z'
  };
}

describe.runIf(Boolean(adminUrl))('contactos del hogar desde Postgres bajo RLS', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${CONTACTS_DB} with (force)`);
      await cluster.query(`create database ${CONTACTS_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: contactsUrlFor(adminUrl as string) });
    await admin.connect();
    try {
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      await admin.query(CONTACTS_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: contactsUrlFor(adminUrl as string), max: 2 });
    const url = new URL(contactsUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it('los cinco roles leen el directorio; solo la familia puede escribir', async () => {
    for (const [user, canWrite] of [
      [ADMIN_USER, true],
      [FAMILY_USER, true],
      [EMPLOYEE_USER, false],
      [HELPER_USER, false],
      [VIEWER_USER, false]
    ] as const) {
      const directory = await loadContacts(user, FIXTURE_HOUSEHOLD, appPool);
      expect(directory).not.toBeNull();
      expect(directory!.canWrite).toBe(canWrite);
      expect(directory!.contacts.map((contact) => contact.name)).toEqual([
        'Centro Pediátrico Olmo',
        'Carmen · 2.º B'
      ]);
    }
  });

  it('la familia crea, edita y archiva un contacto vía el handler congelado', async () => {
    // Alta (Marta, family_member).
    const created = await processSyncBatch(
      appPool,
      { userId: FAMILY_USER.id },
      [
        upsertContact(
          {
            householdId: FIXTURE_HOUSEHOLD,
            name: 'Abuela Rosa',
            roleLabel: 'Familia cercana',
            phone: '+34 600 111 222',
            kind: 'emergency',
            featured: true,
            notes: 'Vive a dos calles'
          },
          nextOperation()
        )
      ],
      contactCommandHandlers
    );
    expect(created.acknowledgements[0]).toMatchObject({ status: 'accepted' });
    const newId = created.acknowledgements[0]!.resourceId!;

    // Edición del mismo contacto.
    const edited = await processSyncBatch(
      appPool,
      { userId: FAMILY_USER.id },
      [
        upsertContact(
          {
            householdId: FIXTURE_HOUSEHOLD,
            contactId: newId,
            name: 'Abuela Rosa',
            roleLabel: 'Familia cercana',
            phone: '+34 600 111 333',
            kind: 'emergency',
            featured: true
          },
          nextOperation()
        )
      ],
      contactCommandHandlers
    );
    expect(edited.acknowledgements[0]).toMatchObject({ status: 'accepted', resourceId: newId });

    const directory = await loadContacts(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool);
    const rosa = directory!.contacts.find((contact) => contact.id === newId);
    expect(rosa).toMatchObject({ phone: '+34 600 111 333', kind: 'emergency', featured: true });
    // El orden agrupa por tipo: emergency delante del resto.
    expect(directory!.contacts[0]!.id).toBe(newId);

    // Archivado: desaparece del directorio pero la fila persiste (auditable).
    const archived = await processSyncBatch(
      appPool,
      { userId: FAMILY_USER.id },
      [archiveContact({ householdId: FIXTURE_HOUSEHOLD, contactId: newId }, nextOperation())],
      contactCommandHandlers
    );
    expect(archived.acknowledgements[0]).toMatchObject({ status: 'accepted', resourceId: newId });

    const after = await loadContacts(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(after!.contacts.some((contact) => contact.id === newId)).toBe(false);

    // Archivar dos veces se rechaza con causa clara.
    const again = await processSyncBatch(
      appPool,
      { userId: FAMILY_USER.id },
      [archiveContact({ householdId: FIXTURE_HOUSEHOLD, contactId: newId }, nextOperation())],
      contactCommandHandlers
    );
    expect(again.acknowledgements[0]).toMatchObject({ status: 'rejected', errorCode: 'contact_not_found' });
  });

  it('helper y viewer leen pero no escriben: handler y RLS lo impiden', async () => {
    for (const user of [HELPER_USER, VIEWER_USER, EMPLOYEE_USER]) {
      const result = await processSyncBatch(
        appPool,
        { userId: user.id },
        [
          upsertContact(
            { householdId: FIXTURE_HOUSEHOLD, name: 'Intruso', phone: '600 000 000', kind: 'otros', featured: false },
            nextOperation()
          )
        ],
        contactCommandHandlers
      );
      expect(result.acknowledgements[0]).toMatchObject({ status: 'rejected', errorCode: 'not_allowed' });
    }

    // Defensa en profundidad: aunque el handler no existiera, la policy
    // contacts_family_write bloquea el INSERT directo bajo el rol de apoyo.
    await expect(
      withAuthorizedTransaction(appPool, { userId: HELPER_USER.id }, FIXTURE_HOUSEHOLD, async (client, membership) =>
        client.query(
          `insert into app.contacts (household_id, name, phone, kind, created_by_membership_id)
           values ($1, 'Directo', '600 000 001', 'otros', $2)`,
          [FIXTURE_HOUSEHOLD, membership.id]
        )
      )
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('emergencias reales: solo los destacados, con el 112 fijo fuera de la DB', async () => {
    const emergency = await loadEmergencyContacts(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(emergency).not.toBeNull();
    expect(emergency!.canWrite).toBe(false);
    expect(emergency!.featured.map((contact) => contact.name)).toEqual(['Centro Pediátrico Olmo']);
  });

  it('el snapshot crítico lleva 112 + destacados reales y cero notas de demo', async () => {
    const snapshotContacts = await loadSnapshotContacts(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(snapshotContacts).not.toBeNull();
    expect(snapshotContacts!.map((contact) => contact.name)).toEqual(['Emergencias', 'Centro Pediátrico Olmo']);
    expect(snapshotContacts![0]).toMatchObject({ phone: '112', kind: 'emergency' });

    const payload = getCriticalSnapshotPayload(snapshotContacts);
    expect(payload.contacts.map((contact) => contact.name)).toEqual(['Emergencias', 'Centro Pediátrico Olmo']);
    // Las notas de demostración no se mezclan con datos reales.
    expect(payload.emergency).toEqual([]);

    // Sin pool (demo) la fixture sintética se conserva.
    expect(await loadSnapshotContacts(ADMIN_USER, FIXTURE_HOUSEHOLD, null)).toBeNull();
    const fixture = getCriticalSnapshotPayload(null);
    expect(fixture.contacts.length).toBeGreaterThan(0);
    expect(fixture.emergency.length).toBeGreaterThan(0);
  });

  it('un usuario sin membresía en el hogar no ve el directorio', async () => {
    expect(await loadContacts({ id: 'fixture:otro:usuario' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });
});
