import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_HOUSEHOLD } from './helpers';

/**
 * La tarjeta «Finanzas» de los Ajustes del hogar, comprobada por sus dos
 * mitades: la que trae el dato y la que lo pinta.
 *
 * La suite de integración vecina (`finance-access.integration.test.ts`) afirma
 * que `loadFinanceGrantOverview` lee bien las concesiones bajo RLS. Eso, solo,
 * dejaba en verde el escenario que de verdad duele: que nadie llame a ese
 * ayudante, o que la tarjeta desaparezca de la pantalla. Sin superficie no hay
 * activación por cuenta, y el módulo entero se queda sin la única puerta por la
 * que se enciende.
 *
 * El entorno de vitest es `node`: no hay DOM y el componente no se puede montar
 * (tampoco hay biblioteca para ello en el proyecto). Así que la mitad de
 * pintado se vigila sobre el CÓDIGO FUENTE de la página, como ya hace
 * `calendar-no-metrics.test.ts` con las vistas de rutinas. Las
 * correspondencias que sí pueden salir del componente —qué comando le toca a
 * cada fila— viven en `$lib/finance/commands.ts` y se prueban ejecutándolas
 * (`finance-commands.test.ts`).
 */

const { fakeEnv } = vi.hoisted(() => ({
  // Con base configurada, que es el caso de producción: las maquetas no existen.
  fakeEnv: { DATABASE_URL: 'postgresql://casa_clara_app@127.0.0.1:5432/casaclara' } as Record<
    string,
    string | undefined
  >
}));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));

/** Las dos lecturas de la pantalla, cada una con su respuesta reconocible. */
const { reads } = vi.hoisted(() => ({
  reads: {
    access: { householdId: 'x', memberships: [] } as unknown,
    finance: { householdId: 'x', admins: [] } as unknown,
    financeCalls: [] as { userId: string; householdId: string }[]
  }
}));
vi.mock('$lib/server/access.server', () => ({
  loadAccessOverview: () => Promise.resolve(reads.access),
  requirePasswordChange: () => Promise.resolve(undefined),
  resolveMembershipIdentity: () => Promise.resolve(null)
}));
vi.mock('$lib/server/finance-access.server', () => ({
  loadFinanceGrantOverview: (user: { id: string }, householdId: string) => {
    reads.financeCalls.push({ userId: user.id, householdId });
    return Promise.resolve(reads.finance);
  }
}));
vi.mock('$lib/server/auth.server', () => ({ getAuth: () => null }));
vi.mock('$lib/server/handover.server', () => ({ canDownloadHandover: () => Promise.resolve(false) }));
vi.mock('$lib/server/fixtures.server', () => ({ getSettingsFixture: () => null }));

const PAGE = '../src/routes/h/[householdId]/settings/+page.server.ts';

interface SettingsData {
  access: unknown;
  finance: unknown;
}

type PageLoad = (event: Record<string, unknown>) => Promise<SettingsData>;

async function runLoad(user: { id: string } | null): Promise<{ data: SettingsData; depends: string[] }> {
  const { load } = (await import(/* @vite-ignore */ PAGE)) as { load: PageLoad };
  const depends: string[] = [];
  const data = await load({
    locals: { user },
    params: { householdId: FIXTURE_HOUSEHOLD },
    depends: (token: string) => depends.push(token)
  });
  return { data, depends };
}

describe('Ajustes carga las concesiones de Finanzas junto a los accesos', () => {
  beforeEach(() => {
    reads.financeCalls.length = 0;
    reads.finance = { householdId: FIXTURE_HOUSEHOLD, admins: [] };
  });

  it('la vista de concesiones llega a la página, y por el hogar de la URL', async () => {
    const overview = {
      householdId: FIXTURE_HOUSEHOLD,
      admins: [{ membershipId: 'm-1', name: 'Quien administra', granted: true, isSelf: true }]
    };
    reads.finance = overview;
    const { data } = await runLoad({ id: 'fixture:roble:admin' });
    // Es la vista de concesiones, no la de accesos: son dos lecturas distintas
    // y la tarjeta no puede acabar pintando la lista equivocada.
    expect(data.finance).toEqual(overview);
    expect(data.finance).not.toBe(data.access);
    expect(reads.financeCalls).toEqual([
      { userId: 'fixture:roble:admin', householdId: FIXTURE_HOUSEHOLD }
    ]);
  });

  it('sin sesión no se pregunta por las concesiones de nadie', async () => {
    const { data } = await runLoad(null);
    expect(data.finance).toBeNull();
    expect(reads.financeCalls).toEqual([]);
  });

  it('declara el token que refresca la tarjeta tras cada comando', async () => {
    // `cc:settings` es lo que invalida `OptimisticActions` al confirmarse un
    // comando. Sin la declaración, el estado pintado se queda congelado en el
    // anterior a la concesión y la tarjeta pasa a mentir en cuanto se usa.
    const { depends } = await runLoad({ id: 'fixture:roble:admin' });
    expect(depends).toContain('cc:settings');
  });
});
