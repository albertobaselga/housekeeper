import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentDependencies } from '../src/lib/server/attachments.server';
import { createAttachmentDependencies } from '../src/lib/server/attachment-deps.server';
import { loadCouponPhoto } from '../src/lib/server/coupon-photo.server';
import { GET } from '../src/routes/api/v1/households/[householdId]/coupons/[couponId]/photo/+server';

/**
 * La foto de un cupón (spec cupones §7.3), con dobles para la base y el
 * almacén: aquí se prueba lo que decide la RUTA —sesión, pertenencia,
 * capacidad, 404 opaco, bucket y cabeceras—. Qué filas ve cada papel lo decide
 * la RLS y se prueba en coupon-photo.integration.test.ts.
 */
vi.mock('$lib/server/coupon-photo.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/server/coupon-photo.server')>();
  return { ...actual, loadCouponPhoto: vi.fn() };
});
vi.mock('$lib/server/attachment-deps.server', () => ({ createAttachmentDependencies: vi.fn() }));

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const OTHER_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const COUPON = 'cd200000-0000-4000-8000-000000000001';
const BUCKET = 'housekeeper-test';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

type Role = 'family_admin' | 'family_member' | 'employee_live_in' | 'helper' | 'viewer';

function userWith(role: Role) {
  return {
    id: `fixture:roble:${role}`,
    name: 'Persona',
    initials: 'P',
    email: 'persona@casaclara.demo',
    memberships: [{ householdId: HOUSEHOLD, membershipId: 'm1', role }]
  };
}

function event(options: { user?: ReturnType<typeof userWith> | null; householdId?: string; couponId?: string } = {}) {
  return {
    locals: { user: options.user === undefined ? userWith('family_member') : options.user },
    params: { householdId: options.householdId ?? HOUSEHOLD, couponId: options.couponId ?? COUPON }
  } as unknown as Parameters<typeof GET>[0];
}

function photo(overrides: Partial<{ bucket: string; objectKey: string; mediaType: string; byteSize: string }> = {}) {
  return {
    bucket: BUCKET,
    objectKey: `${HOUSEHOLD}/attachments/0123456789abcdef.jpg`,
    mediaType: 'image/jpeg',
    byteSize: String(JPEG.length),
    ...overrides
  };
}

function store(overrides: Partial<AttachmentDependencies> = {}): AttachmentDependencies {
  return {
    bucket: BUCKET,
    putObject: vi.fn(async () => undefined),
    getObject: vi.fn(async () => JPEG),
    ...overrides
  };
}

async function outcome(run: () => Response | Promise<Response>): Promise<{ status: number; message?: string }> {
  try {
    return { status: (await run()).status };
  } catch (cause) {
    const failure = cause as { status?: number; body?: { message?: string } };
    return { status: failure.status ?? 0, message: failure.body?.message };
  }
}

