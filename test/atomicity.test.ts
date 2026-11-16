import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { Store, type Gig } from "../src/store";
import { openStore } from "./harness";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-atomic-"));
  path = join(dir, "gigs.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(store: Store, n: number) {
  store.createProject("gig");
  for (let i = 0; i < n; i++) store.createGig("gig", "seed", { title: `gig ${i}` });
}

test("two stores on one file never claim the same gig", () => {
  const a = openStore(path);
  const b = openStore(path);
  seed(a, 30);
  const claimed: string[] = [];
  for (let i = 0; i < 20; i++) {
    for (const [store, actor] of [[a, "a"], [b, "b"]] as const) {
      const gig = store.claimNext("gig", actor);
      if (gig) claimed.push(gig.id);
    }
  }
  expect(claimed).toHaveLength(30);
  expect(new Set(claimed).size).toBe(30);
  expect(a.ready("gig")).toEqual([]);
  a.dispose();
  b.dispose();
});

test("concurrent HTTP claim-next requests across two servers get distinct gigs", async () => {
  const stores = [openStore(path), openStore(path)];
  seed(stores[0]!, 15);
  const servers = stores.map((store) => Bun.serve({ port: 0, fetch: createHandler(store) }));
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const server = servers[i % 2]!;
        const res = await fetch(new URL("/projects/gig/claim", server.url), {
          method: "POST",
          headers: { "X-Gigs-Actor": `agent-${i}` },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as Gig | null;
      }),
    );
    const ids = results.filter((b) => b !== null).map((b) => b.id);
    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(15);
    expect(results.filter((b) => b === null)).toHaveLength(5);
  } finally {
    for (const s of servers) s.stop(true);
    for (const s of stores) s.dispose();
  }
});
