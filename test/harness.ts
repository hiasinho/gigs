import { describe, test } from "bun:test";
import type { Sql } from "../src/sql";
import { BunSql } from "../src/sql-bun";
import { DoSql, type DurableObjectSqlStorage } from "../src/sql-do";
import { Store, type StoreOptions } from "../src/store";

// Store tests run on Bun (bun:sqlite files) and, via `bun run test:do`, inside workerd against a
// real Durable Object's SQLite storage (see test/do/). Tests open databases through this module.

/** True when running in workerd against a Durable Object. */
export const onDurableObject = typeof Bun === "undefined";

declare global {
  /** The running test's Durable Object storage, set by test/do/bun-test.ts. */
  var gigsTestStorage: DurableObjectSqlStorage | undefined;
}

/** Raw SQL on the test database: a new connection to the file on Bun; the test's DO storage in workerd (one per test, whatever the path). */
export function openSql(path: string): Sql {
  if (!onDurableObject) return new BunSql(path);
  if (!globalThis.gigsTestStorage) throw new Error("no Durable Object here: open databases inside a test or beforeEach");
  return new DoSql(globalThis.gigsTestStorage);
}

export function openStore(path: string, options: Omit<StoreOptions, "sql"> = {}): Store {
  return new Store({ sql: openSql(path), ...options });
}

/** For tests that need Bun itself (Bun.serve, spawning the CLI, a database shared across tests); skipped in workerd. */
export const bunTest = onDurableObject ? test.skip : test;
export const bunDescribe = onDurableObject ? describe.skip : describe;
