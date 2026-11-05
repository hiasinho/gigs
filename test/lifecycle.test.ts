import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoonsError, Store } from "../src/store";

// Claim expiry, renewal, heartbeat, defer/undefer, update and comments, all on a fake clock.

let dir: string;
let path: string;
let store: Store;
let clock: Date;
const T0 = "2026-01-01T00:00:00.000Z";
const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));
const at = (offsetMinutes: number) => new Date(Date.parse(T0) + offsetMinutes * 60_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boons-lifecycle-"));
  path = join(dir, "boons.db");
  clock = new Date(T0);
  store = new Store({ path, now: () => clock, claimTtlMinutes: 30 });
  store.createProject("bn");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });

const create = (title: string, input = {}) => store.createBoon("bn", "a", { title, ...input });
const readyIds = () => store.ready("bn").map((b) => b.id);
function error(fn: () => unknown, code: string, status = 409) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(BoonsError);
    expect(err).toMatchObject({ code, status });
    return err as BoonsError;
  }
  throw new Error(`expected ${code}`);
}

describe("claim expiry", () => {
  test("a lapsed claim returns the boon to ready and lets another actor claim it", () => {
    const { id } = create("x");
    expect(store.claim(id, "alice").claim_expires_at).toBe(at(30));
    minutes(29);
    expect(readyIds()).toEqual([]);
    error(() => store.claim(id, "bob"), "claimed");
    minutes(1);
    expect(store.getBoon(id)).toMatchObject({ status: "open", claimed_by: null, claimed_at: null, claim_expires_at: null, updated_at: at(30) });
    expect(readyIds()).toEqual([id]);
    expect(store.claim(id, "bob")).toMatchObject({ claimed_by: "bob", claimed_at: at(30), claim_expires_at: at(60) });
  });

  test("claimNext also sees lapsed claims", () => {
    create("x");
    store.claimNext("bn", "alice");
    expect(store.claimNext("bn", "bob")).toBeNull();
    minutes(30);
    expect(store.claimNext("bn", "bob")).toMatchObject({ claimed_by: "bob" });
  });

  test("holder activity renews the claim; another actor's activity does not", () => {
    const { id } = create("x");
    const other = create("other");
    store.claim(id, "alice");
    const expires = () => store.getBoon(id).claim_expires_at;
    minutes(10);
    store.update(id, "alice", { title: "renamed" });
    expect(expires()).toBe(at(40));
    minutes(10);
    store.addComment(id, "alice", "progress");
    expect(expires()).toBe(at(50));
    minutes(10);
    store.addLink(id, other.id, "related", "alice");
    expect(expires()).toBe(at(60));
    minutes(10);
    store.removeLink(id, other.id, "related", "alice");
    expect(expires()).toBe(at(70));
    minutes(10);
    store.update(id, "bob", { priority: 0 });
    store.addComment(id, "bob", "drive-by");
    store.addLink(id, other.id, "related", "bob");
    expect(expires()).toBe(at(70));
    // Linking from another boon is not activity on this one.
    minutes(10);
    store.addLink(other.id, id, "discovered-from", "alice");
    expect(expires()).toBe(at(70));
    minutes(10);
    expect(store.getBoon(id).status).toBe("open");
  });

  test("heartbeat renews for the holder only", () => {
    const { id } = create("x");
    error(() => store.heartbeat(id, "alice"), "conflict");
    store.claim(id, "alice");
    minutes(20);
    const beat = store.heartbeat(id, "alice");
    expect(beat).toMatchObject({ claimed_by: "alice", claimed_at: T0, claim_expires_at: at(50) });
    const err = error(() => store.heartbeat(id, "bob"), "claimed");
    expect(err.message).toBe(`${id} is already claimed by alice (until ${at(50)})`);
    minutes(30);
    error(() => store.heartbeat(id, "alice"), "conflict");
  });

  test("unclaim and close clear the expiry", () => {
    const a = create("a");
    const b = create("b");
    store.claim(a.id, "alice");
    store.claim(b.id, "alice");
    expect(store.unclaim(a.id, "bob").claim_expires_at).toBeNull();
    expect(store.close(b.id, "alice").claim_expires_at).toBeNull();
  });

  test("the claim TTL must be positive, finite and representable", () => {
    for (const claimTtlMinutes of [0, Infinity, 1e300, 1e10]) {
      expect(() => new Store({ path, claimTtlMinutes })).toThrow();
    }
  });
});

