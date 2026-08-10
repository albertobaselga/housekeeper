import net from 'node:net';
import tls from 'node:tls';

import { env } from '$env/dynamic/private';

import type { AttachmentDependencies } from './attachments.server';
import { createSupabaseStorageClient, readSupabaseStorageConfig } from './supabase-storage.server';

/** Tamaño de cada trozo INSTREAM (límite habitual de clamd: 25 MB/stream). */
const INSTREAM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /**
   * TLS en el transporte. Obligatorio cuando clamd NO está en la misma red
   * privada que la web —el caso del despliegue en Vercel, donde el antivirus
   * vive en el host del worker—: el documento del hogar viaja entero por ese
   * socket y no puede ir en claro por internet.
   */
  tls?: boolean;
  /**
   * Secreto compartido que la pasarela de `infra/clamav` exige antes de dejar
   * pasar nada a clamd. clamd no tiene autenticación propia, así que sin esto
   * publicar el 3310 equivale a ofrecer escaneo gratis a quien pase por ahí.
   */
  token?: string;
  /**
   * Autoridad de confianza en PEM, para cuando el certificado de la pasarela lo
   * emite una CA propia en vez de una pública. La verificación NUNCA se apaga:
   * o el certificado encadena con las CA del sistema, o se declara la CA aquí.
   */
  caPem?: string;
}

/**
 * Cliente mínimo del protocolo INSTREAM de clamd por TCP, sin dependencias:
 * se envía `zINSTREAM\0`, después cada trozo precedido de su longitud en 4
 * bytes big-endian y un trozo de longitud cero como terminador. clamd responde
 * `stream: OK` (limpio) o `stream: <firma> FOUND` (infectado), terminado en \0.
 *
 * Con `tls` el socket se abre cifrado y con `token` se antepone la línea
 * `CASACLARA <token>\n`, que la pasarela consume y no reenvía: clamd al otro
 * lado ve exactamente el mismo diálogo de siempre.
 */
export function scanWithClamAv(bytes: Uint8Array, options: ClamAvOptions): Promise<'clean' | 'infected'> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = options.tls
      ? tls.connect({
          host: options.host,
          port: options.port,
          servername: options.host,
          ...(options.caPem ? { ca: options.caPem } : {})
        })
      : net.connect(options.port, options.host);
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

    const sendStream = (): void => {
      // El saludo de la pasarela va PRIMERO y en su propia escritura: quien
      // no lo conozca no llega a hablar con clamd.
      if (options.token) socket.write(`CASACLARA ${options.token}\n`);
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < bytes.length; offset += INSTREAM_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + INSTREAM_CHUNK_BYTES, bytes.length));
        const frame = Buffer.alloc(4 + chunk.length);
        frame.writeUInt32BE(chunk.length, 0);
        frame.set(chunk, 4);
        socket.write(frame);
      }
      socket.write(Buffer.from([0, 0, 0, 0]));
    };
    // Con TLS hay que esperar al handshake: escribir en `connect` mandaría los
    // bytes antes de que el canal esté cifrado y negociado.
    socket.on(options.tls ? 'secureConnect' : 'connect', sendStream);

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

/** Solo lo del almacén: sin escáner y sin nada más. */
type StorageBackend = Pick<AttachmentDependencies, 'bucket' | 'putObject' | 'getObject'> &
  Required<Pick<AttachmentDependencies, 'getObjectStream'>>;

/**
 * Almacén por S3, el camino AUTOGESTIONADO (MinIO en Compose, o cualquier S3).
 * El SDK se carga BAJO DEMANDA y una sola vez: en el despliegue serverless, que
 * usa Supabase Storage por HTTP, no llega a evaluarse nunca y no se paga en el
 * arranque en frío.
 */
function createS3Backend(environment: Partial<Record<string, string>>): StorageBackend | null {
  const endpoint = environment.S3_ENDPOINT?.trim();
  const bucket = environment.S3_PRIVATE_BUCKET?.trim();
  const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const region = environment.S3_REGION?.trim() || 'eu-west-1';

  // Mismo cliente y estilo path-style que apps/worker (integrations.ts).
  let client: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;
  const s3 = async () => {
    client ??= import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })
    );
    return await client;
  };
  const getBody = async (key: string) => {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const result = await (await s3()).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error(`El objeto ${key} llegó sin contenido`);
    return result.Body;
  };

  return {
    bucket,
    putObject: async (key, bytes, contentType) => {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await (await s3()).send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType })
      );
    },
    getObject: async (key) => await (await getBody(key)).transformToByteArray(),
    getObjectStream: async (key) => (await getBody(key)).transformToWebStream() as ReadableStream<Uint8Array>
  };
}

/**
 * Escáner antivirus, si este despliegue tiene uno. Devuelve undefined cuando no
 * hay `CLAMAV_HOST`, y eso NO anula los adjuntos: la tubería sube sin escanear
 * (riesgo asumido y documentado en docs/security/adjuntos-sin-antivirus.md).
 * Definir `CLAMAV_HOST` lo vuelve a encender sin tocar código.
 */
function createScanner(
  environment: Partial<Record<string, string>>
): AttachmentDependencies['scan'] | undefined {
  const clamHost = environment.CLAMAV_HOST?.trim();
  const clamPort = Number.parseInt(environment.CLAMAV_PORT?.trim() || '3310', 10);
  if (!clamHost || !Number.isInteger(clamPort)) return undefined;
  // Transporte del antivirus: en Compose clamd está en la red interna y va en
  // claro; con la web en Vercel y clamd en un host aparte, CLAMAV_TLS y
  // CLAMAV_TOKEN son obligatorias (ver docs/despliegue/runbook-despliegue.md).
  const clamTls = environment.CLAMAV_TLS?.trim() === 'true';
  const clamToken = environment.CLAMAV_TOKEN?.trim();
  const clamCa = environment.CLAMAV_TLS_CA_PEM?.trim();
  return (bytes) =>
    scanWithClamAv(bytes, {
      host: clamHost,
      port: clamPort,
      ...(clamTls ? { tls: true } : {}),
      ...(clamToken ? { token: clamToken } : {}),
      ...(clamCa ? { caPem: clamCa } : {})
    });
}

/**
 * Dependencias reales de la tubería de adjuntos. Lo único imprescindible es el
 * ALMACÉN; el antivirus se añade solo si hay dónde ejecutarlo.
 *
 * Se prefiere Supabase Storage cuando hay clave de servicio (el despliegue
 * real: Vercel + Supabase, sin host propio) y se cae a S3 con las S3_* cuando
 * las hay (Compose local y staging con MinIO). Sin ninguna de las dos devuelve
 * null y la ruta responde 503 con 'attachments_unavailable' en lugar de fingir
 * que sube.
 */
export function createAttachmentDependencies(
  environment: Partial<Record<string, string>> = env
): AttachmentDependencies | null {
  const supabase = readSupabaseStorageConfig(environment);
  const storage: StorageBackend | null = supabase
    ? createSupabaseStorageClient(supabase)
    : createS3Backend(environment);
  if (!storage) return null;
  const scan = createScanner(environment);
  return { ...storage, ...(scan ? { scan } : {}) };
}
