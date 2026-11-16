import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoonsError, Store } from "../src/store";

// Human boons: only a human works them, so claiming the next ready boon never hands them out.

let dir: string;
let path: string;
let store: Store;
let clock: Date;
const T0 = "2026-01-01T00:00:00.000Z";
const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));
const at = (offsetMinutes: number) => new Date(Date.parse(T0) + offsetMinutes * 60_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boons-human-"));
  path = join(dir, "boons.db");
  clock = new Date(T0);
  store = new Store({ path, now: () => clock, claimTtlMinutes: 30 });
  store.createProject("bn");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });

const create = (title: string, input = {}) => store.createBoon("bn", "a", { title, ...input });
const ids = (boons: { id: string }[]) => boons.map((b) => b.id);
function error(fn: () => unknown, code = "bad_request", status = 400) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(BoonsError);
    expect(err).toMatchObject({ code, status });
    return err as BoonsError;
  }
  throw new Error(`expected ${code}`);
}

describe("human boons", () => {
  test("default to not human; set on create; must be a boolean", () => {
    expect(create("plain").human).toBe(false);
    const h = create("decide", { human: true });
    expect(h.human).toBe(true);
    expect(store.getDetail(h.id).boon.human).toBe(true);
    expect(create("explicit", { human: false }).human).toBe(false);
    for (const bad of [1, "yes", null]) error(() => create("x", { human: bad }));
    error(() => store.update(h.id, "a", { human: "no" }));
  });

  test("claim-next skips human boons and picks the next ready non-human boon", () => {
    const urgent = create("urgent question", { human: true, priority: 0 });
    const work = create("work", { priority: 2 });
    expect(ids(store.ready("bn"))).toEqual([urgent.id, work.id]);
    expect(store.claimNext("bn", "agent")).toMatchObject({ id: work.id, claimed_by: "agent" });
    expect(store.claimNext("bn", "agent")).toBeNull();
    // Still ready, and claimable by id by anyone.
    expect(ids(store.ready("bn"))).toEqual([urgent.id]);
    expect(store.claim(urgent.id, "agent-2")).toMatchObject({ status: "in_progress", claimed_by: "agent-2", human: true });
  });

  test("claim-next with a spec skips human boons too", () => {
    const s = store.createSpec("bn", "a", { title: "S", text: "t" });
    const human = create("in spec, human", { spec: s.id, priority: 0, human: true });
    create("outside spec", { priority: 0 });
    const agent = create("in spec", { spec: s.id, priority: 3 });
    expect(ids(store.ready("bn", s.id))).toEqual([human.id, agent.id]);
    expect(store.claimNext("bn", "agent", s.id)?.id).toBe(agent.id);
    expect(store.claimNext("bn", "agent", s.id)).toBeNull();
  });

  test("claim-next returns null when only human boons are ready", () => {
    create("a", { human: true });
    create("b", { human: true });
    expect(store.ready("bn")).toHaveLength(2);
    expect(store.claimNext("bn", "agent")).toBeNull();
    expect(store.ready("bn").every((b) => b.status === "open")).toBe(true);
  });

  test("block and are blocked like any boon: the agent waits on a human answer", () => {
    const mine = create("my work");
    store.claim(mine.id, "agent");
    const question = create("Which API version?", { human: true });
    store.addLink(mine.id, question.id, "blocks", "agent");
    store.unclaim(mine.id, "agent");
    expect(ids(store.ready("bn"))).toEqual([question.id]);
    expect(store.claimNext("bn", "agent")).toBeNull();
    store.addComment(question.id, "human", "Use v2.");
    store.close(question.id, "human");
    expect(ids(store.ready("bn"))).toEqual([mine.id]);
    expect(store.claimNext("bn", "agent")?.id).toBe(mine.id);
    // And a human boon is blocked by its own blockers.
    const blocker = create("blocker");
    const h = create("human, blocked", { human: true, blocked_by: [blocker.id] });
    expect(ids(store.blocked("bn").map((x) => x.boon))).toEqual([h.id]);
    error(() => store.claim(h.id, "human"), "not_ready", 409);
  });

  test("a claim on a human boon lapses normally", () => {
    const h = create("h", { human: true });
    store.claim(h.id, "human");
    minutes(30);
    expect(store.getBoon(h.id)).toMatchObject({ status: "open", claimed_by: null, human: true });
    expect(store.claimNext("bn", "agent")).toBeNull();
  });

  test("list and ready filter to human boons only", () => {
    const h1 = create("h1", { human: true });
    const a = create("a");
    const h2 = create("h2", { human: true, blocked_by: [a.id] });
    expect(ids(store.listBoons("bn", { human: true }))).toEqual([h1.id, h2.id]);
    expect(ids(store.listBoons("bn", { human: false }))).toEqual([h1.id, a.id, h2.id]);
    expect(ids(store.listBoons("bn"))).toEqual([h1.id, a.id, h2.id]);
    expect(ids(store.ready("bn", undefined, { human: true }))).toEqual([h1.id]);
    store.close(h1.id, "human");
    expect(ids(store.listBoons("bn", { human: true }))).toEqual([h2.id]);
    expect(ids(store.listBoons("bn", { human: true, all: true }))).toEqual([h1.id, h2.id]);
  });

  test("set and clear via update, on any status; the change is activity that renews the holder's claim", () => {
    const { id } = create("x");
    store.claim(id, "alice");
    minutes(10);
    expect(store.update(id, "alice", { human: true })).toMatchObject({ human: true, claim_expires_at: at(40), updated_at: at(10) });
    minutes(10);
    expect(store.update(id, "bob", { human: false })).toMatchObject({ human: false, claim_expires_at: at(40), updated_at: at(20) });
    store.close(id, "alice");
    expect(store.update(id, "a", { human: true })).toMatchObject({ status: "closed", human: true });
    const d = create("deferred");
    store.defer(d.id, "a");
    expect(store.update(d.id, "a", { human: true })).toMatchObject({ status: "deferred", human: true });
  });
});

describe("migration 7", () => {
  test("upgrades a v6 database: existing boons keep their data and are not human", () => {
    const held = create("held", { labels: ["x"] });
    store.claim(held.id, "holder");
    store.dispose();
    const db = new Database(path);
    db.run("ALTER TABLE boons DROP COLUMN human; PRAGMA user_version = 6;");
    db.close();
    store = new Store({ path, now: () => clock, claimTtlMinutes: 30 });
    expect(store.getBoon(held.id)).toMatchObject({ title: "held", claimed_by: "holder", labels: ["x"], human: false });
    expect(store.update(held.id, "holder", { human: true }).human).toBe(true);
  });
});
