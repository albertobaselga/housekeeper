import type { DemoUser, Session } from '$lib/auth/types';

declare global {
  namespace App {
    interface Locals {
      session: Session | null;
      user: DemoUser | null;
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
