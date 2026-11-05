import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { Store, type Boon } from "../src/store";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boons-atomic-"));
  path = join(dir, "boons.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(store: Store, n: number) {
  store.createProject("bn");
  for (let i = 0; i < n; i++) store.createBoon("bn", "seed", { title: `boon ${i}` });
}

test("two stores on one file never claim the same boon", () => {
  const a = new Store({ path });
  const b = new Store({ path });
  seed(a, 30);
  const claimed: string[] = [];
  for (let i = 0; i < 20; i++) {
    for (const [store, actor] of [[a, "a"], [b, "b"]] as const) {
      const boon = store.claimNext("bn", actor);
      if (boon) claimed.push(boon.id);
    }
  }
  expect(claimed).toHaveLength(30);
  expect(new Set(claimed).size).toBe(30);
  expect(a.ready("bn")).toEqual([]);
  a.dispose();
  b.dispose();
});

test("concurrent HTTP claim-next requests across two servers get distinct boons", async () => {
  const stores = [new Store({ path }), new Store({ path })];
  seed(stores[0]!, 15);
  const servers = stores.map((store) => Bun.serve({ port: 0, fetch: createHandler(store) }));
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const server = servers[i % 2]!;
        const res = await fetch(new URL("/projects/bn/claim", server.url), {
          method: "POST",
          headers: { "X-Boons-Actor": `agent-${i}` },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as Boon | null;
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
