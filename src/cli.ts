#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BINDING_FILE, type Binding, connection, findBinding, readBinding, tokenHint, writeBinding } from "./binding";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Client, type GigChangesInput } from "./client";
import { configFromEnv, serve } from "./server";
import { GigsError, formatReasons as reasonText, type Gig, type GigDetail, type GigSummary, type LinkKind, type Project, type Spec, type TextEdit, type Token } from "./store";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | undefined>;

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  human: { type: "boolean" },
  full: { type: "boolean" },
  as: { type: "string" },
  project: { type: "string", short: "P" },
  help: { type: "boolean", short: "h" },
} satisfies Options;

const LABEL_OPTIONS = { label: { type: "string" }, "exclude-label": { type: "string" } } satisfies Options;
const FILTER_OPTIONS = { ...LABEL_OPTIONS, "human-only": { type: "boolean" } } satisfies Options;

interface Ctx {
  args: string[];
  values: Values;
  json: boolean;
  full: boolean;
  /** Print JSON: `shape(raw)` by default, the raw API response with --full. */
  print<T>(raw: T, shape?: (raw: T) => unknown): void;
  client(): Client;
  /** The server the client talks to. */
  url: string;
  project(): string;
}

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  /** Accept `--no-<flag>` for boolean options. */
  allowNegative?: boolean;
  run(ctx: Ctx): Promise<void>;
}

