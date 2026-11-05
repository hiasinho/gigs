import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoonsError, Store, type NewBoon } from "../src/store";

let dir: string;
let store: Store;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boons-links-"));
  const path = join(dir, "test.db");
  store = new Store({ path });
  db = new Database(path);
  store.createProject("bn");
  store.createProject("xy");
});
afterEach(() => { db.close(); store.dispose(); rmSync(dir, { recursive: true, force: true }); });
const create = (title: string, input: NewBoon = {}) => store.createBoon("bn", "a", { title, ...input });
const add = (id: string, target: string, kind = "blocks") => store.addLink(id, target, kind, "a");
function error(fn: () => unknown, code: string, status = 409) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(BoonsError);
    expect(err).toMatchObject({ code, status });
    return err as BoonsError;
  }
  throw new Error(`expected ${code}`);
}

test("readiness inherits blockers across two ancestors, even closed ancestors; close/reopen recomputes", () => {
  const blocker = store.createBoon("xy", "a", { title: "external blocker" });
  const root = create("root", { blocked_by: [blocker.id] });
  const mid = create("mid", { parent: root.id });
  const leaf = create("leaf", { parent: mid.id });
  expect(store.getDetail(root.id).reasons).toEqual([{ kind: "blocker", id: blocker.id }, { kind: "child", id: mid.id }]);
  expect(store.getDetail(mid.id).reasons).toEqual([{ kind: "child", id: leaf.id }, { kind: "inherited", id: blocker.id, via: root.id }]);
  expect(store.getDetail(leaf.id).reasons).toEqual([{ kind: "inherited", id: blocker.id, via: root.id }]);
  expect(store.ready("bn")).toEqual([]);
  expect(store.blocked("bn").map((e) => e.boon.id)).toEqual([root.id, mid.id, leaf.id]);
  const err = error(() => store.claim(leaf.id, "a"), "not_ready");
  expect(err.reasons).toEqual(store.getDetail(leaf.id).reasons);
  expect(err.message).toContain(`inherits blocker ${blocker.id} via ${root.id}`);
  expect(err.message).not.toContain('[{"');
  store.close(root.id, "a", undefined, true);
  expect(store.getDetail(leaf.id).ready).toBe(false);
  store.close(blocker.id, "a");
  expect(store.ready("bn").map((b) => b.id)).toEqual([leaf.id]);
  store.reopen(blocker.id);
  expect(store.getDetail(leaf.id).ready).toBe(false);
});

test("deferred ancestors prevent readiness but alone do not make descendants blocked", () => {
  const root = create("root");
  const mid = create("mid", { parent: root.id });
  const leaf = create("leaf", { parent: mid.id });
  db.query("UPDATE boons SET status = 'deferred' WHERE id = ?").run(root.id);
  expect(store.getDetail(leaf.id).reasons).toEqual([{ kind: "deferred_ancestor", id: root.id }]);
  expect(store.ready("bn")).toEqual([]);
  expect(store.blocked("bn").map((e) => e.boon.id)).toEqual([mid.id]);
  error(() => store.claim(leaf.id, "a"), "not_ready");
  error(() => store.claim(root.id, "a"), "not_claimable");
  const blocker = create("blocker");
  add(root.id, blocker.id);
  expect(store.blocked("bn").find((e) => e.boon.id === leaf.id)?.reasons).toEqual([
    { kind: "inherited", id: blocker.id, via: root.id }, { kind: "deferred_ancestor", id: root.id },
  ]);
});

test("claimNext and ready agree, skipping higher priority blocked parents and direct blockers", () => {
  const root = create("urgent parent", { priority: 0 });
  const child = create("child", { parent: root.id, priority: 1 });
  const blocked = create("blocked", { priority: 0, blocked_by: [child.id] });
  expect(store.ready("bn").map((b) => b.id)).toEqual([child.id]);
  expect(store.claimNext("bn", "a")?.id).toBe(child.id);
  expect(store.claimNext("bn", "b")).toBeNull();
  store.close(child.id, "a");
  expect(store.ready("bn").map((b) => b.id)).toEqual([root.id, blocked.id]);
  expect(store.claimNext("bn", "a")?.id).toBe(root.id);
});

