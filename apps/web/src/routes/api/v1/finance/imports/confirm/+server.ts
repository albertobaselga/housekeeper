import { error, isHttpError, json } from '@sveltejs/kit';

import { AuthorizationError, CommandRejectedError, FinanceParserError, createLogger, errorCode } from '@housekeeper/server';

import {
  ImportUncoveredAccountsError,
  MAX_IMPORT_BYTES,
  confirmImport,
  type NewAccountInput
} from '$lib/server/finance-imports.server';
import { DATA_UNAVAILABLE_MESSAGE, DATA_UNAVAILABLE_STATUS } from '$lib/server/data-source.server';
import { requireFinanceRequest } from '$lib/server/finance.server';
import type { RequestHandler } from './$types';

const log = createLogger('web:finance-imports');

// `zod` no es dependencia directa de @housekeeper/web (pnpm no la hoisteaba
// desde @housekeeper/contracts): en vez de añadir una dependencia nueva para
// un único esquema de 4 campos, se estrecha `unknown` a mano con guardas de
// tipo (Ruling del brief: "sin `as` ni `!`" — un `value is T` cumple la regla
// sin necesitar el esquema declarativo).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAccountKind(value: unknown): value is NewAccountInput['kind'] {
  return value === 'comun' || value === 'personal' || value === 'inversion';
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

function isNewAccountInput(value: unknown): value is NewAccountInput {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.bankRef, 1, 64) &&
    isBoundedString(value.name, 1, 120) &&
    isAccountKind(value.kind) &&
    isBoundedString(value.ownerLabel, 1, 80)
  );
}

/**
 * `{ newAccounts: [] }` por defecto: confirmar sin cuentas nuevas es válido.
 * Divergencia observable respecto del brief: el esquema Zod original exigía
 * la clave `newAccounts` explícita y `payload='{}'` habría fallado; aquí
 * `undefined` se trata igual que `[]`. Es el comportamiento que se quiere
 * (el cliente puede omitir la clave si no da de alta ninguna cuenta) y queda
 * escrito aquí para que la Task 12 no lo descubra por sorpresa.
 */
function parseNewAccounts(payload: unknown): NewAccountInput[] | null {
  if (!isRecord(payload)) return null;
  const { newAccounts } = payload;
  if (newAccounts === undefined) return [];
  if (!Array.isArray(newAccounts) || newAccounts.length > 10) return null;
  const parsed: NewAccountInput[] = [];
  for (const candidate of newAccounts) {
    if (!isNewAccountInput(candidate)) return null;
    parsed.push({
      bankRef: candidate.bankRef.trim(),
      name: candidate.name.trim(),
      kind: candidate.kind,
      ownerLabel: candidate.ownerLabel.trim()
    });
  }
  return parsed;
}

/**
 * Misma cabecera de guarda que `imports/preview` (§ Task 6): origen cruzado y
 * `requireFinanceRequest` primero; lo propio de esta ruta es el `payload` JSON
 * que acompaña al fichero con las cuentas nuevas a dar de alta.
 */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) error(403, 'Origen no permitido');
  const { user, householdId, pool } = requireFinanceRequest(locals, url);

  // Tope de tamaño ANTES de tocar el cuerpo: mismo criterio que el adjunto
  // (`content-length` declarado, no el real, que aún no se ha leído).
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_IMPORT_BYTES) {
    error(413, `El extracto supera el máximo de ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB`);
  }

  const form = await request.formData().catch(() => null);
  if (!form) error(400, 'No se pudo leer el fichero');
  const file = form.get('file');
  if (!(file instanceof File)) error(422, 'No llegó ningún fichero');
  if (file.size > MAX_IMPORT_BYTES) {
    error(413, `El extracto supera el máximo de ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  const rawPayload = form.get('payload');
  let parsedJson: unknown = { newAccounts: [] };
  if (typeof rawPayload === 'string' && rawPayload) {
    try {
      parsedJson = JSON.parse(rawPayload);
    } catch {
      error(422, 'Cuentas nuevas inválidas');
    }
  }
  const newAccounts = parseNewAccounts(parsedJson);
  if (newAccounts === null) error(422, 'Cuentas nuevas inválidas');

  try {
    const result = await confirmImport(user, householdId, bytes, file.name, newAccounts, pool);
    return json({ apiVersion: 1, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof FinanceParserError) error(422, cause.message);
    if (cause instanceof ImportUncoveredAccountsError) error(422, cause.message);
    if (cause instanceof AuthorizationError) error(404, 'Hogar no encontrado');
    if (cause instanceof CommandRejectedError) error(404, 'Hogar no encontrado');
    if (isHttpError(cause)) throw cause;
    // Simetría con `financeRead` (finance.server.ts): un fallo inesperado no
    // sale como 500 pelado y sin rastro, sale como el mismo 503 honesto.
    log.error('finance import unavailable', { code: errorCode(cause) });
    error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
  }
};
