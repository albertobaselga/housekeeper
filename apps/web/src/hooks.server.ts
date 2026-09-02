import { building } from '$app/environment';
import { error, redirect, type Handle } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';

import { can } from '$lib/auth/capabilities';
import { belongsToHousehold, membershipIn } from '$lib/auth/membership';
import { guardForPath } from '$lib/auth/routing';
import { resolveAppUser } from '$lib/server/app-user.server';
import { getAuth } from '$lib/server/auth.server';
import { bootRefusal, refusalResponse, skipDuringBuild } from '$lib/server/boot-guard.server';
import {
  DATA_UNAVAILABLE_MESSAGE,
  DATA_UNAVAILABLE_STATUS,
  isDataUnavailable
} from '$lib/server/data-source.server';
import { getDemoUser } from '$lib/server/fixtures.server';
import { readDemoSession } from '$lib/server/session.server';
import { syntheticGuard } from '$lib/server/synthetic.server';
import type { Session } from '$lib/auth/types';

export const handle: Handle = async ({ event, resolve }) => {
  // Lo PRIMERO, antes de tocar identidad, base de datos o rutas: la regla
  // indivisible de configuración. Se calcula una vez por proceso; a partir de
  // ahí es una comparación con null. Ver boot-guard.server.ts para por qué
  // negarse aquí no deja a nadie de la casa fuera.
  if (!skipDuringBuild()) {
    const refusal = bootRefusal();
    if (refusal) return refusalResponse(refusal);
  }

  const auth = getAuth();
  // Control 9: el flag solo-sintético se lee aquí y viaja por layout data
  // hasta el banner persistente del AppShell.
  event.locals.syntheticOnly = syntheticGuard().syntheticOnly;
  event.locals.dataUnavailable = false;

  if (event.url.pathname.startsWith('/api/auth')) {
    if (!auth) error(404, 'La autenticación real no está configurada en este entorno');
    return svelteKitHandler({ event, resolve, auth, building });
  }

  if (auth) {
    const authSession = await auth.api.getSession({ headers: event.request.headers });
    if (authSession) {
      const session: Session = {
        id: authSession.session.id,
        userId: authSession.user.id,
        createdAt: new Date(authSession.session.createdAt).toISOString(),
        expiresAt: new Date(authSession.session.expiresAt).toISOString()
      };
      let user = null;
      try {
        user = await resolveAppUser(
          authSession.user.id,
          authSession.user.email,
          authSession.user.name ?? authSession.user.email
        );
      } catch (cause) {
        // Avería leyendo el perfil. La sesión es buena, así que NO se echa a la
        // calle a nadie: se marca y la guarda de más abajo responde 503, que es
        // el camino que el service worker convierte en la pantalla guardada.
        if (!isDataUnavailable(cause)) throw cause;
        event.locals.dataUnavailable = true;
      }
      event.locals.session = user ? session : null;
      event.locals.user = user;
    } else {
      event.locals.session = null;
      event.locals.user = null;
    }
  } else if (__FIXTURE_LOGIN__) {
    // Modo demo sin base de datos: sesiones en memoria y cuentas fixture. La
    // rama completa desaparece del paquete cuando la constante es falsa, y con
    // ella la única vía que tenía una cookie `cc_demo_session` de convertirse
    // en `locals.user` —y de ahí en `set_config('app.user_id', …)`—.
    const session = readDemoSession(event.cookies);
    const user = session ? getDemoUser(session.userId) : null;
    event.locals.session = user ? session : null;
    event.locals.user = user;
  } else {
    event.locals.session = null;
    event.locals.user = null;
  }

  const guard = guardForPath(event.url.pathname);
  if (guard) {
    if (!guard.known) error(404, 'Esta ruta no existe');
    if (!event.locals.user) {
      if (event.locals.dataUnavailable) error(DATA_UNAVAILABLE_STATUS, DATA_UNAVAILABLE_MESSAGE);
      const next = `${event.url.pathname}${event.url.search}`;
      redirect(303, `/login?next=${encodeURIComponent(next)}`);
    }
    if (!guard.householdId || !belongsToHousehold(event.locals.user, guard.householdId)) {
      error(404, 'Hogar no encontrado');
    }
    // Contraseña provisional sin cambiar: la única pantalla del hogar que se
    // abre es «Tu contraseña». No es una recomendación en un aviso, es la
    // puerta. Las rutas de /api quedan fuera a propósito: no enseñan nada que
    // esta persona no pueda ver de todos modos, y bloquearlas rompería la
    // propia pantalla a la que se la está mandando.
    if (event.locals.user.mustChangePassword && guard.module !== 'account') {
      redirect(303, `/h/${encodeURIComponent(guard.householdId)}/account`);
    }
    /*
     * LA LLAVE DE LA RUTA GOBIERNA TAMBIÉN LO QUE ESCRIBE, Y ESO TIENE QUE
     * PASAR AQUÍ. No es una duplicación del layout: es la mitad que el layout
     * no puede cubrir.
     *
     * En SvelteKit 2.70.2, ante un POST a una *form action* el servidor ejecuta
     * la acción ANTES que cualquier `load`, layouts incluidos
     * (`runtime/server/page/index.js`: la acción en las líneas 70-77, los `load`
     * en la 193). Y el único `error(403)` por capacidad de esta aplicación vive
     * en el `load` del layout del hogar. O sea: un POST a
     * `/h/<casa>/employment/alta?/hire` atravesaba `guard.known` y
     * `belongsToHousehold` —pertenecer a la casa CON CUALQUIER PAPEL— y llegaba
     * a la acción sin que `access.manage` se hubiera consultado ni una vez.
     *
     * Hoy no se puede explotar porque cada acción revalida el papel dentro de
     * su transacción y, por debajo, la RLS rechaza. Pero eso es la segunda reja;
     * la invariante que esta tabla de rutas promete es la primera, y sin esto
     * estaba mal contada: el día que alguien escriba una acción confiando en
     * «la llave ya la comprobó la ruta» se convierte en un agujero de verdad.
     *
     * NO SE PUEDE «LIMPIAR» LLEVÁNDOLO AL LAYOUT. Ahí llega tarde por
     * construcción, y llegaría tarde igual aunque el layout lo comprobase dos
     * veces. Se queda en el hook, y sólo para lo que no es GET: la navegación
     * normal sigue recibiendo el 403 amable de `+layout.server.ts`, que aterriza
     * en `+error.svelte` con lenguaje de casa y un camino de vuelta a Hoy, en
     * vez de la página de fallo cruda que renderiza un error lanzado aquí.
     */
    if (event.request.method !== 'GET' && guard.capability) {
      const membership = membershipIn(event.locals.user, guard.householdId);
      if (!can(membership?.role, guard.capability)) {
        error(403, 'Esta parte la lleva la familia.');
      }
    }
  }

  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Una respuesta a algo que no es GET puede llevar dentro algo que se enseña
  // UNA sola vez: la contraseña provisional del alta viaja así, en el resultado
  // de la acción. Por semántica HTTP esa respuesta ya no es cacheable sin
  // frescura declarada, así que esto es cinturón sobre tirantes; en un
  // dispositivo compartido —el ordenador de la cocina— cuesta una línea. Los
  // GET no se tocan: ahí el service worker tiene que poder guardar lo que
  // guarda.
  if (event.request.method !== 'GET') response.headers.set('Cache-Control', 'no-store');
  return response;
};
