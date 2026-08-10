import type { AppContext, DemoUser, Session } from '$lib/auth/types';

declare global {
  namespace App {
    interface Locals {
      session: Session | null;
      user: DemoUser | null;
      /** ALLOW_SYNTHETIC_DATA_ONLY === 'true': entorno declarado solo-sintético. */
      syntheticOnly: boolean;
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
