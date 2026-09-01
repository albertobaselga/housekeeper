import { beforeEach, describe, expect, it, vi } from 'vitest';

import { capabilitiesFor, type Capability, type Role } from '../src/lib/auth/capabilities';
import type { AppContext } from '../src/lib/auth/types';
import { FIXTURE_HOUSEHOLD } from './helpers';

/**
 * La retirada de `finance.access` en el layout del hogar, comprobada donde
 * ocurre. La suite de integración vecina (`finance-access.integration.test.ts`)
 * afirma que el helper lee bien el cerrojo de la base; esta afirma lo otro: que
 * el layout HACE algo con esa respuesta. Sin ella, borrar la retirada dejaría
 * la fase entera en verde y el módulo abierto a cualquier administración.
 *
 * No necesita Postgres: el cerrojo se sustituye por un interruptor y lo que se
 * mide es la decisión del layout —qué capacidades entrega al cliente, cuándo
 * lanza el 403 y a quién le cuesta una consulta—, no la consulta en sí.
 */

const { fakeEnv } = vi.hoisted(() => ({
  // Con base configurada, que es el caso de producción: las maquetas no existen.
  fakeEnv: { DATABASE_URL: 'postgresql://casa_clara_app@127.0.0.1:5432/casaclara' } as Record<
    string,
    string | undefined
  >
}));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));

// Sin pool: las dos lecturas del snapshot que hace el layout devuelven null sin
// tocar la red. El contexto sale parcial, que es justo lo que este layout hace
// cuando no puede leer, y aquí no estorba: lo que se mira son las capacidades.
vi.mock('$lib/server/db.server', () => ({ getDatabasePool: () => null }));

/** El cerrojo, sustituido por un interruptor con contador de llamadas. */
const { grant } = vi.hoisted(() => ({
  grant: { live: false, calls: [] as { userId: string; householdId: string }[] }
}));
vi.mock('$lib/server/finance-access.server', () => ({
  financeAccessGranted: (user: { id: string }, householdId: string) => {
    grant.calls.push({ userId: user.id, householdId });
    return Promise.resolve(grant.live);
  }
}));

const LAYOUT = '../src/routes/h/[householdId]/+layout.server.ts';
const MEMBERSHIP = '11000000-0000-4000-8000-000000000001';

type LayoutLoad = (event: Record<string, unknown>) => Promise<{ context: AppContext }>;

async function runLayout(role: Role, pathname = `/h/${FIXTURE_HOUSEHOLD}`): Promise<AppContext> {
  const { load } = (await import(/* @vite-ignore */ LAYOUT)) as { load: LayoutLoad };
  const { context } = await load({
    locals: {
      user: {
        id: `fixture:${role}`,
        name: 'Persona sintética',
        initials: 'PS',
        email: `${role}@casaclara.test`,
        mustChangePassword: false,
        memberships: [{ householdId: FIXTURE_HOUSEHOLD, membershipId: MEMBERSHIP, role }],
        households: [{ id: FIXTURE_HOUSEHOLD, name: 'Casa sintética', subtitle: 'Hogar de prueba' }]
      },
      session: null,
      syntheticOnly: false,
      dataUnavailable: false
    },
    params: { householdId: FIXTURE_HOUSEHOLD },
    url: new URL(`https://casa.test${pathname}`),
    depends: () => undefined,
    setHeaders: () => undefined,
    request: new Request(`https://casa.test${pathname}`)
  });
  return context;
}

function without(role: Role, capability: Capability): Capability[] {
  return capabilitiesFor(role).filter((candidate) => candidate !== capability);
}

describe('el layout del hogar retira finance.access sin concesión viva', () => {
  beforeEach(() => {
    grant.live = false;
    grant.calls.length = 0;
  });

  it('a la administración sin concesión le llega su papel entero MENOS Finanzas', async () => {
    const context = await runLayout('family_admin');
    expect(context.capabilities).not.toContain('finance.access');
    // Se retira una capacidad, no se recorta el papel: el resto llega igual.
    expect([...context.capabilities]).toEqual(without('family_admin', 'finance.access'));
  });

  it('con concesión viva la capacidad llega intacta', async () => {
    grant.live = true;
    const context = await runLayout('family_admin');
    expect([...context.capabilities]).toEqual([...capabilitiesFor('family_admin')]);
  });

  it('el guard de /finanzas mide contra las capacidades EFECTIVAS', async () => {
    await expect(runLayout('family_admin', `/h/${FIXTURE_HOUSEHOLD}/finanzas`)).rejects.toMatchObject({
      status: 403
    });
    // Las rutas hijas están igual de cerradas: la capacidad es una para las siete.
    await expect(
      runLayout('family_admin', `/h/${FIXTURE_HOUSEHOLD}/finanzas/movimientos`)
    ).rejects.toMatchObject({ status: 403 });

    grant.live = true;
    const context = await runLayout('family_admin', `/h/${FIXTURE_HOUSEHOLD}/finanzas/movimientos`);
    expect(context.capabilities).toContain('finance.access');
  });

  it('quien no puede tener Finanzas por su papel no paga la consulta', async () => {
    for (const role of ['family_member', 'employee_live_in', 'helper', 'viewer'] as const) {
      const context = await runLayout(role);
      expect([...context.capabilities], role).toEqual([...capabilitiesFor(role)]);
    }
    // Ni una sola consulta al cerrojo para los cuatro papeles de arriba: esto
    // corre en TODAS las páginas del hogar y la mayoría de las visitas no son
    // de la administración.
    expect(grant.calls).toEqual([]);

    // A la administración sí se le pregunta, una vez y por el hogar de la URL.
    await runLayout('family_admin');
    expect(grant.calls).toEqual([{ userId: 'fixture:family_admin', householdId: FIXTURE_HOUSEHOLD }]);
  });
});
