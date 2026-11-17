import { afterAll, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { bunDescribe, bunTest, openStore } from "./harness";

// The actor, first wins: --as, GIG_ACTOR, "actor" in .gigs.local.json, git config user.name, $USER,
// "unknown". The CLI runs in a hand-built environment: HOME and the global git config point at
// empty files, so the developer's own git identity never leaks in.

const dir = mkdtempSync(join(tmpdir(), "gigs-actor-"));
const store = openStore(join(dir, "actor.db"));
const server = Bun.serve({ port: 0, fetch: createHandler(store) });
store.createProject("ac");
const emptyGitConfig = join(dir, "gitconfig");
writeFileSync(emptyGitConfig, "");
afterAll(() => {
  server.stop(true);
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function env(extra: Record<string, string | undefined>, path = process.env.PATH!): Record<string, string> {
  const base: Record<string, string | undefined> = {
    PATH: path,
    HOME: dir,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dir,
    GIGS_URL: server.url.href,
    GIG_PROJECT: "ac",
    ...extra,
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

async function cli(args: string[], cwd: string, extra: Record<string, string | undefined> = {}, path?: string) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    cwd, env: env(extra, path), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

async function whoami(cwd: string, extra: Record<string, string | undefined> = {}, args: string[] = []) {
  const r = await cli(["whoami", ...args], cwd, extra);
  expect(r).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(r.stdout);
}

/** A git repo with a local user.name, a binding, and a .gigs.local.json actor. */
function repo(name: string, local: object, json: object = { project: "ac" }): string {
  const d = join(dir, name);
  mkdirSync(join(d, "sub"), { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.name", "Git Person"]]) {
    const r = Bun.spawnSync(["git", ...args], { cwd: d, env: env({}) });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  writeFileSync(join(d, ".gigs.json"), JSON.stringify(json));
  writeFileSync(join(d, ".gigs.local.json"), JSON.stringify(local));
  return join(d, "sub");
}

bunDescribe("actor", () => {
  bunTest("each step wins over the ones below it", async () => {
    const cwd = repo("order", { actor: "local-actor" });
    expect(await whoami(cwd, { USER: "u" }, ["--as", "flag"])).toEqual({ actor: "flag", source: "--as" });
    expect(await whoami(cwd, { GIG_ACTOR: "env", USER: "u" }, ["--as", "flag"])).toEqual({ actor: "flag", source: "--as" });
    expect(await whoami(cwd, { GIG_ACTOR: "env", USER: "u" })).toEqual({ actor: "env", source: "GIG_ACTOR" });
    expect(await whoami(cwd, { USER: "u" })).toEqual({ actor: "local-actor", source: ".gigs.local.json" });

    const noLocal = repo("order-git", {});
    expect(await whoami(noLocal, { USER: "u" })).toEqual({ actor: "Git Person", source: "git" });

    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    expect(await whoami(outside, { USER: "u" })).toEqual({ actor: "u", source: "USER" });
    expect(await whoami(outside, {})).toEqual({ actor: "unknown", source: "default" });
  });

  bunTest("no git on PATH falls through to $USER", async () => {
    const cwd = repo("nogit", {});
    const empty = join(dir, "emptybin");
    mkdirSync(empty, { recursive: true });
    const r = await cli(["whoami"], cwd, { USER: "u" }, empty);
    expect(r).toMatchObject({ code: 0, stdout: '{"actor":"u","source":"USER"}\n' });
  });

  bunTest("empty and whitespace values fall through", async () => {
    const cwd = repo("blank", { actor: "  " });
    expect(await whoami(cwd, { GIG_ACTOR: " ", USER: "u" }, ["--as", ""])).toEqual({ actor: "Git Person", source: "git" });
    const outside = join(dir, "blank-outside");
    mkdirSync(outside, { recursive: true });
    expect(await whoami(outside, { GIG_ACTOR: "", USER: "  " })).toEqual({ actor: "unknown", source: "default" });
  });

  bunTest("values are trimmed", async () => {
    const cwd = repo("trim", { actor: " local " });
    expect(await whoami(cwd, {})).toEqual({ actor: "local", source: ".gigs.local.json" });
    expect(await whoami(cwd, { GIG_ACTOR: " env " })).toEqual({ actor: "env", source: "GIG_ACTOR" });
  });

  bunTest("an actor in the committed .gigs.json is ignored", async () => {
    const cwd = repo("committed", {}, { project: "ac", actor: "committed" });
    expect(await whoami(cwd, { USER: "u" })).toEqual({ actor: "Git Person", source: "git" });
  });

  bunTest("whoami --human prints one line and needs no server", async () => {
    const outside = join(dir, "human");
    mkdirSync(outside, { recursive: true });
    const r = await cli(["whoami", "--human"], outside, { GIG_ACTOR: "impl-a", GIGS_URL: "http://127.0.0.1:1" });
    expect(r).toMatchObject({ code: 0, stdout: "impl-a (from GIG_ACTOR)\n" });
  });

  bunTest("the actor reaches the server on writes", async () => {
    const cwd = repo("write", { actor: "local-writer" });
    const r = await cli(["create", "from local"], cwd, { USER: "u" });
    expect(r.code).toBe(0);
    expect(store.getGig(JSON.parse(r.stdout).id).created_by).toBe("local-writer");
  });

  bunTest("reads don't run git; writes that need the actor do", async () => {
    // A fake git on PATH that leaves a marker when it runs.
    const bin = join(dir, "fakebin");
    const marker = join(dir, "git-ran");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), `#!/bin/sh\ntouch '${marker}'\necho fake-git\n`);
    chmodSync(join(bin, "git"), 0o755);
    const cwd = join(dir, "lazy");
    mkdirSync(cwd, { recursive: true });
    const path = `${bin}:${process.env.PATH}`;
    const created = await cli(["create", "seed"], cwd, { GIG_ACTOR: "seeder" }, path);
    expect(created.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const id = JSON.parse(created.stdout).id;

    for (const args of [["ready"], ["list"], ["show", id], ["blocked"]]) {
      const r = await cli(args, cwd, { USER: "u" }, path);
      expect(r.code).toBe(0);
    }
    expect(existsSync(marker)).toBe(false);

    const claimed = await cli(["claim", id], cwd, { USER: "u" }, path);
    expect(claimed.code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(claimed.stdout).claimed_by).toBe("fake-git");
  });
});
