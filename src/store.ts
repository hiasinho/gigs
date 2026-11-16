import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "./sql";

export const TYPES = ["bug", "feature", "task", "epic", "chore"] as const;
export const STATUSES = ["open", "in_progress", "deferred", "closed"] as const;
export type GigType = (typeof TYPES)[number];
export type Status = (typeof STATUSES)[number];

export interface Project {
  prefix: string;
  name: string;
  created_at: string;
}

/** A project token's record; the plaintext is never stored, only its sha256. */
export interface Token {
  id: number;
  project: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface Gig {
  id: string;
  project: string;
  title: string;
  description: string;
  type: GigType;
  priority: number;
  status: Status;
  parent: string | null;
  spec: string | null;
  /** Sorted; inert markers that never affect readiness or claims. */
  labels: string[];
  /** Only a human works it: claiming the next ready gig never hands it out. */
  human: boolean;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  defer_until: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_by: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

export const SPEC_STATES = ["draft", "ready", "closed"] as const;
export type SpecState = (typeof SPEC_STATES)[number];
/** Derived at read time from the stored state and the spec's gigs; never stale. */
export type SpecStatus = "draft" | "ready" | "active" | "done" | "closed";

/** An agreement about a body of work that gigs can point to. */
export interface Spec {
  id: string;
  project: string;
  title: string;
  text: string;
  version: number;
  /** Stored: draft until marked ready; closed when abandoned. */
  state: SpecState;
  /** closed if closed; else active while any of its gigs is unfinished, done once all are closed; else the state. */
  status: SpecStatus;
  close_reason: string | null;
  closed_by: string | null;
  closed_at: string | null;
  created_by: string;
  created_at: string;
}

/** An exact find/replace on a spec text or gig description. */
export interface TextEdit { old: string; new: string }
export interface SpecHistory {
  version: number;
  by: string;
  at: string;
  kind: "create" | "update" | "edit";
  title?: string;
  text?: "replaced";
  edits?: TextEdit[];
}

/** Why an unfinished gig is blocked or has a deferred ancestor. */
export interface Reason {
  kind: "blocker" | "child" | "inherited" | "deferred_ancestor";
  id: string;
  via?: string;
}

export type GigSummary = Pick<Gig, "id" | "title" | "status" | "type" | "priority">;
export const LINK_KINDS = ["blocks", "related", "discovered-from"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
interface Link { gig_id: string; target_id: string; kind: LinkKind }
interface Graph { gigs: Map<string, Gig>; links: Link[] }

export interface Comment {
  id: number;
  gig_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface GigDetail {
  gig: Gig;
  ready: boolean;
  reasons: Reason[];
  parent: GigSummary | null;
  children: GigSummary[];
  blockers: GigSummary[];
  blocks: GigSummary[];
  related: GigSummary[];
  discovered_from: GigSummary[];
  discovered: GigSummary[];
  comments: Comment[];
}

export interface NewGig {
  title?: unknown;
  description?: unknown;
  type?: unknown;
  priority?: unknown;
  parent?: unknown;
  blocked_by?: unknown;
  discovered_from?: unknown;
  spec?: unknown;
  labels?: unknown;
  human?: unknown;
  /** Create the gig already deferred (implied by `defer_until`). */
  defer?: unknown;
  /** With defer: until when (null: until undeferred). */
  defer_until?: unknown;
}

export interface NewSpec {
  title?: unknown;
  text?: unknown;
}

/** Fields `update` may change; absent fields are left alone. */
export interface GigChanges {
  title?: unknown;
  description?: unknown;
  type?: unknown;
  priority?: unknown;
  parent?: unknown;
  spec?: unknown;
  add_labels?: unknown;
  remove_labels?: unknown;
  human?: unknown;
}
const CHANGEABLE = ["title", "description", "type", "priority", "parent", "spec", "add_labels", "remove_labels", "human"];

/** Only gigs with all of `label` and none of `exclude_label`. */
export interface LabelFilter {
  label?: string[];
  exclude_label?: string[];
}

/** A label filter; with `parent`, only that gig's descendants: the whole subtree, not the gig itself. */
export interface ClaimFilter extends LabelFilter {
  parent?: string;
}

/** A claim filter; with `human`, only human gigs. */
export interface ReadyFilter extends ClaimFilter {
  human?: boolean;
}

export interface ListFilter extends LabelFilter {
  /** Only human gigs. */
  human?: boolean;
  status?: string[];
  type?: string;
  all?: boolean;
  /** Direct children of this gig only (unlike ReadyFilter's whole subtree). */
  parent?: string;
  spec?: string;
}

export class GigsError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public reasons?: Reason[],
  ) {
    super(message);
  }
}

const badRequest = (message: string) => new GigsError("bad_request", message, 400);
const notFound = (message: string) => new GigsError("not_found", message, 404);
const conflict = (message: string, code = "conflict") => new GigsError(code, message, 409);

// Ordered; never edit an applied migration, append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE projects (
    prefix      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    next_number INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE gigs (
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
  CREATE INDEX gigs_project_status ON gigs (project, status);
  `,
  `
  ALTER TABLE gigs ADD COLUMN parent TEXT REFERENCES gigs(id);
  CREATE INDEX gigs_parent ON gigs(parent);
  CREATE TABLE links (
    gig_id TEXT NOT NULL REFERENCES gigs(id),
    target_id TEXT NOT NULL REFERENCES gigs(id),
    kind TEXT NOT NULL CHECK (kind IN ('blocks', 'related', 'discovered-from')),
    PRIMARY KEY (gig_id, target_id, kind)
  );
  `,
  // Claims taken before this migration get their expiry in migrate(), using the store's clock and TTL.
  `
  ALTER TABLE gigs ADD COLUMN claim_expires_at TEXT;
  ALTER TABLE gigs ADD COLUMN defer_until TEXT;
  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    gig_id    TEXT NOT NULL REFERENCES gigs(id),
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_gig ON comments(gig_id);
  `,
  `
  CREATE TABLE specs (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL REFERENCES projects(prefix),
    number     INTEGER NOT NULL,
    title      TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project, number)
  );
  ALTER TABLE projects ADD COLUMN next_spec_number INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE gigs ADD COLUMN spec TEXT REFERENCES specs(id);
  CREATE INDEX gigs_spec ON gigs(spec);
  `,
  `
  ALTER TABLE specs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE spec_versions (
    spec_id    TEXT NOT NULL REFERENCES specs(id),
    version    INTEGER NOT NULL,
    title      TEXT NOT NULL,
    text       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('create', 'update', 'edit')),
    change     TEXT,
    changed_by TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (spec_id, version)
  );
  INSERT INTO spec_versions (spec_id, version, title, text, kind, change, changed_by, changed_at)
    SELECT id, 1, title, text, 'create', NULL, created_by, created_at FROM specs;
  `,
  `
  CREATE TABLE labels (
    gig_id TEXT NOT NULL REFERENCES gigs(id),
    label   TEXT NOT NULL,
    PRIMARY KEY (gig_id, label)
  );
  CREATE INDEX labels_label ON labels(label);
  `,
  `
  ALTER TABLE gigs ADD COLUMN human INTEGER NOT NULL DEFAULT 0 CHECK (human IN (0, 1));
  `,
  `
  ALTER TABLE specs ADD COLUMN state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'ready', 'closed'));
  ALTER TABLE specs ADD COLUMN close_reason TEXT;
  ALTER TABLE specs ADD COLUMN closed_by TEXT;
  ALTER TABLE specs ADD COLUMN closed_at TEXT;
  `,
  `
  CREATE TABLE tokens (
    id         INTEGER PRIMARY KEY,
    project    TEXT NOT NULL REFERENCES projects(prefix),
    hash       TEXT NOT NULL UNIQUE,
    label      TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX tokens_project ON tokens(project);
  `,
];

const PROJECT_COLUMNS = "prefix, name, created_at";
const GIG_COLUMNS =
  "id, project, title, description, type, priority, status, claimed_by, claimed_at, claim_expires_at, defer_until, " +
  "created_by, created_at, updated_at, closed_by, closed_at, close_reason, parent, spec, human, " +
  "(SELECT json_group_array(label) FROM labels WHERE gig_id = gigs.id) AS labels";
/** A spec's derived status (see Spec.status), using the gigs_spec index. */
const SPEC_STATUS = `CASE WHEN specs.state = 'closed' THEN 'closed'
  WHEN EXISTS (SELECT 1 FROM gigs WHERE gigs.spec = specs.id AND gigs.status != 'closed') THEN 'active'
  WHEN EXISTS (SELECT 1 FROM gigs WHERE gigs.spec = specs.id) THEN 'done'
  ELSE specs.state END`;
const SPEC_COLUMNS = `id, project, title, text, version, state, (${SPEC_STATUS}) AS status, close_reason, closed_by, closed_at, created_by, created_at`;
const TOKEN_COLUMNS = "id, project, label, created_at, revoked_at";
const COMMENT_COLUMNS = "id, gig_id, author, body, created_at";
const CLEAR_CLAIM = "claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL";
const READY_ORDER = "ORDER BY priority, created_at, number";

const PREFIX_RE = /^[a-z][a-z0-9]{1,2}$/;
export const LABEL_RE = /^[a-z0-9][a-z0-9._:-]*$/;
export const LABEL_MAX = 50;

export interface StoreOptions {
  /** The database; the store owns it from here on (dispose closes it). See sql-bun.ts and sql-do.ts. */
  sql: Sql;
  now?: () => Date;
  /** How long a claim lasts without activity by its holder. Default 60. */
  claimTtlMinutes?: number;
}

export class Store {
  private sql: Sql;
  private now: () => Date;
  private ttlMs: number;

  constructor({ sql, now = () => new Date(), claimTtlMinutes = 60 }: StoreOptions) {
    if (!validClaimTtl(claimTtlMinutes, now().getTime())) {
      sql.close();
      throw new Error(`claim TTL must be positive and produce a four-digit-year expiry, got ${claimTtlMinutes}`);
    }
    this.now = now;
    this.ttlMs = claimTtlMinutes * 60_000;
    this.sql = sql;
    this.sql.transaction(() => this.migrate());
  }

  /** Closes the database connection. */
  dispose() {
    this.sql.close();
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
      this.sql.run("INSERT INTO projects (prefix, name, created_at) VALUES (?, ?, ?)", p, name?.trim() || p, this.timestamp());
      return this.findProject(p)!;
    });
  }

  listProjects(): Project[] {
    return this.op(() =>
      this.sql.all(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY prefix`) as Project[],
    );
  }

  getProject(prefix: string): Project {
    return this.op(() => this.mustGetProject(prefix));
  }

  // --- tokens ---

  /** A new token for the project; the plaintext `token` is returned here only, never stored. */
  createToken(project: string, label?: unknown): Token & { token: string } {
    return this.op(() => {
      const p = this.mustGetProject(project);
      if (label !== undefined && label !== null && typeof label !== "string") throw badRequest("label must be a string");
      const token = `gig_${randomBytes(32).toString("base64url")}`;
      const row = this.sql.get(`INSERT INTO tokens (project, hash, label, created_at) VALUES (?, ?, ?, ?) RETURNING ${TOKEN_COLUMNS}`, p.prefix, sha256(token), label?.trim() || null, this.timestamp()) as Token;
      return { ...row, token };
    });
  }

  /** All tokens of a project, revoked ones included. */
  listTokens(project: string): Token[] {
    return this.op(() =>
      this.sql.all(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE project = ? ORDER BY id`, this.mustGetProject(project).prefix) as Token[],
    );
  }

  revokeToken(id: unknown): Token {
    return this.op(() => {
      const token = this.sql.get(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE id = ?`, Number(id)) as Token | null;
      if (!token) throw notFound(`token ${id} not found`);
      if (token.revoked_at) throw conflict(`token ${token.id} is already revoked`);
      return this.sql.get(`UPDATE tokens SET revoked_at = ? WHERE id = ? RETURNING ${TOKEN_COLUMNS}`, this.timestamp(), token.id) as Token;
    });
  }

  /** The project a valid (unrevoked) token belongs to, or null. */
  tokenProject(token: string): string | null {
    const row = this.sql.get("SELECT project FROM tokens WHERE hash = ? AND revoked_at IS NULL", sha256(token)) as { project: string } | null;
    return row?.project ?? null;
  }

  // --- gigs ---

  createGig(project: string, actor: string, input: NewGig): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const p = this.mustGetProject(project);
      const title = checkTitle(input.title);
      const description = checkDescription(input.description === undefined ? "" : input.description);
      const type = checkType(input.type === undefined ? "task" : input.type);
      const priority = checkPriority(input.priority === undefined ? 2 : input.priority);
      const parent = input.parent == null ? null : this.reference(input.parent);
      if (input.blocked_by !== undefined && !Array.isArray(input.blocked_by)) {
        throw badRequest("blocked_by must be an array of ids");
      }
      const blockers = ((input.blocked_by ?? []) as unknown[]).map((id) => this.reference(id));
      const discovered = input.discovered_from == null ? null : this.reference(input.discovered_from);
      const spec = input.spec == null ? null : this.assignableSpec(input.spec, p.prefix);
      const labels = input.labels === undefined ? [] : checkLabels(input.labels, "labels");
      const human = input.human === undefined ? false : checkHuman(input.human);
      if (input.defer !== undefined && typeof input.defer !== "boolean") throw badRequest("defer must be a boolean");
      if (input.defer === false && input.defer_until != null) throw badRequest("defer_until requires defer");
      const deferUntil = this.deferUntil(input.defer_until);
      const deferred = input.defer === true || deferUntil !== null;

      const { next_number: n } = this.sql.get("UPDATE projects SET next_number = next_number + 1 WHERE prefix = ? RETURNING next_number - 1 AS next_number", p.prefix) as { next_number: number };
      const id = `${p.prefix}-${n}`;
      const now = this.timestamp();
      this.sql.run(`INSERT INTO gigs (id, project, number, title, description, type, priority, status, defer_until, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, p.prefix, n, title, description, type, priority, deferred ? "deferred" : "open", deferUntil, actor, now, now);
      this.sql.run("UPDATE gigs SET parent = ?, spec = ?, human = ? WHERE id = ?", parent, spec, human ? 1 : 0, id);
      for (const target of blockers) this.insertLink(id, target, "blocks");
      if (discovered) this.insertLink(id, discovered, "discovered-from");
      this.changeLabels(id, labels, []);
      this.checkCycles();
      return this.mustGet(id);
    });
  }

  getGig(id: string): Gig {
    return this.op(() => this.mustGet(id));
  }

  getDetail(id: string): GigDetail {
    return this.op(() => {
      const gig = this.mustGet(id);
      const graph = this.graph();
      const summaries = (ids: string[]) => [...new Set(ids)]
        .map((id) => graph.gigs.get(id)!)
        .sort((a, b) => a.project.localeCompare(b.project) || Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]))
        .map(summary);
      const outgoing = (kind: LinkKind) => graph.links.filter((l) => l.gig_id === gig.id && l.kind === kind).map((l) => l.target_id);
      const incoming = (kind: LinkKind) => graph.links.filter((l) => l.target_id === gig.id && l.kind === kind).map((l) => l.gig_id);
      const comments = this.sql.all(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE gig_id = ? ORDER BY id`, gig.id) as Comment[];
      return {
        gig, ...this.readiness(gig, graph),
        parent: gig.parent ? summary(graph.gigs.get(gig.parent)!) : null,
        children: summaries([...graph.gigs.values()].filter((b) => b.parent === gig.id).map((b) => b.id)),
        blockers: summaries(outgoing("blocks")), blocks: summaries(incoming("blocks")),
        related: summaries([...outgoing("related"), ...incoming("related")]),
        discovered_from: summaries(outgoing("discovered-from")), discovered: summaries(incoming("discovered-from")),
        comments,
      };
    });
  }

  /** Changes a gig's fields; status changes go through claim/close/defer instead. */
  update(id: string, actor: string, changes: GigChanges): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      if (typeof changes !== "object" || changes === null) throw badRequest("changes must be an object");
      const unknown = Object.keys(changes).filter((k) => !CHANGEABLE.includes(k));
      if (unknown.length) throw badRequest(`cannot update ${unknown.join(", ")}; updatable fields: ${CHANGEABLE.join(", ")}`);
      const sets: Record<string, string | number | null> = {};
      if (changes.title !== undefined) sets.title = checkTitle(changes.title);
      if (changes.description !== undefined) sets.description = checkDescription(changes.description);
      if (changes.type !== undefined) sets.type = checkType(changes.type);
      if (changes.priority !== undefined) sets.priority = checkPriority(changes.priority);
      if (changes.parent !== undefined) sets.parent = changes.parent === null ? null : this.reference(changes.parent);
      if (changes.spec !== undefined) {
        sets.spec = changes.spec === null ? null : this.specReference(changes.spec, gig.project);
        if (sets.spec !== null && sets.spec !== gig.spec) this.checkSpecAssignable(sets.spec);
      }
      if (changes.human !== undefined) sets.human = checkHuman(changes.human) ? 1 : 0;
      const add = changes.add_labels === undefined ? undefined : checkLabels(changes.add_labels, "add_labels");
      const remove = changes.remove_labels === undefined ? undefined : checkLabels(changes.remove_labels, "remove_labels");
      const both = add?.filter((l) => remove?.includes(l)) ?? [];
      if (both.length) throw badRequest(`cannot both add and remove label ${both.join(", ")}`);
      const keys = Object.keys(sets);
      if (!keys.length && !add && !remove) throw badRequest(`nothing to update; give at least one of ${CHANGEABLE.join(", ")}`);
      if (keys.length) this.sql.run(`UPDATE gigs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(sets), gig.id);
      this.changeLabels(gig.id, add ?? [], remove ?? []);
      if ("parent" in sets) this.checkCycles();
      this.touch(gig, actor);
      return this.mustGet(gig.id);
    });
  }

  /** Exact find/replace on a gig's description (see applyEdits); read, check and write in one transaction. */
  editGig(id: string, actor: string, edits: unknown): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      const description = applyEdits(gig.description, edits);
      this.sql.run("UPDATE gigs SET description = ? WHERE id = ?", description, gig.id);
      this.touch(gig, actor);
      return this.mustGet(gig.id);
    });
  }

  addComment(id: string, actor: string, body: unknown): Comment {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      if (typeof body !== "string" || !body.trim()) throw badRequest("comment body is required");
      const comment = this.sql.get(`INSERT INTO comments (gig_id, author, body, created_at) VALUES (?, ?, ?, ?) RETURNING ${COMMENT_COLUMNS}`, gig.id, actor, body.trim(), this.timestamp()) as Comment;
      this.touch(gig, actor);
      return comment;
    });
  }

  /** Gigs of a project. Default: unfinished only; `all` includes closed; `status` overrides both. */
  listGigs(project: string, filter: ListFilter = {}): Gig[] {
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
      if (filter.spec !== undefined) {
        where.push("spec = ?");
        params.push(this.specReference(filter.spec, p.prefix));
      }
      humanFilterClauses(filter, where, params);
      return this.gigs(`SELECT ${GIG_COLUMNS} FROM gigs WHERE ${where.join(" AND ")} ORDER BY priority, number`, ...params);
    });
  }

  /** Ready gigs of a project (only those pointing to `spec` and matching `filter`, if given), in the order they should be picked up. */
  ready(project: string, spec?: unknown, filter: ReadyFilter = {}): Gig[] {
    return this.op(() => this.readyGigs(this.mustGetProject(project).prefix, spec, filter));
  }

  blocked(project: string, spec?: unknown): { gig: Gig; reasons: Reason[] }[] {
    return this.op(() => {
      const prefix = this.mustGetProject(project).prefix;
      const graph = this.graph();
      return this.orderedGigs(prefix, spec).filter((b) => b.status !== "closed" && b.status !== "deferred")
        .map((gig) => ({ gig, reasons: this.readiness(gig, graph).reasons }))
        .filter((entry) => entry.reasons.some((r) => r.kind !== "deferred_ancestor"));
    });
  }

  addLink(id: string, target: unknown, kind: unknown, actor: string): GigDetail {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      const targetId = this.reference(target);
      const linkKind = checkLinkKind(kind);
      this.insertLink(gig.id, targetId, linkKind);
      if (linkKind === "blocks") this.checkCycles();
      this.touch(gig, actor);
      return this.getDetail(gig.id);
    });
  }

  removeLink(id: string, target: unknown, kind: unknown, actor: string): GigDetail {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      const targetId = this.reference(target);
      const linkKind = checkLinkKind(kind);
      if (gig.id === targetId) throw badRequest("a gig cannot link to itself");
      this.sql.run("DELETE FROM links WHERE gig_id = ? AND target_id = ? AND kind = ?", gig.id, targetId, linkKind);
      if (linkKind === "related") {
        this.sql.run("DELETE FROM links WHERE gig_id = ? AND target_id = ? AND kind = ?", targetId, gig.id, linkKind);
      }
      this.touch(gig, actor);
      return this.getDetail(gig.id);
    });
  }

  // --- specs ---

  createSpec(project: string, actor: string, input: NewSpec): Spec {
    return this.op(() => {
      actor = checkActor(actor);
      const p = this.mustGetProject(project);
      const title = checkTitle(input.title);
      const text = checkSpecText(input.text);
      const { n } = this.sql.get("UPDATE projects SET next_spec_number = next_spec_number + 1 WHERE prefix = ? RETURNING next_spec_number - 1 AS n", p.prefix) as { n: number };
      const id = `${p.prefix}-s${n}`;
      this.sql.run("INSERT INTO specs (id, project, number, title, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, p.prefix, n, title, text, actor, this.timestamp());
      const spec = this.mustGetSpec(id);
      this.recordSpecVersion(spec, actor, "create", null, spec.created_at);
      return spec;
    });
  }

  /** Changes a spec's title and/or text; absent fields are left alone. */
  updateSpec(id: string, actor: string, changes: NewSpec): Spec {
    return this.op(() => {
      actor = checkActor(actor);
      const spec = this.mustGetSpec(id);
      if (typeof changes !== "object" || changes === null) throw badRequest("changes must be an object");
      const unknown = Object.keys(changes).filter((k) => k !== "title" && k !== "text");
      if (unknown.length) throw badRequest(`cannot update ${unknown.join(", ")}; updatable fields: title, text`);
      const sets: Record<string, string> = {};
      if (changes.title !== undefined) sets.title = checkTitle(changes.title);
      if (changes.text !== undefined) sets.text = checkSpecText(changes.text);
      const keys = Object.keys(sets);
      if (!keys.length) throw badRequest("nothing to update; give at least one of title, text");
      const title = sets.title ?? spec.title;
      const text = sets.text ?? spec.text;
      if (title === spec.title && text === spec.text) return spec;
      this.sql.run("UPDATE specs SET title = ?, text = ?, version = version + 1 WHERE id = ?", title, text, spec.id);
      const updated = this.mustGetSpec(spec.id);
      this.recordSpecVersion(updated, actor, "update", {
        ...(title !== spec.title ? { title } : {}),
        ...(text !== spec.text ? { text: "replaced" } : {}),
      });
      return updated;
    });
  }

  /** Specs of a project. Default: draft, ready and active only; `all` includes done and closed. */
  listSpecs(project: string, filter: { all?: boolean } = {}): Spec[] {
    return this.op(() => {
      const where = filter.all ? "" : ` AND (${SPEC_STATUS}) NOT IN ('done', 'closed')`;
      return this.sql.all(`SELECT ${SPEC_COLUMNS} FROM specs WHERE project = ?${where} ORDER BY number`, this.mustGetProject(project).prefix) as Spec[];
    });
  }

  // State changes are not content: they bump no version and write no history.

  /** Marks a draft spec ready (the owner says it is final); idempotent. A closed spec must be reopened first. */
  readySpec(id: string, actor: string): Spec {
    return this.op(() => {
      checkActor(actor);
      const spec = this.mustGetSpec(id);
      if (spec.state === "closed") throw conflict(`spec ${spec.id} is closed; reopen it first: gig spec reopen ${spec.id}`, "spec_closed");
      if (spec.state === "ready") return spec;
      this.sql.run("UPDATE specs SET state = 'ready' WHERE id = ?", spec.id);
      return this.mustGetSpec(spec.id);
    });
  }

  /** Abandons a spec; refused while any of its gigs is unfinished. */
  closeSpec(id: string, actor: string, reason: unknown): Spec {
    return this.op(() => {
      actor = checkActor(actor);
      if (typeof reason !== "string" || !reason.trim()) throw badRequest("reason is required");
      const spec = this.mustGetSpec(id);
      if (spec.state === "closed") throw conflict(`spec ${spec.id} is already closed`);
      const unfinished = this.sql.all("SELECT id FROM gigs WHERE spec = ? AND status != 'closed' ORDER BY number", spec.id) as { id: string }[];
      if (unfinished.length) {
        throw conflict(`spec ${spec.id} has unfinished gigs: ${unfinished.map((g) => g.id).join(", ")}; close them or clear their spec (gig update <id> --spec none) first`, "spec_active");
      }
      this.sql.run("UPDATE specs SET state = 'closed', close_reason = ?, closed_by = ?, closed_at = ? WHERE id = ?", reason.trim(), actor, this.timestamp(), spec.id);
      return this.mustGetSpec(spec.id);
    });
  }

  /** Makes a closed spec a draft again; marking it ready is a deliberate second step. */
  reopenSpec(id: string, actor: string): Spec {
    return this.op(() => {
      checkActor(actor);
      const spec = this.mustGetSpec(id);
      if (spec.state !== "closed") throw conflict(`spec ${spec.id} is not closed`);
      this.sql.run("UPDATE specs SET state = 'draft', close_reason = NULL, closed_by = NULL, closed_at = NULL WHERE id = ?", spec.id);
      return this.mustGetSpec(spec.id);
    });
  }

  getSpec(id: string, version?: unknown): Spec {
    return this.op(() => {
      const spec = this.mustGetSpec(id);
      if (version === undefined) return spec;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw badRequest("version must be a positive integer");
      const snapshot = this.sql.get("SELECT title, text, version FROM spec_versions WHERE spec_id = ? AND version = ?", spec.id, version) as Pick<Spec, "title" | "text" | "version"> | null;
      if (!snapshot) throw notFound(`spec ${spec.id} version ${version} not found`);
      return { ...spec, ...snapshot };
    });
  }

  editSpec(id: string, actor: string, edits: unknown): Spec {
    return this.op(() => {
      actor = checkActor(actor);
      const spec = this.mustGetSpec(id);
      const text = applyEdits(spec.text, edits);
      checkSpecText(text);
      if (text === spec.text) return spec;
      this.sql.run("UPDATE specs SET text = ?, version = version + 1 WHERE id = ?", text, spec.id);
      const updated = this.mustGetSpec(spec.id);
      this.recordSpecVersion(updated, actor, "edit", { edits });
      return updated;
    });
  }

  specHistory(id: string): SpecHistory[] {
    return this.op(() => {
      const spec = this.mustGetSpec(id);
      const rows = this.sql.all("SELECT version, changed_by AS by, changed_at AS at, kind, change FROM spec_versions WHERE spec_id = ? ORDER BY version", spec.id) as (SpecHistory & { change: string | null })[];
      return rows.map(({ change, ...row }) => ({ ...row, ...(change === null ? {} : JSON.parse(change)) }));
    });
  }

  private recordSpecVersion(spec: Spec, actor: string, kind: SpecHistory["kind"], change: Record<string, unknown> | null, at = this.timestamp()) {
    this.sql.run("INSERT INTO spec_versions (spec_id, version, title, text, kind, change, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", spec.id, spec.version, spec.title, spec.text, kind, change === null ? null : JSON.stringify(change), actor, at);
  }

  // --- claims ---

  claim(id: string, actor: string): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      if (gig.status === "in_progress") {
        if (gig.claimed_by === actor) return this.renew(gig.id);
        throw claimedBy(gig);
      }
      if (gig.status !== "open") throw conflict(`${gig.id} is ${gig.status} and cannot be claimed`, "not_claimable");
      const { ready, reasons } = this.readiness(gig);
      if (!ready) throw new GigsError("not_ready", `${gig.id} is not ready: ${formatReasons(reasons)}`, 409, reasons);
      return this.claimGig(gig.id, actor);
    });
  }

  /**
   * Claims the first ready gig of the project (within `spec` and matching `filter`, if given, in `ready` order)
   * that is not a human gig, or returns null if there is none. Human gigs are skipped whatever the filter.
   */
  claimNext(project: string, actor: string, spec?: unknown, filter: ClaimFilter = {}): Gig | null {
    return this.op(() => {
      actor = checkActor(actor);
      const { label, exclude_label, parent } = filter;
      const next = this.readyGigs(this.mustGetProject(project).prefix, spec, { label, exclude_label, parent }).find((gig) => !gig.human);
      return next ? this.claimGig(next.id, actor) : null;
    });
  }

  /** Renews the claim; only its holder may do so. */
  heartbeat(id: string, actor: string): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      if (gig.status !== "in_progress") throw conflict(`${gig.id} is not claimed (status ${gig.status})`);
      if (gig.claimed_by !== actor) {
        throw conflict(`${gig.id} is claimed by ${gig.claimed_by}, not ${actor}; only the holder can heartbeat`, "claimed");
      }
      return this.renew(gig.id);
    });
  }

  unclaim(id: string, actor: string): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      if (gig.status !== "in_progress") throw conflict(`${gig.id} is not claimed`);
      this.sql.run(`UPDATE gigs SET status = 'open', ${CLEAR_CLAIM}, updated_at = ? WHERE id = ?`, this.timestamp(), gig.id);
      return this.mustGet(gig.id);
    });
  }

  // --- close / reopen ---

  close(id: string, actor: string, reason?: unknown, force: unknown = false): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      if (reason !== undefined && reason !== null && typeof reason !== "string") {
        throw badRequest("reason must be a string");
      }
      const gig = this.mustGet(id);
      if (gig.status === "closed") throw conflict(`${gig.id} is already closed`);
      if (typeof force !== "boolean") throw badRequest("force must be a boolean");
      const children = this.sql.all("SELECT id FROM gigs WHERE parent = ? AND status != 'closed'", gig.id) as { id: string }[];
      if (!force && children.length) throw conflict(`${gig.id} has unfinished children: ${children.map((c) => c.id).join(", ")}`, "has_open_children");
      const now = this.timestamp();
      this.sql.run(`UPDATE gigs SET status = 'closed', ${CLEAR_CLAIM}, defer_until = NULL,
             closed_by = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?`, actor, now, reason?.trim() || null, now, gig.id);
      return this.mustGet(gig.id);
    });
  }

  reopen(id: string): Gig {
    return this.op(() => {
      const gig = this.mustGet(id);
      if (gig.status !== "closed") throw conflict(`${gig.id} is not closed`);
      this.sql.run(`UPDATE gigs SET status = 'open', closed_by = NULL, closed_at = NULL, close_reason = NULL,
             updated_at = ? WHERE id = ?`, this.timestamp(), gig.id);
      return this.mustGet(gig.id);
    });
  }

  // --- defer ---

  /** Sets an open or in-progress gig aside, optionally until a future time; clears any claim. */
  defer(id: string, actor: string, until?: unknown): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      if (gig.status === "closed") throw conflict(`${gig.id} is closed and cannot be deferred`);
      const deferUntil = this.deferUntil(until);
      this.sql.run(`UPDATE gigs SET status = 'deferred', ${CLEAR_CLAIM}, defer_until = ?, updated_at = ? WHERE id = ?`, deferUntil, this.timestamp(), gig.id);
      return this.mustGet(gig.id);
    });
  }

  undefer(id: string, actor: string): Gig {
    return this.op(() => {
      actor = checkActor(actor);
      const gig = this.mustGet(id);
      if (gig.status !== "deferred") throw conflict(`${gig.id} is not deferred`);
      this.sql.run("UPDATE gigs SET status = 'open', defer_until = NULL, updated_at = ? WHERE id = ?", this.timestamp(), gig.id);
      return this.mustGet(gig.id);
    });
  }

  // --- internals ---

  /** A defer's end: absent/null means until undeferred; otherwise a future ISO time. */
  private deferUntil(until: unknown): string | null {
    if (until === undefined || until === null) return null;
    const date = isoTime(until);
    if (isNaN(date.getTime()) || date.getUTCFullYear() > 9999) throw badRequest("until must be an ISO-8601 time");
    if (date <= this.now()) throw badRequest("until must be in the future");
    return date.toISOString();
  }

  /** Every store operation runs in its own write transaction (IMMEDIATE on Bun), after applying lapsed claims and defers. */
  private op<T>(fn: () => T): T {
    return this.sql.transaction(() => {
      this.applyTimeTransitions();
      return fn();
    });
  }

  /** Lazy time-based transitions; each takes effect (updated_at) at the moment it lapsed. */
  private applyTimeTransitions() {
    const now = this.timestamp();
    this.sql.run(`UPDATE gigs SET status = 'open', ${CLEAR_CLAIM}, updated_at = claim_expires_at
              WHERE status = 'in_progress' AND claim_expires_at <= ?`, now);
    this.sql.run(`UPDATE gigs SET status = 'open', defer_until = NULL, updated_at = defer_until
              WHERE status = 'deferred' AND defer_until <= ?`, now);
  }

  private migrate() {
    const version = this.sql.version();
    if (version > MIGRATIONS.length) {
      throw new Error(`database schema version ${version} is newer than this gigs (${MIGRATIONS.length})`);
    }
    if (version === MIGRATIONS.length) return;
    for (const sql of MIGRATIONS.slice(version)) this.sql.exec(sql);
    this.sql.setVersion(MIGRATIONS.length);
    // Claims from before claim expiry existed get a full TTL from now rather than lapsing at once.
    this.sql.run("UPDATE gigs SET claim_expires_at = ? WHERE status = 'in_progress' AND claim_expires_at IS NULL", this.expiry());
  }

  private timestamp() {
    return this.now().toISOString();
  }

  private expiry() {
    return new Date(this.now().getTime() + this.ttlMs).toISOString();
  }

  private renew(id: string): Gig {
    this.sql.run("UPDATE gigs SET claim_expires_at = ? WHERE id = ?", this.expiry(), id);
    return this.mustGet(id);
  }

  /** Records a change to the gig; activity by the claim holder renews the claim. */
  private touch(gig: Gig, actor: string) {
    this.sql.run("UPDATE gigs SET updated_at = ? WHERE id = ?", this.timestamp(), gig.id);
    if (gig.status === "in_progress" && gig.claimed_by === actor) this.renew(gig.id);
  }

  private findProject(prefix: string): Project | null {
    return this.sql.get(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE prefix = ?`, prefix.trim().toLowerCase()) as Project | null;
  }

  private mustGetProject(prefix: string): Project {
    const p = this.findProject(prefix);
    if (!p) throw notFound(`project ${prefix} not found`);
    return p;
  }

  private mustGet(id: string): Gig {
    const [gig] = this.gigs(`SELECT ${GIG_COLUMNS} FROM gigs WHERE id = ?`, id.trim().toLowerCase());
    if (!gig) throw notFound(`gig ${id} not found`);
    return gig;
  }

  /** Runs a query selecting GIG_COLUMNS, decoding each gig's labels and human flag. */
  private gigs(sql: string, ...params: (string | number)[]): Gig[] {
    const rows = this.sql.all(sql, ...params) as (Omit<Gig, "labels" | "human"> & { labels: string; human: number })[];
    return rows.map((row) => ({ ...row, human: row.human === 1, labels: (JSON.parse(row.labels) as string[]).sort() }));
  }

  /** Adding a present label or removing a missing one is a no-op. */
  private changeLabels(id: string, add: string[], remove: string[]) {
    for (const label of add) this.sql.run("INSERT OR IGNORE INTO labels (gig_id, label) VALUES (?, ?)", id, label);
    for (const label of remove) this.sql.run("DELETE FROM labels WHERE gig_id = ? AND label = ?", id, label);
  }

  private reference(id: unknown): string {
    if (typeof id !== "string" || !id.trim()) throw badRequest("referenced id must be a non-empty string");
    return this.mustGet(id).id;
  }

  private mustGetSpec(id: string): Spec {
    const spec = this.sql.get(`SELECT ${SPEC_COLUMNS} FROM specs WHERE id = ?`, id.trim().toLowerCase()) as Spec | null;
    if (!spec) throw notFound(`spec ${id} not found`);
    return spec;
  }

  /** A gig may only point to a spec of its own project. */
  private specReference(id: unknown, project: string): string {
    if (typeof id !== "string" || !id.trim()) throw badRequest("spec must be a non-empty string");
    const spec = this.mustGetSpec(id);
    if (spec.project !== project) throw badRequest(`spec ${spec.id} belongs to project ${spec.project}, not ${project}`);
    return spec.id;
  }

  /** specReference plus the lifecycle rule for pointing a gig at a spec. */
  private assignableSpec(id: unknown, project: string): string {
    const spec = this.specReference(id, project);
    this.checkSpecAssignable(spec);
    return spec;
  }

  /** New work may only point at a ready or active spec. */
  private checkSpecAssignable(id: string) {
    const spec = this.mustGetSpec(id);
    if (spec.status === "draft") throw conflict(`spec ${spec.id} is a draft; mark it ready first: gig spec ready ${spec.id}`, "spec_draft");
    if (spec.status === "done") throw conflict(`spec ${spec.id} is done and is history; link the new gig with --discovered-from <gig> instead`, "spec_done");
    if (spec.status === "closed") throw conflict(`spec ${spec.id} is closed (abandoned); reopen it first (gig spec reopen ${spec.id}) or file the gig without --spec`, "spec_closed");
  }

  private insertLink(id: string, target: string, kind: LinkKind) {
    if (id === target) throw badRequest("a gig cannot link to itself");
    if (kind === "related" && this.sql.get("SELECT 1 FROM links WHERE gig_id = ? AND target_id = ? AND kind = 'related'", target, id)) return;
    this.sql.run("INSERT OR IGNORE INTO links (gig_id, target_id, kind) VALUES (?, ?, ?)", id, target, kind);
  }

  private graph(): Graph {
    const gigs = this.gigs(`SELECT ${GIG_COLUMNS} FROM gigs ORDER BY id`);
    return { gigs: new Map(gigs.map((b) => [b.id, b])), links: this.sql.all("SELECT * FROM links ORDER BY gig_id, target_id, kind") as Link[] };
  }

  private ancestors(gig: Gig, graph: Graph): Gig[] {
    const result: Gig[] = [];
    const seen = new Set([gig.id]);
    let parent = gig.parent;
    while (parent) {
      if (seen.has(parent)) throw conflict(`parent cycle: ${[gig.id, ...result.map((b) => b.id), parent].join(" -> ")}`, "cycle");
      seen.add(parent);
      const ancestor = graph.gigs.get(parent)!;
      result.push(ancestor);
      parent = ancestor.parent;
    }
    return result;
  }

  /** Structural checks include closed gigs, since they can be reopened. */
  private checkCycles() {
    const graph = this.graph();
    const edges = new Map<string, Set<string>>([...graph.gigs.keys()].map((id) => [id, new Set<string>()]));
    const blockers = (id: string) => graph.links.filter((l) => l.gig_id === id && l.kind === "blocks");
    for (const gig of graph.gigs.values()) {
      if (gig.parent) edges.get(gig.parent)!.add(gig.id);
      for (const link of blockers(gig.id)) edges.get(gig.id)!.add(link.target_id);
      for (const ancestor of this.ancestors(gig, graph)) {
        for (const link of blockers(ancestor.id)) edges.get(gig.id)!.add(link.target_id);
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
    for (const id of graph.gigs.keys()) visit(id);
  }

  private readiness(gig: Gig, graph = this.graph()): { ready: boolean; reasons: Reason[] } {
    const reasons: Reason[] = [];
    if (gig.status !== "closed") {
      const blockers = (id: string) => graph.links.filter((l) => l.gig_id === id && l.kind === "blocks" && graph.gigs.get(l.target_id)!.status !== "closed");
      for (const link of blockers(gig.id)) reasons.push({ kind: "blocker", id: link.target_id });
      for (const child of graph.gigs.values()) {
        if (child.parent === gig.id && child.status !== "closed") reasons.push({ kind: "child", id: child.id });
      }
      for (const ancestor of this.ancestors(gig, graph)) {
        for (const link of blockers(ancestor.id)) reasons.push({ kind: "inherited", id: link.target_id, via: ancestor.id });
        if (ancestor.status === "deferred") reasons.push({ kind: "deferred_ancestor", id: ancestor.id });
      }
    }
    return { ready: gig.status === "open" && reasons.length === 0, reasons };
  }

  /** Gigs of the project in pickup order; with `spec`, only those pointing to it; with `filter`, only those matching. */
  private orderedGigs(prefix: string, spec?: unknown, filter: ReadyFilter = {}): Gig[] {
    const where = ["project = ?"];
    const params: (string | number)[] = [prefix];
    if (spec !== undefined) {
      where.push("spec = ?");
      params.push(this.specReference(spec, prefix));
    }
    if (filter.parent !== undefined) {
      // Every descendant (children, grandchildren, ...), not the parent itself; parent cycles are rejected on write.
      where.push(`id IN (WITH RECURSIVE subtree(id) AS (SELECT id FROM gigs WHERE parent = ?
        UNION SELECT gigs.id FROM gigs JOIN subtree ON gigs.parent = subtree.id) SELECT id FROM subtree)`);
      params.push(this.reference(filter.parent));
    }
    humanFilterClauses(filter, where, params);
    return this.gigs(`SELECT ${GIG_COLUMNS} FROM gigs WHERE ${where.join(" AND ")} ${READY_ORDER}`, ...params);
  }

  /** Readiness is always derived from the whole graph, so a blocker outside the spec or filter still blocks. */
  private readyGigs(prefix: string, spec?: unknown, filter?: ReadyFilter): Gig[] {
    const graph = this.graph();
    return this.orderedGigs(prefix, spec, filter).filter((gig) => this.readiness(gig, graph).ready);
  }

  private claimGig(id: string, actor: string): Gig {
    const now = this.timestamp();
    this.sql.run("UPDATE gigs SET status = 'in_progress', claimed_by = ?, claimed_at = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?", actor, now, this.expiry(), now, id);
    return this.mustGet(id);
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Expiries must remain sortable as four-digit-year ISO timestamps in SQLite. */
export function validClaimTtl(minutes: number, now = Date.now()): boolean {
  const expiry = new Date(now + minutes * 60_000);
  return minutes > 0 && Number.isFinite(minutes) && Number.isFinite(expiry.getTime()) && expiry.getUTCFullYear() <= 9999;
}

function isoTime(value: unknown): Date {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return new Date(NaN);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (days[month - 1] ?? 0)) return new Date(NaN);
  return new Date(value as string);
}

export function formatReasons(reasons: Reason[]): string {
  return reasons.map((r) => {
    switch (r.kind) {
      case "blocker": return "blocked by " + r.id;
      case "child": return "child " + r.id + " unfinished";
      case "inherited": return "inherits blocker " + r.id + " via " + r.via;
      case "deferred_ancestor": return "ancestor " + r.id + " deferred";
    }
  }).join("; ");
}

function claimedBy(gig: Gig) {
  return conflict(`${gig.id} is already claimed by ${gig.claimed_by} (until ${gig.claim_expires_at})`, "claimed");
}

function summary({ id, title, status, type, priority }: Gig): GigSummary {
  return { id, title, status, type, priority };
}

function checkLinkKind(kind: unknown): LinkKind {
  if (!LINK_KINDS.includes(kind as LinkKind)) throw badRequest(`kind must be one of ${LINK_KINDS.join(", ")}`);
  return kind as LinkKind;
}

/** A list of unique labels, each lowercase without spaces: a letter or digit, then letters, digits, `.`, `_`, `:` or `-`. */
function checkLabels(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw badRequest(`${field} must be an array of labels`);
  for (const label of v) {
    if (typeof label !== "string" || !LABEL_RE.test(label) || label.length > LABEL_MAX) {
      throw badRequest(`invalid label ${JSON.stringify(label)}: use up to ${LABEL_MAX} lowercase letters, digits, '.', '_', ':' or '-', starting with a letter or digit`);
    }
  }
  return [...new Set(v as string[])];
}

/** Appends SQL conditions for a label filter on `gigs`. */
function labelClauses(filter: LabelFilter, where: string[], params: (string | number)[]) {
  const has = "SELECT 1 FROM labels WHERE labels.gig_id = gigs.id AND labels.label";
  for (const label of checkLabels(filter.label ?? [], "label")) {
    where.push(`EXISTS (${has} = ?)`);
    params.push(label);
  }
  const excluded = checkLabels(filter.exclude_label ?? [], "exclude_label");
  if (excluded.length) {
    where.push(`NOT EXISTS (${has} IN (${excluded.map(() => "?").join(", ")}))`);
    params.push(...excluded);
  }
}

/** Appends SQL conditions for labels and, with `human`, only human gigs. */
function humanFilterClauses(filter: LabelFilter & { human?: unknown }, where: string[], params: (string | number)[]) {
  labelClauses(filter, where, params);
  if (filter.human !== undefined && typeof filter.human !== "boolean") throw badRequest("human must be a boolean");
  if (filter.human) where.push("human = 1");
}

function checkHuman(v: unknown): boolean {
  if (typeof v !== "boolean") throw badRequest("human must be a boolean");
  return v;
}

function checkSpecText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) throw badRequest("text is required");
  return text;
}

