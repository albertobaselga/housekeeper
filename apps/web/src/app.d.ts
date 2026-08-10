import type { DemoUser, Session } from '$lib/auth/types';

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
