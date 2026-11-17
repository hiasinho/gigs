import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { onDurableObject, openStore } from "./harness";

// HTTP API tests run twice: on Bun against the Bun server's handler (`bun test`), and in workerd
// against the real Worker entry, which routes every request to the one GigsDO (`bun run test:do`).
// The store sits behind the Worker there, so these tests set up their data over HTTP too.

/** The admin token on both runtimes; vitest.config.ts binds it as GIGS_ADMIN_TOKEN. */
export const ADMIN_TOKEN = "adm1n";

export interface TestServer {
  fetch(req: Request): Promise<Response>;
  /** POSTs with the admin token and returns the created (201) body; anything else throws. */
  seed<T = any>(path: string, body?: unknown, actor?: string): Promise<T>;
  dispose(): void;
}

/** One server per test file: a fresh database on Bun; in workerd, the Worker (vitest gives each file its own storage). */
export function openTestServer(): TestServer {
  let fetch: (req: Request) => Promise<Response>;
  let dispose = () => {};
  if (onDurableObject) {
    fetch = async (req) => (await import("cloudflare:test")).SELF.fetch(req);
  } else {
    const dir = mkdtempSync(join(tmpdir(), "gigs-http-"));
    const store = openStore(join(dir, "gigs.db"));
    fetch = createHandler(store, { adminToken: ADMIN_TOKEN });
    dispose = () => {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    };
  }
  return {
    fetch,
    dispose,
    async seed(path, body = {}, actor = "fixture") {
      const headers = { Authorization: `Bearer ${ADMIN_TOKEN}`, "X-Gigs-Actor": actor };
      const res = await fetch(new Request(`http://gigs${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
      if (res.status !== 201) throw new Error(`seed ${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as any;
    },
  };
}