describe("defer", () => {
  test("defer without until lasts until undefer; deferred boons are not ready or claimable", () => {
    const { id } = create("x");
    expect(store.defer(id, "a")).toMatchObject({ status: "deferred", defer_until: null });
    expect(readyIds()).toEqual([]);
    error(() => store.claim(id, "a"), "not_claimable");
    minutes(60 * 24 * 365);
    expect(store.getBoon(id).status).toBe("deferred");
    expect(store.undefer(id, "a")).toMatchObject({ status: "open", defer_until: null });
    error(() => store.undefer(id, "a"), "conflict");
    expect(readyIds()).toEqual([id]);
  });

  test("defer until wakes up once the time has passed", () => {
    const { id } = create("x");
    expect(store.defer(id, "a", "2026-01-01T02:00:00+01:00").defer_until).toBe(at(60));
    minutes(59);
    expect(readyIds()).toEqual([]);
    minutes(1);
    expect(store.getBoon(id)).toMatchObject({ status: "open", defer_until: null, updated_at: at(60) });
    expect(readyIds()).toEqual([id]);
  });

  test("defer clears the claim; re-deferring changes the time", () => {
    const { id } = create("x");
    store.claim(id, "alice");
    expect(store.defer(id, "bob", at(10))).toMatchObject({ status: "deferred", claimed_by: null, claimed_at: null, claim_expires_at: null });
    expect(store.defer(id, "bob", at(20)).defer_until).toBe(at(20));
  });

  test("defer validates until and refuses closed boons", () => {
    const { id } = create("x");
    for (const bad of ["soon", T0, at(-1), 42, "+100000-01-01T00:00:00Z"]) error(() => store.defer(id, "a", bad), "bad_request", 400);
    store.close(id, "a");
    error(() => store.defer(id, "a"), "conflict");
  });

  test("until requires an ISO timestamp with a valid calendar date", () => {
    const { id } = create("x");
    for (const bad of ["2999", "January 1, 2999", "2999-02-30T00:00:00Z"]) {
      error(() => store.defer(id, "a", bad), "bad_request", 400);
    }
    expect(store.getBoon(id).status).toBe("open");
    expect(store.defer(id, "a", "2028-02-29T12:30:00+02:30").defer_until).toBe("2028-02-29T10:00:00.000Z");
  });

  test("claimNext wakes deferred ancestors and descendants in the same operation", () => {
    const root = create("root", { priority: 0 });
    const mid = create("mid", { parent: root.id });
    const leaf = create("leaf", { parent: mid.id });
    store.defer(root.id, "a", at(5));
    store.defer(leaf.id, "a", at(5));
    expect(store.claimNext("bn", "worker")).toBeNull();
    minutes(5);
    expect(store.claimNext("bn", "worker")).toMatchObject({ id: leaf.id, status: "in_progress", defer_until: null });
    expect(store.getBoon(root.id)).toMatchObject({ status: "open", defer_until: null });
  });

  test("a deferred parent keeps its descendants from being ready until it wakes", () => {
    const parent = create("parent");
    const child = create("child", { parent: parent.id });
    store.defer(parent.id, "a", at(5));
    expect(readyIds()).toEqual([]);
    expect(store.getDetail(child.id).reasons).toEqual([{ kind: "deferred_ancestor", id: parent.id }]);
    minutes(5);
    expect(readyIds()).toEqual([child.id]);
  });
});

describe("update", () => {
  test("changes only the given fields and validates like create", () => {
    const { id } = create("x", { description: "keep" });
    minutes(1);
    const updated = store.update(id, "a", { title: "  new  ", type: "bug", priority: 0 });
    expect(updated).toMatchObject({ title: "new", description: "keep", type: "bug", priority: 0, updated_at: at(1) });
    expect(store.update(id, "a", { description: "" }).description).toBe("");
    for (const bad of [{ title: " " }, { type: "story" }, { priority: 5 }, { priority: "1" }, { description: 3 }, {}, { status: "closed" }, { title: "x", claimed_by: "me" }]) {
      error(() => store.update(id, "a", bad), "bad_request", 400);
    }
    error(() => store.update(id, "a", { parent: "bn-99" }), "not_found", 404);
    error(() => store.update("bn-99", "a", { title: "y" }), "not_found", 404);
    expect(store.getBoon(id).title).toBe("new");
  });

  test("sets and clears the parent, rejecting cycles", () => {
    const a = create("a");
    const b = create("b", { parent: a.id });
    const c = create("c");
    expect(store.update(c.id, "x", { parent: b.id }).parent).toBe(b.id);
    error(() => store.update(a.id, "x", { parent: c.id }), "cycle");
    error(() => store.update(a.id, "x", { parent: a.id }), "cycle");
    // c inherits a's blocker; making that blocker a child of c would close a wait cycle.
    const blocker = create("blocker");
    store.addLink(a.id, blocker.id, "blocks", "x");
    error(() => store.update(blocker.id, "x", { parent: c.id }), "cycle");
    expect(store.getBoon(blocker.id).parent).toBeNull();
    expect(store.update(c.id, "x", { parent: null }).parent).toBeNull();
  });
});

describe("comments", () => {
  test("are trimmed, validated and listed oldest first in the detail", () => {
    const { id } = create("x");
    expect(store.addComment(id, "alice", "  first  ")).toEqual({ id: 1, boon_id: id, author: "alice", body: "first", created_at: T0 });
    minutes(1);
    store.addComment(id, "bob", "second\nline");
    expect(store.getDetail(id).comments.map((c) => [c.author, c.body, c.created_at])).toEqual([
      ["alice", "first", T0], ["bob", "second\nline", at(1)],
    ]);
    error(() => store.addComment(id, "a", "  "), "bad_request", 400);
    error(() => store.addComment(id, "a", 7), "bad_request", 400);
    error(() => store.addComment("bn-99", "a", "x"), "not_found", 404);
    expect(store.getBoon(id).updated_at).toBe(at(1));
  });
});

describe("migration 3", () => {
  test("claims from a slice 2 database get a full TTL from the upgrade, then lapse", () => {
    const held = create("held");
    store.claim(held.id, "holder");
    store.addComment(held.id, "holder", "gone after downgrade");
    store.dispose();
    const db = new Database(path);
    db.run("DROP TABLE comments; ALTER TABLE boons DROP COLUMN claim_expires_at; ALTER TABLE boons DROP COLUMN defer_until; PRAGMA user_version = 2;");
    db.close();
    minutes(120);
    store = new Store({ path, now: () => clock, claimTtlMinutes: 30 });
    expect(store.getBoon(held.id)).toMatchObject({ status: "in_progress", claimed_by: "holder", claimed_at: T0, claim_expires_at: at(150), defer_until: null });
    expect(store.getDetail(held.id).comments).toEqual([]);
    minutes(30);
    expect(store.getBoon(held.id).status).toBe("open");
  });
});
