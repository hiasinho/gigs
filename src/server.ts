import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BoonsError, Store } from "./store";

export interface HandlerOptions {
  token?: string;
}

export function createHandler(store: Store, { token }: HandlerOptions = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const result = await route(store, req, token);
      return result instanceof Response ? result : json(result);
    } catch (err) {
      if (err instanceof BoonsError) return json({ error: { code: err.code, message: err.message } }, err.status);
      console.error(err);
      return json({ error: { code: "internal", message: "internal server error" } }, 500);
    }
  };
}

/** Returns the JSON result, or a ready Response when the status is not 200. */
async function route(store: Store, req: Request, token: string | undefined): Promise<unknown> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const shape = parts.map((s, i) => (i === 1 ? ":" : s)).join("/");
  const key = `${req.method} /${shape}`;
  const param = parts[1] ?? "";

  if (key === "GET /health") return { ok: true };

  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    throw new BoonsError("unauthorized", "missing or invalid token", 401);
  }

  let actor = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    actor = req.headers.get("x-boons-actor")?.trim() ?? "";
    if (!actor) throw new BoonsError("bad_request", "X-Boons-Actor header is required", 400);
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
        all: q.get("all") === "1" || q.get("all") === "true",
      });
    }
    case "POST /projects/:/boons":
      return json(store.createBoon(param, actor, await readBody(req)), 201);
    case "GET /projects/:/ready":
      return store.ready(param);
    case "POST /projects/:/claim":
      return store.claimNext(param, actor);
    case "GET /boons/:":
      return store.getDetail(param);
    case "POST /boons/:/claim":
      return store.claim(param, actor);
    case "POST /boons/:/unclaim":
      return store.unclaim(param, actor);
    case "POST /boons/:/close":
      return store.close(param, actor, (await readBody(req)).reason);
    case "POST /boons/:/reopen":
      return store.reopen(param);
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
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const port = Number(env.BOONS_PORT ?? 7357);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid BOONS_PORT: ${env.BOONS_PORT}`);
  return {
    host: env.BOONS_HOST || "127.0.0.1",
    port,
    db: env.BOONS_DB || join(homedir(), ".local/share/boons/boons.db"),
    token: env.BOONS_TOKEN || undefined,
  };
}

export function serve(config: ServerConfig) {
  mkdirSync(dirname(config.db), { recursive: true });
  const store = new Store({ path: config.db });
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createHandler(store, { token: config.token }),
  });
}