const COMMANDS: Record<string, Command> = {
  serve: {
    usage: "serve",
    summary: "start the server (env: GIGS_HOST, GIGS_PORT, GIGS_DB, GIGS_ADMIN_TOKEN, GIGS_CLAIM_TTL_MINUTES; GIGS_ADMIN_TOKEN turns auth on)",
    async run() {
      const config = configFromEnv();
      const server = serve(config);
      console.log(`gigs listening on ${server.url} (db: ${config.db})`);
    },
  },

  init: {
    usage: "init <prefix> [--name <name>]",
    summary: "create the project if missing (else just bind to it) and write this directory's binding: ./.gigs.json with the project (and \"url\" unless the server is the built-in default); when the server has auth on and you use the admin token, also a new project token in ./.gigs.local.json (kept if the binding already has one), which a git repo's ./.gitignore then lists",
    options: { name: { type: "string" } },
    async run({ args, values, json, print, client, url }) {
      const prefix = arg(args, 0, "prefix");
      const c = client();
      let project: Project;
      let created = true;
      try {
        project = await c.createProject(prefix, values.name as string | undefined);
      } catch (err) {
        // A project token may bind to its own project but not create one.
        if (!(err instanceof GigsError && (err.code === "conflict" || err.code === "forbidden"))) throw err;
        project = await c.getProject(prefix);
        created = false;
        if (values.name !== undefined && values.name !== project.name) {
          console.error(`warning: project ${project.prefix} already exists as "${project.name}"; --name ignored`);
        }
      }
      const existing = readBinding(process.cwd());
      let token = existing?.project === project.prefix ? existing.token : undefined;
      let minted: Token | undefined;
      if (!token && (await c.health()).auth) {
        try {
          const created = await c.createToken(project.prefix, "init");
          ({ token, ...minted } = created);
        } catch (err) {
          // A project token cannot mint tokens; the caller already has one.
          if (!(err instanceof GigsError && err.code === "forbidden")) throw err;
        }
      }
      const written = writeBinding(process.cwd(), { project: project.prefix, url, token });
      if (json) return print(project, (p) => compact({ ...p, token_id: minted?.id }));
      console.log(`${created ? "created" : "bound existing"} project ${project.prefix} (${project.name}); wrote ${written.join(", ")}${minted ? " (with a new token)" : ""}`);
    },
  },

  token: {
    usage: "token add [--label x] | token list | token revoke <id>",
    summary: "manage the project's tokens; needs the admin token. `add` prints the new token, the only time it is shown; `list` never shows tokens; revoked tokens stop working at once",
    options: { label: { type: "string" } },
    async run({ args, values, json, print, client, project }) {
      const action = arg(args, 0, "add|list|revoke");
      if (values.label !== undefined && action !== "add") throw new Error("--label only works with token add");
      if (args.length > (action === "revoke" ? 2 : 1)) throw new Error("too many arguments (see `gig token --help`)");
      if (action === "add") {
        const token = await client().createToken(project(), values.label as string | undefined);
        if (json) return print(token, (t) => ({ ...tokenRow(t), token: t.token }));
        return console.log(token.token);
      }
      if (action === "list") {
        const tokens = await client().listTokens(project());
        if (json) return print(tokens, (list) => list.map(tokenRow));
        return console.log(tokens.length ? tokens.map((t) => `${t.id}  ${t.revoked_at ? "revoked" : "active "}  ${t.created_at}  ${t.label ?? ""}`.trimEnd()).join("\n") : "no tokens");
      }
      if (action === "revoke") {
        const token = await client().revokeToken(arg(args, 1, "id"));
        if (json) return print(token, tokenRow);
        return console.log(`revoked token ${token.id}`);
      }
      throw new Error("expected `gig token add|list|revoke`");
    },
  },

  projects: {
    usage: "projects",
    summary: "list projects",
    async run({ json, print, client }) {
      const projects = await client().listProjects();
      if (json) return print(projects);
      if (!projects.length) return console.log("no projects");
      const w = Math.max(...projects.map((p) => p.prefix.length));
      for (const p of projects) console.log(`${p.prefix.padEnd(w)}  ${p.name}`);
    },
  },

  create: {
    usage: "create <title> [-t type] [-p 0-4] [-d desc|-] [--parent id] [--blocked-by id[,id]] [--discovered-from id] [--spec id] [--label l[,l]] [--human-only] [--defer] [--until <ISO time|YYYY-MM-DD|30m|4h|2d>]",
    summary: "create a gig (`-d -` reads the description from stdin; with --spec, in the spec's project; --human-only: a human gig, never handed out by `gig claim` without an id; --defer: created deferred, never claimable in between, --until implies it)",
    options: {
      type: { type: "string", short: "t" },
      priority: { type: "string", short: "p" },
      description: { type: "string", short: "d" },
      parent: { type: "string" },
      "blocked-by": { type: "string" },
      "discovered-from": { type: "string" },
      spec: { type: "string" },
      label: { type: "string" },
      "human-only": { type: "boolean" },
      defer: { type: "boolean" },
      until: { type: "string" },
    },
    async run({ args, values, json, print, client, project }) {
      const title = args.join(" ");
      if (!title.trim()) throw new Error("missing <title>");
      // `--defer 4h` would otherwise silently append "4h" to the title and defer indefinitely.
      const afterDefer = process.argv[process.argv.indexOf("--defer") + 1];
      if (values.defer === true && afterDefer !== undefined && /^(\d+[mhd]|\d{4}-\d{2}-\d{2}\S*)$/.test(afterDefer)) {
        throw new Error(`--defer takes no value; to defer until ${afterDefer}, use --until ${afterDefer}`);
      }
      const description = await readText(values.description as string | undefined);
      const gig = await client().createGig(project(), {
        title,
        description,
        type: values.type as string | undefined,
        priority: values.priority === undefined ? undefined : parsePriority(values.priority as string),
        parent: values.parent as string | undefined,
        blocked_by: (values["blocked-by"] as string | undefined)?.split(","),
        discovered_from: values["discovered-from"] as string | undefined,
        spec: values.spec as string | undefined,
        labels: labelList(values.label),
        human: values["human-only"] === true ? true : undefined,
        defer: values.defer === true || values.until !== undefined ? true : undefined,
        defer_until: values.until === undefined ? undefined : parseUntil(values.until as string),
      });
      if (json) return print(gig, row);
      console.log(gig.id);
    },
  },

  list: {
    usage: "list [--all] [--status s[,s]] [--type t] [--parent id] [--spec id] [--label l[,l]] [--exclude-label l[,l]] [--human-only]",
    summary: "list gigs (default: unfinished; --parent: direct children only; --label: has all of them, --exclude-label: has none of them; --human-only: only human gigs)",
    options: {
      all: { type: "boolean" },
      status: { type: "string" },
      type: { type: "string" },
      parent: { type: "string" },
      spec: { type: "string" },
      ...FILTER_OPTIONS,
    },
    async run({ values, json, print, client, project }) {
      const gigs = await client().listGigs(project(), {
        all: values.all as boolean | undefined,
        status: values.status as string | undefined,
        parent: values.parent as string | undefined,
        type: values.type as string | undefined,
        spec: values.spec as string | undefined,
        ...filterQuery(values),
      });
      if (json) return print(gigs, (list) => list.map(row));
      console.log(gigs.length ? rows(gigs) : "no gigs");
    },
  },

  ready: {
    usage: "ready [--spec id] [--parent id] [--label l[,l]] [--exclude-label l[,l]] [--human-only]",
    summary: "ready gigs in priority order (--parent: the whole subtree, i.e. all descendants, not the gig itself; --human-only: only human gigs, the human's queue)",
    options: { spec: { type: "string" }, parent: { type: "string" }, ...FILTER_OPTIONS },
    async run({ values, json, print, client, project }) {
      const gigs = await client().ready(project(), values.spec as string | undefined, { ...filterQuery(values), parent: values.parent as string | undefined });
      if (json) return print(gigs, (list) => list.map(row));
      console.log(gigs.length ? rows(gigs) : "no ready gigs");
    },
  },

  blocked: {
    usage: "blocked [--spec id]",
    summary: "blocked gigs with reasons",
    options: { spec: { type: "string" } },
    async run({ values, json, print, client, project }) {
      const blocked = await client().blocked(project(), values.spec as string | undefined);
      if (json) return print(blocked, (list) => list.map(({ gig, reasons }) => ({ ...row(gig), reasons })));
      console.log(blocked.length ? blocked.map(({ gig, reasons }) => `${rows([gig])}\n  ${reasonText(reasons)}`).join("\n") : "no blocked gigs");
    },
  },

  dep: {
    usage: "dep add|rm <id> <target-id> [--kind blocks|related|discovered-from]",
    summary: "add/remove a link (default: target blocks id)",
    options: { kind: { type: "string" } },
    async run({ args, values, json, print, client }) {
      const action = arg(args, 0, "add|rm");
      if (action !== "add" && action !== "rm") throw new Error("expected `gig dep add` or `gig dep rm`");
      const id = arg(args, 1, "id");
      const target = arg(args, 2, "target-id");
      const kind = (values.kind as string | undefined) ?? "blocks";
      const c = client();
      const detail = action === "add" ? await c.addLink(id, target, kind) : await c.removeLink(id, target, kind);
      if (json) return print(detail, (d) => row(d.gig));
      const phrase = { blocks: "blocked by", related: "related to", "discovered-from": "discovered from" }[kind as LinkKind];
      console.log(`${detail.gig.id} is ${action === "add" ? "now" : "no longer"} ${phrase} ${target.toLowerCase()}`);
    },
  },

  label: {
    usage: "label add|rm <id> <label...>",
    summary: "add or remove labels: inert markers, lowercase without spaces, e.g. needs-triage or triage:needs-info (adding a present or removing a missing label is a no-op; any status)",
    async run({ args, json, print, client }) {
      const action = arg(args, 0, "add|rm");
      if (action !== "add" && action !== "rm") throw new Error("expected `gig label add` or `gig label rm`");
      const id = arg(args, 1, "id");
      const labels = labelList(args.slice(2).join(","));
      if (!labels?.length) throw new Error("missing <label>");
      const gig = await client().update(id, action === "add" ? { add_labels: labels } : { remove_labels: labels });
      if (json) return print(gig, row);
      console.log(`${gig.id} labels: ${gig.labels.join(", ") || "none"}`);
    },
  },

  show: {
    usage: "show <id> [--full]",
    summary: "show a compact gig (--full shows everything)",
    async run({ args, json, full, print, client }) {
      const detail = await client().getGig(arg(args, 0, "id"));
      if (json) return print(detail, compactShow);
      console.log(full ? showDetail(detail) : showCompactDetail(detail));
    },
  },

  update: {
    usage: "update <id> [--title t] [-d desc|-] [-t type] [-p n] [--parent id|none] [--spec id|none] [--add-label l[,l]] [--remove-label l[,l]] [--human-only|--no-human-only]",
    summary: "change a gig's fields (`none` clears the parent or spec; --human-only makes it a human gig, --no-human-only makes it an ordinary one)",
    options: {
      title: { type: "string" },
      description: { type: "string", short: "d" },
      type: { type: "string", short: "t" },
      priority: { type: "string", short: "p" },
      parent: { type: "string" },
      spec: { type: "string" },
      "add-label": { type: "string" },
      "remove-label": { type: "string" },
      "human-only": { type: "boolean" },
    },
    allowNegative: true,
    async run({ args, values, json, print, client }) {
      const id = arg(args, 0, "id");
      const changes: GigChangesInput = {
        title: values.title as string | undefined,
        description: await readText(values.description as string | undefined),
        type: values.type as string | undefined,
        priority: values.priority === undefined ? undefined : parsePriority(values.priority as string),
        parent: values.parent === "none" ? null : (values.parent as string | undefined),
        spec: values.spec === "none" ? null : (values.spec as string | undefined),
        add_labels: labelList(values["add-label"]),
        remove_labels: labelList(values["remove-label"]),
        human: values["human-only"] as boolean | undefined,
      };
      if (Object.values(changes).every((v) => v === undefined)) throw new Error("nothing to update (see `gig update --help`)");
      const gig = await client().update(id, changes);
      if (json) return print(gig, row);
      console.log(`updated ${gig.id}`);
    },
  },

  edit: {
    usage: "edit <id> --old text --new text | edit <id> -",
    summary: "replace exact text in a gig's description; each old text must occur exactly once (`-` reads a JSON array of {old,new} from stdin)",
    options: { old: { type: "string" }, new: { type: "string" } },
    async run({ args, values, json, print, client }) {
      const id = arg(args, 0, "id");
      const gig = await client().editGig(id, await readEdits(args.slice(1), values, "edit"));
      if (json) return print(gig, row);
      console.log(`edited ${gig.id}`);
    },
  },

  claim: {
    usage: "claim [id] | claim [--spec id] [--parent id] [--label l[,l]] [--exclude-label l[,l]]",
    summary: "claim the given gig, or the first gig of `gig ready` with the same filters that is not a human gig (--parent: the whole subtree; filters only without an id)",
    options: { spec: { type: "string" }, parent: { type: "string" }, ...LABEL_OPTIONS },
    async run({ args, values, json, full, print, client, project }) {
      const filters = ["spec", "parent", "label", "exclude-label"].filter((f) => values[f] !== undefined);
      if (args[0] && filters.length) {
        throw new Error(`${filters.map((f) => `--${f}`).join(", ")} only work${filters.length === 1 ? "s" : ""} with \`gig claim\` without an id`);
      }
      const c = client();
      const gig = args[0] ? await c.claim(args[0]) : await c.claimNext(project(), values.spec as string | undefined, {
        label: values.label as string | undefined,
        exclude_label: values["exclude-label"] as string | undefined,
        parent: values.parent as string | undefined,
      });
      if (json) return print(gig && !full ? compactShow(await c.getGig(gig.id)) : gig);
      console.log(gig ? `claimed ${gig.id}: ${gig.title}` : "no ready gigs");
    },
  },

  unclaim: {
    usage: "unclaim <id>",
    summary: "release the claim on a gig",
    async run({ args, json, print, client }) {
      const gig = await client().unclaim(arg(args, 0, "id"));
      if (json) return print(gig, row);
      console.log(`unclaimed ${gig.id}`);
    },
  },

  heartbeat: {
    usage: "heartbeat <id>",
    summary: "renew your claim on a gig",
    async run({ args, json, print, client }) {
      const gig = await client().heartbeat(arg(args, 0, "id"));
      if (json) return print(gig, row);
      console.log(`claim on ${gig.id} renewed until ${gig.claim_expires_at}`);
    },
  },

  close: {
    usage: "close <id...> [-r reason] [--force]",
    summary: "close one or more gigs",
    options: { reason: { type: "string", short: "r" }, force: { type: "boolean" } },
    async run({ args, values, json, print, client }) {
      arg(args, 0, "id");
      const c = client();
      const closed: Gig[] = [];
      let failed = false;
      for (const id of args) {
        try {
          const gig = await c.close(id, values.reason as string | undefined, values.force === true);
          closed.push(gig);
          if (!json) console.log(`closed ${gig.id}`);
        } catch (err) {
          if (args.length === 1) throw err;
          console.error(`error: ${errorMessage(err)}`);
          failed = true;
        }
      }
      if (json) {
        if (args.length === 1) print(closed[0]!, row);
        else print(closed, (list) => list.map(row));
      }
      if (failed) process.exitCode = 1;
    },
  },

  reopen: {
    usage: "reopen <id>",
    summary: "reopen a closed gig",
    async run({ args, json, print, client }) {
      const gig = await client().reopen(arg(args, 0, "id"));
      if (json) return print(gig, row);
      console.log(`reopened ${gig.id}`);
    },
  },
  defer: {
    usage: "defer <id> [--until <ISO time|YYYY-MM-DD|30m|4h|2d>]",
    summary: "set a gig aside (clears its claim), optionally until a time",
    options: { until: { type: "string" } },
    async run({ args, values, json, print, client }) {
      const until = values.until === undefined ? undefined : parseUntil(values.until as string);
      const gig = await client().defer(arg(args, 0, "id"), until);
      if (json) return print(gig, row);
      console.log(`deferred ${gig.id}${gig.defer_until ? ` until ${gig.defer_until}` : ""}`);
    },
  },

  undefer: {
    usage: "undefer <id>",
    summary: "make a deferred gig open again",
    async run({ args, json, print, client }) {
      const gig = await client().undefer(arg(args, 0, "id"));
      if (json) return print(gig, row);
      console.log(`undeferred ${gig.id}`);
    },
  },

  comment: {
    usage: "comment <id> <text|->",
    summary: "add a comment to a gig (`-` reads it from stdin)",
    async run({ args, json, print, client }) {
      const id = arg(args, 0, "id");
      const text = await readText(args.slice(1).join(" "));
      if (!text?.trim()) throw new Error("missing <text>");
      const comment = await client().comment(id, text);
      if (json) return print(comment, (c) => ({ gig_id: c.gig_id, author: c.author, at: c.created_at, body: c.body }));
      console.log(`commented on ${comment.gig_id}`);
    },
  },

  spec: {
    usage: "spec create <title> -d text|- | spec update <id> [--title t] [-d text|-] | spec edit <id> --old text --new text | spec edit <id> - | spec history <id> | spec show <id> [--version n] [--full] | spec list [--all] | spec ready <id> | spec close <id> -r reason | spec reopen <id>",
    summary: "create, edit, show or list specs: agreements gigs can point to (`-d -` reads the text from stdin). Status: draft until `spec ready`; active while any of its gigs is unfinished, done once all are closed; closed by `spec close` (abandoned; refused while it has unfinished gigs), which `spec reopen` undoes (stored state back to draft; a spec with gigs is active or done again). `spec list` shows draft, ready and active specs; --all adds done and closed",
    options: {
      description: { type: "string", short: "d" }, title: { type: "string" },
      old: { type: "string" }, new: { type: "string" }, version: { type: "string" },
      reason: { type: "string", short: "r" }, all: { type: "boolean" },
    },
    async run({ args, values, json, full, print, client, project }) {
      const action = arg(args, 0, "create|update|edit|history|show|list|ready|close|reopen");
      if (values.version !== undefined && action !== "show") throw new Error("--version only works with spec show");
      if ((values.old !== undefined || values.new !== undefined) && action !== "edit") throw new Error("--old and --new only work with spec edit");
      if (values.reason !== undefined && action !== "close") throw new Error("--reason only works with spec close");
      if (values.all !== undefined && action !== "list") throw new Error("--all only works with spec list");
      if (action === "create") {
        const title = args.slice(1).join(" ");
        if (!title.trim()) throw new Error("missing <title>");
        const text = await readText(values.description as string | undefined);
        if (!text?.trim()) throw new Error("missing text: pass -d <text> or -d - (see `gig spec --help`)");
        const spec = await client().createSpec(project(), title, text);
        if (json) return print(spec, specRow);
        return console.log(spec.id);
      }
      if (action === "update") {
        if (args.length > 2) throw new Error("too many arguments (see `gig spec --help`)");
        const changes: { title?: string; text?: string } = {};
        if (values.title !== undefined) changes.title = values.title as string;
        const text = await readText(values.description as string | undefined);
        if (text !== undefined) changes.text = text;
        if (!Object.keys(changes).length) throw new Error("nothing to update: pass --title and/or -d (see `gig spec --help`)");
        const spec = await client().updateSpec(arg(args, 1, "id"), changes);
        if (json) return print(spec, specRow);
        return console.log(`updated ${spec.id}`);
      }
      if (action === "edit") {
        const id = arg(args, 1, "id");
        const spec = await client().editSpec(id, await readEdits(args.slice(2), values, "spec"));
        if (json) return print(spec, specRow);
        return console.log(`edited ${spec.id} (version ${spec.version})`);
      }
      if (action === "history") {
        if (args.length > 2) throw new Error("too many arguments (see `gig spec --help`)");
        const history = await client().specHistory(arg(args, 1, "id"));
        if (json) return print(history);
        return console.log(history.map(({ version, by, at, kind, title, text, edits }) => [
          `v${version}  ${kind}  ${by}  ${at}`,
          ...(title === undefined ? [] : [`  title: ${title}`]),
          ...(text === undefined ? [] : ["  text: replaced"]),
          ...(edits ?? []).flatMap((edit) => [`  - ${JSON.stringify(edit.old)}`, `  + ${JSON.stringify(edit.new)}`]),
        ].join("\n")).join("\n"));
      }
      if (action === "show") {
        if (args.length > 2) throw new Error("too many arguments (see `gig spec --help`)");
        const version = values.version === undefined ? undefined : Number(values.version);
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new Error("version must be a positive integer");
        const spec = await client().getSpec(arg(args, 1, "id"), version);
        if (json) return print(spec, (s) => ({ ...specRow(s), text: s.text }));
        return console.log(showSpec(spec, full));
      }
      if (action === "list") {
        if (args.length > 1) throw new Error("too many arguments (see `gig spec --help`)");
        const specs = await client().listSpecs(project(), values.all === true);
        if (json) return print(specs, (list) => list.map(specRow));
        const w = Math.max(...specs.map((s) => s.id.length));
        return console.log(specs.length ? specs.map((s) => `${s.id.padEnd(w)}  ${s.status.padEnd(6)}  ${s.title}`).join("\n") : "no specs");
      }
      if (action === "ready" || action === "close" || action === "reopen") {
        if (args.length > 2) throw new Error("too many arguments (see `gig spec --help`)");
        const id = arg(args, 1, "id");
        const c = client();
        let spec: Spec;
        if (action === "close") {
          const reason = values.reason as string | undefined;
          if (!reason?.trim()) throw new Error("missing reason: pass -r <reason> (see `gig spec --help`)");
          spec = await c.closeSpec(id, reason);
        } else {
          spec = action === "ready" ? await c.readySpec(id) : await c.reopenSpec(id);
        }
        if (json) return print(spec, specRow);
        // The status shown is the derived one: a spec with gigs stays active or done whatever was set by hand.
        return console.log(`${{ ready: "marked", close: "closed", reopen: "reopened" }[action]} ${spec.id}; status ${spec.status}`);
      }
      throw new Error("expected `gig spec create|update|edit|history|show|list|ready|close|reopen`");
    },
  },

  skill: {
    usage: "skill",
    summary: "print the agent skill (SKILL.md) that teaches the gig workflow",
    async run() {
      process.stdout.write(readFileSync(SKILL_PATH, "utf8"));
    },
  },
};

