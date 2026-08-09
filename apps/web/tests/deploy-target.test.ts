import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * El adaptador se elige en tiempo de build y su elección no falla: si sale la
 * equivocada, la build termina en verde y es el despliegue el que muere después
 * («No Output Directory named "public" found» cuando Vercel recibe el `build/`
 * de adapter-node). Estas pruebas fijan la elección para que el error salga
 * aquí y no tres minutos más tarde en la plataforma.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadAdapterName(env: Record<string, string | undefined>): Promise<string> {
  for (const key of ['DEPLOY_TARGET', 'VERCEL']) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  const { default: config } = await import('../svelte.config.js');
  const adapter = config.kit?.adapter;
  if (!adapter) throw new Error('svelte.config.js no expuso ningún adaptador');
  return adapter.name;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('elección del adaptador de despliegue', () => {
  it('usa adapter-node fuera de Vercel y sin DEPLOY_TARGET', async () => {
    await expect(loadAdapterName({})).resolves.toBe('@sveltejs/adapter-node');
  });

  it('usa adapter-vercel cuando la build corre en Vercel sin DEPLOY_TARGET', async () => {
    await expect(loadAdapterName({ VERCEL: '1' })).resolves.toBe('@sveltejs/adapter-vercel');
  });

  it('deja que DEPLOY_TARGET mande sobre la detección de plataforma', async () => {
    await expect(loadAdapterName({ VERCEL: '1', DEPLOY_TARGET: 'node' })).resolves.toBe(
      '@sveltejs/adapter-node'
    );
    await expect(loadAdapterName({ DEPLOY_TARGET: 'vercel' })).resolves.toBe(
      '@sveltejs/adapter-vercel'
    );
  });

  it('trata DEPLOY_TARGET vacío como no declarado', async () => {
    await expect(loadAdapterName({ VERCEL: '1', DEPLOY_TARGET: '  ' })).resolves.toBe(
      '@sveltejs/adapter-vercel'
    );
  });

  it('rechaza un objetivo desconocido en vez de caer al de por omisión', async () => {
    await expect(loadAdapterName({ DEPLOY_TARGET: 'heroku' })).rejects.toThrow(
      /DEPLOY_TARGET="heroku"/
    );
  });
});
