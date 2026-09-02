import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanWithClamAv } from '../src/lib/server/attachment-deps.server';

/**
 * La pasarela de infra/clamav es lo ÚNICO que separa al antivirus del hogar de
 * internet abierto cuando la web vive en Vercel y clamd en el host del worker:
 * clamd no tiene autenticación propia. Estas pruebas la arrancan de verdad
 * —proceso Node real, TLS real— contra un clamd falso, y fijan las dos mitades
 * del contrato: con el token correcto el diálogo INSTREAM llega intacto y sin
 * el saludo; sin token o con uno equivocado, a clamd no le llega NADA.
 */

const GATEWAY = fileURLToPath(new URL('../../../infra/clamav/gateway.mjs', import.meta.url));
const TOKEN = 'token-de-prueba-0123456789abcdef';

interface FakeClamd {
  port: number;
  /** Todo lo que la pasarela reenvió; debe ser INSTREAM puro. */
  readonly forwarded: Buffer;
  close(): void;
}

function startFakeClamd(): Promise<FakeClamd> {
  return new Promise((resolve) => {
    const state = { forwarded: Buffer.alloc(0) };
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        state.forwarded = Buffer.concat([state.forwarded, chunk]);
        // El terminador de INSTREAM son cuatro ceros al final del flujo.
        if (state.forwarded.length >= 4 && state.forwarded.readUInt32BE(state.forwarded.length - 4) === 0) {
          socket.write('stream: OK\0');
          socket.end();
        }
      });
      socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        get forwarded() {
          return state.forwarded;
        },
        close: () => server.close()
      });
    });
  });
}

/** Par certificado/clave autofirmado para `localhost`, vía el openssl del sistema. */
async function selfSigned(): Promise<{ certPath: string; keyPath: string; caPem: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'housekeeper-clamav-gw-'));
  const keyPath = join(dir, 'privkey.pem');
  const certPath = join(dir, 'fullchain.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  await new Promise<void>((resolve, reject) => {
    const openssl = spawn('openssl', [
      'req', '-new', '-x509', '-key', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
    ]);
    openssl.on('error', reject);
    openssl.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`openssl salió con ${code}`))));
  });
  return { certPath, keyPath, caPem: readFileSync(certPath, 'utf8') };
}

function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (condition()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('la pasarela no llegó a escuchar'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('pasarela autenticada delante de clamd', () => {
  let clamd: FakeClamd;
  let gateway: ChildProcess;
  let port = 0;
  let caPem = '';
  let listening = false;

  beforeAll(async () => {
    clamd = await startFakeClamd();
    const { certPath, keyPath, caPem: ca } = await selfSigned();
    caPem = ca;
    gateway = spawn(process.execPath, [GATEWAY], {
      env: {
        ...process.env,
        CLAMAV_GATEWAY_TOKEN: TOKEN,
        CLAMAV_GATEWAY_CERT: certPath,
        CLAMAV_GATEWAY_KEY: keyPath,
        // 0 = que el sistema elija; el puerto real se lee del log de arranque.
        CLAMAV_GATEWAY_PORT: '0',
        CLAMAV_UPSTREAM_HOST: '127.0.0.1',
        CLAMAV_UPSTREAM_PORT: String(clamd.port)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    gateway.stdout?.on('data', (chunk: Buffer) => {
      const match = /escuchando TLS en :(\d+)/.exec(chunk.toString('utf8'));
      if (match) {
        port = Number(match[1]);
        listening = true;
      }
    });
    await waitFor(() => listening);
  }, 40_000);

  afterAll(() => {
    gateway?.kill('SIGTERM');
    clamd?.close();
  });

  it('con el token correcto el INSTREAM llega intacto a clamd y el veredicto vuelve', async () => {
    const verdict = await scanWithClamAv(new TextEncoder().encode('contenido inocuo'), {
      host: 'localhost',
      port,
      tls: true,
      token: TOKEN,
      caPem,
      timeoutMs: 4_000
    });
    expect(verdict).toBe('clean');
    // El saludo se consume en la pasarela: clamd ve el diálogo de siempre.
    expect(clamd.forwarded.subarray(0, 10).toString('utf8')).toBe('zINSTREAM\0');
  });

  it('sin token no se llega a hablar con clamd', async () => {
    const before = clamd.forwarded.length;
    await expect(
      scanWithClamAv(new TextEncoder().encode('x'), {
        host: 'localhost',
        port,
        tls: true,
        caPem,
        timeoutMs: 4_000
      })
    ).rejects.toThrow(/ClamAV/);
    expect(clamd.forwarded.length).toBe(before);
  });

  it('con un token equivocado tampoco pasa nada al antivirus', async () => {
    const before = clamd.forwarded.length;
    await expect(
      scanWithClamAv(new TextEncoder().encode('x'), {
        host: 'localhost',
        port,
        tls: true,
        token: 'token-equivocado-0000000000000000',
        caPem,
        timeoutMs: 4_000
      })
    ).rejects.toThrow(/ClamAV/);
    expect(clamd.forwarded.length).toBe(before);
  });

  it('el certificado se verifica: una CA que no encaja corta la conexión', async () => {
    const otra = await selfSigned();
    await expect(
      scanWithClamAv(new TextEncoder().encode('x'), {
        host: 'localhost',
        port,
        tls: true,
        token: TOKEN,
        caPem: otra.caPem,
        timeoutMs: 4_000
      })
    ).rejects.toThrow(/ClamAV/);
  });
});
