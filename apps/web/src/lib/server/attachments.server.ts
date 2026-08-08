import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import { getDatabasePool } from './db.server';

const log = createLogger('web:attachments');

/** Límite duro de subida (control 5 de la línea base de seguridad). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Tipos permitidos y su extensión canónica en la clave de objeto. */
export const ALLOWED_ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf'
};

export type AttachmentErrorCode =
  | 'attachment_too_large'
  | 'attachment_type_not_allowed'
  | 'attachment_signature_mismatch'
  | 'attachment_infected'
  | 'attachments_unavailable'
  /** El antivirus no contesta o contesta algo que no se entiende. */
  | 'attachment_scan_unavailable'
  /** El almacén de objetos rechazó el PUT (credenciales, red, cuota). */
  | 'attachment_storage_unavailable';

/** Error tipado de la tubería de adjuntos; la ruta lo traduce a HTTP. */
export class AttachmentError extends Error {
  override readonly name = 'AttachmentError';

  constructor(
    readonly code: AttachmentErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * Dependencias externas inyectables: el escáner antivirus y el almacén de
 * objetos. En producción son ClamAV (INSTREAM) y S3/MinIO; en tests, dobles.
 */
export interface AttachmentDependencies {
  /** Nombre del bucket que se registrará en app.storage_objects. */
  bucket: string;
  scan(bytes: Uint8Array): Promise<'clean' | 'infected'>;
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Lectura del objeto ya guardado (ver un justificante desde la cuenta del mes). */
  getObject(key: string): Promise<Uint8Array>;
  /**
   * Misma lectura, pero en flujo. Es opcional para no obligar a los dobles de
   * test a implementarla, y el motivo de existir es concreto: una función de
   * Vercel no puede devolver más de 4,5 MB en una respuesta materializada, y un
   * justificante llega hasta MAX_ATTACHMENT_BYTES (10 MiB). En flujo ese límite
   * no aplica. Sin ella, la ruta cae a `getObject` (el camino autogestionado).
   */
  getObjectStream?(key: string): Promise<ReadableStream<Uint8Array>>;
}

export interface AttachmentInput {
  bytes: Uint8Array;
  /** MIME declarado por el cliente; se contrasta con la firma mágica real. */
  mediaType: string;
}

export interface AttachmentResult {
  storageObjectId: string;
  sha256: string;
}

function startsWithBytes(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((value, index) => bytes[offset + index] === value);
}

/**
 * Comprueba la firma mágica real del fichero: el MIME declarado no basta,
 * porque cualquier cliente puede mentir en el header (control 5).
 */
export function matchesMagicSignature(mediaType: string, bytes: Uint8Array): boolean {
  switch (mediaType) {
    case 'image/jpeg':
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      // RIFF <size> WEBP
      return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case 'application/pdf':
      return startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    default:
      return false;
  }
}

/** Clave determinista dentro del hogar: contenido idéntico → clave idéntica. */
export function attachmentObjectKey(householdId: string, sha256: string, mediaType: string): string {
  return `${householdId}/attachments/${sha256.slice(0, 16)}${ALLOWED_ATTACHMENT_TYPES[mediaType] ?? ''}`;
}

/**
 * Tubería completa de subida de un adjunto (AC-07/AC-11/AC-12-Storage):
 * validación de tamaño y tipo (header + firma mágica), sha-256, escaneo
 * antivirus ANTES de tocar el almacén (un fichero infectado no se sube ni se
 * registra: queda solo en el dispositivo, en cuarentena de facto) y, ya bajo
 * la RLS del actor, alta en app.storage_objects seguida del PUT al bucket
 * dentro de la misma transacción: si el PUT falla, el registro se revierte.
 */
export async function uploadAttachment(
  user: { id: string },
  householdId: string,
  input: AttachmentInput,
  deps: AttachmentDependencies,
  pool: Pool | null = getDatabasePool()
): Promise<AttachmentResult> {
  if (!pool) {
    throw new AttachmentError('attachments_unavailable', 'Los adjuntos requieren la base de datos del hogar');
  }
  const { bytes, mediaType } = input;
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      'attachment_too_large',
      `El adjunto debe ocupar entre 1 byte y ${MAX_ATTACHMENT_BYTES} bytes`
    );
  }
  if (!Object.hasOwn(ALLOWED_ATTACHMENT_TYPES, mediaType)) {
    throw new AttachmentError(
      'attachment_type_not_allowed',
      'Solo se admiten imágenes JPEG, PNG o WebP y documentos PDF'
    );
  }
  if (!matchesMagicSignature(mediaType, bytes)) {
    throw new AttachmentError(
      'attachment_signature_mismatch',
      'El contenido del fichero no coincide con el tipo declarado'
    );
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Antivirus SIEMPRE antes de subir: un positivo corta la tubería en seco.
  // Un antivirus CAÍDO no es un positivo y tampoco puede pasar por limpio: se
  // traduce a un error tipado que la ruta convierte en 503 con un mensaje
  // veraz («el antivirus no responde»), en vez del 500 mudo que salía antes de
  // que nadie capturase el rechazo del socket (auditoría §6).
  let verdict: 'clean' | 'infected';
  try {
    verdict = await deps.scan(bytes);
  } catch (cause) {
    log.error('antivirus unavailable', { code: errorCode(cause) });
    throw new AttachmentError(
      'attachment_scan_unavailable',
      'El antivirus del hogar no responde: la foto sigue en tu dispositivo y no se ha guardado nada'
    );
  }
  if (verdict === 'infected') {
    throw new AttachmentError(
      'attachment_infected',
      'El antivirus ha detectado malware: el fichero queda en cuarentena y no se ha guardado'
    );
  }

  const objectKey = attachmentObjectKey(householdId, sha256, mediaType);

  return withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
    // Contenido idéntico ya registrado en este hogar → subida idempotente.
    const existing = await client.query<{ id: string }>(
      `select id from app.storage_objects
        where bucket = $1 and object_key = $2 and household_id = $3 and deleted_at is null`,
      [deps.bucket, objectKey, householdId]
    );
    const existingId = existing.rows[0]?.id;
    if (existingId) return { storageObjectId: existingId, sha256 };

    const inserted = await client.query<{ id: string }>(
      `insert into app.storage_objects
         (household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [householdId, deps.bucket, objectKey, mediaType, bytes.length, sha256, membership.id]
    );
    // PUT dentro de la transacción: si el almacén falla, el registro se
    // revierte y no queda fila huérfana apuntando a un objeto inexistente.
    // El fallo se tipa igual que el del antivirus: 503 honesto en vez de 500.
    try {
      await deps.putObject(objectKey, bytes, mediaType);
    } catch (cause) {
      log.error('object store unavailable', { code: errorCode(cause) });
      throw new AttachmentError(
        'attachment_storage_unavailable',
        'El almacén de documentos del hogar no responde: la foto sigue en tu dispositivo y no se ha guardado nada'
      );
    }
    return { storageObjectId: inserted.rows[0]!.id, sha256 };
  });
}
