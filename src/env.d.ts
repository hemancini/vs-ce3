/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}

interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT: string;
  VODSCENE_EMAIL: string;
  VODSCENE_PASSWORD: string;
  /** Contraseña de acceso a la app. Usar: wrangler pages secret put API_KEY */
  API_KEY: string;
}