describe('GET /api/v1/households/[householdId]/coupons/[couponId]/photo', () => {
  beforeEach(() => {
    vi.mocked(loadCouponPhoto).mockReset();
    vi.mocked(createAttachmentDependencies).mockReset();
    vi.mocked(loadCouponPhoto).mockResolvedValue(photo());
    vi.mocked(createAttachmentDependencies).mockReturnValue(store());
  });

  it('sin sesión: 401, sin preguntar a la base', async () => {
    expect((await outcome(() => GET(event({ user: null })))).status).toBe(401);
    expect(loadCouponPhoto).not.toHaveBeenCalled();
  });

  it('el hook no protege /api: la ruta comprueba la pertenencia y responde 404 opaco', async () => {
    expect((await outcome(() => GET(event({ householdId: OTHER_HOUSEHOLD })))).status).toBe(404);
    expect(loadCouponPhoto).not.toHaveBeenCalled();
  });

  it('la empleada, el apoyo y el acceso puntual no llegan ni a la consulta: 404, igual que si no existiera', async () => {
    for (const role of ['employee_live_in', 'helper', 'viewer'] as const) {
      const result = await outcome(() => GET(event({ user: userWith(role) })));
      expect(result.status, role).toBe(404);
    }
    expect(loadCouponPhoto).not.toHaveBeenCalled();
    expect(createAttachmentDependencies).not.toHaveBeenCalled();
  });

  it('un identificador que no es un uuid es 404, no una avería de la base', async () => {
    expect((await outcome(() => GET(event({ couponId: 'no-es-un-cupon' })))).status).toBe(404);
    expect(loadCouponPhoto).not.toHaveBeenCalled();
  });

  it('cupón que no existe o no se ve: el MISMO 404 que el de un papel sin acceso', async () => {
    vi.mocked(loadCouponPhoto).mockResolvedValueOnce(null);
    const missing = await outcome(() => GET(event()));
    const forbidden = await outcome(() => GET(event({ user: userWith('employee_live_in') })));
    expect(missing).toEqual(forbidden);
    expect(missing.status).toBe(404);
  });

  it('la familia, con sus dos papeles, ve la foto', async () => {
    for (const role of ['family_admin', 'family_member'] as const) {
      const response = await GET(event({ user: userWith(role) }));
      expect(response.status, role).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG);
    }
    expect(loadCouponPhoto).toHaveBeenCalledWith({ id: 'fixture:roble:family_member' }, HOUSEHOLD, COUPON);
  });

  it('cabeceras: tipo de la lista blanca, nosniff, sandbox, sin caché y sin el nombre del comercio', async () => {
    const response = await GET(event());
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('content-length')).toBe(String(JPEG.length));
    // El nombre del fichero lo pone la ruta con el id, nunca con datos del cupón.
    expect(response.headers.get('content-disposition')).toBe(`inline; filename="cupon-${COUPON}.jpg"`);
  });

  it('PNG y WebP salen con su tipo; cualquier otra cosa, como bytes opacos', async () => {
    vi.mocked(loadCouponPhoto).mockResolvedValueOnce(photo({ mediaType: 'image/png' }));
    expect((await GET(event())).headers.get('content-type')).toBe('image/png');
    vi.mocked(loadCouponPhoto).mockResolvedValueOnce(photo({ mediaType: 'image/webp' }));
    expect((await GET(event())).headers.get('content-type')).toBe('image/webp');
    // La regla de enlace no deja colgar otra cosa, pero si la fila mintiera el
    // navegador no recibiría un tipo que pueda interpretar.
    for (const mediaType of ['application/pdf', 'text/html', 'image/svg+xml']) {
      vi.mocked(loadCouponPhoto).mockResolvedValueOnce(photo({ mediaType }));
      const response = await GET(event());
      expect(response.headers.get('content-type'), mediaType).toBe('application/octet-stream');
      expect(response.headers.get('content-disposition'), mediaType).toBe(`inline; filename="cupon-${COUPON}"`);
    }
  });

  it('en flujo cuando el almacén lo permite, con el tamaño de la fila', async () => {
    const getObject = vi.fn(async () => JPEG);
    const getObjectStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(JPEG);
            controller.close();
          }
        })
    );
    vi.mocked(createAttachmentDependencies).mockReturnValue(store({ getObject, getObjectStream }));
    vi.mocked(loadCouponPhoto).mockResolvedValueOnce(photo({ byteSize: '8' }));
    const response = await GET(event());
    expect(getObjectStream).toHaveBeenCalledWith(`${HOUSEHOLD}/attachments/0123456789abcdef.jpg`);
    expect(getObject).not.toHaveBeenCalled();
    expect(response.headers.get('content-length')).toBe('8');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG);
  });

  it('sin almacén configurado: 503 honesto', async () => {
    vi.mocked(createAttachmentDependencies).mockReturnValue(null);
    expect((await outcome(() => GET(event()))).status).toBe(503);
  });

  it('foto registrada en OTRO bucket: 503 antes de leer nada', async () => {
    const getObject = vi.fn(async () => JPEG);
    vi.mocked(createAttachmentDependencies).mockReturnValue(store({ getObject }));
    vi.mocked(loadCouponPhoto).mockResolvedValueOnce(photo({ bucket: 'otro-almacen' }));
    const result = await outcome(() => GET(event()));
    expect(result.status).toBe(503);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('el almacén que falla al leer: 503, no un 500 mudo', async () => {
    vi.mocked(createAttachmentDependencies).mockReturnValue(
      store({ getObject: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) })
    );
    expect((await outcome(() => GET(event()))).status).toBe(503);
  });
});
