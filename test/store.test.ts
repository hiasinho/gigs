import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GigsError, Store } from "../src/store";
import { openSql, openStore } from "./harness";

/** Removes migrations 8, 7, 6, 5 and 4, leaving a v3 database. */
const DROP_MIGRATION_4 =
  "DROP TABLE tokens; ALTER TABLE specs DROP COLUMN state; ALTER TABLE specs DROP COLUMN close_reason; ALTER TABLE specs DROP COLUMN closed_by; ALTER TABLE specs DROP COLUMN closed_at; ALTER TABLE gigs DROP COLUMN human; DROP TABLE labels; DROP TABLE spec_versions; ALTER TABLE specs DROP COLUMN version; DROP INDEX gigs_spec; ALTER TABLE gigs DROP COLUMN spec; ALTER TABLE projects DROP COLUMN next_spec_number; DROP TABLE specs;";

let dir: string;
let store: Store;
let clock: Date;

/** Advances the fake clock by one second per call, so created_at differs between gigs unless frozen. */
const tick = () => (clock = new Date(clock.getTime() + 1000));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-store-"));
  clock = new Date("2026-01-01T00:00:00.000Z");
  store = openStore(join(dir, "gigs.db"), { now: () => clock });
  store.createProject("gig", "Gigs");
});

afterEach(() => {
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function expectError(fn: () => unknown, code: string, status: number) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect((err as GigsError).code).toBe(code);
    expect((err as GigsError).status).toBe(status);
    return err as GigsError;
  }
  throw new Error(`expected ${code} error`);
}

describe("projects", () => {
  test("create, get, list", () => {
    const p = store.createProject("ab1");
    expect(p).toEqual({ prefix: "ab1", name: "ab1", created_at: clock.toISOString() });
    expect(store.getProject("AB1").prefix).toBe("ab1");
    expect(store.listProjects().map((p) => p.prefix)).toEqual(["ab1", "gig"]);
  });

  test("validates prefix and rejects duplicates", () => {
    for (const bad of ["a", "abcd", "1ab", "a-b", "", 42]) expectError(() => store.createProject(bad), "bad_request", 400);
    expectError(() => store.createProject("gig"), "conflict", 409);
    expectError(() => store.getProject("zz"), "not_found", 404);
  });
});

