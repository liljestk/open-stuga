import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Keep one documented environment file at the workspace root.
  envDir: "../..",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Route modules are already lazy-loaded. Keep the stable React runtime
        // out of the application entry as well so both chunks remain below the
        // production warning threshold and can be cached independently.
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});
