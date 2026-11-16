// The HTTP API as a plain fetch handler over a Store, runtime-neutral: the Bun server (server.ts)
// and the Cloudflare Worker's Durable Object (worker.ts) both serve it.
import { timingSafeEqual } from "node:crypto";
import { GigsError, Store, sha256, type ClaimFilter, type GigDetail, type GigSummary, type LabelFilter } from "./store";

export interface HandlerOptions {
  /** Turns auth on: every request but /health and the UI page needs this or a project token. */
  adminToken?: string;
  /** The read-only UI page (ui.html) served at `GET /`; without it, `/` is 404. */
  ui?: () => ConstructorParameters<typeof Response>[0];
}

export function createHandler(store: Store, { adminToken, ui }: HandlerOptions = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const result = await route(store, req, adminToken, ui);
      return result instanceof Response ? result : json(result);
    } catch (err) {
      if (err instanceof GigsError) return json({ error: { code: err.code, message: err.message, ...(err.reasons ? { reasons: err.reasons } : {}) } }, err.status);
      console.error(err);
      return json({ error: { code: "internal", message: "internal server error" } }, 500);
    }
  };
}

/**
 * Who the request may act for: `null` for everything (auth off, or the admin token), else the one
 * project its token belongs to. Throws 401 when auth is on and the token is missing or invalid.
 */
function authorize(store: Store, req: Request, adminToken: string | undefined): string | null {
  if (!adminToken) return null;
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  if (m && timingSafeEqual(Buffer.from(sha256(m[1]!)), Buffer.from(sha256(adminToken)))) return null;
  const project = m ? store.tokenProject(m[1]!) : null;
  if (!project) throw new GigsError("unauthorized", "missing or invalid token", 401);
  return project;
}

/** The project of a gig or spec id (`ab-12`, `ab-s3`) or a prefix. */
const projectOf = (id: string) => id.trim().toLowerCase().split("-")[0];

/** Returns the JSON result, or a ready Response when the status is not 200. */
async function route(store: Store, req: Request, adminToken: string | undefined, ui: HandlerOptions["ui"]): Promise<unknown> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return { ok: true, auth: Boolean(adminToken) };
  // Read-only UI; the page itself is public, its API calls carry the token.
  if (req.method === "GET" && url.pathname === "/" && ui) return new Response(ui(), { headers: { "content-type": "text/html; charset=utf-8" } });

  const scope = authorize(store, req, adminToken);
  const adminOnly = () => {
    if (scope !== null) throw new GigsError("forbidden", "needs the admin token", 403);
  };
  /** Every gig, spec or project id named (strings, or arrays of them) must be in the token's project. */
  const own = (...ids: unknown[]) => {
    if (scope === null) return;
    for (const id of ids.flat()) {
      if (typeof id === "string" && projectOf(id) !== scope) {
        throw new GigsError("forbidden", `token is for project ${scope}, not ${projectOf(id)}`, 403);
      }
    }
  };

  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new GigsError("bad_request", "URL path contains invalid percent encoding", 400);
  }
  const shape = parts.map((s, i) => (i === 1 ? ":" : s)).join("/");
  const key = `${req.method} /${shape}`;
  const param = parts[1] ?? "";
  if (parts[0] === "tokens" || (parts[0] === "projects" && (parts.length === 1 || parts[2] === "tokens"))) adminOnly();
  else if (parts[0] === "projects" || parts[0] === "gigs" || parts[0] === "specs") own(param);

  let actor = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    actor = req.headers.get("x-gigs-actor")?.trim() ?? "";
    if (!actor) throw new GigsError("bad_request", "X-Gigs-Actor header is required", 400);
  }

  if (req.method === "DELETE" && parts.length === 5 && parts[0] === "gigs" && parts[2] === "links") {
    own(parts[4]);
    return redact(store.removeLink(param, parts[4], parts[3], actor), scope);
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
      own(q.get("parent"), q.get("spec"));
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
    case "POST /projects/:/gigs": {
      const body = await readBody(req);
      own(body.parent, body.blocked_by, body.discovered_from, body.spec);
      return json(store.createGig(param, actor, body), 201);
    }
    case "GET /projects/:/ready": {
      const q = url.searchParams;
      own(q.get("parent"), q.get("spec"));
      return store.ready(param, q.get("spec") ?? undefined, { ...labelFilter(q), parent: q.get("parent") ?? undefined, human: humanQuery(q) });
    }
    case "GET /projects/:/blocked":
      own(url.searchParams.get("spec"));
      return store.blocked(param, url.searchParams.get("spec") ?? undefined);
    case "POST /projects/:/specs":
      return json(store.createSpec(param, actor, await readBody(req)), 201);
    case "GET /projects/:/specs": {
      const all = url.searchParams.get("all");
      return store.listSpecs(param, { all: all === "1" || all === "true" });
    }
    case "GET /specs/:":
      return store.getSpec(param, url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined);
    case "GET /specs/:/history":
      return store.specHistory(param);
    case "POST /specs/:/edits":
      return store.editSpec(param, actor, (await readBody(req)).edits);
    case "PATCH /specs/:":
      return store.updateSpec(param, actor, await readBody(req));
    case "POST /specs/:/ready":
      return store.readySpec(param, actor);
    case "POST /specs/:/close":
      return store.closeSpec(param, actor, (await readBody(req)).reason);
    case "POST /specs/:/reopen":
      return store.reopenSpec(param, actor);
    case "POST /gigs/:/links": {
      const body = await readBody(req);
      own(body.target);
      return redact(store.addLink(param, body.target, body.kind, actor), scope);
    }
    case "POST /projects/:/claim": {
      // Same filters as ready, as JSON (label lists as arrays); there is no human filter: claim-next never hands out human gigs.
      const { spec, label, exclude_label, parent } = await readBody(req);
      own(spec, parent);
      return store.claimNext(param, actor, spec ?? undefined, { label, exclude_label, parent: parent ?? undefined } as ClaimFilter);
    }
    case "GET /gigs/:":
      return redact(store.getDetail(param), scope);
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
    case "PATCH /gigs/:": {
      const body = await readBody(req);
      own(body.parent, body.spec);
      return store.update(param, actor, body);
    }
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
    case "GET /projects/:/tokens":
      return store.listTokens(param);
    case "POST /projects/:/tokens":
      return json(store.createToken(param, (await readBody(req)).label), 201);
    case "POST /tokens/:/revoke":
      return store.revokeToken(param);
  }
  throw new GigsError("not_found", `no route for ${req.method} ${url.pathname}`, 404);
}

/** With a project token, related gigs of other projects show only their id. */
function redact(detail: GigDetail, scope: string | null): GigDetail {
  if (scope === null) return detail;
  const hide = <T extends GigSummary | null>(g: T): T => (g && projectOf(g.id) !== scope ? ({ id: g.id } as T) : g);
  return {
    ...detail, parent: hide(detail.parent),
    children: detail.children.map(hide), blockers: detail.blockers.map(hide), blocks: detail.blocks.map(hide),
    related: detail.related.map(hide), discovered_from: detail.discovered_from.map(hide), discovered: detail.discovered.map(hide),
  };
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
