import { beforeEach, describe, expect, it } from 'vitest';

import { bootRefusal, refusalResponse, resetBootRefusal } from '../src/lib/server/boot-guard.server';

/**
 * La red de abajo: la regla indivisible aplicada en el arranque del servidor,
 * para el caso en que el paquete y su entorno se hayan separado (un despliegue
 * ya construido, una promoción de uno viejo, una variable retirada del panel).
 *
 * Lo que aquí importa además del veredicto es la FORMA de la negativa. Quien
 * aterrice en ella tiene que salir sabiendo qué hacer, y la reparación está en
 * el panel de variables, no dentro de la aplicación.
 */

const REAL: Record<string, string> = {
  DATABASE_URL: 'postgresql://app@db.example.supabase.co:6543/postgres',
  DATABASE_AUTH_URL: 'postgresql://auth@db.example.supabase.co:6543/postgres',
  BETTER_AUTH_SECRET: 'x'.repeat(48),
  BETTER_AUTH_URL: 'https://www.example.test'
};

/**
 * Forma del paquete que se despliega: sin el selector de cuentas sintéticas
 * dentro. Bajo vitest `__FIXTURE_LOGIN__` siempre vale `true` —el banco de
 * pruebas corre como servidor de desarrollo— así que el paquete que importa
 * hay que pedirlo a mano.
 */
const PRODUCCION = false;

/** Forma del paquete de maqueta: el que usan las suites y el desarrollo local. */
const MAQUETA = true;

beforeEach(() => {
  resetBootRefusal();
});

describe('el veredicto se toma una vez, en el arranque', () => {
  it('no vuelve a mirar el entorno en la segunda petición', () => {
    expect(bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, PRODUCCION)).not.toBeNull();
    // Aunque el entorno «mejore», el proceso ya decidió: es un arranque, no una
    // condición por petición. Corregirlo exige un despliegue nuevo, que es
    // exactamente lo que se quiere que ocurra.
    expect(bootRefusal(REAL, PRODUCCION)).not.toBeNull();
    resetBootRefusal();
    expect(bootRefusal(REAL, PRODUCCION)).toBeNull();
  });
});

describe('el modo local sin base de datos no se entera de nada', () => {
  it('sin DATABASE_URL el guardián calla, tenga la forma que tenga el paquete', () => {
    expect(bootRefusal({}, PRODUCCION)).toBeNull();
    resetBootRefusal();
    expect(bootRefusal({}, MAQUETA)).toBeNull();
  });

  it('la batería e2e con base de datos, fuera de la plataforma, arranca', () => {
    // playwright.db.config.ts: DATABASE_URL real de pruebas y el selector
    // pedido a mano. Es la única combinación de «selector + base» legítima.
    expect(bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, MAQUETA)).toBeNull();
  });

  it('pero esa misma combinación en un despliegue de Vercel se niega a servir', () => {
    const refusal = bootRefusal({ VERCEL: '1', DATABASE_URL: REAL.DATABASE_URL }, MAQUETA);
    expect(refusal?.code).toBe('fixture-bundle-with-database');
  });
});

describe('la negativa es una instrucción, no un muro', () => {
  it('responde 503 y pide reintento en un minuto, no en un segundo', () => {
    const refusal = bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, PRODUCCION);
    expect(refusal).not.toBeNull();
    const response = refusalResponse(refusal!);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('va en texto llano: la aplicación es justo lo que no debe servirse', () => {
    const response = refusalResponse(bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, PRODUCCION)!);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('no se guarda en ninguna caché intermedia', () => {
    // Si se cacheara, seguiría negando la casa cuando las variables ya estén bien.
    const response = refusalResponse(bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, PRODUCCION)!);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('nombra una a una las variables que faltan', async () => {
    const response = refusalResponse(bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, PRODUCCION)!);
    const body = await response.text();
    for (const name of ['DATABASE_AUTH_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL']) {
      expect(body).toContain(name);
    }
    expect(body).toContain('incomplete-identity');
  });

  it('no filtra el valor de ninguna variable, sólo su nombre', async () => {
    const response = refusalResponse(
      bootRefusal(
        { DATABASE_URL: REAL.DATABASE_URL, BETTER_AUTH_SECRET: 'secreto-de-verdad' },
        PRODUCCION
      )!
    );
    const body = await response.text();
    expect(body).not.toContain('secreto-de-verdad');
    expect(body).not.toContain(REAL.DATABASE_URL);
  });

  it('habla en castellano llano a quien no es quien despliega', async () => {
    const response = refusalResponse(bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, PRODUCCION)!);
    const body = await response.text();
    expect(body).toContain('Casa Clara no está sirviendo esta casa ahora mismo.');
  });
});

describe('qué NO tumba el arranque', () => {
  it('la configuración completa arranca', () => {
    expect(bootRefusal(REAL, PRODUCCION)).toBeNull();
  });

  it('la clave de firma ausente no tumba nada: rompe snapshots, no la identidad', () => {
    expect(bootRefusal({ ...REAL, SNAPSHOT_SIGNING_KEY_B64: undefined }, PRODUCCION)).toBeNull();
  });

  it('staging solo-sintético con identidad completa arranca', () => {
    expect(bootRefusal({ ...REAL, ALLOW_SYNTHETIC_DATA_ONLY: 'true' }, PRODUCCION)).toBeNull();
  });
});

describe('en el estado que se rechaza no había ningún acceso que perder', () => {
  it('sólo se niega donde nadie podía entrar ya, y se aparta en cuanto se puede', () => {
    // Es el argumento entero de por qué negarse aquí no deja fuera a la casa:
    // sin DATABASE_AUTH_URL ni BETTER_AUTH_SECRET, getAuth() devuelve null
    // (auth.server.ts) y la entrada con contraseña responde 404. Lo único que
    // la aplicación sabría hacer en ese estado es lo que no debe.
    expect(bootRefusal({ DATABASE_URL: REAL.DATABASE_URL }, PRODUCCION)?.code).toBe(
      'incomplete-identity'
    );

    resetBootRefusal();
    // Y en cuanto la identidad está completa —es decir, en cuanto alguien de la
    // casa PUEDE entrar— el guardián se aparta.
    expect(bootRefusal(REAL, PRODUCCION)).toBeNull();
  });
});
