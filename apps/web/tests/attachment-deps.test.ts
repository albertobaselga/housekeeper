import net from 'node:net';
import { describe, expect, it } from 'vitest';

import { createAttachmentDependencies, scanWithClamAv } from '../src/lib/server/attachment-deps.server';

interface FakeClamd {
  port: number;
  /** Comando y payload reconstruidos del último cliente (para auditar el framing). */
  seen: { command: string; payload: Buffer } | null;
  close(): Promise<void>;
}

/**
 * clamd falso: acepta UNA conexión, parsea el protocolo INSTREAM completo
 * (comando `zINSTREAM\0`, trozos con prefijo de longitud en 4 bytes BE y trozo
 * cero terminal) y contesta con la respuesta indicada terminada en \0.
 */
function startFakeClamd(reply: string): Promise<FakeClamd> {
  return new Promise((resolveServer) => {
    const state: FakeClamd = { port: 0, seen: null, close: async () => undefined };
    const server = net.createServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on('data', (data) => {
        buffered = Buffer.concat([buffered, data]);
        const commandEnd = buffered.indexOf(0);
        if (commandEnd === -1) return;
        const command = buffered.subarray(0, commandEnd).toString('utf8');
        let offset = commandEnd + 1;
        const chunks: Buffer[] = [];
        // Reconstruye los trozos; solo respondemos tras el trozo de longitud 0.
        while (offset + 4 <= buffered.length) {
          const length = buffered.readUInt32BE(offset);
          if (length === 0) {
            state.seen = { command, payload: Buffer.concat(chunks) };
            socket.write(`${reply}\0`);
            socket.end();
            return;
          }
          if (offset + 4 + length > buffered.length) return;
          chunks.push(buffered.subarray(offset + 4, offset + 4 + length));
          offset += 4 + length;
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as net.AddressInfo).port;
      state.close = () =>
        new Promise((resolveClose) => {
          server.close(() => resolveClose());
        });
      resolveServer(state);
    });
  });
}

describe('cliente INSTREAM de ClamAV por TCP', () => {
  it("'stream: OK' es limpio y el framing llega intacto (comando, trozos y terminador)", async () => {
    const clamd = await startFakeClamd('stream: OK');
    try {
      const payload = new Uint8Array(200_000).map((_, index) => index % 251);
      const verdict = await scanWithClamAv(payload, { host: '127.0.0.1', port: clamd.port });
      expect(verdict).toBe('clean');
      expect(clamd.seen?.command).toBe('zINSTREAM');
      // El payload de 200 kB viaja en varios trozos de 64 KiB y se reconstruye
      // byte a byte: el prefijo de longitud y el terminador son correctos.
      expect(clamd.seen?.payload.equals(Buffer.from(payload))).toBe(true);
    } finally {
      await clamd.close();
    }
  });

  it("'FOUND' se traduce a infected", async () => {
    const clamd = await startFakeClamd('stream: Eicar-Signature FOUND');
    try {
      const verdict = await scanWithClamAv(new TextEncoder().encode('eicar'), {
        host: '127.0.0.1',
        port: clamd.port
      });
      expect(verdict).toBe('infected');
    } finally {
      await clamd.close();
    }
  });

  it('una respuesta no reconocida es un error, nunca un falso limpio', async () => {
    const clamd = await startFakeClamd('INSTREAM size limit exceeded. ERROR');
    try {
      await expect(
        scanWithClamAv(new TextEncoder().encode('x'), { host: '127.0.0.1', port: clamd.port })
      ).rejects.toThrow('Respuesta de ClamAV no reconocida');
    } finally {
      await clamd.close();
    }
  });

  it('sin daemon accesible el escaneo falla con error claro (no se asume limpio)', async () => {
    const clamd = await startFakeClamd('stream: OK');
    const deadPort = clamd.port;
    await clamd.close();
    await expect(
      scanWithClamAv(new TextEncoder().encode('x'), { host: '127.0.0.1', port: deadPort, timeoutMs: 2_000 })
    ).rejects.toThrow('No se pudo escanear con ClamAV');
  });
});

describe('createAttachmentDependencies desde variables de entorno', () => {
  const FULL_ENV = {
    CLAMAV_HOST: 'clamav',
    CLAMAV_PORT: '3310',
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'eu-west-1',
    S3_PRIVATE_BUCKET: 'casaclara-local',
    S3_ACCESS_KEY_ID: 'casaclara-local',
    S3_SECRET_ACCESS_KEY: 'local-object-storage-only'
  };

  it('con la configuración completa de Compose devuelve deps con el bucket', () => {
    const deps = createAttachmentDependencies(FULL_ENV);
    expect(deps).not.toBeNull();
    expect(deps!.bucket).toBe('casaclara-local');
    expect(typeof deps!.scan).toBe('function');
    expect(typeof deps!.putObject).toBe('function');
  });

  it('sin configuración (local sin Docker) devuelve null y la ruta responderá 503', () => {
    expect(createAttachmentDependencies({})).toBeNull();
    expect(createAttachmentDependencies({ ...FULL_ENV, S3_PRIVATE_BUCKET: ' ' })).toBeNull();
    expect(createAttachmentDependencies({ ...FULL_ENV, CLAMAV_HOST: undefined })).toBeNull();
  });
});
