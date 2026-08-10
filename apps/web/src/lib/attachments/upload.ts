/**
 * Subida de un adjunto (foto o PDF del justificante) a la ruta de adjuntos del
 * hogar. Es el camino ONLINE del flujo del gasto: el fichero viaja primero y el
 * comando del gasto referencia después el storageObjectId devuelto. El camino
 * offline (guardar la foto local y enlazarla al sincronizar) queda documentado
 * como siguiente paso en lib/offline/sync.ts (flushBlobs).
 */

export type UploadAttachmentErrorCode =
  | 'attachment_too_large'
  | 'attachment_type_not_allowed'
  | 'attachment_infected'
  | 'attachments_unavailable'
  | 'attachment_upload_failed';

/** Mensajes honestos en el idioma de la interfaz; la causa técnica viaja en `code`. */
const ERROR_MESSAGES: Record<UploadAttachmentErrorCode, string> = {
  attachment_too_large: 'El fichero pesa demasiado para subirlo. Si es una foto, hazla otra vez; si es un PDF, usa uno más ligero.',
  attachment_type_not_allowed: 'Ese tipo de fichero no está permitido: usa una foto (JPG, PNG, WebP) o un PDF.',
  attachment_infected: 'El fichero no ha pasado la revisión de seguridad y no se ha guardado.',
  attachments_unavailable: 'Adjuntar ficheros no está disponible ahora mismo.',
  attachment_upload_failed: 'No se pudo subir el fichero. Inténtalo de nuevo con conexión.'
};

export class UploadAttachmentError extends Error {
  override readonly name = 'UploadAttachmentError';

  constructor(readonly code: UploadAttachmentErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

function codeForStatus(status: number): UploadAttachmentErrorCode {
  switch (status) {
    case 413:
      return 'attachment_too_large';
    case 415:
      return 'attachment_type_not_allowed';
    case 422:
      return 'attachment_infected';
    case 503:
      return 'attachments_unavailable';
    default:
      return 'attachment_upload_failed';
  }
}

/**
 * Sube un File como cuerpo binario (content-type + x-attachment-name, el mismo
 * contrato que usa flushBlobs) y devuelve el storageObjectId confirmado por el
 * servidor. Cualquier fallo se traduce a un UploadAttachmentError con mensaje
 * listo para pintar en la interfaz.
 */
export async function uploadAttachment(
  householdId: string,
  file: File,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(`/api/v1/households/${householdId}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-attachment-name': file.name || 'adjunto'
      },
      body: file
    });
  } catch {
    throw new UploadAttachmentError('attachment_upload_failed');
  }

  if (!response.ok) throw new UploadAttachmentError(codeForStatus(response.status));

  let storageObjectId: unknown;
  try {
    storageObjectId = ((await response.json()) as { storageObjectId?: unknown }).storageObjectId;
  } catch {
    throw new UploadAttachmentError('attachment_upload_failed');
  }
  if (typeof storageObjectId !== 'string' || !storageObjectId) {
    throw new UploadAttachmentError('attachment_upload_failed');
  }
  return storageObjectId;
}
