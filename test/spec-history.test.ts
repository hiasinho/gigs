import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GigsError, Store } from "../src/store";
import { openSql, openStore } from "./harness";

let dir: string;
let path: string;
let store: Store;
const at = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-spec-history-"));
  path = join(dir, "test.db");
  store = openStore(path, { now: () => new Date(at) });
  store.createProject("gig");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });
const create = (text = "one two") => store.createSpec("gig", "alice", { title: "Agreement", text });
function error(fn: () => unknown, code: string, status: number, message?: string) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect(err).toMatchObject({ code, status, ...(message ? { message } : {}) });
    return;
  }
  throw new Error(`expected ${code}`);
}

test("numbered snapshots and compact ascending history for each kind of change", () => {
  const first = create();
  expect(first.version).toBe(1);
  expect(store.updateSpec(first.id, " bob ", { title: "Renamed" }).version).toBe(2);
  expect(store.updateSpec(first.id, "bob", { text: "one three" }).version).toBe(3);
  const edits = [{ old: "one", new: "first" }, { old: "first three", new: "final" }];
  expect(store.editSpec(first.id, "carol", edits)).toMatchObject({ version: 4, text: "final" });
  expect(store.updateSpec(first.id, "bob", { title: "Last", text: "done" }).version).toBe(5);
  expect(store.getSpec(" GIG-S1 ", 1)).toEqual(first);
  expect(store.getSpec(first.id, 2)).toEqual({ ...first, version: 2, title: "Renamed" });
  expect(store.getSpec(first.id, 3)).toEqual({ ...first, version: 3, title: "Renamed", text: "one three" });
  expect(store.getSpec(first.id, 4)).toEqual({ ...first, version: 4, title: "Renamed", text: "final" });
  expect(store.specHistory(first.id)).toEqual([
    { version: 1, by: "alice", at, kind: "create" },
    { version: 2, by: "bob", at, kind: "update", title: "Renamed" },
    { version: 3, by: "bob", at, kind: "update", text: "replaced" },
    { version: 4, by: "carol", at, kind: "edit", edits },
    { version: 5, by: "bob", at, kind: "update", title: "Last", text: "replaced" },
  ]);
  expect(store.listSpecs("gig")[0]?.version).toBe(5);
  error(() => store.getSpec(first.id, 6), "not_found", 404);
  for (const version of [0, -1, 1.5, "1", NaN, Infinity]) error(() => store.getSpec(first.id, version), "bad_request", 400);
  error(() => store.specHistory("gig-s99"), "not_found", 404);
  error(() => store.editSpec("gig-s99", "a", []), "not_found", 404);
  store.dispose();
  store = openStore(path);
  expect(store.getSpec(first.id, 1)).toEqual(first);
  expect(store.specHistory(first.id)).toHaveLength(5);
});

test("edits sequence against the evolving text after a deletion", () => {
  const s = create("one two");
  expect(store.editSpec(s.id, "a", [{ old: "one", new: "" }, { old: " two", new: "final" }])).toMatchObject({ text: "final", version: 2 });
});

test("deletions work without trimming the resulting text", () => {
  const s = create("  one two  ");
  expect(store.editSpec(s.id, "a", [{ old: "one ", new: "" }])).toMatchObject({ text: "  two  ", version: 2 });
  expect(store.editSpec(s.id, "a", [{ old: "two", new: "$&" }]).text).toBe("  $&  ");
});

test("conflicts include one-based edit position and leave every snapshot unchanged", () => {
  const s = create("one two two");
  error(() => store.editSpec(s.id, "a", [{ old: "one", new: "first" }, { old: "missing", new: "x" }]), "edit_conflict", 409, "edit 2: old text not found");
  error(() => store.editSpec(s.id, "a", [{ old: "two", new: "x" }]), "edit_conflict", 409, "edit 1: old text found 2 times; include more context");
  expect(store.getSpec(s.id)).toEqual(s);
  expect(store.specHistory(s.id)).toHaveLength(1);
  const overlap = create("aaa");
  error(() => store.editSpec(overlap.id, "a", [{ old: "aa", new: "x" }]), "edit_conflict", 409, "edit 1: old text found 2 times; include more context");
});

