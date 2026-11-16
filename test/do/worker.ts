import { DurableObject } from "cloudflare:workers";

/** A bare SQLite-backed Durable Object; tests reach its storage through runInDurableObject. */
export class TestDO extends DurableObject {}

// The real Worker entry, so test/do/worker-entry.ts can call it as SELF.
export { default, GigsDO } from "../../src/worker";
