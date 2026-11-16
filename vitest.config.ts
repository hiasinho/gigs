import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `bun run test:do`: the store tests in workerd, against a real SQLite-backed Durable Object.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/do/worker.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { DB: { className: "TestDO", useSQLite: true } },
      },
    }),
  ],
  resolve: {
    alias: { "bun:test": here("./test/do/bun-test.ts"), "bun:sqlite": here("./test/do/bun-sqlite.ts") },
  },
  test: {
    // Store-level tests; server/CLI/multi-process tests (e2e, server, atomicity, multiprocess) need Bun.
    include: [
      "test/sql.test.ts", "test/store.test.ts", "test/lifecycle.test.ts", "test/links.test.ts", "test/labels.test.ts",
      "test/human.test.ts", "test/gig-edit.test.ts", "test/claim-filters.test.ts", "test/create-defer.test.ts",
      "test/spec-status.test.ts", "test/spec-enforce.test.ts", "test/spec-history.test.ts", "test/auth.test.ts",
    ],
  },
});
