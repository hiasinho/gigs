import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoonsError, Store } from "../src/store";

// Exact find/replace on boon descriptions, on a fake clock.

let dir: string;
let store: Store;
let clock: Date;
const T0 = "2026-01-01T00:00:00.000Z";
const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));
const at = (offsetMinutes: number) => new Date(Date.parse(T0) + offsetMinutes * 60_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boons-boon-edit-"));
  clock = new Date(T0);
  store = new Store({ path: join(dir, "boons.db"), now: () => clock, claimTtlMinutes: 30 });
  store.createProject("bn");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });

const create = (description = "one two") => store.createBoon("bn", "a", { title: "x", description });
const description = (id: string) => store.getDetail(id).boon.description;
function error(fn: () => unknown, code: string, status: number, message?: string) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(BoonsError);
    expect(err).toMatchObject({ code, status, ...(message ? { message } : {}) });
    return;
  }
  throw new Error(`expected ${code}`);
}

test("a single edit replaces exactly the old text and bumps updated_at", () => {
  const { id } = create("Decisions:\n- use SQLite\n");
  minutes(5);
  const edited = store.editBoon(id, "b", [{ old: "- use SQLite\n", new: "- use SQLite\n- no runtime deps\n" }]);
  expect(edited).toMatchObject({ id, description: "Decisions:\n- use SQLite\n- no runtime deps\n", updated_at: at(5) });
});

test("multiple edits run in order against the evolving text", () => {
  const { id } = create("one two");
  const edited = store.editBoon(id, "a", [{ old: "one", new: "first" }, { old: "first two", new: "done" }]);
  expect(edited.description).toBe("done");
});

test("missing or ambiguous old text fails and changes nothing, even after earlier edits applied", () => {
  const { id, updated_at } = create("one two two");
  minutes(5);
  error(() => store.editBoon(id, "a", [{ old: "three", new: "x" }]), "edit_conflict", 409, "edit 1: old text not found");
  error(() => store.editBoon(id, "a", [{ old: "one", new: "1" }, { old: "two", new: "x" }]), "edit_conflict", 409,
    "edit 2: old text found 2 times; include more context");
  expect(store.getDetail(id).boon).toMatchObject({ description: "one two two", updated_at });
});

test("a stale edit fails loudly instead of losing another session's append", () => {
  const { id } = create("Log:\n- a\n");
  // Both sessions read "Log:\n- a\n" and append after "- a\n".
  store.editBoon(id, "s1", [{ old: "- a\n", new: "- a\n- from s1\n" }]);
  store.editBoon(id, "s2", [{ old: "- a\n", new: "- a\n- from s2\n" }]);
  expect(description(id)).toBe("Log:\n- a\n- from s2\n- from s1\n");
  // An edit anchored on text s1 already replaced fails rather than overwriting.
  error(() => store.editBoon(id, "s2", [{ old: "- a\n- from s1\n", new: "- a\n- mine\n" }]), "edit_conflict", 409);
  expect(description(id)).toBe("Log:\n- a\n- from s2\n- from s1\n");
});

test("empty or malformed edits are rejected; new may be empty and the result may be empty", () => {
  const { id } = create("only");
  for (const edits of [undefined, null, "x", {}, [], [{ old: "", new: "x" }], [{ old: "only" }], [{ old: "only", new: 1 }],
    [{ old: "only", new: "", extra: 1 }], [null], [["only", ""]]]) {
    error(() => store.editBoon(id, "a", edits), "bad_request", 400);
  }
  expect(description(id)).toBe("only");
  expect(store.editBoon(id, "a", [{ old: "only", new: "" }]).description).toBe("");
  error(() => store.editBoon(id, "a", [{ old: "only", new: "x" }]), "edit_conflict", 409);
  error(() => store.editBoon("bn-99", "a", [{ old: "a", new: "b" }]), "not_found", 404);
  error(() => store.editBoon(id, " ", [{ old: "a", new: "b" }]), "bad_request", 400);
});

test("edits by the claim holder renew the claim; others' edits do not", () => {
  const { id } = create();
  store.claim(id, "a");
  minutes(20);
  expect(store.editBoon(id, "b", [{ old: "one", new: "1" }]).claim_expires_at).toBe(at(30));
  expect(store.editBoon(id, "a", [{ old: "two", new: "2" }]).claim_expires_at).toBe(at(50));
});

test("works on any status, like update", () => {
  const { id } = create();
  store.close(id, "a");
  expect(store.editBoon(id, "a", [{ old: "one", new: "1" }])).toMatchObject({ status: "closed", description: "1 two" });
  store.reopen(id);
  store.defer(id, "a");
  expect(store.editBoon(id, "a", [{ old: "two", new: "2" }])).toMatchObject({ status: "deferred", description: "1 2" });
});
