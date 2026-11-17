import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/handler";
import type { Sql } from "../src/sql";
import { GigsError, Store, type Dump } from "../src/store";
import { bunTest, onDurableObject, openSql, openStore } from "./harness";

// Moving a whole database between servers: exportDump on one, importDump into an empty one.
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-transfer-"));
  store = openStore(join(dir, "a.db"), { now: () => new Date("2026-01-01T00:00:00.000Z") });
  store.createProject("ab", "Alpha");
  const a = store.createSpec("ab", "alice", { title: "S", text: "one" });
  store.editSpec(a.id, "bob", [{ old: "one", new: "two" }]);
  store.readySpec(a.id, "alice");
  const epic = store.createGig("ab", "alice", { title: "epic", type: "epic", spec: a.id });
  store.createGig("ab", "alice", { title: "child", parent: epic.id, labels: ["x", "y"] });
  // A parent that sorts after its child: ab-2's parent becomes ab-3, so rows cannot simply go in id order.
  const late = store.createGig("ab", "alice", { title: "late parent" });
  store.update("ab-2", "alice", { parent: late.id });
  store.createGig("ab", "alice", { title: "blocked", blocked_by: [late.id], discovered_from: epic.id });
  store.addComment(epic.id, "bob", "first");
  store.addComment(epic.id, "carol", "second");
  store.close("ab-2", "alice", "done", true);
  store.claim(late.id, "carol");
  store.createProject("cd");
  store.createGig("cd", "dave", { title: "other", human: true });
  store.createToken("ab", "laptop");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });

/** Deletes every row, children first: the same database becomes an empty target (workerd has one per test). */
function wipe(sql: Sql) {
  sql.transaction(() => {
    sql.run("UPDATE gigs SET parent = NULL");
    for (const t of ["labels", "links", "comments", "tokens", "spec_versions", "gigs", "specs", "projects"]) sql.run(`DELETE FROM ${t}`);
  });
}

function error(fn: () => unknown, code: string, status: number) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect(err).toMatchObject({ code, status });
    return;
  }
  throw new Error(`expected ${code}`);
}

test("export lists every table's rows and the schema version, nothing else", () => {
  const dump = store.exportDump();
  expect(dump.version).toBeGreaterThan(0);
  expect(Object.keys(dump.tables).sort()).toEqual(["comments", "gigs", "labels", "links", "projects", "spec_versions", "specs", "tokens"]);
  expect(dump.tables.projects).toEqual([
    expect.objectContaining({ prefix: "ab", name: "Alpha", next_number: 5, next_spec_number: 2 }),
    expect.objectContaining({ prefix: "cd", next_number: 2 }),
  ]);
  expect(dump.tables.spec_versions).toHaveLength(2);
  expect(dump.tables.comments!.map((c) => c.id)).toEqual([1, 2]);
});

test("round trip: an empty database at the same version gets identical rows", () => {
  const before = store.exportDump();
  const target = onDurableObject ? (wipe(openSql("")), store) : openStore(join(dir, "b.db"));
  try {
    expect(target.importDump(JSON.parse(JSON.stringify(before)))).toEqual({
      version: before.version,
      tables: Object.fromEntries(Object.entries(before.tables).map(([t, rows]) => [t, rows.length])),
    });
    expect(target.exportDump()).toEqual(before);
    // The counters came along: the next gig and spec continue the numbering.
    expect(target.createGig("ab", "x", { title: "next" }).id).toBe("ab-5");
    expect(target.getDetail("ab-1").comments.map((c) => c.body)).toEqual(["first", "second"]);
  } finally {
    if (target !== store) target.dispose();
  }
});

test("import refuses a database that has data, another schema version, or an unknown table", () => {
  const dump = store.exportDump();
  error(() => store.importDump(dump), "conflict", 409);
  wipe(openSql(join(dir, "a.db")));
  error(() => store.importDump({ ...dump, version: dump.version + 1 }), "conflict", 409);
  error(() => store.importDump({ ...dump, tables: { ...dump.tables, nope: [] } }), "bad_request", 400);
  error(() => store.importDump({ version: dump.version } as unknown as Dump), "bad_request", 400);
  // A failed import leaves nothing behind.
  error(() => store.importDump({ ...dump, tables: { ...dump.tables, gigs: [{ id: "zz-1" }] } }), "bad_request", 400);
  expect(store.listProjects()).toEqual([]);
});

// Bun-only: test/do/worker-entry.ts checks the same through the Worker.
bunTest("the endpoints are admin-only", async () => {
  const handle = createHandler(store, { adminToken: "adm1n" });
  const token = store.createToken("cd").token;
  const call = (method: string, path: string, auth: string, body?: unknown) =>
    handle(new Request(`http://gigs${path}`, { method, headers: { Authorization: `Bearer ${auth}`, "X-Gigs-Actor": "a" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  expect((await call("GET", "/admin/export", token)).status).toBe(403);
  expect((await call("POST", "/admin/import", token, {})).status).toBe(403);
  const res = await call("GET", "/admin/export", "adm1n");
  expect(res.status).toBe(200);
  const dump = (await res.json()) as Dump;
  expect(dump.tables.tokens).toHaveLength(2);
  expect((await call("POST", "/admin/import", "adm1n", dump)).status).toBe(409);
});
