import { error, json } from '@sveltejs/kit';

import { AuthorizationError } from '@casa-clara/server';

import { createAttachmentDependencies } from '$lib/server/attachment-deps.server';
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  uploadAttachment
} from '$lib/server/attachments.server';
import { getDatabasePool } from '$lib/server/db.server';
import type { RequestHandler } from './$types';

const ERROR_STATUS: Record<AttachmentError['code'], number> = {
  attachment_too_large: 413,
  attachment_type_not_allowed: 415,
  attachment_signature_mismatch: 415,
  attachment_infected: 422,
  attachments_unavailable: 503,
  attachment_scan_unavailable: 503,
  attachment_storage_unavailable: 503
};

/**
 * Subida de un adjunto (foto de ticket, justificante, PDF). Acepta multipart
 * (`file`) o el cuerpo binario directo con content-type + x-attachment-name.
 * El fichero pasa validación de tipo/tamaño/firma, sha-256 y ClamAV antes de
 * llegar al bucket; un positivo devuelve 422 y NO deja rastro en el servidor.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
  if (!locals.user) error(401, 'Inicia sesión para adjuntar ficheros');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) error(403, 'Origen no permitido');

  const pool = getDatabasePool();
  const deps = createAttachmentDependencies();
  if (!pool || !deps) {
    error(503, 'Los adjuntos requieren la base de datos, el almacén de objetos y el antivirus del hogar');
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_ATTACHMENT_BYTES) {
    error(413, `El adjunto supera el máximo de ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
  }

  const contentType = request.headers.get('content-type') ?? '';
  let bytes: Uint8Array;
  let mediaType: string;
  if (contentType.startsWith('multipart/form-data')) {
    let file: FormDataEntryValue | null;
    try {
      file = (await request.formData()).get('file');
    } catch {
      error(400, 'No se pudo leer el fichero adjunto');
    }
    if (!(file instanceof File)) error(422, 'No llegó ningún fichero adjunto');
    bytes = new Uint8Array(await file.arrayBuffer());
    mediaType = file.type;
  } else {
    bytes = new Uint8Array(await request.arrayBuffer());
    mediaType = contentType.split(';')[0]!.trim();
  }

  try {
    const result = await uploadAttachment(locals.user, params.householdId, { bytes, mediaType }, deps, pool);
    return json(
      { apiVersion: 1, storageObjectId: result.storageObjectId, sha256: result.sha256 },
      { status: 201, headers: { 'cache-control': 'no-store' } }
    );
  } catch (cause) {
    if (cause instanceof AttachmentError) error(ERROR_STATUS[cause.code], cause.message);
    if (cause instanceof AuthorizationError) error(403, 'No perteneces a este hogar');
    throw cause;
  }
};
