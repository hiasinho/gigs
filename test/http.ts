import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { onDurableObject, openStore } from "./harness";

// HTTP API tests run twice: on Bun against the Bun server's handler (`bun test`), and in workerd
// against the real Worker entry, which routes every request to the one GigsDO (`bun run test:do`).

/** The admin token on both runtimes; vitest.config.ts binds it as GIGS_ADMIN_TOKEN. */
export const ADMIN_TOKEN = "adm1n";

export interface Api {
  fetch(req: Request): Promise<Response>;
  dispose(): void;
}

/** One server for a test file: its database lives until dispose (on Bun) or for the whole file (in workerd). */
export function openApi(): Api {
  if (onDurableObject) {
    return { fetch: async (req) => (await import("cloudflare:test")).SELF.fetch(req), dispose() {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "gigs-http-"));
  const store = openStore(join(dir, "gigs.db"));
  return {
    fetch: createHandler(store, { adminToken: ADMIN_TOKEN }),
    dispose() {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
