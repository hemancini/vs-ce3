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
      external: ["playwright", "dotenv", "node:fs", "node:path", "node:child_process", "node:url", "node:https", "node:crypto"],
    },
    server: {
      watch: {
        ignored: ["**/videos.json"],
      },
    },
  },
  server: {
    host: true, // escucha en todas las interfaces (0.0.0.0)
  },
});