const SKILL_PATH = join(import.meta.dir, "../.agents/skills/gigs/SKILL.md");

function wrapHelp(text: string, indent: string, continuation = indent): string {
  const lines: string[] = [];
  let line = indent;
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > 80 && line !== indent) {
      lines.push(line);
      line = continuation;
    }
    line += (line.trim() ? " " : "") + word;
  }
  return [...lines, line].join("\n");
}

function usage() {
  const lines = Object.values(COMMANDS).map((c) =>
    `${wrapHelp(`gig ${c.usage}`, "  ", "    ")}\n${wrapHelp(c.summary, "    ")}`,
  );
  return `gig - gigs, a ticket system for coding agents

usage:
${lines.join("\n")}
  gig help | gig <command> --help

output: compact JSON by default (one line, empty fields omitted)

global options:
  --human            print human-readable text instead of JSON
  --json             optional legacy flag (JSON is already the default)
  --full             raw API JSON; with --human: full show view
  --as <actor>       act as <actor> (default: $GIG_ACTOR, then $USER)
  -P, --project <p>  project prefix
                     (default: $GIG_PROJECT, then the binding)
  --spec <id>        (create, list, ready, blocked, claim) the project comes
                     from the spec id, overriding -P, $GIG_PROJECT, the binding

binding: the nearest .gigs.json, plus .gigs.local.json next to it (gitignored,
     holds the token); keys project, url, token
server and token, first wins: env GIGS_URL / GIGS_TOKEN, .gigs.local.json,
     .gigs.json, GIGS_DEFAULT_URL, http://127.0.0.1:7357`;
}

