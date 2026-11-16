// The Cloudflare entry (wrangler.toml): every request goes to one Durable Object, which holds the
// whole database in its SQLite storage and serves the same handler as the Bun server.
import { DurableObject } from "cloudflare:workers";
import { createHandler } from "./handler";
import { DoSql, type DurableObjectSqlStorage } from "./sql-do";
import { Store, validClaimTtl } from "./store";
// A Text module (wrangler.toml rules): the page's source as a string. Bun's types say HTMLBundle.
import uiHtml from "./ui.html";

export interface Env {
  GIGS: DurableObjectNamespace;
  /** Secret; auth is always on here, so requests are refused while it is missing. */
  GIGS_ADMIN_TOKEN?: string;
  /** Like the Bun server's; default 60. */
  GIGS_CLAIM_TTL_MINUTES?: string;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

interface DurableObjectState {
  storage: DurableObjectSqlStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

const ui = uiHtml as unknown as string;

/** Refuses to run without the admin token: a Worker is public, so auth must not silently be off. */
function missingSecret(env: Env): Response | null {
  if (env.GIGS_ADMIN_TOKEN) return null;
  return Response.json({ error: { code: "misconfigured", message: "GIGS_ADMIN_TOKEN is not set" } }, { status: 503 });
}

export class GigsDO extends DurableObject {
  private handle: ((req: Request) => Promise<Response>) | null = null;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    if (missingSecret(env)) return;
    const claimTtlMinutes = Number(env.GIGS_CLAIM_TTL_MINUTES || 60);
    if (!validClaimTtl(claimTtlMinutes)) throw new Error(`invalid GIGS_CLAIM_TTL_MINUTES: ${env.GIGS_CLAIM_TTL_MINUTES}`);
    // The store migrates the schema on construction; no request may run before that is done.
    void ctx.blockConcurrencyWhile(async () => {
      const store = new Store({ sql: new DoSql(ctx.storage), claimTtlMinutes });
      this.handle = createHandler(store, { adminToken: env.GIGS_ADMIN_TOKEN, ui: () => ui });
    });
  }

  fetch(req: Request): Promise<Response> | Response {
    return missingSecret(this.env) ?? this.handle!(req);
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    return missingSecret(env) ?? env.GIGS.get(env.GIGS.idFromName("gigs")).fetch(req);
  },
};
