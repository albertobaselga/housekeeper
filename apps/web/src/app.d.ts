import type { DemoUser, Session } from '$lib/auth/types';

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
    }
  }
}

export {};