describe("create gig", () => {
  test("numbers gigs per project starting at 1, with defaults", () => {
    store.createProject("xy");
    const a = store.createGig("gig", "alice", { title: "  First  " });
    const b = store.createGig("gig", "alice", { title: "Second" });
    const c = store.createGig("xy", "alice", { title: "Other" });
    expect([a.id, b.id, c.id]).toEqual(["gig-1", "gig-2", "xy-1"]);
    expect(a).toMatchObject({
      project: "gig",
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
    expectError(() => store.createGig("gig", "a", { title: "  " }), "bad_request", 400);
    expectError(() => store.createGig("gig", "a", {}), "bad_request", 400);
    expectError(() => store.createGig("gig", "a", { title: "x", type: "story" }), "bad_request", 400);
    expectError(() => store.createGig("gig", "a", { title: "x", priority: 5 }), "bad_request", 400);
    expectError(() => store.createGig("gig", "a", { title: "x", priority: 1.5 }), "bad_request", 400);
    expectError(() => store.createGig("gig", "a", { title: "x", priority: "1" }), "bad_request", 400);
    expectError(() => store.createGig("gig", "a", { title: "x", description: 3 }), "bad_request", 400);
    expectError(() => store.createGig("gig", " ", { title: "x" }), "bad_request", 400);
    expectError(() => store.createGig("nope", "a", { title: "x" }), "not_found", 404);
    // A failed create does not consume a number.
    expect(store.createGig("gig", "a", { title: "x" }).id).toBe("gig-1");
  });

  test("explicit null is not a default for non-nullable fields", () => {
    for (const input of [{ description: null }, { type: null }, { priority: null }]) {
      expectError(() => store.createGig("gig", "a", { title: "x", ...input }), "bad_request", 400);
    }
    expect(store.createGig("gig", "a", { title: "valid" }).id).toBe("gig-1");
  });

  test("ids are matched case-insensitively", () => {
    store.createGig("gig", "a", { title: "x" });
    expect(store.getGig(" GIG-1 ").id).toBe("gig-1");
    expectError(() => store.getGig("gig-9"), "not_found", 404);
  });
});

describe("list and ready", () => {
  test("list defaults to unfinished; --all, status and type filters", () => {
    store.createGig("gig", "a", { title: "one", type: "bug" });
    store.createGig("gig", "a", { title: "two" });
    store.createGig("gig", "a", { title: "three" });
    store.close("gig-2", "a");
    store.claim("gig-3", "a");
    const ids = (f = {}) => store.listGigs("gig", f).map((b) => b.id);
    expect(ids()).toEqual(["gig-1", "gig-3"]);
    expect(ids({ all: true })).toEqual(["gig-1", "gig-2", "gig-3"]);
    expect(ids({ status: ["closed", "in_progress"] })).toEqual(["gig-2", "gig-3"]);
    expect(ids({ type: "bug" })).toEqual(["gig-1"]);
    expectError(() => store.listGigs("gig", { status: ["blocked"] }), "bad_request", 400);
    expectError(() => store.listGigs("gig", { type: "story" }), "bad_request", 400);
  });

  test("ready lists open gigs by priority, created_at, number", () => {
    store.createGig("gig", "a", { title: "p2 early" }); // gig-1
    tick();
    store.createGig("gig", "a", { title: "p1 late", priority: 1 }); // gig-2
    store.createGig("gig", "a", { title: "p1 same time", priority: 1 }); // gig-3, same created_at as gig-2
    store.createGig("gig", "a", { title: "p0 closed", priority: 0 }); // gig-4
    store.close("gig-4", "a");
    store.createGig("gig", "a", { title: "p0 claimed", priority: 0 }); // gig-5
    store.claim("gig-5", "a");
    expect(store.ready("gig").map((b) => b.id)).toEqual(["gig-2", "gig-3", "gig-1"]);
  });

  test("detail carries readiness", () => {
    store.createGig("gig", "a", { title: "x" });
    expect(store.getDetail("gig-1")).toMatchObject({ gig: { id: "gig-1" }, ready: true, reasons: [] });
    store.claim("gig-1", "a");
    expect(store.getDetail("gig-1").ready).toBe(false);
  });
});

test.each(["children", "blockers", "blocks", "related", "discovered_from", "discovered"] as const)(
  "detail orders %s by project then numeric id",
  (relation) => {
    const center = store.createGig("gig", "a", { title: "Center" });
    for (const project of ["aa", "zz"]) {
      store.createProject(project);
      for (let n = 1; n <= 10; n++) store.createGig(project, "a", { title: `${project} ${n}` });
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
    store.createGig("gig", "a", { title: "x" });
    const claimed = store.claim("gig-1", "alice");
    expect(claimed).toMatchObject({ status: "in_progress", claimed_by: "alice", claimed_at: clock.toISOString(), claim_expires_at: "2026-01-01T01:00:00.000Z" });
    tick();
    expect(store.claim("GIG-1", "alice")).toEqual({ ...claimed, claim_expires_at: "2026-01-01T01:00:01.000Z" });
    const err = expectError(() => store.claim("gig-1", "bob"), "claimed", 409);
    expect(err.message).toBe("gig-1 is already claimed by alice (until 2026-01-01T01:00:01.000Z)");
  });

  test("closed and deferred gigs are not claimable", () => {
    store.createGig("gig", "a", { title: "x" });
    store.close("gig-1", "a");
    expectError(() => store.claim("gig-1", "a"), "not_claimable", 409);
    expectError(() => store.claim("gig-9", "a"), "not_found", 404);
  });

  test("claimNext takes ready gigs in order, then returns null", () => {
    store.createGig("gig", "a", { title: "low", priority: 3 });
    store.createGig("gig", "a", { title: "high", priority: 0 });
    expect(store.claimNext("gig", "alice")?.id).toBe("gig-2");
    expect(store.claimNext("gig", "bob")?.id).toBe("gig-1");
    expect(store.claimNext("gig", "carol")).toBeNull();
    expectError(() => store.claimNext("zz", "a"), "not_found", 404);
  });

  test("unclaim releases; unclaiming an unclaimed gig conflicts", () => {
    store.createGig("gig", "a", { title: "x" });
    store.claim("gig-1", "alice");
    expect(store.unclaim("gig-1", "bob")).toMatchObject({ status: "open", claimed_by: null, claimed_at: null });
    expectError(() => store.unclaim("gig-1", "bob"), "conflict", 409);
  });
});

describe("close and reopen", () => {
  test("close records actor, time and reason, and clears the claim", () => {
    store.createGig("gig", "a", { title: "x" });
    store.claim("gig-1", "alice");
    tick();
    const closed = store.close("gig-1", "bob", " done ");
    expect(closed).toMatchObject({
      status: "closed",
      claimed_by: null,
      claimed_at: null,
      closed_by: "bob",
      closed_at: clock.toISOString(),
      close_reason: "done",
      updated_at: clock.toISOString(),
    });
    expectError(() => store.close("gig-1", "bob"), "conflict", 409);
  });

  test("reopen clears closed fields; reopening an unfinished gig conflicts", () => {
    store.createGig("gig", "a", { title: "x" });
    expectError(() => store.reopen("gig-1"), "conflict", 409);
    store.close("gig-1", "a", "dup");
    expect(store.reopen("gig-1")).toMatchObject({ status: "open", closed_by: null, closed_at: null, close_reason: null });
    expect(store.ready("gig").map((b) => b.id)).toEqual(["gig-1"]);
  });
});

describe("migrations", () => {
  test("upgrades a slice 1 database without losing gigs, claims or numbering", () => {
    const first = store.createGig("gig", "a", { title: "existing" });
    store.claim(first.id, "holder");
    // Reconstruct the exact v1 schema by removing only migration 2's additions.
    const db = openSql(join(dir, "gigs.db"));
    db.exec(DROP_MIGRATION_4);
    db.exec("DROP TABLE comments; ALTER TABLE gigs DROP COLUMN claim_expires_at; ALTER TABLE gigs DROP COLUMN defer_until;");
    db.exec("DROP TABLE links; DROP INDEX gigs_parent; ALTER TABLE gigs DROP COLUMN parent;"); db.setVersion(1);
    db.close();
    const upgraded = openStore(join(dir, "gigs.db"));
    try {
      expect(upgraded.getGig(first.id)).toMatchObject({ title: "existing", parent: null, claimed_by: "holder" });
      const child = upgraded.createGig("gig", "a", { title: "child", parent: first.id });
      expect(child.id).toBe("gig-2");
      expect(upgraded.getDetail(first.id).children[0]?.id).toBe(child.id);
    } finally { upgraded.dispose(); }
  });
  test("set the schema version and survive reopening the database", () => {
    store.createGig("gig", "a", { title: "x" });
    const again = openStore(join(dir, "gigs.db"));
    expect(again.getGig("gig-1").title).toBe("x");
    again.dispose();
    const db = openSql(join(dir, "gigs.db"));
    expect(db.version()).toBe(9);
    db.close();
  });
});

describe("specs", () => {
  const spec = (title = "Agreement", project = "gig") => store.createSpec(project, "alice", { title, text: "We agree." });
  /** Gigs may only point at a ready (or active) spec. */
  const readySpec = (title = "Agreement", project = "gig") => store.readySpec(spec(title, project).id, "alice");

  test("numbered per project with their own counter, case-insensitive ids, listed by number", () => {
    store.createProject("xy");
    store.createGig("gig", "a", { title: "gig" });
    const [a, b, c] = [spec("  First  "), spec("Second"), spec("Other", "xy")];
    expect([a.id, b.id, c.id]).toEqual(["gig-s1", "gig-s2", "xy-s1"]);
    expect(a).toEqual({ id: "gig-s1", project: "gig", title: "First", text: "We agree.", version: 1, state: "draft", status: "draft", close_reason: null, closed_by: null, closed_at: null, created_by: "alice", created_at: clock.toISOString() });
    expect(store.getSpec(" GIG-S2 ")).toEqual(b);
    expect(store.listSpecs("GIG").map((s) => s.id)).toEqual(["gig-s1", "gig-s2"]);
    expect(store.createGig("gig", "a", { title: "next" }).id).toBe("gig-2");
    expectError(() => store.getSpec("gig-s9"), "not_found", 404);
    expectError(() => store.listSpecs("zz"), "not_found", 404);
  });

  test("title and text are required; specs can be edited any time", () => {
    for (const input of [{ text: "x" }, { title: " ", text: "x" }, { title: "t" }, { title: "t", text: "  " }, { title: "t", text: 3 }]) {
      expectError(() => store.createSpec("gig", "a", input), "bad_request", 400);
    }
    expectError(() => store.createSpec("gig", " ", { title: "t", text: "x" }), "bad_request", 400);
    const s = readySpec();
    const gig = store.createGig("gig", "a", { title: "x", spec: s.id });
    store.claim(gig.id, "bob");
    expect(store.updateSpec("GIG-S1", "a", { text: "We agree more." })).toEqual({ ...s, text: "We agree more.", version: 2, status: "active" });
    expect(store.updateSpec(s.id, "a", { title: "  Renamed  " })).toEqual({ ...s, title: "Renamed", text: "We agree more.", version: 3, status: "active" });
    store.close(gig.id, "bob");
    expect(store.updateSpec(s.id, "a", { title: "After", text: "Done." })).toMatchObject({ title: "After", text: "Done." });
    for (const changes of [{}, { title: " " }, { text: "" }, { text: 3 }, { project: "xy" }, { title: "t", created_by: "z" }]) {
      expectError(() => store.updateSpec(s.id, "a", changes as any), "bad_request", 400);
    }
    expectError(() => store.updateSpec(s.id, " ", { title: "t" }), "bad_request", 400);
    expectError(() => store.updateSpec("gig-s9", "a", { title: "t" }), "not_found", 404);
    expect(store.getGig(gig.id).spec).toBe(s.id);
  });

  test("gigs point to a spec of their own project; set on create, change or clear on update, no inheritance", () => {
    store.createProject("xy");
    // other stays a draft: the project mismatch is reported before the lifecycle.
    const [s1, s2, other] = [readySpec(), readySpec(), spec("Other", "xy")];
    const parent = store.createGig("gig", "a", { title: "parent", spec: "GIG-S1" });
    expect(parent.spec).toBe(s1.id);
    expect(store.createGig("gig", "a", { title: "child", parent: parent.id }).spec).toBeNull();
    expect(store.update(parent.id, "a", { spec: s2.id }).spec).toBe(s2.id);
    expect(store.update(parent.id, "a", { spec: null }).spec).toBeNull();
    expectError(() => store.createGig("gig", "a", { title: "x", spec: other.id }), "bad_request", 400);
    expectError(() => store.update(parent.id, "a", { spec: other.id }), "bad_request", 400);
    expectError(() => store.createGig("gig", "a", { title: "x", spec: "gig-s9" }), "not_found", 404);
    expectError(() => store.createGig("gig", "a", { title: "x", spec: 7 }), "bad_request", 400);
    expectError(() => store.listGigs("gig", { spec: other.id }), "bad_request", 400);
    expectError(() => store.ready("gig", "gig-s9"), "not_found", 404);
  });

  test("spec filters reuse readiness: a blocker outside the spec still blocks", () => {
    const s = readySpec();
    const outside = store.createGig("gig", "a", { title: "outside", priority: 0 });
    const blocked = store.createGig("gig", "a", { title: "blocked", spec: s.id, priority: 0, blocked_by: [outside.id] });
    const free = store.createGig("gig", "a", { title: "free", spec: s.id });
    const done = store.createGig("gig", "a", { title: "done", spec: s.id });
    store.close(done.id, "a");
    expect(store.ready("gig", s.id).map((b) => b.id)).toEqual([free.id]);
    expect(store.ready("gig").map((b) => b.id)).toEqual([outside.id, free.id]);
    expect(store.blocked("gig", s.id)).toEqual([{ gig: store.getGig(blocked.id), reasons: [{ kind: "blocker", id: outside.id }] }]);
    expect(store.listGigs("gig", { spec: s.id }).map((b) => b.id)).toEqual([blocked.id, free.id]);
    expect(store.listGigs("gig", { spec: s.id, all: true }).map((b) => b.id)).toEqual([blocked.id, free.id, done.id]);
    store.close(outside.id, "a");
    expect(store.ready("gig", s.id).map((b) => b.id)).toEqual([blocked.id, free.id]);
  });

  test("claimNext within a spec skips other specs and standalone gigs", () => {
    const [s1, s2] = [readySpec(), readySpec()];
    store.createGig("gig", "a", { title: "standalone", priority: 0 });
    store.createGig("gig", "a", { title: "other spec", priority: 0, spec: s2.id });
    const mine = store.createGig("gig", "a", { title: "mine", priority: 3, spec: s1.id });
    expect(store.claimNext("gig", "alice", s1.id)).toMatchObject({ id: mine.id, status: "in_progress", claimed_by: "alice" });
    expect(store.claimNext("gig", "alice", s1.id)).toBeNull();
    expect(store.claimNext("gig", "alice")?.title).toBe("standalone");
  });
});

describe("migration 4", () => {
  test("upgrades a v3 database: gigs keep their data, gain a null spec, and specs start at s1", () => {
    const first = store.createGig("gig", "a", { title: "existing" });
    store.claim(first.id, "holder");
    store.dispose();
    const db = openSql(join(dir, "gigs.db"));
    db.exec(DROP_MIGRATION_4); db.setVersion(3);
    db.close();
    store = openStore(join(dir, "gigs.db"), { now: () => clock });
    expect(store.getGig(first.id)).toMatchObject({ title: "existing", claimed_by: "holder", spec: null });
    const s = store.readySpec(store.createSpec("gig", "a", { title: "Agreement", text: "text" }).id, "a");
    expect(s.id).toBe("gig-s1");
    expect(store.createGig("gig", "a", { title: "within", spec: s.id })).toMatchObject({ id: "gig-2", spec: s.id });
  });
});
