import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GigsError, Store, type ClaimFilter } from "../src/store";

// Claim-next takes ready's filters; --parent on ready and claim-next means the whole subtree.

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-claim-filters-"));
  store = new Store({ path: join(dir, "gigs.db") });
  store.createProject("gig");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });

const create = (title: string, input = {}) => store.createGig("gig", "a", { title, ...input });
const ids = (gigs: { id: string }[]) => gigs.map((b) => b.id);
const next = (filter: ClaimFilter, spec?: string) => store.claimNext("gig", "agent", spec, filter)?.id ?? null;
function error(fn: () => unknown, code = "bad_request", status = 400) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect(err).toMatchObject({ code, status });
    return err as GigsError;
  }
  throw new Error(`expected ${code}`);
}

describe("claim-next filters", () => {
  test("--label: all present; --exclude-label: none present; in ready order", () => {
    const first = create("first", { priority: 0 });
    const tagged = create("tagged", { labels: ["ready-for-agent"], priority: 2 });
    const both = create("both", { labels: ["ready-for-agent", "big"], priority: 1 });
    expect(ids(store.ready("gig", undefined, { label: ["ready-for-agent"] }))).toEqual([both.id, tagged.id]);
    expect(next({ label: ["ready-for-agent"], exclude_label: ["big"] })).toBe(tagged.id);
    expect(next({ label: ["ready-for-agent"] })).toBe(both.id);
    expect(next({ label: ["ready-for-agent"] })).toBeNull();
    expect(next({ exclude_label: ["missing"] })).toBe(first.id);
    error(() => next({ label: ["Bad"] }));
    error(() => next({ exclude_label: "big" as unknown as string[] }));
  });

  test("--parent: every descendant, grandchildren included, the parent itself excluded", () => {
    const epic = create("epic", { type: "epic" });
    const child = create("child", { parent: epic.id });
    const grandchild = create("grandchild", { parent: child.id, priority: 1 });
    const great = create("great-grandchild", { parent: grandchild.id, priority: 0 });
    const done = create("closed child", { parent: epic.id });
    store.close(done.id, "a");
    create("outside", { priority: 0 });
    // Only the leaf is ready; the parents wait for their children.
    expect(ids(store.ready("gig", undefined, { parent: epic.id }))).toEqual([great.id]);
    expect(ids(store.ready("gig", undefined, { parent: grandchild.id }))).toEqual([great.id]);
    expect(store.ready("gig", undefined, { parent: great.id })).toEqual([]);
    expect(next({ parent: epic.id.toUpperCase() })).toBe(great.id);
    store.close(great.id, "agent");
    expect(next({ parent: epic.id })).toBe(grandchild.id);
    store.close(grandchild.id, "agent");
    store.close(child.id, "agent");
    // The epic is ready now, but never part of its own subtree.
    expect(ids(store.ready("gig"))).toContain(epic.id);
    expect(store.ready("gig", undefined, { parent: epic.id })).toEqual([]);
    expect(next({ parent: epic.id })).toBeNull();
    expect(store.getGig(epic.id).status).toBe("open");
  });

  test("list --parent stays direct children only", () => {
    const epic = create("epic");
    const child = create("child", { parent: epic.id });
    create("grandchild", { parent: child.id });
    expect(ids(store.listGigs("gig", { parent: epic.id }))).toEqual([child.id]);
  });

  test("readiness comes from the whole graph: a blocker outside the subtree still blocks", () => {
    const outside = create("outside blocker", { priority: 0 });
    const epic = create("epic");
    const blocked = create("blocked", { parent: epic.id, blocked_by: [outside.id], priority: 0 });
    const free = create("free", { parent: epic.id, priority: 3 });
    expect(ids(store.ready("gig", undefined, { parent: epic.id }))).toEqual([free.id]);
    expect(next({ parent: epic.id })).toBe(free.id);
    expect(next({ parent: epic.id })).toBeNull();
    // A blocker on the parent itself is inherited by the whole subtree.
    const gate = create("gate");
    const gated = create("gated epic", { blocked_by: [gate.id] });
    create("under gate", { parent: gated.id });
    expect(store.ready("gig", undefined, { parent: gated.id })).toEqual([]);
    expect(next({ parent: gated.id })).toBeNull();
    store.close(outside.id, "a");
    expect(next({ parent: epic.id })).toBe(blocked.id);
  });

  test("filters combine (AND) with each other and with --spec", () => {
    const s = store.createSpec("gig", "a", { title: "S", text: "t" });
    const epic = create("epic");
    create("in tree, no label", { parent: epic.id, spec: s.id, priority: 0 });
    create("labelled, outside tree", { labels: ["agent"], spec: s.id, priority: 0 });
    create("in tree, labelled, no spec", { parent: epic.id, labels: ["agent"], priority: 0 });
    create("in tree, labelled, excluded", { parent: epic.id, labels: ["agent", "hold"], spec: s.id, priority: 0 });
    const match = create("match", { parent: epic.id, labels: ["agent"], spec: s.id, priority: 4 });
    const filter = { parent: epic.id, label: ["agent"], exclude_label: ["hold"] };
    expect(ids(store.ready("gig", s.id, filter))).toEqual([match.id]);
    expect(next(filter, s.id)).toBe(match.id);
    expect(next(filter, s.id)).toBeNull();
  });

  test("human gigs are always skipped, under any filter", () => {
    const epic = create("epic");
    const human = create("ask", { parent: epic.id, labels: ["agent"], human: true, priority: 0 });
    const work = create("work", { parent: epic.id, labels: ["agent"], priority: 2 });
    expect(ids(store.ready("gig", undefined, { parent: epic.id, label: ["agent"] }))).toEqual([human.id, work.id]);
    // A human flag smuggled into the filter changes nothing.
    expect(next({ parent: epic.id, label: ["agent"], human: true } as ClaimFilter)).toBe(work.id);
    expect(next({ parent: epic.id, label: ["agent"] })).toBeNull();
    expect(next({ label: ["agent"] })).toBeNull();
    expect(store.getGig(human.id).status).toBe("open");
  });

  test("returns null when only human gigs match", () => {
    const epic = create("epic");
    create("ask", { parent: epic.id, human: true });
    create("elsewhere");
    expect(next({ parent: epic.id })).toBeNull();
    expect(next({ label: [], exclude_label: [] })).not.toBeNull();
  });

  test("an unknown or empty parent is an error, on ready and claim-next", () => {
    error(() => store.ready("gig", undefined, { parent: "gig-99" }), "not_found", 404);
    error(() => next({ parent: "gig-99" }), "not_found", 404);
    error(() => next({ parent: "" }));
  });
});
