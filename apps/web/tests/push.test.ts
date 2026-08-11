import { describe, expect, it } from 'vitest';

import { endpointIsAcceptable, pushPublicKey } from '../src/lib/server/push.server';
import { decodeVapidKey } from '../src/lib/push/subscribe';

describe('la clave pública del canal', () => {
  const complete = {
    VAPID_PUBLIC_KEY: 'BPublicaDePrueba',
    VAPID_PRIVATE_KEY: 'PrivadaDePrueba',
    VAPID_SUBJECT: 'mailto:casa@ejemplo.es'
  };

  it('solo existe si el canal entero está configurado', () => {
    expect(pushPublicKey(complete)).toBe('BPublicaDePrueba');
    // Con la pública puesta y la privada a medias, el navegador se suscribiría a
    // un servidor que jamás podrá escribirle: el silencio se leería como «está
    // roto» en vez de como «no está configurado». Las tres o ninguna.
    expect(pushPublicKey({ ...complete, VAPID_PRIVATE_KEY: '' })).toBeNull();
    expect(pushPublicKey({ ...complete, VAPID_SUBJECT: '  ' })).toBeNull();
    expect(pushPublicKey({})).toBeNull();
  });

  it('no deja escapar la privada por ninguna parte', () => {
    // Suena a perogrullada y por eso se escribe: la pública viaja al cliente por
    // definición y la privada firma. Una confusión aquí manda la firma al
    // navegador de todo el mundo.
    expect(pushPublicKey(complete)).not.toBe(complete.VAPID_PRIVATE_KEY);
  });
});

describe('veto sobre la dirección de avisos que manda el navegador', () => {
  // El endpoint lo elige el navegador, pero llega en una petición que cualquiera
  // de las cinco personas del hogar puede fabricar a mano. Sin veto, el servidor
  // haría POST a donde le dijeran.
  const publicDns = async () => [{ address: '93.184.216.34' }];
  const privateDns = async () => [{ address: '10.0.0.5' }];
  const mixedDns = async () => [{ address: '93.184.216.34' }, { address: '169.254.169.254' }];

  it('acepta un endpoint https de un host público', async () => {
    expect(await endpointIsAcceptable('https://fcm.ejemplo.test/abc123', publicDns)).toBe(true);
  });

  it('rechaza todo lo que no sea https limpio', async () => {
    expect(await endpointIsAcceptable('http://fcm.ejemplo.test/abc', publicDns)).toBe(false);
    expect(await endpointIsAcceptable('no-es-una-url', publicDns)).toBe(false);
    expect(await endpointIsAcceptable('https://usuario:clave@fcm.ejemplo.test/a', publicDns)).toBe(false);
    expect(await endpointIsAcceptable(`https://fcm.ejemplo.test/${'x'.repeat(2100)}`, publicDns)).toBe(false);
  });

  it('rechaza la red interna, incluido el punto de metadatos', async () => {
    expect(await endpointIsAcceptable('https://interno.ejemplo.test/a', privateDns)).toBe(false);
    // Un solo registro prohibido descarta el host entero: el atacante no elige
    // cuál de las direcciones se usa.
    expect(await endpointIsAcceptable('https://mixto.ejemplo.test/a', mixedDns)).toBe(false);
    expect(await endpointIsAcceptable('https://127.0.0.1/a', async () => [{ address: '127.0.0.1' }])).toBe(false);
  });

  it('falla cerrado cuando el host no resuelve', async () => {
    const noDns = async () => {
      throw new Error('NXDOMAIN');
    };
    expect(await endpointIsAcceptable('https://fantasma.ejemplo.test/a', noDns)).toBe(false);
    expect(await endpointIsAcceptable('https://vacio.ejemplo.test/a', async () => [])).toBe(false);
  });
});

describe('la clave VAPID que se le pasa al navegador', () => {
  it('se decodifica desde base64url, con o sin relleno', () => {
    // El alfabeto de base64url cambia `+/` por `-_` y suele venir sin `=`. Si el
    // relleno no se repone, `atob` lanza y la suscripción falla con un error que
    // no dice nada — en un navegador, y solo en el momento de encenderlos.
    const bytes = new Uint8Array(decodeVapidKey('SGVsbG8td29ybGQ_-w'));
    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('Hello');
  });
});
