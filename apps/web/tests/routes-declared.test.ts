import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NESTED_ROUTE_CAPABILITY, guardForPath } from '../src/lib/auth/routing';

/**
 * NINGUNA RUTA DEL HOGAR SIN DECLARAR.
 *
 * `guardForPath` falla cerrado ante una ruta anidada que no esté en
 * `NESTED_ROUTE_CAPABILITY`, y eso está bien: una ruta nueva no hereda el
 * permiso de su padre por colgar de él. Lo que está mal es cómo se entera uno.
 * `known: false` se convierte en `error(404, 'Esta ruta no existe')` dentro del
 * hook, así que una ruta que existe y funciona desaparece del mapa SIN QUE
 * NADIE SE ENTERE: no hay error en el registro, no hay prueba roja, y la
 * pantalla que la llamaba se limita a comportarse un poco peor.
 *
 * Pasó de verdad. `/h/<casa>/calendar/ventana` llevaba sin declarar desde que
 * se escribió: el `fetch` del cambio de mes recibía un 404 SIEMPRE, y como está
 * escrito a propósito para poder fallar sin consecuencias, el calendario se
 * quedaba en el mes de antes y enseñaba la banda de «sin conexión». Es decir:
 * le echaba la culpa a la red de quien miraba por una tabla incompleta.
 *
 * Por eso esta prueba recorre el ÁRBOL REAL de `src/routes` en vez de una lista
 * escrita a mano. Una lista escrita a mano envejece exactamente igual que la
 * tabla que pretende vigilar, y las dos se quedarían viejas a la vez.
 */

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');

/** Ficheros que hacen que un directorio SEA una ruta servible. */
const ROUTE_FILES = ['+page.svelte', '+page.server.ts', '+server.ts'];

/**
 * Cada ruta del árbol, como la pediría un navegador. Los segmentos dinámicos se
 * sustituyen por un valor cualquiera: a `guardForPath` le importa la FORMA de la
 * ruta, no lo que traiga dentro el parámetro.
 */
function rutasDelArbol(dir: string = routesDir, prefijo = ''): string[] {
  const rutas: string[] = [];
  const entradas = readdirSync(dir);

  if (entradas.some((entrada) => ROUTE_FILES.includes(entrada))) {
    rutas.push(prefijo === '' ? '/' : prefijo);
  }

  for (const entrada of entradas) {
    const completa = path.join(dir, entrada);
    if (!statSync(completa).isDirectory()) continue;
    // `[householdId]` viaja con el identificador de las fixtures para que la
    // ruta se lea como una de verdad; el resto de parámetros, con un relleno.
    const segmento = entrada.startsWith('[')
      ? entrada === '[householdId]'
        ? '10000000-0000-4000-8000-000000000001'
        : 'un-parametro-cualquiera'
      : entrada;
    rutas.push(...rutasDelArbol(completa, `${prefijo}/${segmento}`));
  }

  return rutas;
}

const TODAS = rutasDelArbol();
const DEL_HOGAR = TODAS.filter((ruta) => ruta.startsWith('/h/'));
const FUERA_DEL_HOGAR = TODAS.filter((ruta) => !ruta.startsWith('/h/'));

describe('el árbol de rutas y la tabla de autorización dicen lo mismo', () => {
  it('el recorrido encuentra rutas de verdad (si esto falla, la prueba se quedó ciega)', () => {
    // Una prueba que recorre un árbol y no encuentra nada pasa siempre. Esta
    // afirmación es la que impide que este fichero se vuelva decorativo si
    // alguien mueve `src/routes` o cambia la convención de SvelteKit.
    expect(DEL_HOGAR.length).toBeGreaterThan(15);
    expect(DEL_HOGAR).toContain('/h/10000000-0000-4000-8000-000000000001/calendar/ventana');
  });

  it('TODA ruta del hogar que existe está declarada', () => {
    const huerfanas = DEL_HOGAR.filter((ruta) => !guardForPath(ruta)?.known);
    // El mensaje importa tanto como la aserción: quien estrene una ruta y vea
    // esto rojo tiene que salir sabiendo qué hacer sin leer este fichero.
    expect(
      huerfanas,
      `Estas rutas existen en src/routes pero guardForPath las da por desconocidas, así que ` +
        `el hook las convertirá en un 404 silencioso. Declara cada una en ` +
        `NESTED_ROUTE_CAPABILITY con la capacidad que le toque —mírala, no la copies de la ` +
        `vecina— y escribe el porqué junto a la entrada:\n  ${huerfanas.join('\n  ')}`
    ).toEqual([]);
  });

  it('toda ruta del hogar sale con una capacidad, salvo la portada del hogar', () => {
    // `known` sin capacidad sería una puerta abierta a cualquiera que pertenezca
    // a la casa. Sólo la raíz `/h/<casa>` puede permitírselo: no enseña nada,
    // redirige.
    const raiz = '/h/10000000-0000-4000-8000-000000000001';
    for (const ruta of DEL_HOGAR) {
      const guarda = guardForPath(ruta);
      if (ruta === raiz) {
        expect(guarda?.capability, ruta).toBeNull();
      } else {
        expect(guarda?.capability, ruta).not.toBeNull();
      }
    }
  });

  it('la tabla no arrastra entradas de rutas que ya no existen', () => {
    // La otra mitad del desajuste: una ruta que se borra o se renombra deja su
    // entrada aquí, y la siguiente persona la lee como si describiera algo.
    const declaradas = Object.keys(NESTED_ROUTE_CAPABILITY);
    const reales = new Set(
      DEL_HOGAR.map((ruta) => ruta.split('/').slice(3).join('/')).filter((cola) => cola !== '')
    );
    const fantasmas = declaradas.filter((entrada) => !reales.has(entrada));
    expect(
      fantasmas,
      `NESTED_ROUTE_CAPABILITY declara rutas que no existen en src/routes:\n  ${fantasmas.join('\n  ')}`
    ).toEqual([]);
  });
});

describe('lo que esta tabla NO gobierna, y por qué', () => {
  it('las rutas de fuera del hogar no pasan por la guarda de ruta', () => {
    /*
     * `/api/**`, `/login`, `/logout` y `/offline` devuelven `null`: el hook no
     * las mira y cada una lleva su propia autorización dentro del manejador
     * (`membershipIn` + el papel, en las de `/api/v1`). No es un olvido, y la
     * afirmación está aquí para que el ALCANCE de esta prueba también se
     * compruebe: si algún día una ruta de `/api` empezara a devolver guarda,
     * esto se pone rojo y hay que decidir a conciencia, no por omisión.
     */
    for (const ruta of FUERA_DEL_HOGAR) {
      expect(guardForPath(ruta), ruta).toBeNull();
    }
  });

  it('la Guía es una jerarquía abierta y no se declara nota a nota', () => {
    // Una nota por slug, y las notas las escribe la casa: enumerarlas aquí sería
    // pedirle a esta tabla que siguiera al contenido. `guardForPath` lo resuelve
    // dejando pasar cualquier profundidad bajo `wiki` con la llave del módulo.
    const casa = '10000000-0000-4000-8000-000000000001';
    expect(guardForPath(`/h/${casa}/wiki/una-nota-que-nadie-ha-escrito-aun`)).toMatchObject({
      known: true,
      capability: 'content.read'
    });
    // Y sigue sin ser una barra libre: fuera de `wiki`, la profundidad no
    // declarada falla cerrada, que es el comportamiento que hace útil la tabla.
    expect(guardForPath(`/h/${casa}/employment/acuerdo/mas`)).toMatchObject({ known: false });
  });
});
