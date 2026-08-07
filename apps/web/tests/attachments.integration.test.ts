import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  uploadAttachment,
  type AttachmentDependencies
} from '../src/lib/server/attachments.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_attach_login';
// Base de datos propia (patrón de la suite de comida): las demás suites
// recrean el esquema entero en paralelo y ninguna puede compartir instancia.
const ATTACH_DB = 'casaclara_attach_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
const HELPER_MEMBERSHIP = '11000000-0000-4000-8000-000000000004';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const OUTSIDER_USER = { id: 'fixture:no-membership' };

const BUCKET = 'casaclara-test';

// Regex del esquema (0003) y de putPrivateObject del worker: la clave que
// generamos debe pasar ambas para que la tubería completa sea coherente.
const WORKER_KEY_PATTERN = /^[a-f0-9-]+\/[a-z0-9/_-]+\.[a-z0-9]+$/i;

function jpegBytes(seed = 0): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, seed & 0xff, (seed >> 8) & 0xff]);
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.4\n1 0 obj\nsintético\n%%EOF\n');
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface FakeDeps {
  deps: AttachmentDependencies;
  scan: ReturnType<typeof vi.fn>;
  puts: Array<{ key: string; contentType: string; byteSize: number }>;
}

function fakeDeps(verdict: 'clean' | 'infected' = 'clean'): FakeDeps {
  const puts: FakeDeps['puts'] = [];
  const scan = vi.fn(async () => verdict);
  return {
    scan,
    puts,
    deps: {
      bucket: BUCKET,
      scan,
      putObject: async (key, bytes, contentType) => {
        puts.push({ key, contentType, byteSize: bytes.length });
      }
    }
  };
}

function attachUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${ATTACH_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('subida de adjuntos bajo RLS con antivirus inyectado', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${ATTACH_DB} with (force)`);
      await cluster.query(`create database ${ATTACH_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: attachUrlFor(adminUrl as string) });
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
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: attachUrlFor(adminUrl as string), max: 2 });
    const url = new URL(attachUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  async function storedRow(storageObjectId: string) {
    const result = await adminPool.query<{
      bucket: string;
      objectKey: string;
      mediaType: string;
      byteSize: string;
      sha256: string;
      createdBy: string;
    }>(
      `select bucket, object_key as "objectKey", media_type as "mediaType",
              byte_size::text as "byteSize", sha256, created_by_membership_id as "createdBy"
         from app.storage_objects where id = $1`,
      [storageObjectId]
    );
    return result.rows[0] ?? null;
  }

  async function storageObjectCount(): Promise<number> {
    const result = await adminPool.query<{ count: string }>('select count(*)::text as count from app.storage_objects');
    return Number(result.rows[0]!.count);
  }

  it('la subida feliz escanea, sube y registra storage_objects con sha y clave válidas', async () => {
    const bytes = jpegBytes(1);
    const { deps, scan, puts } = fakeDeps();
    const result = await uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes, mediaType: 'image/jpeg' }, deps, appPool);

    expect(result.sha256).toBe(sha256Of(bytes));
    expect(scan).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.contentType).toBe('image/jpeg');
    expect(puts[0]!.byteSize).toBe(bytes.length);

    const row = await storedRow(result.storageObjectId);
    expect(row).not.toBeNull();
    expect(row!.bucket).toBe(BUCKET);
    expect(row!.mediaType).toBe('image/jpeg');
    expect(row!.byteSize).toBe(String(bytes.length));
    expect(row!.sha256).toBe(result.sha256);
    expect(row!.createdBy).toBe(ADMIN_MEMBERSHIP);
    // Clave: <householdId>/attachments/<sha256-16><ext>, aceptada tanto por el
    // CHECK del esquema (la fila existe) como por el patrón del worker.
    expect(row!.objectKey).toBe(`${FIXTURE_HOUSEHOLD}/attachments/${result.sha256.slice(0, 16)}.jpg`);
    expect(row!.objectKey).toMatch(WORKER_KEY_PATTERN);
    expect(puts[0]!.key).toBe(row!.objectKey);
  });

  it('repetir el mismo contenido es idempotente: mismo objeto, sin re-subida', async () => {
    const bytes = jpegBytes(1);
    const first = await uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes, mediaType: 'image/jpeg' }, fakeDeps().deps, appPool);
    const again = fakeDeps();
    const second = await uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes, mediaType: 'image/jpeg' }, again.deps, appPool);
    expect(second.storageObjectId).toBe(first.storageObjectId);
    expect(again.puts).toHaveLength(0);
  });

  it("'infected' corta la tubería: nada se sube y nada se registra", async () => {
    const before = await storageObjectCount();
    const { deps, puts } = fakeDeps('infected');
    await expect(
      uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes: pdfBytes(), mediaType: 'application/pdf' }, deps, appPool)
    ).rejects.toMatchObject({ name: 'AttachmentError', code: 'attachment_infected' });
    expect(puts).toHaveLength(0);
    expect(await storageObjectCount()).toBe(before);
  });

  it('un tipo no permitido se rechaza antes incluso de escanear', async () => {
    const { deps, scan, puts } = fakeDeps();
    await expect(
      uploadAttachment(
        ADMIN_USER,
        FIXTURE_HOUSEHOLD,
        { bytes: new TextEncoder().encode('texto plano'), mediaType: 'text/plain' },
        deps,
        appPool
      )
    ).rejects.toMatchObject({ code: 'attachment_type_not_allowed' });
    expect(scan).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('el tamaño máximo de 10 MiB se aplica en bytes reales', async () => {
    const oversized = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    oversized.set([0xff, 0xd8, 0xff]);
    const { deps, scan } = fakeDeps();
    await expect(
      uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes: oversized, mediaType: 'image/jpeg' }, deps, appPool)
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
    expect(scan).not.toHaveBeenCalled();
  });

  it('una firma mágica falsa (PNG disfrazado de JPEG) se detecta y no se sube', async () => {
    const before = await storageObjectCount();
    const { deps, scan, puts } = fakeDeps();
    await expect(
      uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes: pngBytes(), mediaType: 'image/jpeg' }, deps, appPool)
    ).rejects.toMatchObject({ code: 'attachment_signature_mismatch' });
    expect(scan).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
    expect(await storageObjectCount()).toBe(before);
  });

  it('la empleada puede subir su propio adjunto (created_by = su membresía)', async () => {
    const bytes = jpegBytes(2);
    const result = await uploadAttachment(
      EMPLOYEE_USER,
      FIXTURE_HOUSEHOLD,
      { bytes, mediaType: 'image/jpeg' },
      fakeDeps().deps,
      appPool
    );
    expect((await storedRow(result.storageObjectId))!.createdBy).toBe(EMPLOYEE_MEMBERSHIP);
  });

  it('el apoyo (helper) TAMBIÉN puede subir el suyo: storage_objects_write no restringe por rol', async () => {
    // Verdad del esquema (0005): la política exige tenant_context_matches y
    // created_by = current_membership, sin filtro de rol. Cualquier membresía
    // activa con contexto —helper incluido— inserta SU PROPIA fila. Si algún
    // día se decide vetar al apoyo, hay que endurecer la política, no la web.
    const bytes = jpegBytes(3);
    const result = await uploadAttachment(
      HELPER_USER,
      FIXTURE_HOUSEHOLD,
      { bytes, mediaType: 'image/jpeg' },
      fakeDeps().deps,
      appPool
    );
    expect((await storedRow(result.storageObjectId))!.createdBy).toBe(HELPER_MEMBERSHIP);
  });

  it('sin membresía activa no hay subida: AuthorizationError antes de tocar nada', async () => {
    const { deps, puts } = fakeDeps();
    await expect(
      uploadAttachment(OUTSIDER_USER, FIXTURE_HOUSEHOLD, { bytes: jpegBytes(4), mediaType: 'image/jpeg' }, deps, appPool)
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
    expect(puts).toHaveLength(0);
  });

  it('sin pool el error tipado es attachments_unavailable', async () => {
    await expect(
      uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes: jpegBytes(5), mediaType: 'image/jpeg' }, fakeDeps().deps, null)
    ).rejects.toMatchObject({ code: 'attachments_unavailable' });
  });

  it('si el PUT al bucket falla, el registro se revierte (sin filas huérfanas)', async () => {
    const before = await storageObjectCount();
    const deps: AttachmentDependencies = {
      bucket: BUCKET,
      scan: async () => 'clean',
      putObject: async () => {
        throw new Error('minio caído');
      }
    };
    await expect(
      uploadAttachment(ADMIN_USER, FIXTURE_HOUSEHOLD, { bytes: jpegBytes(6), mediaType: 'image/jpeg' }, deps, appPool)
    ).rejects.toThrow('minio caído');
    expect(await storageObjectCount()).toBe(before);
  });

  it('AttachmentError conserva el código para que la ruta lo traduzca a HTTP', () => {
    const error = new AttachmentError('attachment_infected', 'cuarentena');
    expect(error.code).toBe('attachment_infected');
    expect(error.name).toBe('AttachmentError');
  });
});
