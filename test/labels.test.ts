import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GigsError, Store } from "../src/store";

// Labels: free-form, inert markers on gigs, on a fake clock.

let dir: string;
let path: string;
let store: Store;
let clock: Date;
const T0 = "2026-01-01T00:00:00.000Z";
const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));
const at = (offsetMinutes: number) => new Date(Date.parse(T0) + offsetMinutes * 60_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-labels-"));
  path = join(dir, "gigs.db");
  clock = new Date(T0);
  store = new Store({ path, now: () => clock, claimTtlMinutes: 30 });
  store.createProject("gig");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });

const create = (title: string, input = {}) => store.createGig("gig", "a", { title, ...input });
const label = (id: string, add: string[], remove: string[] = [], actor = "a") => store.update(id, actor, { add_labels: add, remove_labels: remove });
const ids = (gigs: { id: string }[]) => gigs.map((b) => b.id);
function error(fn: () => unknown, code = "bad_request", status = 400) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect(err).toMatchObject({ code, status });
    return err as GigsError;
  }
  throw new Error(`expected ${code}`);
}

describe("labels", () => {
  test("format is strict: lowercase, no spaces, a letter or digit first, at most 50 characters", () => {
    const { id } = create("x");
    for (const good of ["wontfix", "needs-triage", "triage:needs-info", "v1.2", "a_b", "0day", "x".repeat(50)]) {
      expect(label(id, [good]).labels).toContain(good);
    }
    for (const bad of ["", "Wontfix", "needs triage", "-x", ":x", ".x", "x/y", "ü", "x".repeat(51), 7, null]) {
      const err = error(() => label(id, [bad as string]));
      expect(err.message).toContain("invalid label");
    }
    error(() => store.update(id, "a", { add_labels: "wontfix" }));
    error(() => create("y", { labels: "wontfix" }));
    error(() => create("y", { labels: ["Bad"] }));
    error(() => store.listGigs("gig", { label: ["Bad"] }));
    error(() => store.ready("gig", undefined, { exclude_label: ["a b"] }));
  });

  test("set on create; add and remove in one call; repeats and missing labels are no-ops", () => {
    const gig = create("x", { labels: ["b", "a", "b"] });
    expect(gig.labels).toEqual(["a", "b"]);
    expect(create("plain").labels).toEqual([]);
    expect(label(gig.id, ["c", "a"], ["b", "missing"]).labels).toEqual(["a", "c"]);
    expect(label(gig.id, ["a"]).labels).toEqual(["a", "c"]);
    expect(label(gig.id, [], ["missing"]).labels).toEqual(["a", "c"]);
    expect(store.update(gig.id, "a", { remove_labels: ["a", "c"] }).labels).toEqual([]);
    // Labels alone are a valid update; adding and removing the same label is not.
    error(() => label(gig.id, ["a"], ["a"]));
    expect(store.getGig(gig.id).labels).toEqual([]);
    error(() => label("gig-99", ["a"]), "not_found", 404);
  });

  test("appear on gigs, details and the whole graph, and work on closed and deferred gigs", () => {
    const parent = create("parent", { labels: ["epic-ish"] });
    const child = create("child", { parent: parent.id });
    store.close(child.id, "a", "duplicate");
    expect(label(child.id, ["wontfix", "duplicate"])).toMatchObject({ status: "closed", labels: ["duplicate", "wontfix"] });
    store.defer(parent.id, "a");
    expect(label(parent.id, ["later"])).toMatchObject({ status: "deferred", labels: ["epic-ish", "later"] });
    expect(store.getDetail(child.id).gig.labels).toEqual(["duplicate", "wontfix"]);
    expect(store.listGigs("gig", { all: true }).map((b) => b.labels)).toEqual([["epic-ish", "later"], ["duplicate", "wontfix"]]);
  });

  test("filter list and ready by presence (all must be present) and absence (none may be present)", () => {
    const a = create("a", { labels: ["agent", "triage:ready"] });
    const b = create("b", { labels: ["agent"] });
    const c = create("c", { labels: ["wontfix"] });
    const d = create("d");
    expect(ids(store.listGigs("gig", { label: ["agent"] }))).toEqual([a.id, b.id]);
    expect(ids(store.listGigs("gig", { label: ["agent", "triage:ready"] }))).toEqual([a.id]);
    expect(ids(store.listGigs("gig", { exclude_label: ["agent"] }))).toEqual([c.id, d.id]);
    expect(ids(store.listGigs("gig", { exclude_label: ["triage:ready", "wontfix"] }))).toEqual([b.id, d.id]);
    expect(ids(store.listGigs("gig", { label: ["agent"], exclude_label: ["triage:ready"] }))).toEqual([b.id]);
    expect(ids(store.listGigs("gig", { label: ["nobody"] }))).toEqual([]);
    expect(ids(store.ready("gig", undefined, { label: ["agent"] }))).toEqual([a.id, b.id]);
    expect(ids(store.ready("gig", undefined, { exclude_label: ["agent"] }))).toEqual([c.id, d.id]);
    // Combined with other filters; closed gigs only with --all.
    store.close(a.id, "a");
    expect(ids(store.listGigs("gig", { label: ["agent"] }))).toEqual([b.id]);
    expect(ids(store.listGigs("gig", { label: ["agent"], all: true }))).toEqual([a.id, b.id]);
    const s = store.readySpec(store.createSpec("gig", "a", { title: "S", text: "t" }).id, "a");
    const e = create("e", { labels: ["agent"], spec: s.id });
    expect(ids(store.ready("gig", s.id, { label: ["agent"] }))).toEqual([e.id]);
    expect(ids(store.ready("gig", s.id, { exclude_label: ["agent"] }))).toEqual([]);
  });

  test("are inert: never change ready, blocked or claiming", () => {
    const blocker = create("blocker");
    const blocked = create("blocked", { blocked_by: [blocker.id], labels: ["ready-for-agent"] });
    const free = create("free", { priority: 3 });
    const readyIds = () => ids(store.ready("gig"));
    expect(readyIds()).toEqual([blocker.id, free.id]);
    label(free.id, ["wontfix", "blocked", "deferred"]);
    label(blocker.id, ["needs-triage"]);
    expect(readyIds()).toEqual([blocker.id, free.id]);
    expect(store.getDetail(free.id)).toMatchObject({ ready: true, reasons: [] });
    expect(ids(store.blocked("gig").map((x) => x.gig))).toEqual([blocked.id]);
    // A blocker outside the label filter still blocks.
    expect(ids(store.ready("gig", undefined, { label: ["ready-for-agent"] }))).toEqual([]);
    expect(store.claimNext("gig", "alice")).toMatchObject({ id: blocker.id, labels: ["needs-triage"] });
    expect(store.claim(free.id, "bob")).toMatchObject({ status: "in_progress", labels: ["blocked", "deferred", "wontfix"] });
    expect(error(() => store.claim(blocked.id, "carol"), "not_ready", 409)).toBeDefined();
  });

  test("a label change is activity: bumps updated_at and renews the holder's claim only", () => {
    const { id } = create("x");
    store.claim(id, "alice");
    const gig = () => store.getGig(id);
    minutes(10);
    label(id, ["a"], [], "alice");
    expect(gig()).toMatchObject({ claim_expires_at: at(40), updated_at: at(10) });
    minutes(10);
    label(id, ["a"], ["missing"], "alice"); // a no-op change still counts as activity
    expect(gig()).toMatchObject({ claim_expires_at: at(50), updated_at: at(20) });
    minutes(10);
    label(id, [], ["a"], "bob");
    expect(gig()).toMatchObject({ claim_expires_at: at(50), updated_at: at(30), labels: [] });
  });
});

describe("migration 6", () => {
  test("upgrades a v5 database: existing gigs keep their data and start without labels", () => {
    const held = create("held");
    store.claim(held.id, "holder");
    store.dispose();
    const db = new Database(path);
    db.run("ALTER TABLE specs DROP COLUMN state; ALTER TABLE specs DROP COLUMN close_reason; ALTER TABLE specs DROP COLUMN closed_by; ALTER TABLE specs DROP COLUMN closed_at; ALTER TABLE gigs DROP COLUMN human; DROP TABLE labels; PRAGMA user_version = 5;");
    db.close();
    store = new Store({ path, now: () => clock, claimTtlMinutes: 30 });
    expect(store.getGig(held.id)).toMatchObject({ title: "held", claimed_by: "holder", labels: [] });
    expect(label(held.id, ["wontfix"]).labels).toEqual(["wontfix"]);
  });
});
