import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guardas y validación de `imports/preview` e `imports/confirm` SIN Postgres
 * (patrón de `finance-endpoints.test.ts`): `$lib/server/db.server` mockeado a
 * un pool falso pero verdadero (nunca se usa de verdad, solo hace que
 * `requireFinanceRequest` no corte en el 503), así que lo que se ejercita es
 * el 403 de origen cruzado, el 400/422 propios del multipart y del `payload`
 * de `confirm` — todo lo que Minor 1 de la revisión señalaba sin cubrir.
 */

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const USER = {
  id: 'u1',
  name: 'Alberto',
  initials: 'A',
  email: 'a@casaclara.demo',
  memberships: [{ householdId: HOUSEHOLD, membershipId: 'm1', role: 'family_admin' as const }]
};

const PREVIEW_URL = `https://casa.local/api/v1/finance/imports/preview?household=${HOUSEHOLD}`;
const CONFIRM_URL = `https://casa.local/api/v1/finance/imports/confirm?household=${HOUSEHOLD}`;

type AnyPost = (event: unknown) => Promise<Response>;

/** Construye el `event` mínimo que consume el `POST` de las rutas de imports. */
function eventOf(rawUrl: string, request: Request): { locals: { user: typeof USER }; request: Request; url: URL } {
  return { locals: { user: USER }, request, url: new URL(rawUrl) };
}

async function statusOf(run: () => Promise<Response>): Promise<number> {
  try {
    const response = await run();
    return response.status;
  } catch (cause) {
    return (cause as { status?: number }).status ?? 0;
  }
}

// Extracto OpenBank SINTÉTICO válido: para los tests que solo comprueban
// 400/403/413/422 el contenido es indiferente, pero el ÚLTIMO test (payload
// `{}`) sí necesita que `parseStatement` NO lance `FinanceParserError`, para
// que la petición llegue de verdad hasta `withAuthorizedTransaction` y el 503
// que se comprueba sea el del pool falso, no un 422 de parseo disfrazado.
const VALID_STATEMENT_HTML = `<html>
<head><title>OPENBANK - Cuentas - Movimientos</title></head>
<body><table>
<tr><td>Número de cuenta:</td><td>ES21 0073 0100 5500 1234 5678</td></tr>
<tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>05/07/2026</td><td>05/07/2026</td><td>UNA FILA</td><td>-1,00</td><td>1,00</td></tr>
</table></body></html>`;

function fileForm(
  // `parseOpenbank` decodifica los bytes como iso-8859-1 (mismo criterio que
  // `finance-imports.integration.test.ts`): pasar el string JS tal cual a
  // `File` lo codificaría en UTF-8 y «Número de cuenta» dejaría de casar
  // byte a byte, así que el `Buffer.from(…, 'latin1')` no es cosmético.
  file: FormDataEntryValue | null = new File([Buffer.from(VALID_STATEMENT_HTML, 'latin1')], 'extracto.xls'),
  extra?: Record<string, string>
): FormData {
  const form = new FormData();
  if (file !== null) form.set('file', file);
  if (extra) for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

describe('imports/preview: guarda multipart (sin Postgres)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('$lib/server/db.server', () => ({ getDatabasePool: () => ({}) }));
  });

  it('origen cruzado: 403 antes de leer el cuerpo', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/preview/+server');
    const request = new Request(PREVIEW_URL, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(PREVIEW_URL, request)))).toBe(403);
  });

  it('multipart ilegible (content-type miente): 400', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/preview/+server');
    const request = new Request(PREVIEW_URL, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'esto no es multipart de verdad'
    });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(PREVIEW_URL, request)))).toBe(400);
  });

  it('sin campo `file`: 422', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/preview/+server');
    const request = new Request(PREVIEW_URL, { method: 'POST', body: fileForm(null) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(PREVIEW_URL, request)))).toBe(422);
  });

  it('extracto declarado (content-length) por encima del tope: 413, antes de tocar el multipart', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/preview/+server');
    const request = new Request(PREVIEW_URL, {
      method: 'POST',
      headers: { 'content-length': String(50 * 1024 * 1024) },
      body: fileForm()
    });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(PREVIEW_URL, request)))).toBe(413);
  });
});

describe('imports/confirm: guarda multipart y validación de `payload` (sin Postgres)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('$lib/server/db.server', () => ({ getDatabasePool: () => ({}) }));
  });

  it('origen cruzado: 403 antes de leer el cuerpo', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const request = new Request(CONFIRM_URL, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(403);
  });

  it('multipart ilegible (content-type miente): 400', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const request = new Request(CONFIRM_URL, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'esto no es multipart de verdad'
    });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(400);
  });

  it('sin campo `file`: 422', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const request = new Request(CONFIRM_URL, { method: 'POST', body: fileForm(null) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(422);
  });

  it('fichero real por encima del tope (file.size): 413', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const grande = new File([new Uint8Array(11 * 1024 * 1024)], 'grande.xls');
    const request = new Request(CONFIRM_URL, { method: 'POST', body: fileForm(grande) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(413);
  });

  it('`payload` no es JSON: 422', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const request = new Request(CONFIRM_URL, { method: 'POST', body: fileForm(undefined, { payload: '{no-es-json' }) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(422);
  });

  it('`newAccounts` no es un array: 422', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const request = new Request(CONFIRM_URL, {
      method: 'POST',
      body: fileForm(undefined, { payload: JSON.stringify({ newAccounts: 'no-es-array' }) })
    });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(422);
  });

  it('más de 10 cuentas nuevas (11): 422', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const newAccounts = Array.from({ length: 11 }, (_, i) => ({
      bankRef: `ref-${i}`,
      name: `Cuenta ${i}`,
      kind: 'comun',
      ownerLabel: 'familia'
    }));
    const request = new Request(CONFIRM_URL, { method: 'POST', body: fileForm(undefined, { payload: JSON.stringify({ newAccounts }) }) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(422);
  });

  it('`kind` fuera del enum: 422', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const newAccounts = [{ bankRef: 'ref-1', name: 'Cuenta', kind: 'inventado', ownerLabel: 'familia' }];
    const request = new Request(CONFIRM_URL, { method: 'POST', body: fileForm(undefined, { payload: JSON.stringify({ newAccounts }) }) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(422);
  });

  it('`bankRef` de 65 caracteres (excede el máximo de 64): 422', async () => {
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const newAccounts = [{ bankRef: 'x'.repeat(65), name: 'Cuenta', kind: 'comun', ownerLabel: 'familia' }];
    const request = new Request(CONFIRM_URL, { method: 'POST', body: fileForm(undefined, { payload: JSON.stringify({ newAccounts }) }) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(422);
  });

  it('`payload=\'{}\'` se acepta como sin cuentas nuevas (no 422): la validación deja pasar y solo falla después, al no haber Postgres real (503)', async () => {
    // Documenta la divergencia Minor 2 de la revisión: el brief exigía la clave
    // `newAccounts` explícita en el esquema Zod original; aquí `{}` equivale a
    // `{ newAccounts: [] }`. Sin pool real esto llega a `confirmImport` y
    // revienta al intentar conectar — 503, NUNCA 422 — que es justo la prueba
    // de que la validación de payload lo dejó pasar.
    const { POST } = await import('../src/routes/api/v1/finance/imports/confirm/+server');
    const request = new Request(CONFIRM_URL, { method: 'POST', body: fileForm(undefined, { payload: '{}' }) });
    expect(await statusOf(() => (POST as AnyPost)(eventOf(CONFIRM_URL, request)))).toBe(503);
  });
});
