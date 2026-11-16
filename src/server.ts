import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GigsError, Store, validClaimTtl, type ClaimFilter, type LabelFilter } from "./store";

export interface HandlerOptions {
  token?: string;
}

export function createHandler(store: Store, { token }: HandlerOptions = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const result = await route(store, req, token);
      return result instanceof Response ? result : json(result);
    } catch (err) {
      if (err instanceof GigsError) return json({ error: { code: err.code, message: err.message, ...(err.reasons ? { reasons: err.reasons } : {}) } }, err.status);
      console.error(err);
      return json({ error: { code: "internal", message: "internal server error" } }, 500);
    }
  };
}

/** Returns the JSON result, or a ready Response when the status is not 200. */
async function route(store: Store, req: Request, token: string | undefined): Promise<unknown> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return { ok: true };

  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    throw new GigsError("unauthorized", "missing or invalid token", 401);
  }

  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new GigsError("bad_request", "URL path contains invalid percent encoding", 400);
  }
  const shape = parts.map((s, i) => (i === 1 ? ":" : s)).join("/");
  const key = `${req.method} /${shape}`;
  const param = parts[1] ?? "";

  let actor = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    actor = req.headers.get("x-gigs-actor")?.trim() ?? "";
    if (!actor) throw new GigsError("bad_request", "X-Gigs-Actor header is required", 400);
  }

  if (req.method === "DELETE" && parts.length === 5 && parts[0] === "gigs" && parts[2] === "links") {
    return store.removeLink(param, parts[4], parts[3], actor);
  }

  switch (key) {
    case "GET /projects":
      return store.listProjects();
    case "POST /projects": {
      const body = await readBody(req);
      return json(store.createProject(body.prefix, body.name), 201);
    }
    case "GET /projects/:":
      return store.getProject(param);
    case "GET /projects/:/gigs": {
      const q = url.searchParams;
      return store.listGigs(param, {
        status: q.get("status")?.split(",").map((s) => s.trim()).filter(Boolean),
        type: q.get("type") ?? undefined,
        parent: q.get("parent") ?? undefined,
        spec: q.get("spec") ?? undefined,
        ...labelFilter(q),
        human: humanQuery(q),
        all: q.get("all") === "1" || q.get("all") === "true",
      });
    }
    case "POST /projects/:/gigs":
      return json(store.createGig(param, actor, await readBody(req)), 201);
    case "GET /projects/:/ready": {
      const q = url.searchParams;
      return store.ready(param, q.get("spec") ?? undefined, { ...labelFilter(q), parent: q.get("parent") ?? undefined, human: humanQuery(q) });
    }
    case "GET /projects/:/blocked":
      return store.blocked(param, url.searchParams.get("spec") ?? undefined);
    case "POST /projects/:/specs":
      return json(store.createSpec(param, actor, await readBody(req)), 201);
    case "GET /projects/:/specs":
      return store.listSpecs(param);
    case "GET /specs/:":
      return store.getSpec(param, url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined);
    case "GET /specs/:/history":
      return store.specHistory(param);
    case "POST /specs/:/edits":
      return store.editSpec(param, actor, (await readBody(req)).edits);
    case "PATCH /specs/:":
      return store.updateSpec(param, actor, await readBody(req));
    case "POST /gigs/:/links": {
      const body = await readBody(req);
      return store.addLink(param, body.target, body.kind, actor);
    }
    case "POST /projects/:/claim": {
      // Same filters as ready, as JSON (label lists as arrays); there is no human filter: claim-next never hands out human gigs.
      const { spec, label, exclude_label, parent } = await readBody(req);
      return store.claimNext(param, actor, spec ?? undefined, { label, exclude_label, parent: parent ?? undefined } as ClaimFilter);
    }
    case "GET /gigs/:":
      return store.getDetail(param);
    case "POST /gigs/:/claim":
      return store.claim(param, actor);
    case "POST /gigs/:/unclaim":
      return store.unclaim(param, actor);
    case "POST /gigs/:/close": {
      const body = await readBody(req);
      return store.close(param, actor, body.reason, body.force);
    }
    case "POST /gigs/:/reopen":
      return store.reopen(param);
    case "PATCH /gigs/:":
      return store.update(param, actor, await readBody(req));
    case "POST /gigs/:/edits":
      return store.editGig(param, actor, (await readBody(req)).edits);
    case "POST /gigs/:/heartbeat":
      return store.heartbeat(param, actor);
    case "POST /gigs/:/defer":
      return store.defer(param, actor, (await readBody(req)).until);
    case "POST /gigs/:/undefer":
      return store.undefer(param, actor);
    case "POST /gigs/:/comments":
      return json(store.addComment(param, actor, (await readBody(req)).body), 201);
  }
  throw new GigsError("not_found", `no route for ${req.method} ${url.pathname}`, 404);
}

/** `?label=a,b&exclude_label=c` as a filter. */
function labelFilter(q: URLSearchParams): LabelFilter {
  const list = (name: string) => q.get(name)?.split(",").map((s) => s.trim()).filter(Boolean);
  return { label: list("label"), exclude_label: list("exclude_label") };
}

/** `?human=1` or `?human=true`: only human gigs. */
function humanQuery(q: URLSearchParams): boolean {
  return q.get("human") === "1" || q.get("human") === "true";
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GigsError("bad_request", "request body is not valid JSON", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GigsError("bad_request", "request body must be a JSON object", 400);
  }
  return body as Record<string, unknown>;
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export interface ServerConfig {
  host: string;
  port: number;
  db: string;
  token?: string;
  claimTtlMinutes: number;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const port = Number(env.GIGS_PORT ?? 7357);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid GIGS_PORT: ${env.GIGS_PORT}`);
  const claimTtlMinutes = Number(env.GIGS_CLAIM_TTL_MINUTES || 60);
  if (!validClaimTtl(claimTtlMinutes)) throw new Error(`invalid GIGS_CLAIM_TTL_MINUTES: ${env.GIGS_CLAIM_TTL_MINUTES}`);
  return {
    host: env.GIGS_HOST || "127.0.0.1",
    port,
    db: env.GIGS_DB || join(homedir(), ".local/share/gigs/gigs.db"),
    token: env.GIGS_TOKEN || undefined,
    claimTtlMinutes,
  };
}

export function serve(config: ServerConfig) {
  mkdirSync(dirname(config.db), { recursive: true });
  const store = new Store({ path: config.db, claimTtlMinutes: config.claimTtlMinutes });
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createHandler(store, { token: config.token }),
  });
}
