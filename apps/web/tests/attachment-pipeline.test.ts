import { describe, expect, it, vi } from 'vitest';

import {
  AttachmentError,
  detectMediaType,
  matchesMagicSignature,
  uploadAttachment,
  type AttachmentDependencies
} from '../src/lib/server/attachments.server';

/**
 * La tubería de adjuntos SIN antivirus. Lo que queda en pie cuando el escáner
 * desaparece es el asunto de estas pruebas: el tipo real deducido de los bytes
 * (no el que declare el navegador), el límite de tamaño y el fallo honesto.
 */

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP = '22222222-2222-4222-8222-222222222222';
const USER = { id: 'fixture:sin-antivirus:admin' };

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const PDF = new TextEncoder().encode('%PDF-1.7\nsintético\n%%EOF\n');
// Cabecera de un ejecutable de Windows: el caso que el antivirus atrapaba y
// que ahora tiene que atrapar la firma.
const EXECUTABLE = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

/**
 * Pool falso: responde lo justo para que `withAuthorizedTransaction` avance
 * (membresía activa) y registra las sentencias, para poder afirmar QUÉ tipo
 * queda escrito en app.storage_objects.
 */
function fakePool(): { pool: never; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      if (/household_memberships/.test(text)) {
        return { rows: [{ id: MEMBERSHIP, household_id: HOUSEHOLD, role: 'admin', expires_at: null }] };
      }
      if (/^\s*select id from app\.storage_objects/.test(text)) return { rows: [] };
      if (/insert into app\.storage_objects/.test(text)) {
        inserts.push(params);
        return { rows: [{ id: 'objeto-1' }] };
      }
      return { rows: [] };
    },
    release: () => undefined
  };
  return { pool: { connect: async () => client } as never, inserts };
}

function deps(overrides: Partial<AttachmentDependencies> = {}): AttachmentDependencies {
  return {
    bucket: 'casaclara-test',
    putObject: () => Promise.resolve(),
    getObject: () => Promise.resolve(new Uint8Array()),
    ...overrides
  };
}

describe('el tipo real sale de la firma del fichero, no de lo que diga el cliente', () => {
  it('reconoce los cuatro admitidos y solo esos', () => {
    expect(detectMediaType(JPEG)).toBe('image/jpeg');
    expect(detectMediaType(PNG)).toBe('image/png');
    expect(detectMediaType(WEBP)).toBe('image/webp');
    expect(detectMediaType(PDF)).toBe('application/pdf');
    expect(detectMediaType(EXECUTABLE)).toBeNull();
    expect(detectMediaType(new Uint8Array())).toBeNull();
  });

  it('un RIFF que no es WEBP (un WAV) no cuela como imagen', () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectMediaType(wav)).toBeNull();
    expect(matchesMagicSignature('image/webp', wav)).toBe(false);
  });

  it('un ejecutable disfrazado de foto se rechaza por firma, no por confianza', async () => {
    const attempt = uploadAttachment(
      USER,
      HOUSEHOLD,
      { bytes: EXECUTABLE, mediaType: 'image/jpeg' },
      deps(),
      fakePool().pool
    );
    await expect(attempt).rejects.toBeInstanceOf(AttachmentError);
    await expect(attempt).rejects.toMatchObject({ code: 'attachment_signature_mismatch' });
  });

  it('un ejecutable sin tipo declarado tampoco cuela', async () => {
    await expect(
      uploadAttachment(USER, HOUSEHOLD, { bytes: EXECUTABLE, mediaType: '' }, deps(), fakePool().pool)
    ).rejects.toMatchObject({ code: 'attachment_type_not_allowed' });
  });

  it('un MIME fuera de la lista se rechaza aunque los bytes sean una foto de verdad', async () => {
    await expect(
      uploadAttachment(
        USER,
        HOUSEHOLD,
        { bytes: JPEG, mediaType: 'application/x-msdownload' },
        deps(),
        fakePool().pool
      )
    ).rejects.toMatchObject({ code: 'attachment_type_not_allowed' });
  });

  it('declarar PNG y mandar un PDF es discordancia de firma', async () => {
    await expect(
      uploadAttachment(USER, HOUSEHOLD, { bytes: PDF, mediaType: 'image/png' }, deps(), fakePool().pool)
    ).rejects.toMatchObject({ code: 'attachment_signature_mismatch' });
  });

  it('sin tipo declarado —cámaras de Android— decide la firma y ese es el tipo que se guarda', async () => {
    const { pool, inserts } = fakePool();
    const result = await uploadAttachment(
      USER,
      HOUSEHOLD,
      { bytes: JPEG, mediaType: 'application/octet-stream' },
      deps(),
      pool
    );
    expect(result.mediaType).toBe('image/jpeg');
    // Cuarta columna del insert: media_type. Se guarda el DEDUCIDO.
    expect(inserts[0]![3]).toBe('image/jpeg');
  });

  it('el content-type con parámetros (charset) no rompe la comparación', async () => {
    const { pool } = fakePool();
    await expect(
      uploadAttachment(USER, HOUSEHOLD, { bytes: PDF, mediaType: 'application/pdf; charset=binary' }, deps(), pool)
    ).resolves.toMatchObject({ mediaType: 'application/pdf' });
  });
});

