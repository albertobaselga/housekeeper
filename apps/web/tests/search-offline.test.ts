import { describe, expect, it, vi } from 'vitest';

import { getCriticalSnapshotPayload } from '../src/lib/server/fixtures.server';
import { searchOffline } from '../src/lib/search/offline';

/**
 * Lo que se prueba aquí es el buscador sin conexión sobre el corpus de
 * DEMOSTRACIÓN, y el corpus solo existe donde no hay hogar real: desde que la
 * regla «con DATABASE_URL las maquetas no existen» vive en
 * `data-source.server`, `getCriticalSnapshotPayload()` devuelve el paquete
 * parcial (el 112 y nada más) en cuanto la máquina que ejecuta las pruebas
 * tiene una base configurada. Esta batería no habla de eso, así que declara su
 * entorno en vez de heredarlo: sin declararlo, el mismo código pasaba o fallaba
 * según hubiera o no una variable en el shell de quien lanza la suite.
 *
 * Que la regla de verdad se cumple lo comprueba `no-fixtures-with-database`.
 */
vi.mock('$env/dynamic/private', () => ({ env: {} }));

// Mismo contenido que el CriticalSnapshot real: wikiPages y contactos de la
// fixture sintética que la web guarda en IndexedDB.
function snapshot() {
  return { payload: getCriticalSnapshotPayload() };
}

describe('searchOffline sobre el snapshot crítico', () => {
  it("la errata 'lavadra' encuentra la página de la lavadora (una errata tolerada)", () => {
    const results = searchOffline('lavadra', snapshot());
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      kind: 'wiki',
      id: 'lavadora-programa-corto',
      title: 'Lavadora · programa corto',
      detail: 'Equipamiento'
    });
  });

  it('la inclusión en título pesa más que la del cuerpo y el extracto rodea la coincidencia', () => {
    const results = searchOffline('lavadora', snapshot());
    expect(results[0]?.id).toBe('lavadora-programa-corto');
    // 'programa' aparece en el título de la lavadora y solo en el cuerpo de la placa: la lavadora va antes.
    const byBody = searchOffline('detergente', snapshot());
    expect(byBody[0]?.id).toBe('lavadora-programa-corto');
    expect(byBody[0]?.excerpt.toLowerCase()).toContain('detergente');
  });

  it('la búsqueda sin acentos alcanza títulos acentuados', () => {
    const results = searchOffline('induccion', snapshot());
    expect(results[0]).toMatchObject({ kind: 'wiki', id: 'placa-induccion', title: 'Placa de inducción' });
  });

  it('los contactos del snapshot son accionables: nombre, teléfono y kind', () => {
    const results = searchOffline('pediatrico', snapshot());
    const contact = results.find((result) => result.kind === 'contact');
    expect(contact).toMatchObject({
      id: 'pediatrics',
      title: 'Centro Pediátrico Olmo',
      phone: '910 000 111',
      excerpt: '910 000 111'
    });
  });

  it('sin resultados devuelve lista vacía sin error; snapshot ausente también', () => {
    expect(searchOffline('candelabros dorados', snapshot())).toEqual([]);
    expect(searchOffline('lavadora', null)).toEqual([]);
    expect(searchOffline('   ', snapshot())).toEqual([]);
  });

  it('es determinista: dos llamadas con la misma consulta devuelven lo mismo', () => {
    expect(searchOffline('luz', snapshot())).toEqual(searchOffline('luz', snapshot()));
  });

  it('tolera payloads con entradas malformadas sin lanzar', () => {
    const base = snapshot();
    const dirty = {
      payload: {
        ...base.payload,
        wikiPages: [...base.payload.wikiPages, { id: 42 }, null, 'texto'],
        contacts: [...base.payload.contacts, { name: 'Sin id' }]
      }
    };
    expect(() => searchOffline('lavadora', dirty)).not.toThrow();
    expect(searchOffline('lavadora', dirty)[0]?.id).toBe('lavadora-programa-corto');
  });
});
