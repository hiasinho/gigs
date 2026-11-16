import { DurableObject } from "cloudflare:workers";

/** A bare SQLite-backed Durable Object; tests reach its storage through runInDurableObject. */
export class TestDO extends DurableObject {}

export default { fetch: () => new Response("test worker") };