describe('sin escáner configurado la subida sigue funcionando', () => {
  it('sube y registra sin inventarse ningún veredicto', async () => {
    const { pool, inserts } = fakePool();
    const putObject = vi.fn(async () => undefined);
    const result = await uploadAttachment(
      USER,
      HOUSEHOLD,
      { bytes: JPEG, mediaType: 'image/jpeg' },
      deps({ putObject }),
      pool
    );
    expect(result.storageObjectId).toBe('objeto-1');
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
  });

  it('la clave del objeto sigue siendo determinista y dentro del hogar', async () => {
    const { pool } = fakePool();
    const puts: string[] = [];
    await uploadAttachment(
      USER,
      HOUSEHOLD,
      { bytes: PDF, mediaType: 'application/pdf' },
      deps({
        putObject: async (key) => {
          puts.push(key);
        }
      }),
      pool
    );
    expect(puts[0]).toMatch(new RegExp(`^${HOUSEHOLD}/attachments/[a-f0-9]{16}\\.pdf$`));
  });

  it('un almacén caído sigue siendo 503 honesto y no deja fila', async () => {
    const { pool } = fakePool();
    await expect(
      uploadAttachment(
        USER,
        HOUSEHOLD,
        { bytes: JPEG, mediaType: 'image/jpeg' },
        deps({ putObject: () => Promise.reject(new Error('ECONNREFUSED')) }),
        pool
      )
    ).rejects.toMatchObject({ code: 'attachment_storage_unavailable' });
  });

  it('el límite de tamaño no se ha movido: sigue cortando lo vacío y lo enorme', async () => {
    const { pool } = fakePool();
    await expect(
      uploadAttachment(USER, HOUSEHOLD, { bytes: new Uint8Array(), mediaType: 'image/jpeg' }, deps(), pool)
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
    const enormous = new Uint8Array(10 * 1024 * 1024 + 1);
    enormous.set(JPEG);
    await expect(
      uploadAttachment(USER, HOUSEHOLD, { bytes: enormous, mediaType: 'image/jpeg' }, deps(), pool)
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
  });
});

describe('con escáner configurado nada cambia', () => {
  it('un positivo sigue cortando antes de tocar el almacén', async () => {
    const { pool } = fakePool();
    const putObject = vi.fn(async () => undefined);
    await expect(
      uploadAttachment(
        USER,
        HOUSEHOLD,
        { bytes: JPEG, mediaType: 'image/jpeg' },
        deps({ scan: () => Promise.resolve('infected'), putObject }),
        pool
      )
    ).rejects.toMatchObject({ code: 'attachment_infected' });
    expect(putObject).not.toHaveBeenCalled();
  });

  it('un escáner caído sigue siendo 503 y no se asume «limpio»', async () => {
    const { pool } = fakePool();
    await expect(
      uploadAttachment(
        USER,
        HOUSEHOLD,
        { bytes: JPEG, mediaType: 'image/jpeg' },
        deps({ scan: () => Promise.reject(new Error('ECONNREFUSED')) }),
        pool
      )
    ).rejects.toMatchObject({ code: 'attachment_scan_unavailable' });
  });
});
