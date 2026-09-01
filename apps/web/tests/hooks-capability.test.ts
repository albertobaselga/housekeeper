import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';

import { handle } from '../src/hooks.server';
import { createDemoSession } from '../src/lib/server/session.server';

/**
 * LA LLAVE DE LA RUTA GOBIERNA TAMBIÉN LO QUE ESCRIBE.
 *
 * Ninguna prueba comprobaba esta invariante, y por eso llevaba rota desde que
 * existen las *form actions*. En SvelteKit 2.70.2, ante un POST a una acción el
 * servidor la ejecuta ANTES que cualquier `load`, layouts incluidos
 * (`runtime/server/page/index.js`: acción en 70-77, `load` en 193). Como el
 * único `error(403)` por capacidad vivía en el `load` del layout del hogar, un
 * POST a `/h/<casa>/employment/alta?/hire` sólo atravesaba «¿existe la ruta?» y
 * «¿perteneces a esta casa?» —con cualquier papel— y llegaba a la acción sin
 * que `access.manage` se hubiera consultado ni una vez.
 *
 * No era explotable: cada acción revalida el papel dentro de su transacción y
 * la RLS rechaza por debajo. Pero la primera reja estaba mal contada, y esta
 * prueba existe para que siga contada bien: si alguien «limpia» la
 * comprobación llevándola al layout, esto se pone rojo.
 *
 * Se ejercita el hook ENTERO, no una función auxiliar: lo que se afirma es el
 * orden en que la petición atraviesa la casa, y eso sólo se ve desde la puerta.
 */

const CASA = '10000000-0000-4000-8000-000000000001';
const ADMIN = 'fixture:roble:admin';
const FAMILIA = 'fixture:roble:family';
const EMPLEADA = 'fixture:roble:employee';
const APOYO = 'fixture:roble:helper';

/** Tarro de galletas mínimo: la sesión de maqueta vive en un Map del módulo. */
function tarro(): Cookies {
  const galletas = new Map<string, string>();
  return {
    get: (name: string) => galletas.get(name),
    getAll: () => [...galletas].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void galletas.set(name, value),
    delete: (name: string) => void galletas.delete(name),
    serialize: () => ''
  } as unknown as Cookies;
}

interface Intento {
  /** ¿Llegó la petición al resto de la aplicación? */
  atraviesa: boolean;
  status: number | null;
  message: string | null;
}

async function intentar(userId: string, method: string, ruta: string): Promise<Intento> {
  const cookies = tarro();
  createDemoSession(cookies, userId, false);
  const url = new URL(`http://casa.test${ruta}`);
  const event = {
    cookies,
    locals: {},
    params: {},
    request: new Request(url, { method }),
    url
  } as unknown as RequestEvent;

  try {
    const response = await handle({ event, resolve: async () => new Response('llegó') });
    return { atraviesa: (await response.text()) === 'llegó', status: response.status, message: null };
  } catch (cause) {
    const fallo = cause as { status?: number; body?: { message?: string } };
    return { atraviesa: false, status: fallo.status ?? null, message: fallo.body?.message ?? null };
  }
}

describe('un POST no entra por una puerta cuya llave no tiene', () => {
  it('la familia no administradora no llega a la acción del alta', async () => {
    const intento = await intentar(FAMILIA, 'POST', `/h/${CASA}/employment/alta?/hire`);
    expect(intento.atraviesa).toBe(false);
    expect(intento.status).toBe(403);
    expect(intento.message).toBe('Esta parte la lleva la familia.');
  });

  it('tampoco la empleada ni el apoyo, que ni siquiera ven la pantalla', async () => {
    for (const quien of [EMPLEADA, APOYO]) {
      const intento = await intentar(quien, 'POST', `/h/${CASA}/employment/alta?/hire`);
      expect(intento.status, quien).toBe(403);
    }
  });

  it('y tampoco a las de Ajustes, que reponen contraseñas ajenas', async () => {
    const intento = await intentar(FAMILIA, 'POST', `/h/${CASA}/settings?/resetMemberPassword`);
    expect(intento.status).toBe(403);
  });

  it('quien administra sí llega: la puerta filtra por la llave, no por el método', async () => {
    const intento = await intentar(ADMIN, 'POST', `/h/${CASA}/employment/alta?/hire`);
    expect(intento.atraviesa).toBe(true);
  });
});

describe('lo que no se rompe', () => {
  /*
   * El repaso que hay que hacer al tocar esto: hay rutas cuya llave de LECTURA
   * podría no ser la de escritura. Hoy sólo existen cuatro acciones dentro del
   * hogar —alta, acuerdo, ajustes y «Tu acceso»— y la de «Tu acceso» es de
   * todos: cambiar la propia contraseña pide la misma capacidad mínima que Hoy,
   * no `access.manage`. Si alguna vez esta prueba se pone roja, la respuesta
   * casi seguro no es relajar el hook, sino que la ruta está declarada con la
   * llave equivocada en NESTED_ROUTE_CAPABILITY.
   */
  it('cualquiera cambia su propia contraseña, también el apoyo y el visor', async () => {
    for (const quien of [FAMILIA, EMPLEADA, APOYO]) {
      const intento = await intentar(quien, 'POST', `/h/${CASA}/account?/changePassword`);
      expect(intento.atraviesa, quien).toBe(true);
    }
  });

  it('la navegación normal sigue pasando: el 403 amable es del layout', async () => {
    // Un GET a la misma ruta NO se corta aquí. Tiene que seguir hasta el `load`
    // del layout para que el error aterrice en +error.svelte con lenguaje de
    // casa y un camino de vuelta a Hoy, en vez de la página de fallo cruda de
    // SvelteKit que renderiza un error lanzado en el hook.
    const intento = await intentar(FAMILIA, 'GET', `/h/${CASA}/employment/alta`);
    expect(intento.atraviesa).toBe(true);
  });
});

describe('lo que sale de la casa por un POST no se guarda en el disco de nadie', () => {
  it('la respuesta a algo que no es GET declara Cache-Control: no-store', async () => {
    const cookies = tarro();
    createDemoSession(cookies, ADMIN, false);
    const url = new URL(`http://casa.test/h/${CASA}/employment/alta?/hire`);
    const event = {
      cookies,
      locals: {},
      params: {},
      request: new Request(url, { method: 'POST' }),
      url
    } as unknown as RequestEvent;
    const response = await handle({ event, resolve: async () => new Response('llegó') });
    // La contraseña provisional del alta se enseña UNA vez y viaja justo aquí.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('un GET conserva su frescura: el service worker tiene que poder guardarla', async () => {
    const cookies = tarro();
    createDemoSession(cookies, ADMIN, false);
    const url = new URL(`http://casa.test/h/${CASA}/today`);
    const event = {
      cookies,
      locals: {},
      params: {},
      request: new Request(url, { method: 'GET' }),
      url
    } as unknown as RequestEvent;
    const response = await handle({ event, resolve: async () => new Response('llegó') });
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