export async function main(argv: string[]) {
  const at = findCommand(argv);
  const name = argv[at];
  if (name === undefined || name === "help") {
    parseArgs({ args: argv.filter((_, i) => i !== at), options: GLOBAL_OPTIONS, strict: true });
    console.log(usage());
    return;
  }
  const command = COMMANDS[name];
  if (!command) throw new Error(`unknown command '${name}' (see \`gig help\`)`);

  const rest = argv.filter((_, i) => i !== at);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      allowNegative: command.allowNegative === true,
      strict: true,
    });
  } catch (err) {
    throw new Error(`${errorMessage(err)} (see \`gig ${name} --help\`)`);
  }
  const values = parsed.values as Values;
  if (values.help) {
    console.log(`${wrapHelp(`usage: gig ${command.usage}`, "", "  ")}\n\n${wrapHelp(command.summary, "")}`);
    return;
  }

  const maxArgs: Record<string, number> = {
    serve: 0, init: 1, projects: 0, list: 0, ready: 0, blocked: 0,
    dep: 3, show: 1, update: 1, claim: 1, unclaim: 1, heartbeat: 1,
    reopen: 1, defer: 1, undefer: 1, skill: 0,
  };
  if (parsed.positionals.length > (maxArgs[name] ?? Infinity)) {
    throw new Error(`too many arguments (see \`gig ${name} --help\`)`);
  }

  const binding = findBinding(process.cwd());
  const conn = connection(process.env, binding);
  const ctx: Ctx = {
    args: parsed.positionals,
    url: conn.url,
    values,
    json: values.human !== true,
    full: values.full === true,
    print: (raw, shape) => console.log(JSON.stringify(shape && values.full !== true ? shape(raw) : raw)),
    client: () =>
      new Client({
        url: conn.url,
        token: conn.token,
        actor: (values.as as string | undefined) || process.env.GIG_ACTOR || process.env.USER || "unknown",
      }),
    project: () => specProject(values.spec) ?? resolveProject(values.project as string | undefined, binding),
  };
  try {
    await command.run(ctx);
  } catch (err) {
    // A rejected token: say where it came from, since GIGS_TOKEN silently overrides the binding's.
    if (err instanceof GigsError && (err.status === 401 || err.status === 403)) err.message += ` (${tokenHint(conn, binding)})`;
    throw err;
  }
}

