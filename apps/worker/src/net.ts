/**
 * El veto anti-SSRF, en un módulo propio y sin una sola dependencia.
 *
 * Vivía dentro de `ics.ts`, que era su único cliente. Ahora tiene dos: las
 * fuentes de calendario que descarga el worker y los endpoints de aviso que
 * registra la web, que también son URL que llegan de fuera y a las que el
 * servidor va a hacer peticiones. Dos criterios distintos para lo mismo se
 * separan; uno solo, no.
 *
 * Se saca aquí, y no se importa `ics.ts` desde la web, porque ese módulo
 * arrastra el catálogo entero de trabajos —`pdf-lib` incluido— a cualquier ruta
 * que lo toque. Este fichero solo necesita `node:net`.
 */
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** ¿Es una dirección IPv4 privada, loopback, link-local o de metadatos? */
function isForbiddenIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true; // Una IP que no se deja interpretar no se contacta.
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 ("esta red")
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local y metadatos cloud
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}

/** ¿Es una dirección IPv6 privada/loopback/link-local (o un mapeo de una IPv4 prohibida)? */
function isForbiddenIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  // IPv4 embebida: ::ffff:127.0.0.1 y similares.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isForbiddenIpv4(mapped[1] as string);
  if (normalized === "::" || normalized === "::1") return true; // no especificada / loopback
  const firstGroup = normalized.split(":", 1)[0] ?? "";
  const value = firstGroup === "" ? 0 : Number.parseInt(firstGroup, 16);
  if (Number.isNaN(value)) return true;
  if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * Falla cerrado: lo que no se reconoce como IP pública no se contacta. Un
 * nombre de host llega aquí ya resuelto, y basta UN registro prohibido para
 * descartar el host entero.
 */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isForbiddenIpv4(address);
  if (version === 6) return isForbiddenIpv6(address);
  return true;
}
