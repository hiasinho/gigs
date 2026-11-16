// Stands in for "bun:sqlite" in workerd, where only the Durable Object adapter can run.
export class Database {
  constructor() {
    throw new Error("bun:sqlite is not available in workerd");
  }
}