test("wait cycles: direct, cross-project, parent and inherited edges, including closed boons", () => {
  const a = create("a");
  const b = store.createBoon("xy", "a", { title: "b" });
  add(a.id, b.id);
  store.close(a.id, "a");
  const cycle = error(() => add(b.id, a.id), "cycle");
  expect(cycle.message).toContain(a.id);
  expect(cycle.message).toContain(b.id);
  expect(store.getDetail(b.id).blockers).toEqual([]);
  const parent = create("parent");
  const child = create("child", { parent: parent.id });
  error(() => add(child.id, parent.id), "cycle");
  // Parent -> child plus child -> itself inherited from parent -> child.
  error(() => add(parent.id, child.id), "cycle");
  const outside = create("outside");
  add(parent.id, outside.id);
  // Only the inherited child -> outside edge closes this cycle.
  error(() => add(outside.id, child.id), "cycle");
  expect(store.getDetail(outside.id).blockers).toEqual([]);
  // Creating a parent relationship also checks the resulting graph and rolls back numbering.
  error(() => create("invalid child", { parent: parent.id, blocked_by: [parent.id] }), "cycle");
  expect(create("next").id).toBe("bn-5");
});

test("parent-chain cycles are explicitly rejected by structural validation", () => {
  const a = create("a");
  const b = create("b", { parent: a.id });
  // No parent update command in slice 2: exercise the defensive parent-chain check with SQL.
  db.query("UPDATE boons SET parent = ? WHERE id = ?").run(b.id, a.id);
  const err = error(() => create("unrelated"), "cycle");
  expect(err.message).toContain("parent cycle");
  expect(err.message).toContain(a.id);
  expect(err.message).toContain(b.id);
});

test("close requires all children finished unless forced, without closing children", () => {
  const parent = create("parent");
  const child = create("child", { parent: parent.id });
  error(() => store.close(parent.id, "a"), "has_open_children");
  expect(store.close(parent.id, "a", "force", true).status).toBe("closed");
  expect(store.getBoon(child.id).status).toBe("open");
  store.reopen(parent.id);
  db.query("UPDATE boons SET status = 'deferred' WHERE id = ?").run(child.id);
  error(() => store.close(parent.id, "a"), "has_open_children");
  store.close(child.id, "a");
  expect(store.close(parent.id, "a").status).toBe("closed");
  error(() => store.close(child.id, "a", undefined, true), "conflict");
});

test("relations have summary shape, related dedupes both ways and removes from either side", () => {
  const a = create("a");
  const b = create("b", { parent: a.id, discovered_from: a.id });
  add(b.id, a.id, "related");
  add(a.id, b.id, "related");
  expect(db.query("SELECT COUNT(*) AS n FROM links WHERE kind = 'related'").get()).toEqual({ n: 1 });
  const detail = store.getDetail(a.id);
  expect(detail.children).toEqual([{ id: b.id, title: "b", type: "task", status: "open", priority: 2 }]);
  expect(detail.related).toEqual(detail.children);
  expect(detail.discovered).toEqual(detail.children);
  expect(store.getDetail(b.id).parent?.id).toBe(a.id);
  expect(store.getDetail(b.id).discovered_from[0]?.id).toBe(a.id);
  expect(store.listBoons("bn", { parent: a.id.toUpperCase() }).map((b) => b.id)).toEqual([b.id]);
  store.removeLink(a.id, b.id, "related", "a");
  expect(store.getDetail(b.id).related).toEqual([]);
  store.removeLink(a.id, b.id, "related", "a"); // idempotent
  const c = create("c");
  add(c.id, a.id); add(c.id, a.id);
  expect(store.getDetail(c.id).blockers).toHaveLength(1);
});

test("unknown ids, invalid links and transactional create references", () => {
  const a = create("a");
  for (const kind of ["blocks", "related", "discovered-from"]) {
    error(() => add(a.id, a.id, kind), "bad_request", 400);
    error(() => add(a.id, "bn-99", kind), "not_found", 404);
  }
  error(() => add(a.id, a.id, "nope"), "bad_request", 400);
  error(() => create("bad", { parent: "bn-99" }), "not_found", 404);
  error(() => create("bad", { blocked_by: [a.id, "bn-99"] }), "not_found", 404);
  error(() => create("bad", { discovered_from: "bn-99" }), "not_found", 404);
  error(() => create("bad", { blocked_by: "bn-1" }), "bad_request", 400);
  const b = create("b", { blocked_by: [a.id.toUpperCase(), a.id] });
  expect(b.id).toBe("bn-2");
  expect(store.getDetail(b.id).blockers.map((b) => b.id)).toEqual([a.id]);
  expect(store.getDetail(a.id).blocks.map((b) => b.id)).toEqual([b.id]);
  store.removeLink(b.id, a.id, "blocks", "a");
  expect(store.getDetail(b.id).ready).toBe(true);
});
