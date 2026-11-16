import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "../src/sql";
import { openSql } from "./harness";

// What the Store relies on from either SQL adapter (bun:sqlite here, a Durable Object under `bun run test:do`).

let dir: string;
let path: string;
let sql: Sql;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-sql-"));
  path = join(dir, "gigs.db");
  sql = openSql(path);
  sql.exec("CREATE TABLE p (id TEXT PRIMARY KEY, n INTEGER); CREATE TABLE c (p TEXT NOT NULL REFERENCES p(id))");
});
afterEach(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

test("rows are plain objects; integers are numbers, NULL is null; get gives the first row or null", () => {
  sql.run("INSERT INTO p (id, n) VALUES (?, ?), (?, ?)", "a", 1, "b", null);
  expect(sql.all("SELECT id, n, n = 1 AS one, json_group_array(id) AS ids FROM p GROUP BY id ORDER BY id")).toEqual([
    { id: "a", n: 1, one: 1, ids: '["a"]' },
    { id: "b", n: null, one: null, ids: '["b"]' },
  ]);
  expect(sql.get("SELECT id FROM p ORDER BY id")).toEqual({ id: "a" });
  expect(sql.get("SELECT id FROM p WHERE id = ?", "zz")).toBeNull();
  expect(sql.get("UPDATE p SET n = n + 1 WHERE id = ? RETURNING n - 1 AS was", "a")).toEqual({ was: 1 });
});

test("foreign keys are enforced", () => {
  expect(() => sql.run("INSERT INTO c (p) VALUES (?)", "nope")).toThrow(/FOREIGN KEY/);
});

test("a transaction commits on return and rolls back on throw; a caught inner one rolls back alone", () => {
  expect(sql.transaction(() => { sql.run("INSERT INTO p (id) VALUES ('a')"); return 7; })).toBe(7);
  expect(() => sql.transaction(() => { sql.run("INSERT INTO p (id) VALUES ('b')"); throw new Error("boom"); })).toThrow("boom");
  sql.transaction(() => {
    sql.run("INSERT INTO p (id) VALUES ('c')");
    expect(() => sql.transaction(() => { sql.run("INSERT INTO p (id) VALUES ('d')"); throw new Error("inner"); })).toThrow("inner");
  });
  expect(sql.all("SELECT id FROM p ORDER BY id")).toEqual([{ id: "a" }, { id: "c" }]);
});

test("the schema version starts at 0 and persists", () => {
  expect(sql.version()).toBe(0);
  sql.transaction(() => sql.setVersion(3));
  sql.setVersion(9);
  const again = openSql(path);
  try { expect(again.version()).toBe(9); } finally { again.close(); }
});
