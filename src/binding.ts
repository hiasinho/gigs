import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  if (!binding.token) return [BINDING_FILE];
  writeFileSync(join(dir, LOCAL_FILE), JSON.stringify({ token: binding.token }, null, 2) + "\n");
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
  for (; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** The nearest binding, walking up from `dir`. */
export function findBinding(dir: string): Binding | undefined {
  for (; ; dir = dirname(dir)) {
    const binding = readBinding(dir);
    if (binding) return binding;
    if (dirname(dir) === dir) return undefined;
  }
}

export function connection(env: Record<string, string | undefined>, binding: Binding | undefined): Connection {
  const url = env.GIGS_URL || binding?.url || env.GIGS_DEFAULT_URL || BUILTIN_URL;
  if (env.GIGS_TOKEN) return { url, token: env.GIGS_TOKEN, tokenSource: "GIGS_TOKEN" };
  return { url, token: binding?.token, tokenSource: binding?.tokenFile };
}

/** Why the server turned the token down: where it came from, and what it overrode. */
export function tokenHint(conn: Connection, binding: Binding | undefined): string {
  if (!conn.tokenSource) return `no token: put "token" in ${LOCAL_FILE} next to ${BINDING_FILE}, or set GIGS_TOKEN`;
  if (conn.tokenSource === "GIGS_TOKEN" && binding?.tokenFile) return `token from GIGS_TOKEN, which overrides ${binding.tokenFile}`;
  return `token from ${conn.tokenSource}`;
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8"));
  return value && typeof value === "object" ? value : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