/** Index of the command: the first positional argument, skipping global options and their values. */
function findCommand(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--as" || a === "--project" || a === "-P") i++;
    else if (!a.startsWith("-")) return i;
  }
  return -1;
}

function resolveProject(flag: string | undefined, binding: Binding | undefined): string {
  if (flag) return flag;
  if (process.env.GIG_PROJECT) return process.env.GIG_PROJECT;
  if (!binding) throw new Error("no project: pass -P <prefix>, set GIG_PROJECT, or run `gig init <prefix>` in your repo");
  if (!binding.project) throw new Error(`${join(binding.dir, BINDING_FILE)} has no "project"`);
  return binding.project;
}

/** The project of a spec id like `gig-s3`, or undefined without a spec. */
function specProject(spec: unknown): string | undefined {
  if (typeof spec !== "string") return undefined;
  const m = /^([a-z][a-z0-9]{1,2})-s\d+$/i.exec(spec.trim());
  if (!m) throw new Error(`invalid spec id: ${spec}`);
  return m[1]!.toLowerCase();
}

/** `a,b` as a list of labels; the server validates them. */
function labelList(value: unknown): string[] | undefined {
  return typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

function filterQuery(values: Values) {
  return { label: values.label as string | undefined, exclude_label: values["exclude-label"] as string | undefined, human: values["human-only"] === true };
}

function arg(args: string[], i: number, name: string): string {
  const v = args[i];
  if (!v) throw new Error(`missing <${name}>`);
  return v;
}

function parsePriority(s: string): number | string {
  const m = /^[pP]?(\d+)$/.exec(s);
  return m ? Number(m[1]) : s;
}

/** Edits from --old/--new, or (`rest` is just `-`) a JSON array of {old,new} on stdin; the server validates them. */
async function readEdits(rest: string[], values: Record<string, unknown>, command: string): Promise<TextEdit[]> {
  if (rest.length === 1 && rest[0] === "-") {
    if (values.old !== undefined || values.new !== undefined) throw new Error("use stdin or --old/--new, not both");
    try { return JSON.parse(await Bun.stdin.text()); }
    catch { throw new Error("stdin must be a JSON array of {old,new}"); }
  }
  if (rest.length) throw new Error(`too many arguments (see \`gig ${command} --help\`)`);
  if (values.old === undefined || values.new === undefined) throw new Error("pass --old and --new, or - for JSON edits on stdin");
  return [{ old: values.old as string, new: values.new as string }];
}

/** `-` means: read from stdin. */
async function readText(value: string | undefined): Promise<string | undefined> {
  return value === "-" ? (await Bun.stdin.text()).trimEnd() : value;
}

/** A relative duration like 30m, 4h or 2d, a plain date, or a local date-time becomes an ISO time; anything else goes to the server as is. */
function parseUntil(s: string): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (date) {
    // A plain date (start of day) or a date-time without an offset means local time.
    const [y, mo, d, h = 0, mi = 0, sec = 0] = date.slice(1).map((v) => (v === undefined ? undefined : Number(v))) as number[];
    const t = new Date(y!, mo! - 1, d, h, mi, sec);
    if (t.getFullYear() !== y || t.getMonth() !== mo! - 1 || t.getDate() !== d || t.getHours() !== h || t.getMinutes() !== mi) {
      throw new Error(`invalid date: ${s}`);
    }
    return t.toISOString();
  }
  const m = /^(\d+)([mhd])$/.exec(s.trim());
  if (!m) return s;
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return new Date(Date.now() + ms).toISOString();
}

