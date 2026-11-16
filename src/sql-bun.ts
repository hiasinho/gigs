import { Database } from "bun:sqlite";
import type { Sql, SqlValue } from "./sql";

/**
 * bun:sqlite on a file, shared safely by several processes: WAL, a busy timeout, and every
 * transaction IMMEDIATE so writers queue for the lock up front. The schema version is PRAGMA user_version.
 */
export class BunSql implements Sql {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.query(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SqlValue[]): T | null {
    return (this.db.query(sql).get(...params) as T | null) ?? null;
  }

  run(sql: string, ...params: SqlValue[]) {
    this.db.query(sql).run(...params);
  }

  exec(sql: string) {
    this.db.run(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  version(): number {
    return this.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
  }

  setVersion(version: number) {
    this.db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
  }

  close() {
    this.db.close();
  }
}
