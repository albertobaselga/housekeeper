import {
  guideReadEndpoint,
  rememberPendingRead,
  takePendingReads,
  type PendingReadStorage
} from './reading';

/**
 * Envío de «he leído esta nota». Es una llamada propia y minúscula, NO un
 * comando de la cola offline: los comandos dejan recibo con actor y hora en
 * `app.command_receipts`, y eso reconstruiría el rastro de vigilancia que la
 * migración 0026 evita a propósito. Sin red la nota se recuerda en el
 * dispositivo y se envía en el siguiente intento con éxito.
 */

function storage(): PendingReadStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari en modo privado con cuota a cero, por ejemplo.
    return null;
  }
}

async function post(householdId: string, pageIds: string[]): Promise<boolean> {
  if (pageIds.length === 0) return true;
  const response = await fetch(guideReadEndpoint(householdId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pageIds })
  });
  return response.ok;
}

/**
 * Apunta la nota. Devuelve true si el servidor la ha registrado; false si ha
 * quedado guardada en este dispositivo a la espera de red. Nunca lanza: el modo
 * libro debe poder pasar de página aunque no haya cobertura.
 */
export async function markGuideNoteRead(householdId: string, pageId: string): Promise<boolean> {
  const local = storage();
  const pending = local ? takePendingReads(local, householdId) : [];
  const batch = [...pending.filter((candidate) => candidate !== pageId), pageId];
  try {
    if (await post(householdId, batch)) return true;
  } catch {
    // Sin red o servidor caído: se guarda abajo.
  }
  if (local) for (const candidate of batch) rememberPendingRead(local, householdId, candidate);
  return false;
}

/** Reintento de lo que quedó pendiente, al recuperar la conexión. */
export async function flushGuideReads(householdId: string): Promise<void> {
  const local = storage();
  if (!local) return;
  const pending = takePendingReads(local, householdId);
  if (pending.length === 0) return;
  try {
    if (await post(householdId, pending)) return;
  } catch {
    // Sigue sin poder ser.
  }
  for (const candidate of pending) rememberPendingRead(local, householdId, candidate);
}
