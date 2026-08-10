import type { AppContext, DemoUser, Session } from '$lib/auth/types';

declare global {
  /**
   * Constante de compilación (`vite.config.ts`, `define`). Cuando vale `false`
   * el selector de cuentas sintéticas NO ESTÁ en el paquete: no es que esté
   * apagado, es que Rollup se llevó la rama entera. Ver
   * `src/lib/server/fixture-login-flag.js`.
   */
  const __FIXTURE_LOGIN__: boolean;

  namespace App {
    interface Locals {
      session: Session | null;
      user: DemoUser | null;
      /** ALLOW_SYNTHETIC_DATA_ONLY === 'true': entorno declarado solo-sintético. */
      syntheticOnly: boolean;
      /**
       * La sesión es válida pero no hemos podido leer el perfil del hogar por
       * una avería. Distingue «no has entrado» de «no podemos mirar»: sin esta
       * marca, un corte de base echaba a la calle a quien sí había entrado, con
       * un redirect a /login que además es mentira.
       */
      dataUnavailable: boolean;
    }

    interface Error {
      message: string;
    }

    interface PageData {
      user?: DemoUser | null;
      /**
       * Contexto del hogar abierto, publicado por el layout de `/h/[householdId]`.
       * El layout de la raíz lo lee para titular la pestaña con el nombre de ESE
       * hogar; sin él (acceso, sin conexión, error fuera de un hogar) el título
       * es el genérico del producto.
       */
      context?: AppContext;
      /**
       * Etiqueta de sección con la que una página afina su título de pestaña
       * (una nota de la guía se titula con su propio nombre). Sin ella, el
       * layout de la raíz la deduce de la ruta. Ver `$lib/app-title`.
       */
      section?: string;
    }
  }
}

export {};
