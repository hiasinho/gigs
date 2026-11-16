import type { Sql, SqlValue } from "./sql";

/** The parts of a Durable Object's `ctx.storage` (SQLite backend) this adapter uses. */
export interface DurableObjectSqlStorage {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(fn: () => T): T;
}

/**
 * A Durable Object's SQLite database. The DO runs one request at a time, so there is no lock to wait for;
 * transactions are transactionSync (SQL BEGIN/SAVEPOINT are not allowed). Foreign keys are always enforced.
 * PRAGMA user_version is not allowed either, so the schema version lives in a one-row table.
 */
export class DoSql implements Sql {
  constructor(private storage: DurableObjectSqlStorage) {}

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.storage.sql.exec(sql, ...params).toArray() as T[];
  }

  get<T>(sql: string, ...params: SqlValue[]): T | null {
    return (this.all<T>(sql, ...params)[0] ?? null);
  }

  run(sql: string, ...params: SqlValue[]) {
    this.all(sql, ...params);
  }

  exec(sql: string) {
    this.all(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  version(): number {
    this.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    return this.get<{ version: number }>("SELECT version FROM schema_version")?.version ?? 0;
  }

  setVersion(version: number) {
    this.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    this.run("DELETE FROM schema_version");
    this.run("INSERT INTO schema_version (version) VALUES (?)", version);
  }

  /** The DO owns its storage; nothing to close. */
  close() {}
}
