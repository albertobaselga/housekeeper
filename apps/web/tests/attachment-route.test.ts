import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentError, uploadAttachment } from '../src/lib/server/attachments.server';
import { POST } from '../src/routes/api/v1/households/[householdId]/attachments/+server';

/**
 * La ruta de subida traduce los errores tipados de la tubería a HTTP. Aquí
 * solo importa esa traducción: la tubería y su RLS se prueban en
 * attachment-pipeline.test.ts y attachments.integration.test.ts, así que se
 * sustituyen la base, el almacén y la propia subida por dobles.
 */
vi.mock('$lib/server/db.server', () => ({ getDatabasePool: () => ({}) }));
vi.mock('$lib/server/attachment-deps.server', () => ({
  createAttachmentDependencies: () => ({ bucket: 'housekeeper-test' })
}));
vi.mock('$lib/server/attachments.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/server/attachments.server')>();
  return { ...actual, uploadAttachment: vi.fn() };
});

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function event() {
  const url = new URL(`https://casa.local/api/v1/households/${HOUSEHOLD}/attachments`);
  return {
    locals: { user: { id: 'fixture:roble:family' } },
    params: { householdId: HOUSEHOLD },
    url,
    request: new Request(url, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: JPEG })
  } as unknown as Parameters<typeof POST>[0];
}

async function outcome(): Promise<{ status: number; message?: string }> {
  try {
    const response = await POST(event());
    return { status: response.status };
  } catch (cause) {
    const failure = cause as { status?: number; body?: { message?: string } };
    return { status: failure.status ?? 0, message: failure.body?.message };
  }
}

describe('POST /api/v1/households/[householdId]/attachments', () => {
  beforeEach(() => {
    vi.mocked(uploadAttachment).mockReset();
  });

  it('los mismos bytes de otra persona son un 409 con su frase, no un 500', async () => {
    vi.mocked(uploadAttachment).mockRejectedValueOnce(
      new AttachmentError('attachment_duplicate', 'Ese fichero ya lo subió alguien de la casa')
    );
    expect(await outcome()).toEqual({ status: 409, message: 'Ese fichero ya lo subió alguien de la casa' });
  });

  it('la subida idempotente de lo propio sigue siendo un 201 con el objeto', async () => {
    vi.mocked(uploadAttachment).mockResolvedValueOnce({
      storageObjectId: 'cd100000-0000-4000-8000-000000000001',
      sha256: 'a'.repeat(64),
      mediaType: 'image/jpeg'
    });
    const response = await POST(event());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ storageObjectId: 'cd100000-0000-4000-8000-000000000001' });
  });
});
