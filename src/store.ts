import { Database } from "bun:sqlite";

export const TYPES = ["bug", "feature", "task", "epic", "chore"] as const;
export const STATUSES = ["open", "in_progress", "deferred", "closed"] as const;
export type BoonType = (typeof TYPES)[number];
export type Status = (typeof STATUSES)[number];

export interface Project {
  prefix: string;
  name: string;
  created_at: string;
}

export interface Boon {
  id: string;
  project: string;
  title: string;
  description: string;
  type: BoonType;
  priority: number;
  status: Status;
  parent: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_by: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

/** Why an unfinished boon is blocked or has a deferred ancestor. */
export interface Reason {
  kind: "blocker" | "child" | "inherited" | "deferred_ancestor";
  id: string;
  via?: string;
}

export type BoonSummary = Pick<Boon, "id" | "title" | "status" | "type" | "priority">;
export const LINK_KINDS = ["blocks", "related", "discovered-from"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
interface Link { boon_id: string; target_id: string; kind: LinkKind }
interface Graph { boons: Map<string, Boon>; links: Link[] }

export interface BoonDetail {
  boon: Boon;
  ready: boolean;
  reasons: Reason[];
  parent: BoonSummary | null;
  children: BoonSummary[];
  blockers: BoonSummary[];
  blocks: BoonSummary[];
  related: BoonSummary[];
  discovered_from: BoonSummary[];
  discovered: BoonSummary[];
}

export interface NewBoon {
  title?: unknown;
  description?: unknown;
  type?: unknown;
  priority?: unknown;
  parent?: unknown;
  blocked_by?: unknown;
  discovered_from?: unknown;
}

export interface ListFilter {
  status?: string[];
  type?: string;
  all?: boolean;
  parent?: string;
}

export class BoonsError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public reasons?: Reason[],
  ) {
    super(message);
  }
}

const badRequest = (message: string) => new BoonsError("bad_request", message, 400);
const notFound = (message: string) => new BoonsError("not_found", message, 404);
const conflict = (message: string, code = "conflict") => new BoonsError(code, message, 409);

