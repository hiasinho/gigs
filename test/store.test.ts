import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BoonsError, Store } from "../src/store";

let dir: string;
let store: Store;
let clock: Date;

/** Advances the fake clock by one second per call, so created_at differs between boons unless frozen. */
const tick = () => (clock = new Date(clock.getTime() + 1000));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boons-store-"));
  clock = new Date("2026-01-01T00:00:00.000Z");
  store = new Store({ path: join(dir, "boons.db"), now: () => clock });
  store.createProject("bn", "Boons");
});

afterEach(() => {
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function expectError(fn: () => unknown, code: string, status: number) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BoonsError);
    expect((err as BoonsError).code).toBe(code);
    expect((err as BoonsError).status).toBe(status);
    return err as BoonsError;
  }
  throw new Error(`expected ${code} error`);
}

describe("projects", () => {
  test("create, get, list", () => {
    const p = store.createProject("ab1");
    expect(p).toEqual({ prefix: "ab1", name: "ab1", created_at: clock.toISOString() });
    expect(store.getProject("AB1").prefix).toBe("ab1");
    expect(store.listProjects().map((p) => p.prefix)).toEqual(["ab1", "bn"]);
  });

  test("validates prefix and rejects duplicates", () => {
    for (const bad of ["a", "abcd", "1ab", "a-b", "", 42]) expectError(() => store.createProject(bad), "bad_request", 400);
    expectError(() => store.createProject("bn"), "conflict", 409);
    expectError(() => store.getProject("zz"), "not_found", 404);
  });
});

describe("create boon", () => {
  test("numbers boons per project starting at 1, with defaults", () => {
    store.createProject("xy");
    const a = store.createBoon("bn", "alice", { title: "  First  " });
    const b = store.createBoon("bn", "alice", { title: "Second" });
    const c = store.createBoon("xy", "alice", { title: "Other" });
    expect([a.id, b.id, c.id]).toEqual(["bn-1", "bn-2", "xy-1"]);
    expect(a).toMatchObject({
      project: "bn",
      title: "First",
      description: "",
      type: "task",
      priority: 2,
      status: "open",
      claimed_by: null,
      created_by: "alice",
    });
  });

  test("validates input", () => {
    expectError(() => store.createBoon("bn", "a", { title: "  " }), "bad_request", 400);
    expectError(() => store.createBoon("bn", "a", {}), "bad_request", 400);
    expectError(() => store.createBoon("bn", "a", { title: "x", type: "story" }), "bad_request", 400);
    expectError(() => store.createBoon("bn", "a", { title: "x", priority: 5 }), "bad_request", 400);
    expectError(() => store.createBoon("bn", "a", { title: "x", priority: 1.5 }), "bad_request", 400);
    expectError(() => store.createBoon("bn", "a", { title: "x", priority: "1" }), "bad_request", 400);
    expectError(() => store.createBoon("bn", "a", { title: "x", description: 3 }), "bad_request", 400);
    expectError(() => store.createBoon("bn", " ", { title: "x" }), "bad_request", 400);
    expectError(() => store.createBoon("nope", "a", { title: "x" }), "not_found", 404);
    // A failed create does not consume a number.
    expect(store.createBoon("bn", "a", { title: "x" }).id).toBe("bn-1");
  });

  test("ids are matched case-insensitively", () => {
    store.createBoon("bn", "a", { title: "x" });
    expect(store.getBoon(" BN-1 ").id).toBe("bn-1");
    expectError(() => store.getBoon("bn-9"), "not_found", 404);
  });
});

describe("list and ready", () => {
  test("list defaults to unfinished; --all, status and type filters", () => {
    store.createBoon("bn", "a", { title: "one", type: "bug" });
    store.createBoon("bn", "a", { title: "two" });
    store.createBoon("bn", "a", { title: "three" });
    store.close("bn-2", "a");
    store.claim("bn-3", "a");
    const ids = (f = {}) => store.listBoons("bn", f).map((b) => b.id);
    expect(ids()).toEqual(["bn-1", "bn-3"]);
    expect(ids({ all: true })).toEqual(["bn-1", "bn-2", "bn-3"]);
    expect(ids({ status: ["closed", "in_progress"] })).toEqual(["bn-2", "bn-3"]);
    expect(ids({ type: "bug" })).toEqual(["bn-1"]);
    expectError(() => store.listBoons("bn", { status: ["blocked"] }), "bad_request", 400);
    expectError(() => store.listBoons("bn", { type: "story" }), "bad_request", 400);
  });

  test("ready lists open boons by priority, created_at, number", () => {
    store.createBoon("bn", "a", { title: "p2 early" }); // bn-1
    tick();
    store.createBoon("bn", "a", { title: "p1 late", priority: 1 }); // bn-2
    store.createBoon("bn", "a", { title: "p1 same time", priority: 1 }); // bn-3, same created_at as bn-2
    store.createBoon("bn", "a", { title: "p0 closed", priority: 0 }); // bn-4
    store.close("bn-4", "a");
    store.createBoon("bn", "a", { title: "p0 claimed", priority: 0 }); // bn-5
    store.claim("bn-5", "a");
    expect(store.ready("bn").map((b) => b.id)).toEqual(["bn-2", "bn-3", "bn-1"]);
  });

  test("detail carries readiness", () => {
    store.createBoon("bn", "a", { title: "x" });
    expect(store.getDetail("bn-1")).toMatchObject({ boon: { id: "bn-1" }, ready: true, reasons: [] });
    store.claim("bn-1", "a");
    expect(store.getDetail("bn-1").ready).toBe(false);
  });
});

