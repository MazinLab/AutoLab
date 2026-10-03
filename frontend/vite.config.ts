import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "AutoLab",
        short_name: "AutoLab",
        description:
          "Mazin Lab Archive — data catalog and electronic lab notebook",
        theme_color: "#e9eef3",
        background_color: "#e9eef3",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm}"],
        runtimeCaching: [
          {
            // Catalog reads keep working in the cleanroom dead zone; writes
            // are handled by the offline outbox, and artifact downloads are
            // excluded so multi-GB files never land in Cache Storage.
            urlPattern: ({ request, url }) =>
              request.method === "GET" &&
              url.pathname.startsWith("/api/") &&
              !url.pathname.endsWith("/download"),
            handler: "NetworkFirst",
            options: {
              cacheName: "autolab-api",
              networkTimeoutSeconds: 4,
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        // The label station at /labels is its own page, never the SPA shell.
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/mcp(?:\/|$)/,
          /^\/labels(?:\/|$)/,
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        labels: "labels/index.html",
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/mcp": "http://127.0.0.1:8000",
    },
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**"],
    globals: true,
    restoreMocks: true,
  },
});
