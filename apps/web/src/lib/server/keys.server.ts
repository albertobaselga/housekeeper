import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { env } from '$env/dynamic/private';

export interface SnapshotKeys {
  privateKeyPem: string;
  publicKeyPem: string;
  /** Clave pública Ed25519 en crudo (base64url), lista para WebCrypto en el cliente. */
  publicKeyRaw: string;
}

let keys: SnapshotKeys | null = null;

function deriveKeys(privateKeyPem: string): SnapshotKeys {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  const jwk = publicKey.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string };
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
    throw new Error('SNAPSHOT_SIGNING_KEY_B64 debe contener una clave privada Ed25519 en PEM');
  }
  return {
    privateKeyPem,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    publicKeyRaw: jwk.x
  };
}

export function getSnapshotKeys(): SnapshotKeys {
  if (keys) return keys;
  const encoded = env.SNAPSHOT_SIGNING_KEY_B64;
  if (encoded) {
    keys = deriveKeys(Buffer.from(encoded, 'base64').toString('utf8'));
  } else {
    // Sin clave configurada se genera una efímera por proceso: suficiente para la
    // demo local; staging debe fijar SNAPSHOT_SIGNING_KEY_B64 para que los
    // snapshots sobrevivan a reinicios y réplicas.
    const { privateKey } = generateKeyPairSync('ed25519');
    keys = deriveKeys(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  }
  return keys;
}