const RELATIONS = ["children", "blockers", "blocks", "related", "discovered_from", "discovered"] as const;

/** Drop null/undefined/empty-string values and empty arrays/objects. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const empty = (v: unknown) =>
    v == null || v === "" || (Array.isArray(v) ? !v.length : typeof v === "object" && !Object.keys(v).length);
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => !empty(v)));
}

/** The compact JSON row of a gig (list, ready, blocked, mutations). */
function row(b: Gig) {
  const claimed = b.status === "in_progress";
  return compact({
    id: b.id, title: b.title, type: b.type, priority: b.priority, status: b.status, parent: b.parent, spec: b.spec,
    labels: b.labels, human: b.human || null, claimed_by: claimed ? b.claimed_by : null, claim_expires_at: claimed ? b.claim_expires_at : null,
    defer_until: b.defer_until, close_reason: b.status === "closed" ? b.close_reason : null,
  });
}

/** The compact JSON of `gig show`: unfinished relations listed, closed ones counted. */
function compactShow(detail: GigDetail) {
  const { gig: b, ready, reasons } = detail;
  const open = b.status === "open";
  const claimed = b.status === "in_progress";
  const summary = ({ id, title, status }: GigSummary) => ({ id, title, status });
  const relations: Record<string, unknown> = {};
  const closed: Record<string, number> = {};
  for (const key of RELATIONS) {
    relations[key] = detail[key].filter((gig) => gig.status !== "closed").map(summary);
    const n = detail[key].length - (relations[key] as unknown[]).length;
    if (n) closed[key] = n;
  }
  return compact({
    id: b.id, title: b.title, type: b.type, priority: b.priority, status: b.status, spec: b.spec, labels: b.labels, human: b.human || null, description: b.description,
    ready: open ? ready : null, reasons: open && !ready ? reasons : null,
    claimed_by: claimed ? b.claimed_by : null, claim_expires_at: claimed ? b.claim_expires_at : null,
    defer_until: b.defer_until,
    closed_by: b.status === "closed" ? b.closed_by : null, close_reason: b.status === "closed" ? b.close_reason : null,
    parent: detail.parent && summary(detail.parent),
    ...relations,
    closed,
    comments: detail.comments.map((c) => ({ author: c.author, at: c.created_at, body: c.body })),
  });
}

