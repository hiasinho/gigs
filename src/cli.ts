#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Client, type BoonChangesInput } from "./client";
import { configFromEnv, serve } from "./server";
import { BoonsError, formatReasons as reasonText, type Boon, type BoonDetail, type BoonSummary, type LinkKind, type Project } from "./store";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | undefined>;

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  full: { type: "boolean" },
  as: { type: "string" },
  project: { type: "string", short: "P" },
  help: { type: "boolean", short: "h" },
} satisfies Options;

interface Ctx {
  args: string[];
  values: Values;
  json: boolean;
  full: boolean;
  /** Print JSON: `shape(raw)` by default, the raw API response with --full. */
  print<T>(raw: T, shape?: (raw: T) => unknown): void;
  client(): Client;
  project(): string;
}

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  run(ctx: Ctx): Promise<void>;
}

const COMMANDS: Record<string, Command> = {
  serve: {
    usage: "serve",
    summary: "start the server (env: BOONS_HOST, BOONS_PORT, BOONS_DB, BOONS_TOKEN, BOONS_CLAIM_TTL_MINUTES)",
    async run() {
      const config = configFromEnv();
      const server = serve(config);
      console.log(`boons listening on ${server.url} (db: ${config.db})`);
    },
  },

  init: {
    usage: "init <prefix> [--name <name>]",
    summary: "create the project if missing (else just link it) and write ./.boons.json",
    options: { name: { type: "string" } },
    async run({ args, values, json, print, client }) {
      const prefix = arg(args, 0, "prefix");
      const c = client();
      let project: Project;
      let created = true;
      try {
        project = await c.createProject(prefix, values.name as string | undefined);
      } catch (err) {
        if (!(err instanceof BoonsError && err.code === "conflict")) throw err;
        project = await c.getProject(prefix);
        created = false;
        if (values.name !== undefined && values.name !== project.name) {
          console.error(`warning: project ${project.prefix} already exists as "${project.name}"; --name ignored`);
        }
      }
      writeFileSync(".boons.json", JSON.stringify({ project: project.prefix }, null, 2) + "\n");
      if (json) return print(project);
      console.log(`${created ? "created" : "linked existing"} project ${project.prefix} (${project.name}); wrote .boons.json`);
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
    usage: "create <title> [-t type] [-p 0-4] [-d desc|-] [--parent id] [--blocked-by id[,id]] [--discovered-from id]",
    summary: "create a boon and print its id (`-d -` reads the description from stdin)",
    options: {
      type: { type: "string", short: "t" },
      priority: { type: "string", short: "p" },
      description: { type: "string", short: "d" },
      parent: { type: "string" },
      "blocked-by": { type: "string" },
      "discovered-from": { type: "string" },
    },
    async run({ args, values, json, print, client, project }) {
      const title = args.join(" ");
      if (!title.trim()) throw new Error("missing <title>");
      const description = await readText(values.description as string | undefined);
      const boon = await client().createBoon(project(), {
        title,
        description,
        type: values.type as string | undefined,
        priority: values.priority === undefined ? undefined : parsePriority(values.priority as string),
        parent: values.parent as string | undefined,
        blocked_by: (values["blocked-by"] as string | undefined)?.split(","),
        discovered_from: values["discovered-from"] as string | undefined,
      });
      if (json) return print(boon, row);
      console.log(boon.id);
    },
  },

  list: {
    usage: "list [--all] [--status s[,s]] [--type t] [--parent id]",
    summary: "list boons (default: unfinished)",
    options: {
      all: { type: "boolean" },
      status: { type: "string" },
      type: { type: "string" },
      parent: { type: "string" },
    },
    async run({ values, json, print, client, project }) {
      const boons = await client().listBoons(project(), {
        all: values.all as boolean | undefined,
        status: values.status as string | undefined,
        parent: values.parent as string | undefined,
        type: values.type as string | undefined,
      });
      if (json) return print(boons, (list) => list.map(row));
      console.log(boons.length ? rows(boons) : "no boons");
    },
  },

  ready: {
    usage: "ready",
    summary: "ready boons in priority order",
    async run({ json, print, client, project }) {
      const boons = await client().ready(project());
      if (json) return print(boons, (list) => list.map(row));
      console.log(boons.length ? rows(boons) : "no ready boons");
    },
  },

  blocked: {
    usage: "blocked",
    summary: "blocked boons with reasons",
    async run({ json, print, client, project }) {
      const blocked = await client().blocked(project());
      if (json) return print(blocked, (list) => list.map(({ boon, reasons }) => ({ ...row(boon), reasons })));
      console.log(blocked.length ? blocked.map(({ boon, reasons }) => `${rows([boon])}\n  ${reasonText(reasons)}`).join("\n") : "no blocked boons");
    },
  },

  dep: {
    usage: "dep add|rm <id> <target-id> [--kind blocks|related|discovered-from]",
    summary: "add/remove a link (default: target blocks id)",
    options: { kind: { type: "string" } },
    async run({ args, values, json, print, client }) {
      const action = arg(args, 0, "add|rm");
      if (action !== "add" && action !== "rm") throw new Error("expected `bn dep add` or `bn dep rm`");
      const id = arg(args, 1, "id");
      const target = arg(args, 2, "target-id");
      const kind = (values.kind as string | undefined) ?? "blocks";
      const c = client();
      const detail = action === "add" ? await c.addLink(id, target, kind) : await c.removeLink(id, target, kind);
      if (json) return print(detail, (d) => row(d.boon));
      const phrase = { blocks: "blocked by", related: "related to", "discovered-from": "discovered from" }[kind as LinkKind];
      console.log(`${detail.boon.id} is ${action === "add" ? "now" : "no longer"} ${phrase} ${target.toLowerCase()}`);
    },
  },

  show: {
    usage: "show <id> [--full]",
    summary: "show a compact boon (--full shows everything)",
    async run({ args, json, full, print, client }) {
      const detail = await client().getBoon(arg(args, 0, "id"));
      if (json) return print(detail, compactShow);
      console.log(full ? showDetail(detail) : showCompactDetail(detail));
    },
  },

  update: {
    usage: "update <id> [--title t] [-d desc|-] [-t type] [-p n] [--parent id|none]",
    summary: "change a boon's fields (`--parent none` clears the parent)",
    options: {
      title: { type: "string" },
      description: { type: "string", short: "d" },
      type: { type: "string", short: "t" },
      priority: { type: "string", short: "p" },
      parent: { type: "string" },
    },
    async run({ args, values, json, print, client }) {
      const id = arg(args, 0, "id");
      const changes: BoonChangesInput = {
        title: values.title as string | undefined,
        description: await readText(values.description as string | undefined),
        type: values.type as string | undefined,
        priority: values.priority === undefined ? undefined : parsePriority(values.priority as string),
        parent: values.parent === "none" ? null : (values.parent as string | undefined),
      };
      if (Object.values(changes).every((v) => v === undefined)) throw new Error("nothing to update (see `bn update --help`)");
      const boon = await client().update(id, changes);
      if (json) return print(boon, row);
      console.log(`updated ${boon.id}`);
    },
  },

  claim: {
    usage: "claim [id]",
    summary: "claim the given boon, or the next ready one",
    async run({ args, json, full, print, client, project }) {
      const c = client();
      const boon = args[0] ? await c.claim(args[0]) : await c.claimNext(project());
      if (json) return print(boon && !full ? compactShow(await c.getBoon(boon.id)) : boon);
      console.log(boon ? `claimed ${boon.id}: ${boon.title}` : "no ready boons");
    },
  },

  unclaim: {
    usage: "unclaim <id>",
    summary: "release the claim on a boon",
    async run({ args, json, print, client }) {
      const boon = await client().unclaim(arg(args, 0, "id"));
      if (json) return print(boon, row);
      console.log(`unclaimed ${boon.id}`);
    },
  },

  heartbeat: {
    usage: "heartbeat <id>",
    summary: "renew your claim on a boon",
    async run({ args, json, print, client }) {
      const boon = await client().heartbeat(arg(args, 0, "id"));
      if (json) return print(boon, row);
      console.log(`claim on ${boon.id} renewed until ${boon.claim_expires_at}`);
    },
  },

  close: {
    usage: "close <id...> [-r reason] [--force]",
    summary: "close one or more boons",
    options: { reason: { type: "string", short: "r" }, force: { type: "boolean" } },
    async run({ args, values, json, print, client }) {
      arg(args, 0, "id");
      const c = client();
      const closed: Boon[] = [];
      let failed = false;
      for (const id of args) {
        try {
          const boon = await c.close(id, values.reason as string | undefined, values.force === true);
          closed.push(boon);
          if (!json) console.log(`closed ${boon.id}`);
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
    summary: "reopen a closed boon",
    async run({ args, json, print, client }) {
      const boon = await client().reopen(arg(args, 0, "id"));
      if (json) return print(boon, row);
      console.log(`reopened ${boon.id}`);
    },
  },
  defer: {
    usage: "defer <id> [--until <ISO time|YYYY-MM-DD|30m|4h|2d>]",
    summary: "set a boon aside (clears its claim), optionally until a time",
    options: { until: { type: "string" } },
    async run({ args, values, json, print, client }) {
      const until = values.until === undefined ? undefined : parseUntil(values.until as string);
      const boon = await client().defer(arg(args, 0, "id"), until);
      if (json) return print(boon, row);
      console.log(`deferred ${boon.id}${boon.defer_until ? ` until ${boon.defer_until}` : ""}`);
    },
  },

  undefer: {
    usage: "undefer <id>",
    summary: "make a deferred boon open again",
    async run({ args, json, print, client }) {
      const boon = await client().undefer(arg(args, 0, "id"));
      if (json) return print(boon, row);
      console.log(`undeferred ${boon.id}`);
    },
  },

  comment: {
    usage: "comment <id> <text|->",
    summary: "add a comment to a boon (`-` reads it from stdin)",
    async run({ args, json, print, client }) {
      const id = arg(args, 0, "id");
      const text = await readText(args.slice(1).join(" "));
      if (!text?.trim()) throw new Error("missing <text>");
      const comment = await client().comment(id, text);
      if (json) return print(comment, (c) => ({ boon_id: c.boon_id, author: c.author, at: c.created_at, body: c.body }));
      console.log(`commented on ${comment.boon_id}`);
    },
  },

  skill: {
    usage: "skill",
    summary: "print the agent skill (SKILL.md) that teaches the bn workflow",
    async run({ json, print }) {
      const content = readFileSync(SKILL_PATH, "utf8");
      if (json) return print({ name: "boons", content });
      process.stdout.write(content);
    },
  },
};

const SKILL_PATH = join(import.meta.dir, "../.agents/skills/boons/SKILL.md");

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
    `${wrapHelp(`bn ${c.usage}`, "  ", "    ")}\n${wrapHelp(c.summary, "    ")}`,
  );
  return `bn - boons, a ticket system for coding agents

usage:
${lines.join("\n")}
  bn help | bn <command> --help

global options:
  --json             print compact JSON for agents (one line, empty fields
                     omitted)
  --full             with --json: the raw API JSON; with show: everything
  --as <actor>       act as <actor> (default: $BN_ACTOR, then $USER)
  -P, --project <p>  project prefix
                     (default: $BN_PROJECT, then nearest .boons.json)

env: BOONS_URL (default http://127.0.0.1:7357), BOONS_TOKEN`;
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
  if (!command) throw new Error(`unknown command '${name}' (see \`bn help\`)`);

  const rest = argv.filter((_, i) => i !== at);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new Error(`${errorMessage(err)} (see \`bn ${name} --help\`)`);
  }
  const values = parsed.values as Values;
  if (values.help) {
    console.log(`${wrapHelp(`usage: bn ${command.usage}`, "", "  ")}\n\n${wrapHelp(command.summary, "")}`);
    return;
  }

  const maxArgs: Record<string, number> = {
    serve: 0, init: 1, projects: 0, list: 0, ready: 0, blocked: 0,
    dep: 3, show: 1, update: 1, claim: 1, unclaim: 1, heartbeat: 1,
    reopen: 1, defer: 1, undefer: 1, skill: 0,
  };
  if (parsed.positionals.length > (maxArgs[name] ?? Infinity)) {
    throw new Error(`too many arguments (see \`bn ${name} --help\`)`);
  }

  await command.run({
    args: parsed.positionals,
    values,
    json: values.json === true,
    full: values.full === true,
    print: (raw, shape) => console.log(JSON.stringify(shape && values.full !== true ? shape(raw) : raw)),
    client: () =>
      new Client({
        url: process.env.BOONS_URL || "http://127.0.0.1:7357",
        token: process.env.BOONS_TOKEN || undefined,
        actor: (values.as as string | undefined) || process.env.BN_ACTOR || process.env.USER || "unknown",
      }),
    project: () => resolveProject(values.project as string | undefined),
  });
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

function resolveProject(flag: string | undefined): string {
  if (flag) return flag;
  if (process.env.BN_PROJECT) return process.env.BN_PROJECT;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = join(dir, ".boons.json");
    if (existsSync(file)) {
      const project = JSON.parse(readFileSync(file, "utf8")).project;
      if (typeof project !== "string" || !project) throw new Error(`${file} has no "project"`);
      return project;
    }
    if (dirname(dir) === dir) break;
  }
  throw new Error("no project: pass -P <prefix>, set BN_PROJECT, or run `bn init <prefix>` in your repo");
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

/** The compact JSON row of a boon (list, ready, blocked, mutations). */
function row(b: Boon) {
  const claimed = b.status === "in_progress";
  return compact({
    id: b.id, title: b.title, type: b.type, priority: b.priority, status: b.status, parent: b.parent,
    claimed_by: claimed ? b.claimed_by : null, claim_expires_at: claimed ? b.claim_expires_at : null,
    defer_until: b.defer_until, close_reason: b.status === "closed" ? b.close_reason : null,
  });
}

/** The compact JSON of `bn show`: unfinished relations listed, closed ones counted. */
function compactShow(detail: BoonDetail) {
  const { boon: b, ready, reasons } = detail;
  const open = b.status === "open";
  const claimed = b.status === "in_progress";
  const summary = ({ id, title, status }: BoonSummary) => ({ id, title, status });
  const relations: Record<string, unknown> = {};
  const closed: Record<string, number> = {};
  for (const key of RELATIONS) {
    relations[key] = detail[key].filter((boon) => boon.status !== "closed").map(summary);
    const n = detail[key].length - (relations[key] as unknown[]).length;
    if (n) closed[key] = n;
  }
  return compact({
    id: b.id, title: b.title, type: b.type, priority: b.priority, status: b.status, description: b.description,
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

function rows(boons: Boon[]): string {
  const w = Math.max(...boons.map((b) => b.id.length));
  return boons
    .map((b) =>
      [
        b.id.padEnd(w),
        `P${b.priority}`,
        b.status.padEnd(11),
        b.type.padEnd(7),
        b.title + (b.claimed_by ? `  [@${b.claimed_by}]` : "") + (b.defer_until ? `  [until ${b.defer_until}]` : ""),
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

function showCompactDetail(detail: BoonDetail): string {
  const { boon: b, ready, reasons } = detail;
  let status: string = b.status;
  if (b.status === "open") status = ready ? "ready" : "open";
  if (b.status === "in_progress") {
    status = `in progress, claimed by ${b.claimed_by}${b.claim_expires_at ? ` until ${shortTime(b.claim_expires_at)}` : ""}`;
  }
  if (b.status === "deferred") status = `deferred${b.defer_until ? ` until ${shortTime(b.defer_until)}` : ""}`;
  if (b.status === "closed") status = `closed by ${b.closed_by}${b.close_reason ? `: ${b.close_reason}` : ""}`;
  const lines = [`${b.id}  ${b.title}`, `${b.type} · P${b.priority} · ${status}`];
  if (detail.parent) lines.push(`parent: ${detail.parent.id} ${detail.parent.title}`);
  if (b.status === "open" && !ready) lines.push(`not ready: ${reasonText(reasons)}`);
  for (const key of RELATIONS) {
    const unfinished = detail[key].filter((boon) => boon.status !== "closed");
    const closed = detail[key].length - unfinished.length;
    const label = key.replace("_", " ");
    if (unfinished.length) {
      lines.push(`${label}:`, ...unfinished.map((boon) => `  ${boon.id}  ${boon.status}  ${boon.title}`));
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

function showDetail(detail: BoonDetail): string {
  const { boon: b, ready, reasons } = detail;
  const lines = [`${b.id}  ${b.title}`, ""];
  const field = (label: string, value: string) => lines.push(`${(label + ": ").padEnd(11)}${value}`);
  field("status", b.status + (ready ? " (ready)" : ""));
  if (b.claimed_by) field("claimed", `by ${b.claimed_by} at ${b.claimed_at}, expires ${b.claim_expires_at}`);
  if (b.status === "deferred") field("deferred", b.defer_until ? `until ${b.defer_until}` : "until undeferred");
  field("type", b.type);
  field("priority", `P${b.priority}`);
  field("created", `${b.created_at} by ${b.created_by}`);
  field("updated", b.updated_at);
  if (b.closed_at) field("closed", `${b.closed_at} by ${b.closed_by}${b.close_reason ? `: ${b.close_reason}` : ""}`);
  if (!ready) field("not ready", reasons.length ? reasonText(reasons) : `status is ${b.status}`);
  const relation = (label: string, boons: BoonDetail["children"]) => {
    if (!boons.length) return;
    lines.push(`${label}:`);
    for (const boon of boons) lines.push(`  ${boon.id}  ${boon.status}  ${boon.title}`);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`error: ${errorMessage(err)}`);
    process.exit(1);
  });
}