function checkActor(actor: string): string {
  if (typeof actor !== "string" || !actor.trim()) throw badRequest("actor is required");
  return actor.trim();
}

function checkTitle(v: unknown): string {
  const title = typeof v === "string" ? v.trim() : "";
  if (!title) throw badRequest("title is required");
  return title;
}

/**
 * Applies exact find/replace edits in order, all-or-nothing: each `old` must be non-empty and occur
 * exactly once in the text at its step, so an edit based on a stale read fails instead of clobbering.
 */
function applyEdits(text: string, edits: unknown): string {
  if (!Array.isArray(edits) || !edits.length) throw badRequest("edits must be a non-empty array of {old,new}");
  for (const [i, edit] of edits.entries()) {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit) ||
      typeof edit.old !== "string" || !edit.old.length || typeof edit.new !== "string" ||
      Object.keys(edit).some((key) => key !== "old" && key !== "new")) {
      throw badRequest(`edit ${i + 1}: expected {old,new} strings with non-empty old`);
    }
    let count = 0;
    let at = text.indexOf(edit.old);
    const first = at;
    while (at !== -1) {
      count++;
      at = text.indexOf(edit.old, at + 1);
    }
    if (!count) throw conflict(`edit ${i + 1}: old text not found`, "edit_conflict");
    if (count > 1) throw conflict(`edit ${i + 1}: old text found ${count} times; include more context`, "edit_conflict");
    text = text.slice(0, first) + edit.new + text.slice(first + edit.old.length);
  }
  return text;
}

function checkDescription(v: unknown): string {
  if (typeof v !== "string") throw badRequest("description must be a string");
  return v;
}

function checkType(v: unknown): GigType {
  if (!isType(v)) throw badRequest(`type must be one of ${TYPES.join(", ")}`);
  return v;
}

function checkPriority(v: unknown): number {
  if (!isPriority(v)) throw badRequest("priority must be an integer from 0 to 4");
  return v;
}

function isType(v: unknown): v is GigType {
  return TYPES.includes(v as GigType);
}

function isStatus(v: unknown): v is Status {
  return STATUSES.includes(v as Status);
}

function isPriority(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4;
}
