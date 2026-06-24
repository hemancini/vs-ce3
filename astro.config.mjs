import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "server",

  adapter: cloudflare({
    mode: "directory",
    platformProxy: { enabled: true },
  }),

  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // El scraper (src/pages/api/sheer/scrape.js) usa estas deps de Node solo en
      // `astro dev`. Las marcamos como externas para que el build de Cloudflare no
      // intente bundlearlas (fallaría: no existen en Workers).
      // El scraper (src/pages/api/sheer/scrape.js y scrape-stream.js) usa estas
      // deps de Node solo en `astro dev`. Las marcamos como externas para que el
      // build de Cloudflare no intente bundlearlas (no existen en Workers).
      external: ["playwright", "dotenv", "node:fs", "node:path", "node:child_process", "node:url"],
    },
    server: {
      watch: {
        // El scraper escribe estos archivos de datos en runtime.
        // Sin esto, cada escritura dispara un "[vite] program reload"
        // en bucle y rompe astro:server-app.js / el HMR (ws).
        ignored: ["**/videos.json"],
      },
    },
  },

  server: {
    host: true, // escucha en todas las interfaces (0.0.0.0)
  },
});
