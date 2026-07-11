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
  VS_FIREBASE_API_KEY: string;
  VS_FIREBASE_PROJECT: string;
  /** Contraseña de acceso a la app. Usar: wrangler pages secret put API_KEY */
  API_KEY: string;
  /** KV compartido para sesiones/cachés (Sheer, Arsmate…). */
  VS_C3_KV: KVNamespace;
  /** Secreto opcional para cifrar los blobs de sesión guardados en KV. */
  ARS_KV_SECRET?: string;
  SHEER_KV_SECRET?: string;
}
