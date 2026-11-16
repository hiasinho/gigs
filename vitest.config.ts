import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// `bun run test:do`: the store tests in workerd, against a real SQLite-backed Durable Object, and
// the Worker entry (src/worker.ts) end to end.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** `import html from "./ui.html"` as a string, like wrangler's Text rule in wrangler.toml. */
const htmlAsText: Plugin = {
  name: "html-as-text",
  enforce: "pre",
  load(id) {
    if (id.endsWith(".html")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [
    htmlAsText,
    cloudflareTest({
      main: "./test/do/worker.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { DB: { className: "TestDO", useSQLite: true }, GIGS: { className: "GigsDO", useSQLite: true } },
        bindings: { GIGS_ADMIN_TOKEN: "adm1n" },
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
      "test/do/worker-entry.ts",
    ],
  },
});
