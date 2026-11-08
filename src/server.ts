import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BoonsError, Store, validClaimTtl } from "./store";

export interface HandlerOptions {
  token?: string;
}

export function createHandler(store: Store, { token }: HandlerOptions = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const result = await route(store, req, token);
      return result instanceof Response ? result : json(result);
    } catch (err) {
      if (err instanceof BoonsError) return json({ error: { code: err.code, message: err.message, ...(err.reasons ? { reasons: err.reasons } : {}) } }, err.status);
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
    throw new BoonsError("unauthorized", "missing or invalid token", 401);
  }

  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new BoonsError("bad_request", "URL path contains invalid percent encoding", 400);
  }
  const shape = parts.map((s, i) => (i === 1 ? ":" : s)).join("/");
  const key = `${req.method} /${shape}`;
  const param = parts[1] ?? "";

  let actor = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    actor = req.headers.get("x-boons-actor")?.trim() ?? "";
    if (!actor) throw new BoonsError("bad_request", "X-Boons-Actor header is required", 400);
  }

  if (req.method === "DELETE" && parts.length === 5 && parts[0] === "boons" && parts[2] === "links") {
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
    case "GET /projects/:/boons": {
      const q = url.searchParams;
      return store.listBoons(param, {
        status: q.get("status")?.split(",").map((s) => s.trim()).filter(Boolean),
        type: q.get("type") ?? undefined,
        parent: q.get("parent") ?? undefined,
        spec: q.get("spec") ?? undefined,
        all: q.get("all") === "1" || q.get("all") === "true",
      });
    }
    case "POST /projects/:/boons":
      return json(store.createBoon(param, actor, await readBody(req)), 201);
    case "GET /projects/:/ready":
      return store.ready(param, url.searchParams.get("spec") ?? undefined);
    case "GET /projects/:/blocked":
      return store.blocked(param, url.searchParams.get("spec") ?? undefined);
    case "POST /projects/:/specs":
      return json(store.createSpec(param, actor, await readBody(req)), 201);
    case "GET /projects/:/specs":
      return store.listSpecs(param);
    case "GET /specs/:":
      return store.getSpec(param);
    case "POST /boons/:/links": {
      const body = await readBody(req);
      return store.addLink(param, body.target, body.kind, actor);
    }
    case "POST /projects/:/claim":
      return store.claimNext(param, actor, (await readBody(req)).spec ?? undefined);
    case "GET /boons/:":
      return store.getDetail(param);
    case "POST /boons/:/claim":
      return store.claim(param, actor);
    case "POST /boons/:/unclaim":
      return store.unclaim(param, actor);
    case "POST /boons/:/close": {
      const body = await readBody(req);
      return store.close(param, actor, body.reason, body.force);
    }
    case "POST /boons/:/reopen":
      return store.reopen(param);
    case "PATCH /boons/:":
      return store.update(param, actor, await readBody(req));
    case "POST /boons/:/heartbeat":
      return store.heartbeat(param, actor);
    case "POST /boons/:/defer":
      return store.defer(param, actor, (await readBody(req)).until);
    case "POST /boons/:/undefer":
      return store.undefer(param, actor);
    case "POST /boons/:/comments":
      return json(store.addComment(param, actor, (await readBody(req)).body), 201);
  }
  throw new BoonsError("not_found", `no route for ${req.method} ${url.pathname}`, 404);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BoonsError("bad_request", "request body is not valid JSON", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BoonsError("bad_request", "request body must be a JSON object", 400);
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
  const port = Number(env.BOONS_PORT ?? 7357);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid BOONS_PORT: ${env.BOONS_PORT}`);
  const claimTtlMinutes = Number(env.BOONS_CLAIM_TTL_MINUTES || 60);
  if (!validClaimTtl(claimTtlMinutes)) throw new Error(`invalid BOONS_CLAIM_TTL_MINUTES: ${env.BOONS_CLAIM_TTL_MINUTES}`);
  return {
    host: env.BOONS_HOST || "127.0.0.1",
    port,
    db: env.BOONS_DB || join(homedir(), ".local/share/boons/boons.db"),
    token: env.BOONS_TOKEN || undefined,
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
