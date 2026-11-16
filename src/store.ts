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
  spec: string | null;
  /** Sorted; inert markers that never affect readiness or claims. */
  labels: string[];
  /** Only a human works it: claiming the next ready boon never hands it out. */
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

/** An agreement about a body of work that boons can point to. */
export interface Spec {
  id: string;
  project: string;
  title: string;
  text: string;
  version: number;
  created_by: string;
  created_at: string;
}

/** An exact find/replace on a spec text or boon description. */
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

export interface Comment {
  id: number;
  boon_id: string;
  author: string;
  body: string;
  created_at: string;
}

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
  comments: Comment[];
}

export interface NewBoon {
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
}

export interface NewSpec {
  title?: unknown;
  text?: unknown;
}

/** Fields `update` may change; absent fields are left alone. */
export interface BoonChanges {
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

/** Only boons with all of `label` and none of `exclude_label`. */
export interface LabelFilter {
  label?: string[];
  exclude_label?: string[];
}

/** A label filter; with `human`, only human boons. */
export interface ReadyFilter extends LabelFilter {
  human?: boolean;
}

export interface ListFilter extends ReadyFilter {
  status?: string[];
  type?: string;
  all?: boolean;
  parent?: string;
  spec?: string;
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
  // Claims taken before this migration get their expiry in migrate(), using the store's clock and TTL.
  `
  ALTER TABLE boons ADD COLUMN claim_expires_at TEXT;
  ALTER TABLE boons ADD COLUMN defer_until TEXT;
  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    boon_id    TEXT NOT NULL REFERENCES boons(id),
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_boon ON comments(boon_id);
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
  ALTER TABLE boons ADD COLUMN spec TEXT REFERENCES specs(id);
  CREATE INDEX boons_spec ON boons(spec);
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
    boon_id TEXT NOT NULL REFERENCES boons(id),
    label   TEXT NOT NULL,
    PRIMARY KEY (boon_id, label)
  );
  CREATE INDEX labels_label ON labels(label);
  `,
  `
  ALTER TABLE boons ADD COLUMN human INTEGER NOT NULL DEFAULT 0 CHECK (human IN (0, 1));
  `,
];

const PROJECT_COLUMNS = "prefix, name, created_at";
const BOON_COLUMNS =
  "id, project, title, description, type, priority, status, claimed_by, claimed_at, claim_expires_at, defer_until, " +
  "created_by, created_at, updated_at, closed_by, closed_at, close_reason, parent, spec, human, " +
  "(SELECT json_group_array(label) FROM labels WHERE boon_id = boons.id) AS labels";
const SPEC_COLUMNS = "id, project, title, text, version, created_by, created_at";
const COMMENT_COLUMNS = "id, boon_id, author, body, created_at";
const CLEAR_CLAIM = "claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL";
const READY_ORDER = "ORDER BY priority, created_at, number";

const PREFIX_RE = /^[a-z][a-z0-9]{1,2}$/;
export const LABEL_RE = /^[a-z0-9][a-z0-9._:-]*$/;
export const LABEL_MAX = 50;

export interface StoreOptions {
  path: string;
  now?: () => Date;
  /** How long a claim lasts without activity by its holder. Default 60. */
  claimTtlMinutes?: number;
}

export class Store {
  private db: Database;
  private now: () => Date;
  private ttlMs: number;

