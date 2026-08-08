import net from 'node:net';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '$env/dynamic/private';

import type { AttachmentDependencies } from './attachments.server';

/** Tamaño de cada trozo INSTREAM (límite habitual de clamd: 25 MB/stream). */
const INSTREAM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

/**
 * Cliente mínimo del protocolo INSTREAM de clamd por TCP, sin dependencias:
 * se envía `zINSTREAM\0`, después cada trozo precedido de su longitud en 4
 * bytes big-endian y un trozo de longitud cero como terminador. clamd responde
 * `stream: OK` (limpio) o `stream: <firma> FOUND` (infectado), terminado en \0.
 */
export function scanWithClamAv(bytes: Uint8Array, options: ClamAvOptions): Promise<'clean' | 'infected'> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = net.connect(options.port, options.host);
    const received: Buffer[] = [];
    let settled = false;

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      outcome();
    };

    socket.setTimeout(timeoutMs, () => {
      finish(() => reject(new Error(`ClamAV no respondió en ${timeoutMs} ms`)));
    });
    socket.on('error', (cause) => {
      finish(() => reject(new Error(`No se pudo escanear con ClamAV: ${cause.message}`)));
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < bytes.length; offset += INSTREAM_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + INSTREAM_CHUNK_BYTES, bytes.length));
        const frame = Buffer.alloc(4 + chunk.length);
        frame.writeUInt32BE(chunk.length, 0);
        frame.set(chunk, 4);
        socket.write(frame);
      }
      socket.write(Buffer.from([0, 0, 0, 0]));
    });

    const conclude = (): void => {
      const reply = Buffer.concat(received).toString('utf8').replaceAll('\0', '').trim();
      if (/\bFOUND$/.test(reply)) {
        finish(() => resolve('infected'));
      } else if (/\bOK$/.test(reply)) {
        finish(() => resolve('clean'));
      } else {
        finish(() => reject(new Error(`Respuesta de ClamAV no reconocida: "${reply}"`)));
      }
    };

    socket.on('data', (data) => {
      received.push(data);
      if (data.includes(0)) conclude();
    });
    socket.on('end', conclude);
  });
}

/**
 * Dependencias reales de la tubería de adjuntos, construidas desde las env
 * S3_* y CLAMAV_* que Compose inyecta a la web. Devuelve null cuando falta
 * configuración (desarrollo local sin Docker): la ruta responde 503 con el
 * error tipado 'attachments_unavailable' en lugar de fingir que sube.
 */
export function createAttachmentDependencies(
  environment: Partial<Record<string, string>> = env
): AttachmentDependencies | null {
  const clamHost = environment.CLAMAV_HOST?.trim();
  const clamPort = Number.parseInt(environment.CLAMAV_PORT?.trim() || '3310', 10);
  const endpoint = environment.S3_ENDPOINT?.trim();
  const bucket = environment.S3_PRIVATE_BUCKET?.trim();
  const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
  if (!clamHost || !Number.isInteger(clamPort) || !endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  // Mismo cliente y estilo path-style que apps/worker (integrations.ts).
  const client = new S3Client({
    endpoint,
    region: environment.S3_REGION?.trim() || 'eu-west-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }
  });

  return {
    bucket,
    scan: (bytes) => scanWithClamAv(bytes, { host: clamHost, port: clamPort }),
    putObject: async (key, bytes, contentType) => {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType })
      );
    },
    getObject: async (key) => {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error(`El objeto ${key} llegó sin contenido`);
      return await result.Body.transformToByteArray();
    },
    getObjectStream: async (key) => {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error(`El objeto ${key} llegó sin contenido`);
      return result.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    }
  };
}
