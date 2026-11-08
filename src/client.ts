import { BoonsError, type Boon, type BoonDetail, type Comment, type Project, type Reason, type Spec } from "./store";

export interface ClientOptions {
  url: string;
  token?: string;
  actor: string;
}

export interface NewBoonInput {
  title: string;
  description?: string;
  type?: string;
  priority?: number | string;
  parent?: string;
  blocked_by?: string[];
  discovered_from?: string;
  spec?: string;
}

export interface BoonChangesInput {
  title?: string;
  description?: string;
  type?: string;
  priority?: number | string;
  parent?: string | null;
  spec?: string | null;
}

export interface ListQuery {
  status?: string;
  type?: string;
  all?: boolean;
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

  listBoons(project: string, query: ListQuery = {}) {
    const q = new URLSearchParams();
    if (query.status) q.set("status", query.status);
    if (query.type) q.set("type", query.type);
    if (query.parent) q.set("parent", query.parent);
    if (query.spec) q.set("spec", query.spec);
    if (query.all) q.set("all", "1");
    const qs = q.size ? `?${q}` : "";
    return this.request<Boon[]>("GET", `/projects/${enc(project)}/boons${qs}`);
  }

  createBoon(project: string, input: NewBoonInput) {
    return this.request<Boon>("POST", `/projects/${enc(project)}/boons`, input);
  }

  ready(project: string, spec?: string) {
    return this.request<Boon[]>("GET", `/projects/${enc(project)}/ready${specQuery(spec)}`);
  }

  blocked(project: string, spec?: string) {
    return this.request<{ boon: Boon; reasons: Reason[] }[]>("GET", `/projects/${enc(project)}/blocked${specQuery(spec)}`);
  }

  createSpec(project: string, title: string, text: string) {
    return this.request<Spec>("POST", `/projects/${enc(project)}/specs`, { title, text });
  }

  listSpecs(project: string) {
    return this.request<Spec[]>("GET", `/projects/${enc(project)}/specs`);
  }

  getSpec(id: string) {
    return this.request<Spec>("GET", `/specs/${enc(id)}`);
  }

  updateSpec(id: string, changes: { title?: string; text?: string }) {
    return this.request<Spec>("PATCH", `/specs/${enc(id)}`, changes);
  }

  addLink(id: string, target: string, kind: string) {
    return this.request<BoonDetail>("POST", `/boons/${enc(id)}/links`, { target, kind });
  }

  removeLink(id: string, target: string, kind: string) {
    return this.request<BoonDetail>("DELETE", `/boons/${enc(id)}/links/${enc(kind)}/${enc(target)}`);
  }

  claimNext(project: string, spec?: string) {
    return this.request<Boon | null>("POST", `/projects/${enc(project)}/claim`, spec === undefined ? undefined : { spec });
  }

  getBoon(id: string) {
    return this.request<BoonDetail>("GET", `/boons/${enc(id)}`);
  }

  claim(id: string) {
    return this.request<Boon>("POST", `/boons/${enc(id)}/claim`);
  }

  unclaim(id: string) {
    return this.request<Boon>("POST", `/boons/${enc(id)}/unclaim`);
  }

  close(id: string, reason?: string, force = false) {
    return this.request<Boon>("POST", `/boons/${enc(id)}/close`, { reason, force });
  }

  reopen(id: string) {
    return this.request<Boon>("POST", `/boons/${enc(id)}/reopen`);
  }

  update(id: string, changes: BoonChangesInput) {
    return this.request<Boon>("PATCH", `/boons/${enc(id)}`, changes);
  }

  heartbeat(id: string) {
    return this.request<Boon>("POST", `/boons/${enc(id)}/heartbeat`);
  }

  defer(id: string, until?: string) {
    return this.request<Boon>("POST", `/boons/${enc(id)}/defer`, { until });
  }

  undefer(id: string) {
    return this.request<Boon>("POST", `/boons/${enc(id)}/undefer`);
  }

  comment(id: string, body: string) {
    return this.request<Comment>("POST", `/boons/${enc(id)}/comments`, { body });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "X-Boons-Actor": this.opts.actor };
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
      throw new BoonsError(
        "unreachable",
        `cannot reach boons server at ${this.opts.url} (is \`bn serve\` running?)`,
        0,
      );
    }
    const data = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const error = data?.error;
      throw new BoonsError(error?.code ?? "http_error", error?.message ?? `HTTP ${res.status}`, res.status, error?.reasons);
    }
    return data as T;
  }
}

const enc = encodeURIComponent;
const specQuery = (spec?: string) => (spec === undefined ? "" : `?spec=${enc(spec)}`);
