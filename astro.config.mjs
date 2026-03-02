import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  output: "server",

  adapter: cloudflare({
    mode: "directory",
    platformProxy: { enabled: true },
  }),

  integrations: [tailwind()],

  server: {
    host: true, // escucha en todas las interfaces (0.0.0.0)
  },
});