  constructor({ path, now = () => new Date(), claimTtlMinutes = 60 }: StoreOptions) {
    if (!validClaimTtl(claimTtlMinutes, now().getTime())) throw new Error(`claim TTL must be positive and produce a four-digit-year expiry, got ${claimTtlMinutes}`);
    this.now = now;
    this.ttlMs = claimTtlMinutes * 60_000;
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.transaction(() => this.migrate()).immediate();
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
      const spec = input.spec == null ? null : this.specReference(input.spec, p.prefix);
      const labels = input.labels === undefined ? [] : checkLabels(input.labels, "labels");
      const human = input.human === undefined ? false : checkHuman(input.human);

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
      this.db.query("UPDATE boons SET parent = ?, spec = ?, human = ? WHERE id = ?").run(parent, spec, human ? 1 : 0, id);
      for (const target of blockers) this.insertLink(id, target, "blocks");
      if (discovered) this.insertLink(id, discovered, "discovered-from");
      this.changeLabels(id, labels, []);
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
      const summaries = (ids: string[]) => [...new Set(ids)]
        .map((id) => graph.boons.get(id)!)
        .sort((a, b) => a.project.localeCompare(b.project) || Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]))
        .map(summary);
      const outgoing = (kind: LinkKind) => graph.links.filter((l) => l.boon_id === boon.id && l.kind === kind).map((l) => l.target_id);
      const incoming = (kind: LinkKind) => graph.links.filter((l) => l.target_id === boon.id && l.kind === kind).map((l) => l.boon_id);
      const comments = this.db.query(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE boon_id = ? ORDER BY id`).all(boon.id) as Comment[];
      return {
        boon, ...this.readiness(boon, graph),
        parent: boon.parent ? summary(graph.boons.get(boon.parent)!) : null,
        children: summaries([...graph.boons.values()].filter((b) => b.parent === boon.id).map((b) => b.id)),
        blockers: summaries(outgoing("blocks")), blocks: summaries(incoming("blocks")),
        related: summaries([...outgoing("related"), ...incoming("related")]),
        discovered_from: summaries(outgoing("discovered-from")), discovered: summaries(incoming("discovered-from")),
        comments,
      };
    });
  }

  /** Changes a boon's fields; status changes go through claim/close/defer instead. */
  update(id: string, actor: string, changes: BoonChanges): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (typeof changes !== "object" || changes === null) throw badRequest("changes must be an object");
      const unknown = Object.keys(changes).filter((k) => !CHANGEABLE.includes(k));
      if (unknown.length) throw badRequest(`cannot update ${unknown.join(", ")}; updatable fields: ${CHANGEABLE.join(", ")}`);
      const sets: Record<string, string | number | null> = {};
      if (changes.title !== undefined) sets.title = checkTitle(changes.title);
      if (changes.description !== undefined) sets.description = checkDescription(changes.description);
      if (changes.type !== undefined) sets.type = checkType(changes.type);
      if (changes.priority !== undefined) sets.priority = checkPriority(changes.priority);
      if (changes.parent !== undefined) sets.parent = changes.parent === null ? null : this.reference(changes.parent);
      if (changes.spec !== undefined) sets.spec = changes.spec === null ? null : this.specReference(changes.spec, boon.project);
      if (changes.human !== undefined) sets.human = checkHuman(changes.human) ? 1 : 0;
      const add = changes.add_labels === undefined ? undefined : checkLabels(changes.add_labels, "add_labels");
      const remove = changes.remove_labels === undefined ? undefined : checkLabels(changes.remove_labels, "remove_labels");
      const both = add?.filter((l) => remove?.includes(l)) ?? [];
      if (both.length) throw badRequest(`cannot both add and remove label ${both.join(", ")}`);
      const keys = Object.keys(sets);
      if (!keys.length && !add && !remove) throw badRequest(`nothing to update; give at least one of ${CHANGEABLE.join(", ")}`);
      if (keys.length) this.db.query(`UPDATE boons SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(sets), boon.id);
      this.changeLabels(boon.id, add ?? [], remove ?? []);
      if ("parent" in sets) this.checkCycles();
      this.touch(boon, actor);
      return this.mustGet(boon.id);
    });
  }

  /** Exact find/replace on a boon's description (see applyEdits); read, check and write in one transaction. */
  editBoon(id: string, actor: string, edits: unknown): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      const description = applyEdits(boon.description, edits);
      this.db.query("UPDATE boons SET description = ? WHERE id = ?").run(description, boon.id);
      this.touch(boon, actor);
      return this.mustGet(boon.id);
    });
  }

  addComment(id: string, actor: string, body: unknown): Comment {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (typeof body !== "string" || !body.trim()) throw badRequest("comment body is required");
      const comment = this.db
        .query(`INSERT INTO comments (boon_id, author, body, created_at) VALUES (?, ?, ?, ?) RETURNING ${COMMENT_COLUMNS}`)
        .get(boon.id, actor, body.trim(), this.timestamp()) as Comment;
      this.touch(boon, actor);
      return comment;
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
      if (filter.spec !== undefined) {
        where.push("spec = ?");
        params.push(this.specReference(filter.spec, p.prefix));
      }
      readyFilterClauses(filter, where, params);
      return this.boons(`SELECT ${BOON_COLUMNS} FROM boons WHERE ${where.join(" AND ")} ORDER BY priority, number`, ...params);
    });
  }

  /** Ready boons of a project (only those pointing to `spec` and matching `filter`, if given), in the order they should be picked up. */
  ready(project: string, spec?: unknown, filter: ReadyFilter = {}): Boon[] {
    return this.op(() => this.readyBoons(this.mustGetProject(project).prefix, spec, filter));
  }

  blocked(project: string, spec?: unknown): { boon: Boon; reasons: Reason[] }[] {
    return this.op(() => {
      const prefix = this.mustGetProject(project).prefix;
      const graph = this.graph();
      return this.orderedBoons(prefix, spec).filter((b) => b.status !== "closed" && b.status !== "deferred")
        .map((boon) => ({ boon, reasons: this.readiness(boon, graph).reasons }))
        .filter((entry) => entry.reasons.some((r) => r.kind !== "deferred_ancestor"));
    });
  }

  addLink(id: string, target: unknown, kind: unknown, actor: string): BoonDetail {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      const targetId = this.reference(target);
      const linkKind = checkLinkKind(kind);
      this.insertLink(boon.id, targetId, linkKind);
      if (linkKind === "blocks") this.checkCycles();
      this.touch(boon, actor);
      return this.getDetail(boon.id);
    });
  }

  removeLink(id: string, target: unknown, kind: unknown, actor: string): BoonDetail {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      const targetId = this.reference(target);
      const linkKind = checkLinkKind(kind);
      if (boon.id === targetId) throw badRequest("a boon cannot link to itself");
      this.db.query("DELETE FROM links WHERE boon_id = ? AND target_id = ? AND kind = ?").run(boon.id, targetId, linkKind);
      if (linkKind === "related") {
        this.db.query("DELETE FROM links WHERE boon_id = ? AND target_id = ? AND kind = ?").run(targetId, boon.id, linkKind);
      }
      this.touch(boon, actor);
      return this.getDetail(boon.id);
    });
  }

  // --- specs ---

  createSpec(project: string, actor: string, input: NewSpec): Spec {
    return this.op(() => {
      actor = checkActor(actor);
      const p = this.mustGetProject(project);
      const title = checkTitle(input.title);
      const text = checkSpecText(input.text);
      const { n } = this.db
        .query("UPDATE projects SET next_spec_number = next_spec_number + 1 WHERE prefix = ? RETURNING next_spec_number - 1 AS n")
        .get(p.prefix) as { n: number };
      const spec = this.db
        .query(`INSERT INTO specs (id, project, number, title, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${SPEC_COLUMNS}`)
        .get(`${p.prefix}-s${n}`, p.prefix, n, title, text, actor, this.timestamp()) as Spec;
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
      this.db.query("UPDATE specs SET title = ?, text = ?, version = version + 1 WHERE id = ?").run(title, text, spec.id);
      const updated = this.mustGetSpec(spec.id);
      this.recordSpecVersion(updated, actor, "update", {
        ...(title !== spec.title ? { title } : {}),
        ...(text !== spec.text ? { text: "replaced" } : {}),
      });
      return updated;
    });
  }

  listSpecs(project: string): Spec[] {
    return this.op(() =>
      this.db.query(`SELECT ${SPEC_COLUMNS} FROM specs WHERE project = ? ORDER BY number`).all(this.mustGetProject(project).prefix) as Spec[],
    );
  }

  getSpec(id: string, version?: unknown): Spec {
    return this.op(() => {
      const spec = this.mustGetSpec(id);
      if (version === undefined) return spec;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw badRequest("version must be a positive integer");
      const snapshot = this.db.query("SELECT title, text, version FROM spec_versions WHERE spec_id = ? AND version = ?").get(spec.id, version) as Pick<Spec, "title" | "text" | "version"> | null;
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
      this.db.query("UPDATE specs SET text = ?, version = version + 1 WHERE id = ?").run(text, spec.id);
      const updated = this.mustGetSpec(spec.id);
      this.recordSpecVersion(updated, actor, "edit", { edits });
      return updated;
    });
  }

  specHistory(id: string): SpecHistory[] {
    return this.op(() => {
      const spec = this.mustGetSpec(id);
      const rows = this.db.query("SELECT version, changed_by AS by, changed_at AS at, kind, change FROM spec_versions WHERE spec_id = ? ORDER BY version").all(spec.id) as (SpecHistory & { change: string | null })[];
      return rows.map(({ change, ...row }) => ({ ...row, ...(change === null ? {} : JSON.parse(change)) }));
    });
  }

  private recordSpecVersion(spec: Spec, actor: string, kind: SpecHistory["kind"], change: Record<string, unknown> | null, at = this.timestamp()) {
    this.db.query("INSERT INTO spec_versions (spec_id, version, title, text, kind, change, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(spec.id, spec.version, spec.title, spec.text, kind, change === null ? null : JSON.stringify(change), actor, at);
  }

  // --- claims ---

  claim(id: string, actor: string): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (boon.status === "in_progress") {
        if (boon.claimed_by === actor) return this.renew(boon.id);
        throw claimedBy(boon);
      }
      if (boon.status !== "open") throw conflict(`${boon.id} is ${boon.status} and cannot be claimed`, "not_claimable");
      const { ready, reasons } = this.readiness(boon);
      if (!ready) throw new BoonsError("not_ready", `${boon.id} is not ready: ${formatReasons(reasons)}`, 409, reasons);
      return this.claimBoon(boon.id, actor);
    });
  }

  /** Claims the first ready boon of the project (within `spec`, if given) that is not a human boon, or returns null if there is none. */
  claimNext(project: string, actor: string, spec?: unknown): Boon | null {
    return this.op(() => {
      actor = checkActor(actor);
      const next = this.readyBoons(this.mustGetProject(project).prefix, spec).find((boon) => !boon.human);
      return next ? this.claimBoon(next.id, actor) : null;
    });
  }

  /** Renews the claim; only its holder may do so. */
  heartbeat(id: string, actor: string): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (boon.status !== "in_progress") throw conflict(`${boon.id} is not claimed (status ${boon.status})`);
      if (boon.claimed_by !== actor) {
        throw conflict(`${boon.id} is claimed by ${boon.claimed_by}, not ${actor}; only the holder can heartbeat`, "claimed");
      }
      return this.renew(boon.id);
    });
  }

  unclaim(id: string, actor: string): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (boon.status !== "in_progress") throw conflict(`${boon.id} is not claimed`);
      this.db
        .query(`UPDATE boons SET status = 'open', ${CLEAR_CLAIM}, updated_at = ? WHERE id = ?`)
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
          `UPDATE boons SET status = 'closed', ${CLEAR_CLAIM}, defer_until = NULL,
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

  // --- defer ---

  /** Sets an open or in-progress boon aside, optionally until a future time; clears any claim. */
  defer(id: string, actor: string, until?: unknown): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (boon.status === "closed") throw conflict(`${boon.id} is closed and cannot be deferred`);
      let deferUntil: string | null = null;
      if (until !== undefined && until !== null) {
        const date = isoTime(until);
        if (isNaN(date.getTime()) || date.getUTCFullYear() > 9999) throw badRequest("until must be an ISO-8601 time");
        if (date <= this.now()) throw badRequest("until must be in the future");
        deferUntil = date.toISOString();
      }
      this.db
        .query(`UPDATE boons SET status = 'deferred', ${CLEAR_CLAIM}, defer_until = ?, updated_at = ? WHERE id = ?`)
        .run(deferUntil, this.timestamp(), boon.id);
      return this.mustGet(boon.id);
    });
  }

  undefer(id: string, actor: string): Boon {
    return this.op(() => {
      actor = checkActor(actor);
      const boon = this.mustGet(id);
      if (boon.status !== "deferred") throw conflict(`${boon.id} is not deferred`);
      this.db.query("UPDATE boons SET status = 'open', defer_until = NULL, updated_at = ? WHERE id = ?").run(this.timestamp(), boon.id);
      return this.mustGet(boon.id);
    });
  }

  // --- internals ---

  /** Every store operation runs in its own IMMEDIATE transaction, after applying lapsed claims and defers. */
  private op<T>(fn: () => T): T {
    return this.db.transaction(() => {
      this.applyTimeTransitions();
      return fn();
    }).immediate();
  }

  /** Lazy time-based transitions; each takes effect (updated_at) at the moment it lapsed. */
  private applyTimeTransitions() {
    const now = this.timestamp();
    this.db
      .query(`UPDATE boons SET status = 'open', ${CLEAR_CLAIM}, updated_at = claim_expires_at
              WHERE status = 'in_progress' AND claim_expires_at <= ?`)
      .run(now);
    this.db
      .query(`UPDATE boons SET status = 'open', defer_until = NULL, updated_at = defer_until
              WHERE status = 'deferred' AND defer_until <= ?`)
      .run(now);
  }

  private migrate() {
    const { user_version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (user_version > MIGRATIONS.length) {
      throw new Error(`database schema version ${user_version} is newer than this boons (${MIGRATIONS.length})`);
    }
    if (user_version === MIGRATIONS.length) return;
    for (const sql of MIGRATIONS.slice(user_version)) this.db.run(sql);
    this.db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
    // Claims from before claim expiry existed get a full TTL from now rather than lapsing at once.
    this.db.query("UPDATE boons SET claim_expires_at = ? WHERE status = 'in_progress' AND claim_expires_at IS NULL").run(this.expiry());
  }

  private timestamp() {
    return this.now().toISOString();
  }

  private expiry() {
    return new Date(this.now().getTime() + this.ttlMs).toISOString();
  }

  private renew(id: string): Boon {
    this.db.query("UPDATE boons SET claim_expires_at = ? WHERE id = ?").run(this.expiry(), id);
    return this.mustGet(id);
  }

  /** Records a change to the boon; activity by the claim holder renews the claim. */
  private touch(boon: Boon, actor: string) {
    this.db.query("UPDATE boons SET updated_at = ? WHERE id = ?").run(this.timestamp(), boon.id);
    if (boon.status === "in_progress" && boon.claimed_by === actor) this.renew(boon.id);
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
    const [boon] = this.boons(`SELECT ${BOON_COLUMNS} FROM boons WHERE id = ?`, id.trim().toLowerCase());
    if (!boon) throw notFound(`boon ${id} not found`);
    return boon;
  }

  /** Runs a query selecting BOON_COLUMNS, decoding each boon's labels and human flag. */
  private boons(sql: string, ...params: (string | number)[]): Boon[] {
    const rows = this.db.query(sql).all(...params) as (Omit<Boon, "labels" | "human"> & { labels: string; human: number })[];
    return rows.map((row) => ({ ...row, human: row.human === 1, labels: (JSON.parse(row.labels) as string[]).sort() }));
  }

  /** Adding a present label or removing a missing one is a no-op. */
  private changeLabels(id: string, add: string[], remove: string[]) {
    for (const label of add) this.db.query("INSERT OR IGNORE INTO labels (boon_id, label) VALUES (?, ?)").run(id, label);
    for (const label of remove) this.db.query("DELETE FROM labels WHERE boon_id = ? AND label = ?").run(id, label);
  }

  private reference(id: unknown): string {
    if (typeof id !== "string" || !id.trim()) throw badRequest("referenced id must be a non-empty string");
    return this.mustGet(id).id;
  }

  private mustGetSpec(id: string): Spec {
    const spec = this.db.query(`SELECT ${SPEC_COLUMNS} FROM specs WHERE id = ?`).get(id.trim().toLowerCase()) as Spec | null;
    if (!spec) throw notFound(`spec ${id} not found`);
    return spec;
  }

  /** A boon may only point to a spec of its own project. */
  private specReference(id: unknown, project: string): string {
    if (typeof id !== "string" || !id.trim()) throw badRequest("spec must be a non-empty string");
    const spec = this.mustGetSpec(id);
    if (spec.project !== project) throw badRequest(`spec ${spec.id} belongs to project ${spec.project}, not ${project}`);
    return spec.id;
  }

  private insertLink(id: string, target: string, kind: LinkKind) {
    if (id === target) throw badRequest("a boon cannot link to itself");
    if (kind === "related" && this.db.query("SELECT 1 FROM links WHERE boon_id = ? AND target_id = ? AND kind = 'related'").get(target, id)) return;
    this.db.query("INSERT OR IGNORE INTO links (boon_id, target_id, kind) VALUES (?, ?, ?)").run(id, target, kind);
  }

  private graph(): Graph {
    const boons = this.boons(`SELECT ${BOON_COLUMNS} FROM boons ORDER BY id`);
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

  /** Boons of the project in pickup order; with `spec`, only those pointing to it; with `filter`, only those matching. */
  private orderedBoons(prefix: string, spec?: unknown, filter: ReadyFilter = {}): Boon[] {
    const where = ["project = ?"];
    const params: string[] = [prefix];
    if (spec !== undefined) {
      where.push("spec = ?");
      params.push(this.specReference(spec, prefix));
    }
    readyFilterClauses(filter, where, params);
    return this.boons(`SELECT ${BOON_COLUMNS} FROM boons WHERE ${where.join(" AND ")} ${READY_ORDER}`, ...params);
  }

  /** Readiness is always derived from the whole graph, so a blocker outside the spec or filter still blocks. */
  private readyBoons(prefix: string, spec?: unknown, filter?: ReadyFilter): Boon[] {
    const graph = this.graph();
    return this.orderedBoons(prefix, spec, filter).filter((boon) => this.readiness(boon, graph).ready);
  }

  private claimBoon(id: string, actor: string): Boon {
    const now = this.timestamp();
    this.db
      .query("UPDATE boons SET status = 'in_progress', claimed_by = ?, claimed_at = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(actor, now, this.expiry(), now, id);
    return this.mustGet(id);
  }
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

function claimedBy(boon: Boon) {
  return conflict(`${boon.id} is already claimed by ${boon.claimed_by} (until ${boon.claim_expires_at})`, "claimed");
}

function summary({ id, title, status, type, priority }: Boon): BoonSummary {
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

/** Appends SQL conditions for a label filter on `boons`. */
function labelClauses(filter: LabelFilter, where: string[], params: (string | number)[]) {
  const has = "SELECT 1 FROM labels WHERE labels.boon_id = boons.id AND labels.label";
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

/** Appends SQL conditions for labels and, with `human`, only human boons. */
function readyFilterClauses(filter: ReadyFilter, where: string[], params: (string | number)[]) {
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

function checkType(v: unknown): BoonType {
  if (!isType(v)) throw badRequest(`type must be one of ${TYPES.join(", ")}`);
  return v;
}

function checkPriority(v: unknown): number {
  if (!isPriority(v)) throw badRequest("priority must be an integer from 0 to 4");
  return v;
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
