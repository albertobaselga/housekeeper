import { describe, expect, it, vi } from 'vitest';

import { uploadAttachment, UploadAttachmentError } from '../src/lib/attachments/upload';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const STORAGE_OBJECT = 'so-1111';

function makeFile(name = 'ticket.jpg', type = 'image/jpeg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause
  );
  expect(error).toBeInstanceOf(UploadAttachmentError);
  expect((error as UploadAttachmentError).code).toBe(code);
}

describe('uploadAttachment', () => {
  it('sube el fichero como binario con headers y devuelve el storageObjectId (201)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, { apiVersion: 1, storageObjectId: STORAGE_OBJECT }));
    const file = makeFile();

    await expect(uploadAttachment(HOUSEHOLD, file, fetchFn as unknown as typeof fetch)).resolves.toBe(STORAGE_OBJECT);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/households/${HOUSEHOLD}/attachments`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/jpeg');
    expect((init.headers as Record<string, string>)['x-attachment-name']).toBe('ticket.jpg');
    expect(init.body).toBe(file);
  });

  it('413 → attachment_too_large con mensaje traducido', async () => {
    const fetchFn = async () => jsonResponse(413, { message: 'too large' });
    const promise = uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch);
    await expectCode(promise, 'attachment_too_large');
    await expect(
      uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch)
    ).rejects.toThrow(/pesa demasiado/);
  });

  it('415 → attachment_type_not_allowed', async () => {
    const fetchFn = async () => jsonResponse(415, { message: 'bad type' });
    await expectCode(
      uploadAttachment(HOUSEHOLD, makeFile('malware.exe', 'application/x-msdownload'), fetchFn as unknown as typeof fetch),
      'attachment_type_not_allowed'
    );
  });

  it('422 → attachment_infected (el fichero no pasa la revisión)', async () => {
    const fetchFn = async () => jsonResponse(422, { message: 'quarantined' });
    const promise = uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch);
    await expectCode(promise, 'attachment_infected');
    await expect(
      uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch)
    ).rejects.toThrow(/revisión de seguridad/);
  });

  it('503 → attachments_unavailable (sin almacén configurado)', async () => {
    const fetchFn = async () => jsonResponse(503, { message: 'unavailable' });
    const promise = uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch);
    await expectCode(promise, 'attachments_unavailable');
    await expect(
      uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch)
    ).rejects.toThrow(/no está disponible/);
  });

  it('fallo de red → attachment_upload_failed', async () => {
    const fetchFn = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expectCode(
      uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch),
      'attachment_upload_failed'
    );
  });

  it('201 sin storageObjectId en el cuerpo también falla de forma tipada', async () => {
    const fetchFn = async () => jsonResponse(201, { apiVersion: 1 });
    await expectCode(
      uploadAttachment(HOUSEHOLD, makeFile(), fetchFn as unknown as typeof fetch),
      'attachment_upload_failed'
    );
  });

  it('un fichero sin type declarado viaja como application/octet-stream', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, { storageObjectId: STORAGE_OBJECT }));
    await uploadAttachment(HOUSEHOLD, makeFile('nota', ''), fetchFn as unknown as typeof fetch);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
  });
});
