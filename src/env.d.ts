/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    /** Cookie de sesión de Arsmate, inyectada por el middleware `/ars`. */
    arsmateCookie?: string;
    /** ID de usuario de Arsmate, inyectado por el middleware `/ars`. */
    arsmateUserId?: string;
  }
}

interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT: string;
  VODSCENE_EMAIL: string;
  VODSCENE_PASSWORD: string;
  /** Contraseña de acceso a la app. Usar: wrangler pages secret put API_KEY */
  API_KEY: string;
  /** Credenciales de Arsmate. Usar: wrangler pages secret put ARSMATE_EMAIL */
  ARSMATE_EMAIL: string;
  ARSMATE_PASSWORD: string;
}
