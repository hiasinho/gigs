#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Client } from "./client";
import { configFromEnv, serve } from "./server";
import { BoonsError, type Boon, type BoonDetail, type Project } from "./store";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | undefined>;

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  as: { type: "string" },
  project: { type: "string", short: "P" },
  help: { type: "boolean", short: "h" },
} satisfies Options;

interface Ctx {
  args: string[];
  values: Values;
  json: boolean;
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
    summary: "start the server (env: BOONS_HOST, BOONS_PORT, BOONS_DB, BOONS_TOKEN)",
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
    async run({ args, values, json, client }) {
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
      }
      writeFileSync(".boons.json", JSON.stringify({ project: project.prefix }, null, 2) + "\n");
      if (json) return print(project);
      console.log(`${created ? "created" : "linked existing"} project ${project.prefix} (${project.name}); wrote .boons.json`);
    },
  },

  projects: {
    usage: "projects",
    summary: "list projects",
    async run({ json, client }) {
      const projects = await client().listProjects();
      if (json) return print(projects);
      if (!projects.length) return console.log("no projects");
      const w = Math.max(...projects.map((p) => p.prefix.length));
      for (const p of projects) console.log(`${p.prefix.padEnd(w)}  ${p.name}`);
    },
  },

  create: {
    usage: "create <title> [-t type] [-p 0-4] [-d desc|-]",
    summary: "create a boon and print its id (`-d -` reads the description from stdin)",
    options: {
      type: { type: "string", short: "t" },
      priority: { type: "string", short: "p" },
      description: { type: "string", short: "d" },
    },
    async run({ args, values, json, client, project }) {
      const title = args.join(" ");
      if (!title.trim()) throw new Error("missing <title>");
      let description = values.description as string | undefined;
      if (description === "-") description = (await Bun.stdin.text()).trimEnd();
      const boon = await client().createBoon(project(), {
        title,
        description,
        type: values.type as string | undefined,
        priority: values.priority === undefined ? undefined : parsePriority(values.priority as string),
      });
      if (json) return print(boon);
      console.log(boon.id);
    },
  },

  list: {
    usage: "list [--all] [--status s[,s]] [--type t]",
    summary: "list boons (default: unfinished)",
    options: {
      all: { type: "boolean" },
      status: { type: "string" },
      type: { type: "string" },
    },
    async run({ values, json, client, project }) {
      const boons = await client().listBoons(project(), {
        all: values.all as boolean | undefined,
        status: values.status as string | undefined,
        type: values.type as string | undefined,
      });
      if (json) return print(boons);
      console.log(boons.length ? rows(boons) : "no boons");
    },
  },

  ready: {
    usage: "ready",
    summary: "ready boons in priority order",
    async run({ json, client, project }) {
      const boons = await client().ready(project());
      if (json) return print(boons);
      console.log(boons.length ? rows(boons) : "no ready boons");
    },
  },

  show: {
    usage: "show <id>",
    summary: "show a boon in full",
    async run({ args, json, client }) {
      const detail = await client().getBoon(arg(args, 0, "id"));
      if (json) return print(detail);
      console.log(showDetail(detail));
    },
  },

  claim: {
    usage: "claim [id]",
    summary: "claim the given boon, or the next ready one",
    async run({ args, json, client, project }) {
      const boon = args[0] ? await client().claim(args[0]) : await client().claimNext(project());
      if (json) return print(boon);
      console.log(boon ? `claimed ${boon.id}: ${boon.title}` : "no ready boons");
    },
  },

  unclaim: {
    usage: "unclaim <id>",
    summary: "release the claim on a boon",
    async run({ args, json, client }) {
      const boon = await client().unclaim(arg(args, 0, "id"));
      if (json) return print(boon);
      console.log(`unclaimed ${boon.id}`);
    },
  },

  close: {
    usage: "close <id...> [-r reason]",
    summary: "close one or more boons",
    options: { reason: { type: "string", short: "r" } },
    async run({ args, values, json, client }) {
      arg(args, 0, "id");
      const c = client();
      const closed: Boon[] = [];
      let failed = false;
      for (const id of args) {
        try {
          const boon = await c.close(id, values.reason as string | undefined);
          closed.push(boon);
          if (!json) console.log(`closed ${boon.id}`);
        } catch (err) {
          if (args.length === 1) throw err;
          console.error(`error: ${errorMessage(err)}`);
          failed = true;
        }
      }
      if (json) print(args.length === 1 ? closed[0] : closed);
      if (failed) process.exitCode = 1;
    },
  },

  reopen: {
    usage: "reopen <id>",
    summary: "reopen a closed boon",
    async run({ args, json, client }) {
      const boon = await client().reopen(arg(args, 0, "id"));
      if (json) return print(boon);
      console.log(`reopened ${boon.id}`);
    },
  },
};

function usage() {
  const w = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  const lines = Object.values(COMMANDS).map((c) => `  bn ${c.usage.padEnd(w)}  ${c.summary}`);
  return `bn - boons, a ticket system for coding agents

usage:
${lines.join("\n")}
  bn help | bn <command> --help

global options:
  --json             print the API JSON instead of human output
  --as <actor>       act as <actor> (default: $BN_ACTOR, then $USER)
  -P, --project <p>  project prefix (default: $BN_PROJECT, then nearest .boons.json)

env: BOONS_URL (default http://127.0.0.1:7357), BOONS_TOKEN`;
}

export async function main(argv: string[]) {
  const at = findCommand(argv);
  const name = argv[at];
  if (name === undefined || name === "help") {
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
    console.log(`usage: bn ${command.usage}\n\n${command.summary}`);
    return;
  }

  await command.run({
    args: parsed.positionals,
    values,
    json: values.json === true,
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

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
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
        b.title + (b.claimed_by ? `  [@${b.claimed_by}]` : ""),
      ].join("  "),
    )
    .join("\n");
}

function showDetail({ boon: b, ready }: BoonDetail): string {
  const lines = [`${b.id}  ${b.title}`, ""];
  const field = (label: string, value: string) => lines.push(`${(label + ":").padEnd(10)}${value}`);
  field("status", b.status + (ready ? " (ready)" : ""));
  if (b.claimed_by) field("claimed", `by ${b.claimed_by} at ${b.claimed_at}`);
  field("type", b.type);
  field("priority", `P${b.priority}`);
  field("created", `${b.created_at} by ${b.created_by}`);
  field("updated", b.updated_at);
  if (b.closed_at) field("closed", `${b.closed_at} by ${b.closed_by}${b.close_reason ? `: ${b.close_reason}` : ""}`);
  if (b.description) lines.push("", b.description);
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
