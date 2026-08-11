/**
 * «Ya he visto lo que me habían apuntado.»
 *
 * Llamada propia y minúscula, NO un comando de la cola offline, por el mismo
 * motivo que el «he leído esta nota» de la Guía: los comandos dejan recibo con
 * actor y hora en `app.command_receipts`, y esto no es un hecho del expediente
 * —no es una conformidad ni una firma—, es solo la marca personal que apaga el
 * aviso.
 *
 * Nunca lanza y nunca bloquea la pantalla: si no hay red, el aviso seguirá ahí
 * la próxima vez, que es exactamente lo que tiene que pasar.
 */
export function vacationsSeenEndpoint(householdId: string): string {
  return `/api/v1/households/${householdId}/vacaciones/vistas`;
}

export async function markVacationsSeen(
  householdId: string,
  seenThrough: string | null
): Promise<boolean> {
  try {
    const response = await fetch(vacationsSeenEndpoint(householdId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seenThrough })
    });
    return response.ok;
  } catch {
    return false;
  }
}