test.each(["children", "blockers", "blocks", "related", "discovered_from", "discovered"] as const)(
  "detail orders %s by project then numeric id",
  (relation) => {
    const center = store.createBoon("bn", "a", { title: "Center" });
    for (const project of ["aa", "zz"]) {
      store.createProject(project);
      for (let n = 1; n <= 10; n++) store.createBoon(project, "a", { title: `${project} ${n}` });
    }
    // Insert out of order, including both directions of symmetric related links.
    const ids = ["zz-10", "aa-10", "zz-2", "aa-2"];
    for (const [index, id] of ids.entries()) {
      switch (relation) {
        case "children": store.update(id, "a", { parent: center.id }); break;
        case "blockers": store.addLink(center.id, id, "blocks", "a"); break;
        case "blocks": store.addLink(id, center.id, "blocks", "a"); break;
        case "related":
          store.addLink(index % 2 ? id : center.id, index % 2 ? center.id : id, "related", "a");
          break;
        case "discovered_from": store.addLink(center.id, id, "discovered-from", "a"); break;
        case "discovered": store.addLink(id, center.id, "discovered-from", "a"); break;
      }
    }
    expect(store.getDetail(center.id)[relation].map((b) => b.id)).toEqual(["aa-2", "aa-10", "zz-2", "zz-10"]);
  },
);

describe("claims", () => {
  test("claim sets holder; same actor re-claim renews; others conflict", () => {
    store.createBoon("bn", "a", { title: "x" });
    const claimed = store.claim("bn-1", "alice");
    expect(claimed).toMatchObject({ status: "in_progress", claimed_by: "alice", claimed_at: clock.toISOString(), claim_expires_at: "2026-01-01T01:00:00.000Z" });
    tick();
    expect(store.claim("BN-1", "alice")).toEqual({ ...claimed, claim_expires_at: "2026-01-01T01:00:01.000Z" });
    const err = expectError(() => store.claim("bn-1", "bob"), "claimed", 409);
    expect(err.message).toBe("bn-1 is already claimed by alice (until 2026-01-01T01:00:01.000Z)");
  });

  test("closed and deferred boons are not claimable", () => {
    store.createBoon("bn", "a", { title: "x" });
    store.close("bn-1", "a");
    expectError(() => store.claim("bn-1", "a"), "not_claimable", 409);
    expectError(() => store.claim("bn-9", "a"), "not_found", 404);
  });

  test("claimNext takes ready boons in order, then returns null", () => {
    store.createBoon("bn", "a", { title: "low", priority: 3 });
    store.createBoon("bn", "a", { title: "high", priority: 0 });
    expect(store.claimNext("bn", "alice")?.id).toBe("bn-2");
    expect(store.claimNext("bn", "bob")?.id).toBe("bn-1");
    expect(store.claimNext("bn", "carol")).toBeNull();
    expectError(() => store.claimNext("zz", "a"), "not_found", 404);
  });

  test("unclaim releases; unclaiming an unclaimed boon conflicts", () => {
    store.createBoon("bn", "a", { title: "x" });
    store.claim("bn-1", "alice");
    expect(store.unclaim("bn-1", "bob")).toMatchObject({ status: "open", claimed_by: null, claimed_at: null });
    expectError(() => store.unclaim("bn-1", "bob"), "conflict", 409);
  });
});

describe("close and reopen", () => {
  test("close records actor, time and reason, and clears the claim", () => {
    store.createBoon("bn", "a", { title: "x" });
    store.claim("bn-1", "alice");
    tick();
    const closed = store.close("bn-1", "bob", " done ");
    expect(closed).toMatchObject({
      status: "closed",
      claimed_by: null,
      claimed_at: null,
      closed_by: "bob",
      closed_at: clock.toISOString(),
      close_reason: "done",
      updated_at: clock.toISOString(),
    });
    expectError(() => store.close("bn-1", "bob"), "conflict", 409);
  });

  test("reopen clears closed fields; reopening an unfinished boon conflicts", () => {
    store.createBoon("bn", "a", { title: "x" });
    expectError(() => store.reopen("bn-1"), "conflict", 409);
    store.close("bn-1", "a", "dup");
    expect(store.reopen("bn-1")).toMatchObject({ status: "open", closed_by: null, closed_at: null, close_reason: null });
    expect(store.ready("bn").map((b) => b.id)).toEqual(["bn-1"]);
  });
});

describe("migrations", () => {
  test("upgrades a slice 1 database without losing boons, claims or numbering", () => {
    const first = store.createBoon("bn", "a", { title: "existing" });
    store.claim(first.id, "holder");
    // Reconstruct the exact v1 schema by removing only migration 2's additions.
    const db = new Database(join(dir, "boons.db"));
    db.run("DROP TABLE comments; ALTER TABLE boons DROP COLUMN claim_expires_at; ALTER TABLE boons DROP COLUMN defer_until;");
    db.run("DROP TABLE links; DROP INDEX boons_parent; ALTER TABLE boons DROP COLUMN parent; PRAGMA user_version = 1;");
    db.close();
    const upgraded = new Store({ path: join(dir, "boons.db") });
    try {
      expect(upgraded.getBoon(first.id)).toMatchObject({ title: "existing", parent: null, claimed_by: "holder" });
      const child = upgraded.createBoon("bn", "a", { title: "child", parent: first.id });
      expect(child.id).toBe("bn-2");
      expect(upgraded.getDetail(first.id).children[0]?.id).toBe(child.id);
    } finally { upgraded.dispose(); }
  });
  test("set user_version and survive reopening the database", () => {
    store.createBoon("bn", "a", { title: "x" });
    const again = new Store({ path: join(dir, "boons.db") });
    expect(again.getBoon("bn-1").title).toBe("x");
    again.dispose();
    const db = new Database(join(dir, "boons.db"));
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    db.close();
  });
});