test("malformed edits, empty old and empty final text are rejected atomically", () => {
  const s = create();
  for (const edits of [undefined, null, {}, [], [null], [1], [[]], [{ old: "", new: "x" }], [{ old: "one" }], [{ old: "one", new: 1 }], [{ old: 1, new: "x" }], [{ old: "one", new: "x", extra: true }], [{ old: "one two", new: "" }], [{ old: "one two", new: "  " }], [{ old: "one", new: "first" }, { old: "", new: "x" }]]) {
    error(() => store.editSpec(s.id, "a", edits), "bad_request", 400);
    expect(store.getSpec(s.id)).toEqual(s);
    expect(store.specHistory(s.id)).toHaveLength(1);
  }
  error(() => store.editSpec(s.id, " ", [{ old: "one", new: "x" }]), "bad_request", 400);
});

test("no-op updates and edits do not create versions, including sequences with no net change", () => {
  const s = create();
  expect(store.updateSpec(s.id, "a", { title: " Agreement ", text: s.text })).toEqual(s);
  expect(store.editSpec(s.id, "a", [{ old: "one", new: "one" }])).toEqual(s);
  expect(store.editSpec(s.id, "a", [{ old: "one", new: "first" }, { old: "first", new: "one" }])).toEqual(s);
  expect(store.specHistory(s.id)).toHaveLength(1);
});

test("snapshot insertion failures roll back create, update and edit", () => {
  const s = create();
  const db = openSql(path);
  try {
    db.exec("CREATE TRIGGER reject_version BEFORE INSERT ON spec_versions BEGIN SELECT RAISE(ABORT, 'no history'); END;");
    expect(() => create()).toThrow("no history");
    expect(() => store.updateSpec(s.id, "a", { title: "changed" })).toThrow("no history");
    expect(() => store.editSpec(s.id, "a", [{ old: "one", new: "changed" }])).toThrow("no history");
    expect(store.getSpec(s.id)).toEqual(s);
    expect(store.listSpecs("gig")).toHaveLength(1);
    expect(store.specHistory(s.id)).toHaveLength(1);
    db.exec("DROP TRIGGER reject_version");
    expect(create().id).toBe("gig-s2");
  } finally { db.close(); }
});

test("migration 5 backfills the current v4 state at version 1 using its creator and creation time", () => {
  const first = create();
  store.updateSpec(first.id, "bob", { title: "Current", text: "Current text" });
  store.readySpec(first.id, "a");
  store.createGig("gig", "a", { title: "linked", spec: first.id });
  store.dispose();
  const db = openSql(path);
  db.exec("DROP TABLE tokens; ALTER TABLE specs DROP COLUMN state; ALTER TABLE specs DROP COLUMN close_reason; ALTER TABLE specs DROP COLUMN closed_by; ALTER TABLE specs DROP COLUMN closed_at; ALTER TABLE gigs DROP COLUMN human; DROP TABLE labels; DROP TABLE spec_versions; ALTER TABLE specs DROP COLUMN version;"); db.setVersion(4);
  db.close();
  store = openStore(path);
  expect(store.getSpec(first.id)).toEqual({ ...first, title: "Current", text: "Current text", status: "active" });
  expect(store.getSpec(first.id, 1)).toEqual(store.getSpec(first.id));
  expect(store.specHistory(first.id)).toEqual([{ version: 1, by: "alice", at, kind: "create" }]);
  expect(store.getGig("gig-1").spec).toBe(first.id);
  expect(store.updateSpec(first.id, "carol", { title: "Next" }).version).toBe(2);
  store.dispose();
  store = openStore(path);
  expect(store.specHistory(first.id)).toHaveLength(2);
  expect(create().id).toBe("gig-s2");
});
