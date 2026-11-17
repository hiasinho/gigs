import { afterAll, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { bunDescribe, bunTest, openStore } from "./harness";

// A binding (.gigs.json, plus .gigs.local.json next to it) ties a directory to one project on one
// server. These tests run the real CLI in a clean environment: no GIGS_* or GIG_* variables at all,
// like an agent's non-interactive shell where direnv never ran.

const dir = mkdtempSync(join(tmpdir(), "gigs-binding-"));
const store = openStore(join(dir, "binding.db"));
const server = Bun.serve({ port: 0, fetch: createHandler(store, { adminToken: "adm1n" }) });
store.createProject("bd");
store.createProject("ot");
const bdToken = store.createToken("bd").token;
const otToken = store.createToken("ot").token;
afterAll(() => {
  server.stop(true);
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^GIGS?_/.test(k)) env[k] = v;
  }
  return { ...env, GIG_ACTOR: "agent", ...extra };
}

async function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    cwd, env: cleanEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

function bind(name: string, files: { json?: object; local?: object }): string {
  const d = join(dir, name);
  mkdirSync(join(d, "sub"), { recursive: true });
  if (files.json) writeFileSync(join(d, ".gigs.json"), JSON.stringify(files.json));
  if (files.local) writeFileSync(join(d, ".gigs.local.json"), JSON.stringify(files.local));
  return d;
}

bunDescribe("binding", () => {
  bunTest("a fresh shell with no GIGS_* runs `gig ready` from .gigs.json (project, url) and .gigs.local.json (token)", async () => {
    const d = bind("agent", { json: { project: "bd", url: server.url.href }, local: { token: bdToken } });
    const r = await cli(["ready"], join(d, "sub"));
    expect(r).toMatchObject({ code: 0, stdout: "[]\n" });
  });

  bunTest("lookup order: env, then .gigs.local.json, then .gigs.json, then GIGS_DEFAULT_URL", async () => {
    const dead = "http://127.0.0.1:1";
    const d = bind("order", { json: { project: "bd", url: dead, token: otToken }, local: { url: server.url.href, token: bdToken } });
    // .gigs.local.json beats .gigs.json for both url and token.
    expect(await cli(["ready"], d)).toMatchObject({ code: 0 });
    // GIGS_URL beats both files.
    expect((await cli(["ready"], d, { GIGS_URL: dead })).stderr).toContain(`cannot reach gigs server at ${dead}`);
    // A binding's url beats the launcher's GIGS_DEFAULT_URL.
    expect(await cli(["ready"], d, { GIGS_DEFAULT_URL: dead })).toMatchObject({ code: 0 });
    // Without a url anywhere in the binding, GIGS_DEFAULT_URL applies.
    const noUrl = bind("no-url", { json: { project: "bd" }, local: { token: bdToken } });
    expect(await cli(["ready"], noUrl, { GIGS_DEFAULT_URL: server.url.href })).toMatchObject({ code: 0 });
  });

  bunTest("an existing .gigs.json that carries \"token\" keeps working", async () => {
    const d = bind("legacy", { json: { project: "bd", token: bdToken } });
    expect(await cli(["ready"], d, { GIGS_URL: server.url.href })).toMatchObject({ code: 0, stdout: "[]\n" });
  });

  bunTest("a rejected token: the error says where it came from", async () => {
    const d = bind("errors", { json: { project: "bd", url: server.url.href }, local: { token: bdToken } });
    // A GIGS_TOKEN inherited from another repo overrides this directory's binding.
    expect(await cli(["ready"], d, { GIGS_TOKEN: otToken })).toMatchObject({
      code: 1,
      stderr: `error: token is for project ot, not bd (token from GIGS_TOKEN, which overrides ${join(d, ".gigs.local.json")})\n`,
    });
    expect(await cli(["ready"], d, { GIGS_TOKEN: "nope" })).toMatchObject({
      code: 1,
      stderr: `error: missing or invalid token (token from GIGS_TOKEN, which overrides ${join(d, ".gigs.local.json")})\n`,
    });
    const wrong = bind("wrong-file", { json: { project: "bd", url: server.url.href }, local: { token: otToken } });
    expect((await cli(["ready"], wrong)).stderr).toBe(`error: token is for project ot, not bd (token from ${join(wrong, ".gigs.local.json")})\n`);
    const none = bind("no-token", { json: { project: "bd", url: server.url.href } });
    expect((await cli(["ready"], none)).stderr).toBe(`error: missing or invalid token (no token: put "token" in .gigs.local.json next to .gigs.json, or set GIGS_TOKEN)\n`);
  });

  bunTest("init in a git repo: url in .gigs.json, token in .gigs.local.json, which .gitignore lists once", async () => {
    const d = bind("init-git", {});
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".gitignore"), "node_modules\n");
    const admin = { GIGS_URL: server.url.href, GIGS_TOKEN: "adm1n" };
    const init = await cli(["init", "ig"], d, admin);
    expect(JSON.parse(init.stdout)).toMatchObject({ prefix: "ig", token_id: expect.any(Number) });
    expect(readJson(join(d, ".gigs.json"))).toEqual({ project: "ig", url: server.url.href });
    const local = readJson(join(d, ".gigs.local.json"));
    expect(Object.keys(local)).toEqual(["token"]);
    expect(store.tokenProject(local.token)).toBe("ig");
    expect(readFileSync(join(d, ".gitignore"), "utf8")).toBe("node_modules\n.gigs.local.json\n");

    // Re-running keeps the token and doesn't list the file twice.
    expect(JSON.parse((await cli(["init", "ig"], d, admin)).stdout)).not.toHaveProperty("token_id");
    expect(readJson(join(d, ".gigs.local.json"))).toEqual(local);
    expect(readFileSync(join(d, ".gitignore"), "utf8")).toBe("node_modules\n.gigs.local.json\n");

    // The binding alone is enough, from a subdirectory too.
    expect(await cli(["ready"], join(d, "sub"))).toMatchObject({ code: 0, stdout: "[]\n" });
  });

  bunTest("init outside a git repo writes no .gitignore; re-running moves a legacy token out of .gigs.json", async () => {
    const d = bind("init-legacy", { json: { project: "bd", token: bdToken } });
    expect((await cli(["init", "bd"], d, { GIGS_URL: server.url.href })).code).toBe(0);
    expect(readJson(join(d, ".gigs.json"))).toEqual({ project: "bd", url: server.url.href });
    expect(readJson(join(d, ".gigs.local.json"))).toEqual({ token: bdToken });
    expect(existsSync(join(d, ".gitignore"))).toBe(false);
  });
});

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}
