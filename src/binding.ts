import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The server `gig` talks to when nothing else names one. */
export const BUILTIN_URL = "http://127.0.0.1:7357";

export const BINDING_FILE = ".gigs.json";
/** The gitignored part of a binding, next to `.gigs.json`; usually just the token. */
export const LOCAL_FILE = ".gigs.local.json";

/**
 * A binding: the settings tying a directory (and everything below it) to one project on one
 * server. `.gigs.json` is committed; `.gigs.local.json` next to it is not, and its values win.
 */
export interface Binding {
  /** The directory holding `.gigs.json`. */
  dir: string;
  project?: string;
  url?: string;
  token?: string;
  /** The file the token came from. */
  tokenFile?: string;
  /** Who acts here; only ever from `.gigs.local.json`, since a committed name would fit one checkout only. */
  actor?: string;
}

/** Where the server and token come from, first wins: env, `.gigs.local.json`, `.gigs.json`, `GIGS_DEFAULT_URL` (set by a launcher), built-in default. */
export interface Connection {
  url: string;
  token?: string;
  /** `GIGS_TOKEN` or a file path; undefined without a token. */
  tokenSource?: string;
}

/** The binding in `dir` itself, if it has a `.gigs.json`. */
export function readBinding(dir: string): Binding | undefined {
  const json = readJson(join(dir, BINDING_FILE));
  if (!json) return undefined;
  const local = readJson(join(dir, LOCAL_FILE)) ?? {};
  const pick = (key: string) => str(local[key]) ?? str(json[key]);
  const token = pick("token");
  return {
    dir,
    project: pick("project"),
    url: pick("url"),
    token,
    tokenFile: token === undefined ? undefined : join(dir, str(local.token) ? LOCAL_FILE : BINDING_FILE),
    actor: str(local.actor),
  };
}

/**
 * Binds `dir` to a project: `.gigs.json` gets the project and the url (unless it is the built-in
 * default), `.gigs.local.json` the token, and in a git repo `.gitignore` lists `.gigs.local.json`.
 * Returns the files written.
 */
export function writeBinding(dir: string, binding: { project: string; url: string; token?: string }): string[] {
  const json = binding.url === BUILTIN_URL ? { project: binding.project } : { project: binding.project, url: binding.url };
  writeFileSync(join(dir, BINDING_FILE), JSON.stringify(json, null, 2) + "\n");
  // The local file keeps keys init doesn't own; its stale project, url or token would override this binding.
  const localFile = join(dir, LOCAL_FILE);
  const { project: _p, url: _u, token: _t, ...rest } = readJson(localFile) ?? {};
  const local = binding.token ? { ...rest, token: binding.token } : rest;
  if (Object.keys(local).length) writeFileSync(localFile, JSON.stringify(local, null, 2) + "\n");
  else if (existsSync(localFile)) rmSync(localFile);
  if (!binding.token) return [BINDING_FILE];
  return [BINDING_FILE, LOCAL_FILE, ...(ignoreLocalFile(dir) ? [".gitignore"] : [])];
}

/** Adds `.gigs.local.json` to `dir`'s `.gitignore` when `dir` is in a git repo and it isn't listed yet. */
function ignoreLocalFile(dir: string): boolean {
  if (!inGitRepo(dir)) return false;
  const file = join(dir, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").some((line) => [LOCAL_FILE, `/${LOCAL_FILE}`].includes(line.trim()))) return false;
  writeFileSync(file, text + (text && !text.endsWith("\n") ? "\n" : "") + LOCAL_FILE + "\n");
  return true;
}

function inGitRepo(dir: string): boolean {
  return walkUp(dir, (d) => existsSync(join(d, ".git")) || undefined) ?? false;
}

/** The nearest binding, walking up from `dir`. */
export function findBinding(dir: string): Binding | undefined {
  return walkUp(dir, readBinding);
}

/** The first result of `f` for `dir` or one of its ancestors. */
function walkUp<T>(dir: string, f: (dir: string) => T | undefined): T | undefined {
  for (; ; dir = dirname(dir)) {
    const found = f(dir);
    if (found !== undefined) return found;
    if (dirname(dir) === dir) return undefined;
  }
}

export function connection(env: Record<string, string | undefined>, binding: Binding | undefined): Connection {
  const url = env.GIGS_URL || binding?.url || env.GIGS_DEFAULT_URL || BUILTIN_URL;
  if (env.GIGS_TOKEN) return { url, token: env.GIGS_TOKEN, tokenSource: "GIGS_TOKEN" };
  return { url, token: binding?.token, tokenSource: binding?.tokenFile };
}

export type ActorSource = "--as" | "GIG_ACTOR" | typeof LOCAL_FILE | "git" | "USER" | "default";

/**
 * Who the CLI acts as, first wins: `--as`, `GIG_ACTOR`, `"actor"` in `.gigs.local.json`,
 * `git config user.name` (run in `dir`), `$USER`, `"unknown"`. Blank values fall through.
 */
export function resolveActor(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  binding: Binding | undefined,
  dir: string,
): { actor: string; source: ActorSource } {
  const steps: [ActorSource, () => string | undefined][] = [
    ["--as", () => flag],
    ["GIG_ACTOR", () => env.GIG_ACTOR],
    [LOCAL_FILE, () => binding?.actor],
    ["git", () => gitUserName(dir)],
    ["USER", () => env.USER],
  ];
  for (const [source, value] of steps) {
    const actor = value()?.trim();
    if (actor) return { actor, source };
  }
  return { actor: "unknown", source: "default" };
}

/** `git config user.name` in `dir`; undefined without git, a repo, or a name. */
function gitUserName(dir: string): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "config", "user.name"], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : undefined;
  } catch {
    return undefined; // no git on PATH
  }
}

/** Why the server turned the token down: where it came from, and what it overrode. */
export function tokenHint(conn: Connection, binding: Binding | undefined): string {
  if (!conn.tokenSource) return `no token: put "token" in ${LOCAL_FILE} next to ${BINDING_FILE}, or set GIGS_TOKEN`;
  if (conn.tokenSource === "GIGS_TOKEN" && binding?.tokenFile) return `token from GIGS_TOKEN, which overrides ${binding.tokenFile}`;
  return `token from ${conn.tokenSource}`;
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (err) { throw new Error(`${file}: invalid JSON (${err instanceof Error ? err.message : err})`); }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
