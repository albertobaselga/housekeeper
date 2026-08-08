#!/usr/bin/env node
/**
 * Pasarela autenticada delante de clamd.
 *
 * POR QUÉ EXISTE. clamd no tiene autenticación: quien alcance su puerto 3310
 * puede escanear lo que quiera y agotar el host. En el despliegue
 * autogestionado eso da igual porque clamd vive en la red `data` de Compose,
 * que es `internal: true`. Con la web en Vercel y el antivirus en el host del
 * worker, el socket cruza internet y hacen falta dos cosas que clamd no trae:
 * cifrado y un «quién eres». Publicar el 3310 en abierto NO es una opción.
 *
 * QUÉ HACE. Escucha en TLS (certificado y clave por fichero), exige como
 * primera línea `CASACLARA <token>\n` con el secreto compartido, y a partir de
 * ahí conecta con clamd en 127.0.0.1:3310 y hace de tubería en los dos
 * sentidos SIN tocar un byte: el cliente ve exactamente el diálogo INSTREAM de
 * siempre y clamd ve exactamente el cliente de siempre. El saludo se consume
 * aquí y no se reenvía.
 *
 * QUÉ NO HACE. No parsea INSTREAM, no cachea, no registra contenido. Los logs
 * solo llevan el resultado del saludo y el motivo del cierre: nunca la IP
 * completa ni un byte del fichero.
 *
 * Variables:
 *   CLAMAV_GATEWAY_PORT   puerto de escucha TLS (por omisión 3311)
 *   CLAMAV_GATEWAY_TOKEN  secreto compartido; el mismo valor que CLAMAV_TOKEN
 *                         en la web. Sin él el proceso no arranca.
 *   CLAMAV_GATEWAY_CERT   ruta del certificado en PEM
 *   CLAMAV_GATEWAY_KEY    ruta de la clave privada en PEM
 *   CLAMAV_UPSTREAM_HOST  clamd (por omisión 127.0.0.1)
 *   CLAMAV_UPSTREAM_PORT  clamd (por omisión 3310)
 *   CLAMAV_GATEWAY_HANDSHAKE_MS  plazo para mandar el saludo (por omisión 5000)
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import tls from 'node:tls';

const GREETING = 'CASACLARA ';
const MAX_GREETING_BYTES = 512;

function required(key) {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`[clamav-gateway] falta la variable ${key}`);
    process.exit(78); // EX_CONFIG
  }
  return value;
}

const token = required('CLAMAV_GATEWAY_TOKEN');
const expected = Buffer.from(token, 'utf8');
const port = Number.parseInt(process.env.CLAMAV_GATEWAY_PORT?.trim() || '3311', 10);
const upstreamHost = process.env.CLAMAV_UPSTREAM_HOST?.trim() || '127.0.0.1';
const upstreamPort = Number.parseInt(process.env.CLAMAV_UPSTREAM_PORT?.trim() || '3310', 10);
const handshakeMs = Number.parseInt(process.env.CLAMAV_GATEWAY_HANDSHAKE_MS?.trim() || '5000', 10);

/** Comparación en tiempo constante: un token corto no debe filtrar su prefijo. */
function tokenMatches(candidate) {
  const given = Buffer.from(candidate, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const server = tls.createServer(
  {
    cert: readFileSync(required('CLAMAV_GATEWAY_CERT')),
    key: readFileSync(required('CLAMAV_GATEWAY_KEY')),
    minVersion: 'TLSv1.2'
  },
  (client) => {
    let buffered = Buffer.alloc(0);
    let authorised = false;

    const reject = (reason) => {
      console.warn(`[clamav-gateway] conexión rechazada: ${reason}`);
      client.destroy();
    };

    const deadline = setTimeout(() => {
      if (!authorised) reject('saludo fuera de plazo');
    }, handshakeMs);

    const onGreeting = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a); // \n
      if (end === -1) {
        if (buffered.length > MAX_GREETING_BYTES) reject('saludo demasiado largo');
        return;
      }
      const line = buffered.subarray(0, end).toString('utf8').trimEnd();
      // Lo que venga DESPUÉS del saludo ya es INSTREAM y viaja tal cual.
      const rest = buffered.subarray(end + 1);
      if (!line.startsWith(GREETING) || !tokenMatches(line.slice(GREETING.length))) {
        reject('saludo inválido');
        return;
      }
      authorised = true;
      clearTimeout(deadline);
      client.off('data', onGreeting);
      // Pausa obligatoria: quitar el último listener de 'data' NO detiene el
      // flujo, así que sin esto los bytes que lleguen entre el saludo y el
      // pipe se perderían y el INSTREAM llegaría truncado a clamd.
      client.pause();

      const upstream = net.connect(upstreamPort, upstreamHost);
      upstream.on('error', (cause) => {
        console.warn(`[clamav-gateway] clamd no responde: ${cause.code ?? cause.message}`);
        client.destroy();
      });
      client.on('error', () => upstream.destroy());
      upstream.on('connect', () => {
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };

    client.on('data', onGreeting);
    client.on('error', () => clearTimeout(deadline));
    client.on('close', () => clearTimeout(deadline));
  }
);

server.on('error', (cause) => {
  console.error(`[clamav-gateway] no se pudo escuchar: ${cause.message}`);
  process.exitCode = 1;
});

server.listen(port, '0.0.0.0', () => {
  // Se anuncia el puerto REAL, no el pedido: con 0 lo elige el sistema y las
  // pruebas (y el operador) necesitan saber cuál tocó.
  const bound = server.address().port;
  console.log(`[clamav-gateway] escuchando TLS en :${bound} → clamd ${upstreamHost}:${upstreamPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
