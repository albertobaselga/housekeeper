import { canonicalJson } from '@housekeeper/contracts';

import type { CriticalSnapshotV1 } from './schema';

export type SnapshotVerification = 'valid' | 'invalid' | 'unsupported';

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Verifica la firma Ed25519 del snapshot con WebCrypto. Devuelve `unsupported`
 * cuando el runtime no implementa Ed25519 (se acepta el snapshot sin verificar y
 * se deja constancia); `invalid` significa manipulación y el snapshot se descarta.
 */
export async function verifySnapshotSignature(
  snapshot: CriticalSnapshotV1,
  publicKeyRawBase64Url: string
): Promise<SnapshotVerification> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return 'unsupported';
  let key: CryptoKey;
  try {
    key = await subtle.importKey('raw', base64UrlToBytes(publicKeyRawBase64Url), { name: 'Ed25519' }, false, [
      'verify'
    ]);
  } catch {
    return 'unsupported';
  }
  try {
    const { signature, ...unsigned } = snapshot;
    const valid = await subtle.verify(
      { name: 'Ed25519' },
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(canonicalJson(unsigned))
    );
    return valid ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}
