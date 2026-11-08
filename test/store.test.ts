import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BoonsError, Store } from "../src/store";

/** Removes migrations 5 and 4, leaving a v3 database. */
const DROP_MIGRATION_4 =
  "DROP TABLE spec_versions; ALTER TABLE specs DROP COLUMN version; DROP INDEX boons_spec; ALTER TABLE boons DROP COLUMN spec; ALTER TABLE projects DROP COLUMN next_spec_number; DROP TABLE specs;";

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

  test("explicit null is not a default for non-nullable fields", () => {
    for (const input of [{ description: null }, { type: null }, { priority: null }]) {
      expectError(() => store.createBoon("bn", "a", { title: "x", ...input }), "bad_request", 400);
    }
    expect(store.createBoon("bn", "a", { title: "valid" }).id).toBe("bn-1");
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
    db.run(DROP_MIGRATION_4);
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
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    db.close();
  });
});

describe("specs", () => {
  const spec = (title = "Agreement", project = "bn") => store.createSpec(project, "alice", { title, text: "We agree." });

  test("numbered per project with their own counter, case-insensitive ids, listed by number", () => {
    store.createProject("xy");
    store.createBoon("bn", "a", { title: "boon" });
    const [a, b, c] = [spec("  First  "), spec("Second"), spec("Other", "xy")];
    expect([a.id, b.id, c.id]).toEqual(["bn-s1", "bn-s2", "xy-s1"]);
    expect(a).toEqual({ id: "bn-s1", project: "bn", title: "First", text: "We agree.", version: 1, created_by: "alice", created_at: clock.toISOString() });
    expect(store.getSpec(" BN-S2 ")).toEqual(b);
    expect(store.listSpecs("BN").map((s) => s.id)).toEqual(["bn-s1", "bn-s2"]);
    expect(store.createBoon("bn", "a", { title: "next" }).id).toBe("bn-2");
    expectError(() => store.getSpec("bn-s9"), "not_found", 404);
    expectError(() => store.listSpecs("zz"), "not_found", 404);
  });

  test("title and text are required; specs can be edited any time", () => {
    for (const input of [{ text: "x" }, { title: " ", text: "x" }, { title: "t" }, { title: "t", text: "  " }, { title: "t", text: 3 }]) {
      expectError(() => store.createSpec("bn", "a", input), "bad_request", 400);
    }
    expectError(() => store.createSpec("bn", " ", { title: "t", text: "x" }), "bad_request", 400);
    const s = spec();
    const boon = store.createBoon("bn", "a", { title: "x", spec: s.id });
    store.claim(boon.id, "bob");
    expect(store.updateSpec("BN-S1", "a", { text: "We agree more." })).toEqual({ ...s, text: "We agree more.", version: 2 });
    expect(store.updateSpec(s.id, "a", { title: "  Renamed  " })).toEqual({ ...s, title: "Renamed", text: "We agree more.", version: 3 });
    store.close(boon.id, "bob");
    expect(store.updateSpec(s.id, "a", { title: "After", text: "Done." })).toMatchObject({ title: "After", text: "Done." });
    for (const changes of [{}, { title: " " }, { text: "" }, { text: 3 }, { project: "xy" }, { title: "t", created_by: "z" }]) {
      expectError(() => store.updateSpec(s.id, "a", changes as any), "bad_request", 400);
    }
    expectError(() => store.updateSpec(s.id, " ", { title: "t" }), "bad_request", 400);
    expectError(() => store.updateSpec("bn-s9", "a", { title: "t" }), "not_found", 404);
    expect(store.getBoon(boon.id).spec).toBe(s.id);
  });

  test("boons point to a spec of their own project; set on create, change or clear on update, no inheritance", () => {
    store.createProject("xy");
    const [s1, s2, other] = [spec(), spec(), spec("Other", "xy")];
    const parent = store.createBoon("bn", "a", { title: "parent", spec: "BN-S1" });
    expect(parent.spec).toBe(s1.id);
    expect(store.createBoon("bn", "a", { title: "child", parent: parent.id }).spec).toBeNull();
    expect(store.update(parent.id, "a", { spec: s2.id }).spec).toBe(s2.id);
    expect(store.update(parent.id, "a", { spec: null }).spec).toBeNull();
    expectError(() => store.createBoon("bn", "a", { title: "x", spec: other.id }), "bad_request", 400);
    expectError(() => store.update(parent.id, "a", { spec: other.id }), "bad_request", 400);
    expectError(() => store.createBoon("bn", "a", { title: "x", spec: "bn-s9" }), "not_found", 404);
    expectError(() => store.createBoon("bn", "a", { title: "x", spec: 7 }), "bad_request", 400);
    expectError(() => store.listBoons("bn", { spec: other.id }), "bad_request", 400);
    expectError(() => store.ready("bn", "bn-s9"), "not_found", 404);
  });

  test("spec filters reuse readiness: a blocker outside the spec still blocks", () => {
    const s = spec();
    const outside = store.createBoon("bn", "a", { title: "outside", priority: 0 });
    const blocked = store.createBoon("bn", "a", { title: "blocked", spec: s.id, priority: 0, blocked_by: [outside.id] });
    const free = store.createBoon("bn", "a", { title: "free", spec: s.id });
    const done = store.createBoon("bn", "a", { title: "done", spec: s.id });
    store.close(done.id, "a");
    expect(store.ready("bn", s.id).map((b) => b.id)).toEqual([free.id]);
    expect(store.ready("bn").map((b) => b.id)).toEqual([outside.id, free.id]);
    expect(store.blocked("bn", s.id)).toEqual([{ boon: store.getBoon(blocked.id), reasons: [{ kind: "blocker", id: outside.id }] }]);
    expect(store.listBoons("bn", { spec: s.id }).map((b) => b.id)).toEqual([blocked.id, free.id]);
    expect(store.listBoons("bn", { spec: s.id, all: true }).map((b) => b.id)).toEqual([blocked.id, free.id, done.id]);
    store.close(outside.id, "a");
    expect(store.ready("bn", s.id).map((b) => b.id)).toEqual([blocked.id, free.id]);
  });

  test("claimNext within a spec skips other specs and standalone boons", () => {
    const [s1, s2] = [spec(), spec()];
    store.createBoon("bn", "a", { title: "standalone", priority: 0 });
    store.createBoon("bn", "a", { title: "other spec", priority: 0, spec: s2.id });
    const mine = store.createBoon("bn", "a", { title: "mine", priority: 3, spec: s1.id });
    expect(store.claimNext("bn", "alice", s1.id)).toMatchObject({ id: mine.id, status: "in_progress", claimed_by: "alice" });
    expect(store.claimNext("bn", "alice", s1.id)).toBeNull();
    expect(store.claimNext("bn", "alice")?.title).toBe("standalone");
  });
});

describe("migration 4", () => {
  test("upgrades a v3 database: boons keep their data, gain a null spec, and specs start at s1", () => {
    const first = store.createBoon("bn", "a", { title: "existing" });
    store.claim(first.id, "holder");
    store.dispose();
    const db = new Database(join(dir, "boons.db"));
    db.run(DROP_MIGRATION_4 + " PRAGMA user_version = 3;");
    db.close();
    store = new Store({ path: join(dir, "boons.db"), now: () => clock });
    expect(store.getBoon(first.id)).toMatchObject({ title: "existing", claimed_by: "holder", spec: null });
    const s = store.createSpec("bn", "a", { title: "Agreement", text: "text" });
    expect(s.id).toBe("bn-s1");
    expect(store.createBoon("bn", "a", { title: "within", spec: s.id })).toMatchObject({ id: "bn-2", spec: s.id });
  });
});
