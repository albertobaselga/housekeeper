import { loadEmergencyContacts } from '$lib/server/contacts.server';
import { fixturesAllowed, isDataUnavailable } from '$lib/server/data-source.server';
import { getEmergencyFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

/**
 * Emergencias es la única pantalla que NO puede responder con un error.
 *
 * Alguien puede estar solo en casa, con una urgencia delante, buscando a quién
 * llamar. Por eso aquí no hay 503 aunque la base de datos esté caída: la
 * página se pinta igual, el 112 sigue en su sitio —no sale de ninguna base de
 * datos, lo pinta la propia pantalla— y lo que no se ha podido leer se dice
 * con todas las letras.
 *
 * Lo que esta pantalla NO hace nunca es rellenar el hueco con la maqueta. Ese
 * era el fallo: un corte de base enseñaba «Centro Pediátrico Olmo · 910 000
 * 111» y «la llave general está bajo el fregadero» como si fueran los de esta
 * casa. Un teléfono inventado en una urgencia es peor que ningún teléfono.
 */
export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
  let live = null;
  try {
    live = locals.user ? await loadEmergencyContacts({ id: locals.user.id }, params.householdId) : null;
  } catch (cause) {
    // El cargador ya dejó el registro con su código. Aquí solo importa que la
    // pantalla salga; el hueco se cuenta, no se rellena.
    if (!isDataUnavailable(cause)) throw cause;
  }
  if (live) return { live, emergency: null, unreadable: false };
  // Sin base de datos configurada esto es la demostración y la maqueta es
  // legítima; con hogar real detrás `getEmergencyFixture()` ni siquiera
  // devolvería nada —lanza—, que es exactamente lo que queremos.
  if (fixturesAllowed()) return { live: null, emergency: getEmergencyFixture(), unreadable: false };
  // Avería o membresía que ya no está: desde esta pantalla es lo mismo, no
  // podemos enseñar los contactos de esta casa y hay que decirlo.
  //
  // `no-store` no es una optimización: el service worker guarda cada
  // navegación con éxito bajo su URL para poder servirla sin red, y esta
  // pantalla responde 200 a propósito. Sin esta cabecera, la versión «no
  // podemos leerlos» sustituiría en la caché a la última que SÍ traía los
  // teléfonos del hogar, y la avería de un minuto se llevaría por delante lo
  // único que quedaba para una urgencia sin cobertura.
  setHeaders({ 'cache-control': 'no-store' });
  return { live: null, emergency: null, unreadable: true };
};
