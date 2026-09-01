import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('la tarjeta «Finanzas» está en la pantalla y dice la verdad', () => {
  let page = '';
  /** El `<script>` de la página, con los espacios colapsados. */
  let script = '';
  /**
   * El `<script>` SIN comentarios: lo que se prohíbe se prohíbe en el código, no
   * en la prosa que lo explica (patrón de `calendar-no-metrics.test.ts`). Sin
   * esto, el comentario que dice «sin `apply`» satisfaría —o rompería— por sí
   * solo las comprobaciones que buscan esa palabra.
   */
  let scriptCode = '';
  /** La tarjeta de Finanzas y nada más, con los espacios colapsados. */
  let card = '';

  beforeAll(async () => {
    page = await readFile(
      new URL('../src/routes/h/[householdId]/settings/+page.svelte', import.meta.url),
      'utf8'
    );
    const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const code = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    const rawScript = page.slice(page.indexOf('<script'), page.indexOf('</script>'));
    script = flat(rawScript);
    scriptCode = flat(code(rawScript));
    // La tarjeta se acota por su propia sección para que nada de lo que se
    // afirma abajo pueda quedar satisfecho por la tarjeta de accesos vecina,
    // que tiene filas, chips y botones parecidos.
    const opens = page.indexOf('aria-labelledby="finance-grants-title"');
    card = opens < 0 ? '' : flat(page.slice(opens, page.indexOf('</section>', opens)));
  });

  it('existe, con su encabezado y la lista de administraciones del hogar', () => {
    // Sin esta superficie no hay activación por cuenta: el módulo se queda sin
    // la única puerta por la que se enciende y nadie más lo notaría.
    expect(card, 'la tarjeta de Finanzas ya no está en Ajustes').not.toBe('');
    expect(card).toContain('<h2 id="finance-grants-title">');
    expect(card).toContain('{#each data.finance.admins as admin (admin.membershipId)}');
  });

  it('el estado pintado sale de la concesión, y en la dirección correcta', () => {
    // Invertir cualquiera de las dos correspondencias deja la tarjeta diciendo
    // «Activado» a quien el layout no deja entrar en el módulo.
    expect(card).toMatch(
      /\{#if admin\.granted\}[^{]*<span class="status-chip success">Activado<\/span> \{:else\}[^{]*<span class="status-chip">Apagado<\/span>/
    );
    expect(card).toMatch(
      /admin\.granted \? 'Ve el módulo de Finanzas' : 'No ve el módulo de Finanzas'/
    );
  });

  it('el interruptor envía el comando de la fila, con su estado real', () => {
    expect(card).toContain('onclick={() => askFinance(admin)}');
    // Y dice a quién se lo hace: en una lista de administraciones, «Activar
    // Finanzas» a secas no dice cuál (patrón de fila de rutinas).
    expect(card).toContain('`Desactivar Finanzas a ${admin.name}`');
    expect(card).toContain('`Activar Finanzas a ${admin.name}`');
    expect(script).toContain("from '$lib/finance/commands'");
    expect(script).toContain('financeGrantToggle');
    // El estado que elige entre conceder y revocar es el de ESTA fila, no una
    // constante ni el de la primera: `financeGrantToggle` hace el resto y lo
    // comprueba `finance-commands.test.ts` ejecutándolo.
    expect(script).toMatch(/membershipId: admin\.membershipId, granted: admin\.granted/);
    // Y viaja como comando por la cola optimista, nunca como form action.
    expect(script).toMatch(/financeOptimistic\s*\.run\(envelope/);
    expect(card).not.toContain('method="POST"');
  });

  it('no pinta nada antes de que el servidor conteste', () => {
    // `OptimisticActions` solo miente si se le da un `apply`: sin él, el estado
    // de la tarjeta sigue siendo el que trajo el `load` hasta que un comando se
    // confirma y `cc:settings` lo refresca. Un rechazo deja la fila como estaba
    // y la nota roja al lado.
    //
    // Se prohíbe la PROPIEDAD en sus dos formas, no solo `apply:`: en un objeto
    // literal, `{ apply, messageOverrides }` es la misma entrega del gancho
    // escrita en abreviado, y buscando únicamente los dos puntos el pintado
    // optimista vuelve a entrar con la prueba en verde.
    expect(scriptCode, 'el despacho entrega un gancho `apply` y vuelve a pintar antes de tiempo').not.toMatch(
      /\bapply\s*[,:}]/
    );
    expect(card).toContain('<ActionStatus status={financeStatus} />');
  });

  it('cambiar la concesión PROPIA refresca también la navegación', () => {
    // La promesa del copy de la confirmación —«desaparecerá de la
    // navegación»— la sostiene esto y nada más: la capacidad `finance.access`
    // la retira el layout, y `cc:settings` solo re-ejecuta el load de ESTA
    // página. Sin el `invalidateAll`, la barra seguiría ofreciendo un módulo
    // que ya devuelve 403, y la tarjeta habría prometido algo que no pasa.
    expect(script).toContain("import { invalidateAll } from '$app/navigation'");
    // Va como `settle`, es decir DESPUÉS de que el servidor confirme (un
    // rechazo no tiene por qué mover la navegación), y solo en el caso propio:
    // la concesión de otra persona no cambia lo que ve quien está mirando.
    expect(scriptCode, 'la navegación ya no se refresca al cambiar la concesión propia').toMatch(
      /settle: admin\.isSelf \?[^:]*invalidateAll\(\)/
    );
  });

  it('mientras el comando está en vuelo la fila lo dice y nadie puede repetirlo', () => {
    expect(card).toMatch(/\{#if financePendingId === admin\.membershipId\}/);
    expect(card).toContain('Enviando…');
    expect(card).toContain('disabled={busy}');
  });

  it('quitarse Finanzas a una misma se avisa, no se impide', () => {
    // Alberto eligió que cualquier administración gestione esto, incluida la
    // suya: el botón de la fila propia NO puede estar bloqueado.
    expect(card).not.toMatch(/disabled=\{[^}]*isSelf/);
    // Pero pasa por una confirmación que dice lo que va a ocurrir.
    expect(script).toMatch(/admin\.isSelf && admin\.granted/);
    expect(card).toMatch(/\{#if confirmingFinanceId === admin\.membershipId\}/);
    expect(card).toContain('dejarás de ver el módulo de Finanzas');
  });

  it('la pantalla no autoriza leyendo el papel de nadie', () => {
    // `can(context.role, …)` es un camino paralelo que ignoraría la retirada de
    // capacidad del layout. Quien decide aquí es el servidor: `data.finance` es
    // null salvo para la administración, y la tarjeta no se pinta.
    expect(scriptCode).not.toMatch(/\bcan\(/);
    expect(scriptCode).not.toContain('context.role');
  });
});
