import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * jsdom 30 supports Node ^22.22.2 || ^24.15.0 || >=26. The app itself still
 * runs on Node 22.13, so only the test environment enforces this, and it
 * does so up front instead of failing deep inside a DOM call.
 */
function assertTestNodeVersion(version: string): void {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const atLeast = (minimumMinor: number, minimumPatch: number) => (
    minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)
  );
  const supported = (major === 22 && atLeast(22, 2)) || (major === 24 && atLeast(15, 0)) || major >= 26;
  if (!supported) {
    throw new Error(`Web tests need Node.js 22.22.2+, 24.15+ or 26+ (jsdom 30); found ${version}.`);
  }
}

if (process.env.VITEST) assertTestNodeVersion(process.versions.node);

export default defineConfig({
  plugins: [react()],
  // Keep one documented environment file at the workspace root.
  envDir: "../..",
  server: {
    port: 5173,
    proxy: {
      // Preserve the browser-facing Host header. The API's same-origin CSRF
      // check compares it with Origin; rewriting Host to the upstream address
      // makes the documented local `npm run dev` flow reject every mutation.
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
      // Assistant connections discover Stugu's OAuth endpoints at the origin root.
      "/.well-known/oauth-": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    // Production CSP keeps font-src at 'self'. Fontsource's small subsets fall
    // below Vite's default inline threshold unless font files are excluded.
    assetsInlineLimit(filePath) {
      return /\.(?:woff2?|ttf|otf)$/iu.test(filePath) ? false : undefined;
    },
    rollupOptions: {
      output: {
        // Route modules are already lazy-loaded. Keep the stable React runtime
        // out of the application entry as well so both chunks remain below the
        // production warning threshold and can be cached independently.
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (normalizedId.includes("/node_modules/react/") || normalizedId.includes("/node_modules/react-dom/")) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    // Large jsdom suites can oversubscribe high-core local release hosts and
    // time out midway through user-event input, cascading into later tests.
    maxWorkers: 4,
    coverage: {
      // A floor just under the measured figures, so `npm run test:coverage`
      // (and ci:local) fails when new code lands untested. Raise it as gaps close.
      thresholds: { statements: 80, lines: 84, branches: 73, functions: 78 },
    },
  },
});