function rows(gigs: Gig[]): string {
  const w = Math.max(...gigs.map((b) => b.id.length));
  return gigs
    .map((b) =>
      [
        b.id.padEnd(w),
        `P${b.priority}`,
        b.status.padEnd(11),
        b.type.padEnd(7),
        b.title + (b.claimed_by ? `  [@${b.claimed_by}]` : "") + (b.defer_until ? `  [until ${b.defer_until}]` : "") +
          (b.labels.length ? `  [${b.labels.join(", ")}]` : "") + (b.human ? "  [human]" : ""),
      ].join("  "),
    )
    .join("\n");
}

function shortTime(value: string): string {
  const date = new Date(value);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${month} ${date.getDate()}${year} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function showCompactDetail(detail: GigDetail): string {
  const { gig: b, ready, reasons } = detail;
  let status: string = b.status;
  if (b.status === "open") status = ready ? "ready" : "open";
  if (b.status === "in_progress") {
    status = `in progress, claimed by ${b.claimed_by}${b.claim_expires_at ? ` until ${shortTime(b.claim_expires_at)}` : ""}`;
  }
  if (b.status === "deferred") status = `deferred${b.defer_until ? ` until ${shortTime(b.defer_until)}` : ""}`;
  if (b.status === "closed") status = `closed by ${b.closed_by}${b.close_reason ? `: ${b.close_reason}` : ""}`;
  const lines = [`${b.id}  ${b.title}`, `${b.type} · P${b.priority} · ${status}${b.human ? " · human only" : ""}`];
  if (b.spec) lines.push(`spec: ${b.spec}`);
  if (b.labels.length) lines.push(`labels: ${b.labels.join(", ")}`);
  if (detail.parent) lines.push(`parent: ${[detail.parent.id, detail.parent.title].filter(Boolean).join(" ")}`);
  if (b.status === "open" && !ready) lines.push(`not ready: ${reasonText(reasons)}`);
  for (const key of RELATIONS) {
    const unfinished = detail[key].filter((gig) => gig.status !== "closed");
    const closed = detail[key].length - unfinished.length;
    const label = key.replace("_", " ");
    if (unfinished.length) {
      lines.push(`${label}:`, ...unfinished.map(summaryLine));
      if (closed) lines.push(`  +${closed} closed`);
    } else if (closed) {
      lines.push(`${label}: ${closed} closed`);
    }
  }
  if (b.description) lines.push("", b.description);
  if (detail.comments.length) {
    lines.push("", "comments:");
    for (const c of detail.comments) {
      const [first, ...rest] = c.body.split("\n");
      lines.push(`  ${c.author} (${shortTime(c.created_at)}): ${first}`, ...rest.map((line) => `    ${line}`));
    }
  }
  return lines.join("\n");
}

/** A related gig; one in another project than the token's shows only its id. */
function summaryLine(gig: GigSummary): string {
  return "  " + [gig.id, gig.status, gig.title].filter(Boolean).join("  ");
}

function showDetail(detail: GigDetail): string {
  const { gig: b, ready, reasons } = detail;
  const lines = [`${b.id}  ${b.title}`, ""];
  const field = (label: string, value: string) => lines.push(`${(label + ": ").padEnd(11)}${value}`);
  field("status", b.status + (ready ? " (ready)" : ""));
  if (b.claimed_by) field("claimed", `by ${b.claimed_by} at ${b.claimed_at}, expires ${b.claim_expires_at}`);
  if (b.status === "deferred") field("deferred", b.defer_until ? `until ${b.defer_until}` : "until undeferred");
  field("type", b.type);
  field("priority", `P${b.priority}`);
  if (b.spec) field("spec", b.spec);
  if (b.labels.length) field("labels", b.labels.join(", "));
  if (b.human) field("human", "only a human works it");
  field("created", `${b.created_at} by ${b.created_by}`);
  field("updated", b.updated_at);
  if (b.closed_at) field("closed", `${b.closed_at} by ${b.closed_by}${b.close_reason ? `: ${b.close_reason}` : ""}`);
  if (!ready) field("not ready", reasons.length ? reasonText(reasons) : `status is ${b.status}`);
  const relation = (label: string, gigs: GigDetail["children"]) => {
    if (!gigs.length) return;
    lines.push(`${label}:`);
    for (const gig of gigs) lines.push(summaryLine(gig));
  };
  if (detail.parent) relation("parent", [detail.parent]);
  for (const key of RELATIONS) {
    relation(key, detail[key]);
  }
  if (b.description) lines.push("", b.description);
  if (detail.comments.length) {
    lines.push("", "comments:");
    for (const c of detail.comments) lines.push(`  ${c.created_at} ${c.author}:`, ...c.body.split("\n").map((l) => `    ${l}`));
  }
  return lines.join("\n");
}

/** The compact JSON row of a token; never the token itself. */
function tokenRow(t: Token) {
  return compact({ id: t.id, project: t.project, label: t.label, created_at: t.created_at, revoked_at: t.revoked_at });
}

/** The compact JSON row of a spec; `state` is left out, the derived `status` is what matters. */
function specRow(spec: Spec) {
  return compact({ id: spec.id, title: spec.title, version: spec.version, status: spec.status, close_reason: spec.status === "closed" ? spec.close_reason : null });
}

function showSpec(spec: Spec, full: boolean): string {
  const status = spec.status === "closed" ? `closed by ${spec.closed_by}${spec.close_reason ? `: ${spec.close_reason}` : ""}` : spec.status;
  const lines = [`${spec.id}  ${spec.title}`, `v${spec.version} · ${status}`];
  if (full) lines.push(`created ${spec.created_at} by ${spec.created_by}`);
  return [...lines, "", spec.text].join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`error: ${errorMessage(err)}`);
    process.exit(1);
  });
}
