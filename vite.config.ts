import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import { devtools } from "@tanstack/devtools-vite";

export default defineConfig({
  server: {
  port: 5173,
  host: true,
  strictPort: true,
},
  plugins: [
    // Must come before tanstackStart() so it can hook into the dev server pipeline.
    devtools(),
    tsConfigPaths(),
    tailwindcss(),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
    }),
    // Build-only: turns the Start output into a deployable server. Target platform was
    // Cloudflare Workers — change/remove the preset below if you deploy elsewhere (e.g. Netlify).
    nitro({ preset: "cloudflare-module" }),
    viteReact(),
  ],
  resolve: {
    // Avoid duplicate copies of React/TanStack when linked or hoisted oddly.
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start"],
  },
});
