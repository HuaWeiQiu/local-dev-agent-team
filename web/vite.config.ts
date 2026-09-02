import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify("0.1.0"),
    __APP_BUILD_ID__: JSON.stringify("2026.08.17-github-changes"),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
