/**
 * The synchronous SQL seam the Store talks to; one adapter per backend (sql-bun.ts, sql-do.ts).
 * Parameters are positional `?` only, values are strings, numbers or null, and INTEGER columns read back as numbers.
 */
export type SqlValue = string | number | null;

export interface Sql {
  /** All rows of one statement. */
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** The first row of one statement, or null. */
  get<T>(sql: string, ...params: SqlValue[]): T | null;
  /** Runs one statement for its effect. */
  run(sql: string, ...params: SqlValue[]): void;
  /** Runs semicolon-separated statements without parameters (migrations). */
  exec(sql: string): void;
  /** Runs fn in a write transaction: committed on return, rolled back on throw. May nest. */
  transaction<T>(fn: () => T): T;
  /** The schema version (number of applied migrations); 0 for a new database. */
  version(): number;
  setVersion(version: number): void;
  close(): void;
}
