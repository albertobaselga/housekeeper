import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { describeErrorCode } from '../src/lib/offline/error-codes';
import { couponPhotoUrl } from '../src/lib/server/coupons.server';

/**
 * Las COSTURAS del módulo de cupones: lo que un tramo escribe y otro lee sin
 * que ninguno de los dos lo importe. Cada lado tiene sus pruebas, y por eso
 * mismo pueden divergir los dos a la vez sin que nada se ponga rojo.
 *
 * · La ficha pinta `<img src={photoUrl}>` con la cadena que compone el
 *   cargador; la foto la sirve una ruta de `src/routes`. Si una cambia y la
 *   otra no, la ficha enseña «La foto no se puede cargar ahora» para siempre.
 * · El manejador de comandos (packages/server) rechaza con códigos que la
 *   bandeja de salida traduce (`error-codes.ts`). Un código nuevo sin frase
 *   acaba en la genérica, que no le dice a nadie qué pasó.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.join(here, '..', 'src', 'routes');
const couponHandler = path.join(here, '..', '..', '..', 'packages', 'server', 'src', 'commands', 'coupon.ts');

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const COUPON = 'cd000000-0000-4000-8000-000000000001';
const PHOTO = 'cd100000-0000-4000-8000-000000000001';
const OTHER_PHOTO = 'cd100000-0000-4000-8000-000000000002';

describe('costuras del módulo de cupones', () => {
  it('photoUrl del cargador es la ruta que de verdad sirve la foto (GET)', () => {
    const url = new URL(couponPhotoUrl(HOUSEHOLD, COUPON, PHOTO), 'https://casa.invalid').pathname;
    // De la URL concreta a la carpeta de SvelteKit: los dos parámetros
    // vuelven a ser segmentos dinámicos.
    const routePath = url.replace(HOUSEHOLD, '[householdId]').replace(COUPON, '[couponId]');
    expect(routePath, 'la URL tiene que llevar el hogar y el cupón').not.toBe(url);
    const routeFile = path.join(routesDir, ...routePath.split('/').filter(Boolean), '+server.ts');
    expect(existsSync(routeFile), `no hay ruta para ${routePath}`).toBe(true);
    expect(readFileSync(routeFile, 'utf8')).toMatch(/export const GET\b/);
  });

  it('cada foto tiene su propia dirección: cambiar la foto cambia la URL', () => {
    // Con una URL fija por cupón, tras cambiar la foto la ficha volvía a una
    // dirección que el documento ya había cargado con la foto VIEJA, y un
    // navegador puede reutilizar esa imagen sin preguntar (revisión de
    // integración, ronda 2, m-4). El id del objeto no revela nada que la
    // familia no tenga ya.
    const before = couponPhotoUrl(HOUSEHOLD, COUPON, PHOTO);
    const after = couponPhotoUrl(HOUSEHOLD, COUPON, OTHER_PHOTO);
    expect(after).not.toBe(before);
    expect(new URL(before, 'https://casa.invalid').pathname).toBe(new URL(after, 'https://casa.invalid').pathname);
  });

  it('cada rechazo del manejador de cupones tiene frase en el diccionario de la bandeja', () => {
    const source = readFileSync(couponHandler, 'utf8');
    const codes = new Set([...source.matchAll(/CommandRejectedError\(\s*"([a-z_]+)"/g)].map((match) => match[1]!));
    // El papel lo rechaza `requireFamilyRole` (commands/food.ts) con el
    // `not_allowed` de todos los módulos de la familia.
    if (/requireFamilyRole\(/.test(source)) codes.add('not_allowed');

    // Lista exacta: un código nuevo obliga a pasar por aquí y darle su frase.
    expect([...codes].sort()).toEqual([
      'coupon_not_found',
      'coupon_photo_invalid',
      'coupon_use_not_found',
      'invalid_payload',
      'not_allowed'
    ]);
    for (const code of codes) expect(describeErrorCode(code), code).not.toBeNull();
  });
});
