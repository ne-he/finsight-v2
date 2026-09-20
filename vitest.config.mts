import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests run in plain Node with no network and no database, so `npm test`
 * stays fast enough to run on every commit in CI.
 *
 * Anything that needs Supabase or Gemini lives in `scripts/` instead and is run
 * deliberately, because those calls cost free-tier quota.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