// Ordered; never edit an applied migration, append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE projects (
    prefix      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    next_number INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE boons (
    id           TEXT PRIMARY KEY,
    project      TEXT NOT NULL REFERENCES projects(prefix),
    number       INTEGER NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL CHECK (type IN ('bug', 'feature', 'task', 'epic', 'chore')),
    priority     INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
    status       TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'deferred', 'closed')),
    claimed_by   TEXT,
    claimed_at   TEXT,
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    closed_by    TEXT,
    closed_at    TEXT,
    close_reason TEXT,
    UNIQUE (project, number)
  );
  CREATE INDEX boons_project_status ON boons (project, status);
  `,
  `
  ALTER TABLE boons ADD COLUMN parent TEXT REFERENCES boons(id);
  CREATE INDEX boons_parent ON boons(parent);
  CREATE TABLE links (
    boon_id TEXT NOT NULL REFERENCES boons(id),
    target_id TEXT NOT NULL REFERENCES boons(id),
    kind TEXT NOT NULL CHECK (kind IN ('blocks', 'related', 'discovered-from')),
    PRIMARY KEY (boon_id, target_id, kind)
  );
  `,
];

const PROJECT_COLUMNS = "prefix, name, created_at";
const BOON_COLUMNS =
  "id, project, title, description, type, priority, status, claimed_by, claimed_at, " +
  "created_by, created_at, updated_at, closed_by, closed_at, close_reason, parent";
const READY_ORDER = "ORDER BY priority, created_at, number";

const PREFIX_RE = /^[a-z][a-z0-9]{1,2}$/;

export interface StoreOptions {
  path: string;
  now?: () => Date;
}

export class Store {
  private db: Database;
  private now: () => Date;

  constructor({ path, now = () => new Date() }: StoreOptions) {
    this.now = now;
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.op(() => this.migrate());
  }

  /** Closes the database connection. */
  dispose() {
    this.db.close();
  }

  // --- projects ---

  createProject(prefix: unknown, name?: unknown): Project {
    return this.op(() => {
      if (typeof prefix !== "string" || !PREFIX_RE.test(prefix.trim().toLowerCase())) {
        throw badRequest("prefix must be 2-3 characters: a letter followed by letters or digits");
      }
      const p = prefix.trim().toLowerCase();
      if (name !== undefined && name !== null && typeof name !== "string") {
        throw badRequest("name must be a string");
      }
      if (this.findProject(p)) throw conflict(`project ${p} already exists`);
      this.db
        .query("INSERT INTO projects (prefix, name, created_at) VALUES (?, ?, ?)")
        .run(p, name?.trim() || p, this.timestamp());
      return this.findProject(p)!;
    });
  }

  listProjects(): Project[] {
    return this.op(() =>
      this.db.query(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY prefix`).all() as Project[],
    );
  }

  getProject(prefix: string): Project {
    return this.op(() => this.mustGetProject(prefix));
  }

  // --- boons ---

  createBoon(project: string, actor: string, input: NewBoon): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const p = this.mustGetProject(project);
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) throw badRequest("title is required");
      const description = input.description ?? "";
      if (typeof description !== "string") throw badRequest("description must be a string");
      const type = input.type ?? "task";
      if (!isType(type)) throw badRequest(`type must be one of ${TYPES.join(", ")}`);
      const priority = input.priority ?? 2;
      if (!isPriority(priority)) throw badRequest("priority must be an integer from 0 to 4");
      const parent = input.parent == null ? null : this.reference(input.parent);
      if (input.blocked_by !== undefined && !Array.isArray(input.blocked_by)) {
        throw badRequest("blocked_by must be an array of ids");
      }
      const blockers = ((input.blocked_by ?? []) as unknown[]).map((id) => this.reference(id));
      const discovered = input.discovered_from == null ? null : this.reference(input.discovered_from);

      const { next_number: n } = this.db
        .query("UPDATE projects SET next_number = next_number + 1 WHERE prefix = ? RETURNING next_number - 1 AS next_number")
        .get(p.prefix) as { next_number: number };
      const id = `${p.prefix}-${n}`;
      const now = this.timestamp();
      this.db
        .query(
          `INSERT INTO boons (id, project, number, title, description, type, priority, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(id, p.prefix, n, title, description, type, priority, actor, now, now);
      this.db.query("UPDATE boons SET parent = ? WHERE id = ?").run(parent, id);
      for (const target of blockers) this.insertLink(id, target, "blocks");
      if (discovered) this.insertLink(id, discovered, "discovered-from");
      this.checkCycles();
      return this.mustGet(id);
    });
  }

  getBoon(id: string): Boon {
    return this.op(() => this.mustGet(id));
  }

  getDetail(id: string): BoonDetail {
    return this.op(() => {
      const boon = this.mustGet(id);
      const graph = this.graph();
      const summaries = (ids: string[]) => [...new Set(ids)].map((id) => summary(graph.boons.get(id)!));
      const outgoing = (kind: LinkKind) => graph.links.filter((l) => l.boon_id === boon.id && l.kind === kind).map((l) => l.target_id);
      const incoming = (kind: LinkKind) => graph.links.filter((l) => l.target_id === boon.id && l.kind === kind).map((l) => l.boon_id);
      return {
        boon, ...this.readiness(boon, graph),
        parent: boon.parent ? summary(graph.boons.get(boon.parent)!) : null,
        children: summaries([...graph.boons.values()].filter((b) => b.parent === boon.id).map((b) => b.id)),
        blockers: summaries(outgoing("blocks")), blocks: summaries(incoming("blocks")),
        related: summaries([...outgoing("related"), ...incoming("related")]),
        discovered_from: summaries(outgoing("discovered-from")), discovered: summaries(incoming("discovered-from")),
      };
    });
  }

  /** Boons of a project. Default: unfinished only; `all` includes closed; `status` overrides both. */
  listBoons(project: string, filter: ListFilter = {}): Boon[] {
    return this.op(() => {
      const p = this.mustGetProject(project);
      const where = ["project = ?"];
      const params: (string | number)[] = [p.prefix];
      if (filter.status?.length) {
        for (const s of filter.status) {
          if (!isStatus(s)) throw badRequest(`status must be one of ${STATUSES.join(", ")}`);
        }
        where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
        params.push(...filter.status);
      } else if (!filter.all) {
        where.push("status != 'closed'");
      }
      if (filter.parent !== undefined) {
        where.push("parent = ?");
        params.push(filter.parent.trim().toLowerCase());
      }
      if (filter.type !== undefined) {
        if (!isType(filter.type)) throw badRequest(`type must be one of ${TYPES.join(", ")}`);
        where.push("type = ?");
        params.push(filter.type);
      }
      return this.db
        .query(`SELECT ${BOON_COLUMNS} FROM boons WHERE ${where.join(" AND ")} ORDER BY priority, number`)
        .all(...params) as Boon[];
    });
  }

  /** Ready boons of a project, in the order they should be picked up. */
  ready(project: string): Boon[] {
    return this.op(() => this.readyBoons(this.mustGetProject(project).prefix));
  }

  blocked(project: string): { boon: Boon; reasons: Reason[] }[] {
    return this.op(() => {
      const prefix = this.mustGetProject(project).prefix;
      const graph = this.graph();
      return this.orderedBoons(prefix).filter((b) => b.status !== "closed" && b.status !== "deferred")
        .map((boon) => ({ boon, reasons: this.readiness(boon, graph).reasons }))
        .filter((entry) => entry.reasons.some((r) => r.kind !== "deferred_ancestor"));
    });
  }

  addLink(id: string, target: unknown, kind: unknown, actor: string): BoonDetail {
    return this.op(() => {
      checkActor(actor);
      const boon = this.mustGet(id);
      const targetId = this.reference(target);
      const linkKind = checkLinkKind(kind);
      this.insertLink(boon.id, targetId, linkKind);
      if (linkKind === "blocks") this.checkCycles();
      this.db.query("UPDATE boons SET updated_at = ? WHERE id = ?").run(this.timestamp(), boon.id);
      return this.getDetail(boon.id);
    });
  }

  removeLink(id: string, target: unknown, kind: unknown, actor: string): BoonDetail {
    return this.op(() => {
      checkActor(actor);
      const boon = this.mustGet(id);
      const targetId = this.reference(target);
      const linkKind = checkLinkKind(kind);
      if (boon.id === targetId) throw badRequest("a boon cannot link to itself");
      this.db.query("DELETE FROM links WHERE boon_id = ? AND target_id = ? AND kind = ?").run(boon.id, targetId, linkKind);
      if (linkKind === "related") {
        this.db.query("DELETE FROM links WHERE boon_id = ? AND target_id = ? AND kind = ?").run(targetId, boon.id, linkKind);
      }
      this.db.query("UPDATE boons SET updated_at = ? WHERE id = ?").run(this.timestamp(), boon.id);
      return this.getDetail(boon.id);
    });
  }

  // --- claims ---

  claim(id: string, actor: string): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (boon.status === "in_progress") {
        if (boon.claimed_by === actor) return boon;
        throw conflict(`${boon.id} is already claimed by ${boon.claimed_by} (since ${boon.claimed_at})`, "claimed");
      }
      if (boon.status !== "open") throw conflict(`${boon.id} is ${boon.status} and cannot be claimed`, "not_claimable");
      const { ready, reasons } = this.readiness(boon);
      if (!ready) throw new BoonsError("not_ready", `${boon.id} is not ready: ${JSON.stringify(reasons)}`, 409, reasons);
      return this.claimBoon(boon.id, actor);
    });
  }

  /** Claims the first ready boon of the project, or returns null if there is none. */
  claimNext(project: string, actor: string): Boon | null {
    return this.op(() => {
      actor = checkActor(actor);
      const [next] = this.readyBoons(this.mustGetProject(project).prefix);
      return next ? this.claimBoon(next.id, actor) : null;
    });
  }

  unclaim(id: string, actor: string): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (boon.status !== "in_progress") throw conflict(`${boon.id} is not claimed`);
      this.db
        .query("UPDATE boons SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?")
        .run(this.timestamp(), boon.id);
      return this.mustGet(boon.id);
    });
  }

  // --- close / reopen ---

  close(id: string, actor: string, reason?: unknown, force: unknown = false): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      if (reason !== undefined && reason !== null && typeof reason !== "string") {
        throw badRequest("reason must be a string");
      }
      const boon = this.mustGet(id);
      if (boon.status === "closed") throw conflict(`${boon.id} is already closed`);
      if (typeof force !== "boolean") throw badRequest("force must be a boolean");
      const children = this.db.query("SELECT id FROM boons WHERE parent = ? AND status != 'closed'").all(boon.id) as { id: string }[];
      if (!force && children.length) throw conflict(`${boon.id} has unfinished children: ${children.map((c) => c.id).join(", ")}`, "has_open_children");
      const now = this.timestamp();
      this.db
        .query(
          `UPDATE boons SET status = 'closed', claimed_by = NULL, claimed_at = NULL,
             closed_by = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?`,
        )
        .run(actor, now, reason?.trim() || null, now, boon.id);
      return this.mustGet(boon.id);
    });
  }

  reopen(id: string): Boon {
    return this.op(() => {
      const boon = this.mustGet(id);
      if (boon.status !== "closed") throw conflict(`${boon.id} is not closed`);
      this.db
        .query(
          `UPDATE boons SET status = 'open', closed_by = NULL, closed_at = NULL, close_reason = NULL,
             updated_at = ? WHERE id = ?`,
        )
        .run(this.timestamp(), boon.id);
      return this.mustGet(boon.id);
    });
  }

  // --- internals ---

  /** Every store operation runs in its own IMMEDIATE transaction. */
  private op<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private migrate() {
    const { user_version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (user_version > MIGRATIONS.length) {
      throw new Error(`database schema version ${user_version} is newer than this boons (${MIGRATIONS.length})`);
    }
    if (user_version === MIGRATIONS.length) return;
    for (const sql of MIGRATIONS.slice(user_version)) this.db.run(sql);
    this.db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }

  private timestamp() {
    return this.now().toISOString();
  }

  private findProject(prefix: string): Project | null {
    return this.db
      .query(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE prefix = ?`)
      .get(prefix.trim().toLowerCase()) as Project | null;
  }

  private mustGetProject(prefix: string): Project {
    const p = this.findProject(prefix);
    if (!p) throw notFound(`project ${prefix} not found`);
    return p;
  }

  private mustGet(id: string): Boon {
    const boon = this.db
      .query(`SELECT ${BOON_COLUMNS} FROM boons WHERE id = ?`)
      .get(id.trim().toLowerCase()) as Boon | null;
    if (!boon) throw notFound(`boon ${id} not found`);
    return boon;
  }

  private reference(id: unknown): string {
    if (typeof id !== "string" || !id.trim()) throw badRequest("referenced id must be a non-empty string");
    return this.mustGet(id).id;
  }

  private insertLink(id: string, target: string, kind: LinkKind) {
    if (id === target) throw badRequest("a boon cannot link to itself");
    if (kind === "related" && this.db.query("SELECT 1 FROM links WHERE boon_id = ? AND target_id = ? AND kind = 'related'").get(target, id)) return;
    this.db.query("INSERT OR IGNORE INTO links (boon_id, target_id, kind) VALUES (?, ?, ?)").run(id, target, kind);
  }

  private graph(): Graph {
    const boons = this.db.query(`SELECT ${BOON_COLUMNS} FROM boons ORDER BY id`).all() as Boon[];
    return { boons: new Map(boons.map((b) => [b.id, b])), links: this.db.query("SELECT * FROM links ORDER BY boon_id, target_id, kind").all() as Link[] };
  }

  private ancestors(boon: Boon, graph: Graph): Boon[] {
    const result: Boon[] = [];
    const seen = new Set([boon.id]);
    let parent = boon.parent;
    while (parent) {
      if (seen.has(parent)) throw conflict(`parent cycle: ${[boon.id, ...result.map((b) => b.id), parent].join(" -> ")}`, "cycle");
      seen.add(parent);
      const ancestor = graph.boons.get(parent)!;
      result.push(ancestor);
      parent = ancestor.parent;
    }
    return result;
  }

  /** Structural checks include closed boons, since they can be reopened. */
  private checkCycles() {
    const graph = this.graph();
    const edges = new Map<string, Set<string>>([...graph.boons.keys()].map((id) => [id, new Set<string>()]));
    const blockers = (id: string) => graph.links.filter((l) => l.boon_id === id && l.kind === "blocks");
    for (const boon of graph.boons.values()) {
      if (boon.parent) edges.get(boon.parent)!.add(boon.id);
      for (const link of blockers(boon.id)) edges.get(boon.id)!.add(link.target_id);
      for (const ancestor of this.ancestors(boon, graph)) {
        for (const link of blockers(ancestor.id)) edges.get(boon.id)!.add(link.target_id);
      }
    }
    const done = new Set<string>();
    const active = new Set<string>();
    const path: string[] = [];
    const visit = (id: string) => {
      if (active.has(id)) throw conflict(`wait cycle: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}`, "cycle");
      if (done.has(id)) return;
      active.add(id);
      path.push(id);
      for (const target of edges.get(id)!) visit(target);
      path.pop();
      active.delete(id);
      done.add(id);
    };
    for (const id of graph.boons.keys()) visit(id);
  }

  private readiness(boon: Boon, graph = this.graph()): { ready: boolean; reasons: Reason[] } {
    const reasons: Reason[] = [];
    if (boon.status !== "closed") {
      const blockers = (id: string) => graph.links.filter((l) => l.boon_id === id && l.kind === "blocks" && graph.boons.get(l.target_id)!.status !== "closed");
      for (const link of blockers(boon.id)) reasons.push({ kind: "blocker", id: link.target_id });
      for (const child of graph.boons.values()) {
        if (child.parent === boon.id && child.status !== "closed") reasons.push({ kind: "child", id: child.id });
      }
      for (const ancestor of this.ancestors(boon, graph)) {
        for (const link of blockers(ancestor.id)) reasons.push({ kind: "inherited", id: link.target_id, via: ancestor.id });
        if (ancestor.status === "deferred") reasons.push({ kind: "deferred_ancestor", id: ancestor.id });
      }
    }
    return { ready: boon.status === "open" && reasons.length === 0, reasons };
  }

  private orderedBoons(prefix: string): Boon[] {
    return this.db.query(`SELECT ${BOON_COLUMNS} FROM boons WHERE project = ? ${READY_ORDER}`).all(prefix) as Boon[];
  }

  private readyBoons(prefix: string): Boon[] {
    const graph = this.graph();
    return this.orderedBoons(prefix).filter((boon) => this.readiness(boon, graph).ready);
  }

  private claimBoon(id: string, actor: string): Boon {
    const now = this.timestamp();
    this.db
      .query("UPDATE boons SET status = 'in_progress', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?")
      .run(actor, now, now, id);
    return this.mustGet(id);
  }
}

function summary({ id, title, status, type, priority }: Boon): BoonSummary {
  return { id, title, status, type, priority };
}

function checkLinkKind(kind: unknown): LinkKind {
  if (!LINK_KINDS.includes(kind as LinkKind)) throw badRequest(`kind must be one of ${LINK_KINDS.join(", ")}`);
  return kind as LinkKind;
}

function checkActor(actor: string): string {
  if (typeof actor !== "string" || !actor.trim()) throw badRequest("actor is required");
  return actor.trim();
}

function isType(v: unknown): v is BoonType {
  return TYPES.includes(v as BoonType);
}

function isStatus(v: unknown): v is Status {
  return STATUSES.includes(v as Status);
}

function isPriority(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4;
}
