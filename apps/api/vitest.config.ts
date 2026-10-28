import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // A floor just under the measured figures, so `npm run test:coverage`
      // (and ci:local) fails when new code lands untested. Raise it as gaps close.
      thresholds: { statements: 82, lines: 86, branches: 73, functions: 88 },
    },
  },
});
