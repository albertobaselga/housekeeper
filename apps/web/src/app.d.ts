import type { DemoUser, Session } from '$lib/auth/types';

declare global {
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
    }
  }
}

export {};
