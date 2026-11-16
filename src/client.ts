import { GigsError, type Gig, type GigDetail, type Comment, type Project, type Reason, type Spec, type TextEdit, type SpecHistory } from "./store";

export interface ClientOptions {
  url: string;
  token?: string;
  actor: string;
}

export interface NewGigInput {
  title: string;
  description?: string;
  type?: string;
  priority?: number | string;
  parent?: string;
  blocked_by?: string[];
  discovered_from?: string;
  spec?: string;
  labels?: string[];
  human?: boolean;
  defer?: boolean;
  defer_until?: string;
}

export interface GigChangesInput {
  title?: string;
  description?: string;
  type?: string;
  priority?: number | string;
  parent?: string | null;
  spec?: string | null;
  add_labels?: string[];
  remove_labels?: string[];
  human?: boolean;
}

/** Comma-separated; all of `label` and none of `exclude_label` must be present. */
export interface LabelQuery {
  label?: string;
  exclude_label?: string;
}

/** A label query; `parent`: only that gig's descendants, the whole subtree (not the gig itself). */
export interface ClaimQuery extends LabelQuery {
  parent?: string;
}

/** A claim query; `human`: only human gigs. */
export interface ReadyQuery extends ClaimQuery {
  human?: boolean;
}

export interface ListQuery extends LabelQuery {
  human?: boolean;
  status?: string;
  type?: string;
  all?: boolean;
  /** Direct children only. */
  parent?: string;
  spec?: string;
}

export class Client {
  constructor(private opts: ClientOptions) {}

  health() {
    return this.request<{ ok: true }>("GET", "/health");
  }

  listProjects() {
    return this.request<Project[]>("GET", "/projects");
  }

  createProject(prefix: string, name?: string) {
    return this.request<Project>("POST", "/projects", { prefix, name });
  }

  getProject(prefix: string) {
    return this.request<Project>("GET", `/projects/${enc(prefix)}`);
  }

  listGigs(project: string, query: ListQuery = {}) {
    const q = new URLSearchParams();
    if (query.status) q.set("status", query.status);
    if (query.type) q.set("type", query.type);
    if (query.parent) q.set("parent", query.parent);
    if (query.spec) q.set("spec", query.spec);
    if (query.label) q.set("label", query.label);
    if (query.exclude_label) q.set("exclude_label", query.exclude_label);
    if (query.human) q.set("human", "1");
    if (query.all) q.set("all", "1");
    const qs = q.size ? `?${q}` : "";
    return this.request<Gig[]>("GET", `/projects/${enc(project)}/gigs${qs}`);
  }

  createGig(project: string, input: NewGigInput) {
    return this.request<Gig>("POST", `/projects/${enc(project)}/gigs`, input);
  }

  ready(project: string, spec?: string, filter: ReadyQuery = {}) {
    const q = new URLSearchParams();
    if (spec !== undefined) q.set("spec", spec);
    if (filter.label) q.set("label", filter.label);
    if (filter.exclude_label) q.set("exclude_label", filter.exclude_label);
    if (filter.parent !== undefined) q.set("parent", filter.parent);
    if (filter.human) q.set("human", "1");
    return this.request<Gig[]>("GET", `/projects/${enc(project)}/ready${q.size ? `?${q}` : ""}`);
  }

  blocked(project: string, spec?: string) {
    return this.request<{ gig: Gig; reasons: Reason[] }[]>("GET", `/projects/${enc(project)}/blocked${specQuery(spec)}`);
  }

  createSpec(project: string, title: string, text: string) {
    return this.request<Spec>("POST", `/projects/${enc(project)}/specs`, { title, text });
  }

  /** Draft, ready and active specs; `all` includes done and closed. */
  listSpecs(project: string, all = false) {
    return this.request<Spec[]>("GET", `/projects/${enc(project)}/specs${all ? "?all=1" : ""}`);
  }

  readySpec(id: string) {
    return this.request<Spec>("POST", `/specs/${enc(id)}/ready`);
  }

  closeSpec(id: string, reason: string) {
    return this.request<Spec>("POST", `/specs/${enc(id)}/close`, { reason });
  }

  reopenSpec(id: string) {
    return this.request<Spec>("POST", `/specs/${enc(id)}/reopen`);
  }

  getSpec(id: string, version?: number) {
    return this.request<Spec>("GET", `/specs/${enc(id)}${version === undefined ? "" : `?version=${version}`}`);
  }

  editSpec(id: string, edits: TextEdit[]) {
    return this.request<Spec>("POST", `/specs/${enc(id)}/edits`, { edits });
  }

  specHistory(id: string) {
    return this.request<SpecHistory[]>("GET", `/specs/${enc(id)}/history`);
  }

  updateSpec(id: string, changes: { title?: string; text?: string }) {
    return this.request<Spec>("PATCH", `/specs/${enc(id)}`, changes);
  }

  addLink(id: string, target: string, kind: string) {
    return this.request<GigDetail>("POST", `/gigs/${enc(id)}/links`, { target, kind });
  }

  removeLink(id: string, target: string, kind: string) {
    return this.request<GigDetail>("DELETE", `/gigs/${enc(id)}/links/${enc(kind)}/${enc(target)}`);
  }

  /** Claims the next ready non-human gig matching the filters; label lists go to the server as arrays. */
  claimNext(project: string, spec?: string, filter: ClaimQuery = {}) {
    const body = { spec, label: list(filter.label), exclude_label: list(filter.exclude_label), parent: filter.parent };
    const empty = Object.values(body).every((v) => v === undefined);
    return this.request<Gig | null>("POST", `/projects/${enc(project)}/claim`, empty ? undefined : body);
  }

  getGig(id: string) {
    return this.request<GigDetail>("GET", `/gigs/${enc(id)}`);
  }

  claim(id: string) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/claim`);
  }

  unclaim(id: string) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/unclaim`);
  }

  close(id: string, reason?: string, force = false) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/close`, { reason, force });
  }

  reopen(id: string) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/reopen`);
  }

  update(id: string, changes: GigChangesInput) {
    return this.request<Gig>("PATCH", `/gigs/${enc(id)}`, changes);
  }

  editGig(id: string, edits: TextEdit[]) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/edits`, { edits });
  }

  heartbeat(id: string) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/heartbeat`);
  }

  defer(id: string, until?: string) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/defer`, { until });
  }

  undefer(id: string) {
    return this.request<Gig>("POST", `/gigs/${enc(id)}/undefer`);
  }

  comment(id: string, body: string) {
    return this.request<Comment>("POST", `/gigs/${enc(id)}/comments`, { body });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "X-Gigs-Actor": this.opts.actor };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.opts.url.replace(/\/+$/, "") + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GigsError(
        "unreachable",
        `cannot reach gigs server at ${this.opts.url} (is \`gig serve\` running?)`,
        0,
      );
    }
    const data = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const error = data?.error;
      throw new GigsError(error?.code ?? "http_error", error?.message ?? `HTTP ${res.status}`, res.status, error?.reasons);
    }
    return data as T;
  }
}

const enc = encodeURIComponent;
const list = (value?: string) => value?.split(",").map((s) => s.trim()).filter(Boolean);
const specQuery = (spec?: string) => (spec === undefined ? "" : `?spec=${enc(spec)}`);
