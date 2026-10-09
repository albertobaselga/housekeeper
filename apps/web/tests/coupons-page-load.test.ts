import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_HOUSEHOLD } from './helpers';

/**
 * La página de cupones NO se guarda en el dispositivo.
 *
 * El service worker guarda en su caché de páginas cada navegación con éxito
 * que no diga `no-store` (`storable()` de `service-worker.ts`), y la sirve sin
 * red o ante un 503. El HTML de esta pantalla lleva la cartera ENTERA —códigos,
 * notas, usados y descartados—: guardado, se enseñaría sin red (D-offline dice
 * «solo con red») y se quedaría en un móvil compartido después de cerrar la
 * sesión, a mano de quien no es de la familia (D-audiencia). La foto ya se
 * sirve con `no-store` porque el código «vale dinero»; la página que pinta ese
 * mismo código como texto, igual (revisión de seguridad de la fase 2, I1).
 */

const { fakeEnv, loaded } = vi.hoisted(() => ({
  fakeEnv: { DATABASE_URL: 'postgresql://casa_clara_app@127.0.0.1:5432/casaclara' } as Record<
    string,
    string | undefined
  >,
  loaded: { value: null as unknown }
}));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));
// Solo el cargador se sustituye: la maqueta usa el resto del módulo de verdad.
vi.mock('$lib/server/coupons.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/server/coupons.server')>()),
  loadCoupons: () => Promise.resolve(loaded.value)
}));

const PAGE = '../src/routes/h/[householdId]/cupones/+page.server.ts';

type PageLoad = (event: Record<string, unknown>) => Promise<unknown>;

async function runLoad(): Promise<{ headers: Record<string, string>; result: unknown; error: unknown }> {
  const { load } = (await import(/* @vite-ignore */ PAGE)) as { load: PageLoad };
  const headers: Record<string, string> = {};
  let result: unknown = null;
  let error: unknown = null;
  try {
    result = await load({
      locals: { user: { id: 'fixture:roble:family' } },
      params: { householdId: FIXTURE_HOUSEHOLD },
      depends: () => undefined,
      setHeaders: (next: Record<string, string>) => {
        for (const [name, value] of Object.entries(next)) headers[name.toLowerCase()] = value;
      }
    });
  } catch (cause) {
    error = cause;
  }
  return { headers, result, error };
}

describe('la cartera no se queda en el dispositivo', () => {
  beforeEach(() => {
    fakeEnv.DATABASE_URL = 'postgresql://casa_clara_app@127.0.0.1:5432/casaclara';
    loaded.value = { today: '2026-10-03', coupons: [], merchants: [], counts: { available: 0, used: 0, expired: 0, discarded: 0 } };
  });

  it('con datos de verdad, la respuesta dice `private, no-store`', async () => {
    const { headers, result } = await runLoad();
    expect(result).toMatchObject({ live: true });
    expect(headers['cache-control']).toBe('private, no-store');
  });

  it('también cuando no se ha podido leer: el 503 no deja nada guardado', async () => {
    loaded.value = null;
    const { headers, error } = await runLoad();
    expect(error).not.toBeNull();
    expect(headers['cache-control']).toBe('private, no-store');
  });

  it('y en la demostración, sin base: la misma regla para todos', async () => {
    fakeEnv.DATABASE_URL = undefined;
    loaded.value = null;
    const { headers, result, error } = await runLoad();
    expect(error, String(error)).toBeNull();
    expect(result).toMatchObject({ live: false });
    expect(headers['cache-control']).toBe('private, no-store');
  });
});
