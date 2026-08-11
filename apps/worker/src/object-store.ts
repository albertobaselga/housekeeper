/**
 * Almacén privado de objetos (S3 / Supabase Storage) para los trabajos que
 * producen ficheros — hoy solo `document.render_receipt`.
 *
 * Separado de `integrations.ts` porque el drenaje de la cola desde la web
 * necesita subir el PDF del justificante y nada más, y no puede arrastrar
 * `sharp` ni `tesseract.js` a la función serverless. `integrations.ts`
 * re-exporta sus símbolos.
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Lo que necesita el cliente; espejo de `WorkerConfig["storage"]`. */
export interface ObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function objectStore(config: ObjectStoreConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export async function putPrivateObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  if (!/^[a-f0-9-]+\/[a-z0-9/_-]+\.[a-z0-9]+$/i.test(key)) {
    throw new TypeError("Clave de objeto no autorizada");
  }
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}
