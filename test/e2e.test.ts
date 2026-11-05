import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { Store } from "../src/store";

const CLI = join(import.meta.dir, "../src/cli.ts");
const dir = mkdtempSync(join(tmpdir(), "boons-e2e-"));
const repo = join(dir, "repo");
mkdirSync(join(repo, "sub"), { recursive: true });
const store = new Store({ path: join(dir, "boons.db") });
const server = Bun.serve({ port: 0, fetch: createHandler(store, { token: "t0k" }) });

afterAll(() => {
  server.stop(true);
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function bn(args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    BOONS_URL: server.url.href,
    BOONS_TOKEN: "t0k",
    BN_ACTOR: "agent-1",
    BN_PROJECT: undefined,
    ...opts.env,
  };
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: opts.cwd ?? repo,
    env: env as Record<string, string>,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function bnJson(args: string[], opts?: Parameters<typeof bn>[1]) {
  const r = await bn([...args, "--json"], opts);
  if (r.code !== 0) throw new Error(`bn ${args.join(" ")} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("full workflow through the CLI", async () => {
  // A command that needs a project fails with a hint before init.
  const noProject = await bn(["ready"]);
  expect(noProject.code).toBe(1);
  expect(noProject.stderr).toContain("bn init");

  expect(await bnJson(["init", "bn", "--name", "Boons"])).toMatchObject({ prefix: "bn", name: "Boons" });
  expect(JSON.parse(readFileSync(join(repo, ".boons.json"), "utf8"))).toEqual({ project: "bn" });
  // Idempotent: linking an existing project succeeds.
  expect(await bnJson(["init", "bn"])).toMatchObject({ prefix: "bn", name: "Boons" });
  expect((await bnJson(["projects"])).map((p: any) => p.prefix)).toEqual(["bn"]);

  // Project is found from a subdirectory via .boons.json.
  const sub = join(repo, "sub");
  const first = await bnJson(["create", "Fix", "the", "login", "-t", "bug", "-p", "1"], { cwd: sub });
  expect(first).toMatchObject({ id: "bn-1", title: "Fix the login", type: "bug", priority: 1, created_by: "agent-1" });
  const second = await bnJson(["create", "Write docs", "-d", "-"], { stdin: "Long\ndescription\n" });
  expect(second).toMatchObject({ id: "bn-2", description: "Long\ndescription", priority: 2 });
  expect((await bn(["create", "Plain", "-p", "P3"])).stdout.trim()).toBe("bn-3");

  expect((await bnJson(["ready"])).map((b: any) => b.id)).toEqual(["bn-1", "bn-2", "bn-3"]);

  // --as overrides BN_ACTOR; claim-next picks priority order.
  expect(await bnJson(["claim", "--as", "agent-2"])).toMatchObject({ id: "bn-1", claimed_by: "agent-2" });
  expect(await bnJson(["claim", "BN-2"])).toMatchObject({ id: "bn-2", claimed_by: "agent-1" });
  const conflict = await bn(["claim", "bn-1"]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toMatch(/^error: bn-1 is already claimed by agent-2/);

  expect(await bnJson(["show", "bn-1"])).toMatchObject({ boon: { id: "bn-1", status: "in_progress" }, ready: false, reasons: [] });
  expect(await bnJson(["unclaim", "bn-1"])).toMatchObject({ status: "open", claimed_by: null });

  // Close several at once; single id prints one object, several print an array.
  const closed = await bnJson(["close", "bn-1", "bn-2", "-r", "done"]);
  expect(closed.map((b: any) => [b.id, b.status, b.close_reason])).toEqual([
    ["bn-1", "closed", "done"],
    ["bn-2", "closed", "done"],
  ]);
  expect((await bnJson(["list"])).map((b: any) => b.id)).toEqual(["bn-3"]);
  expect((await bnJson(["list", "--all"])).map((b: any) => b.id)).toEqual(["bn-1", "bn-2", "bn-3"]);
  expect((await bnJson(["list", "--status", "closed", "--type", "bug"])).map((b: any) => b.id)).toEqual(["bn-1"]);
  expect(await bnJson(["reopen", "bn-1"])).toMatchObject({ id: "bn-1", status: "open", closed_at: null });

  expect(await bnJson(["claim", "-P", "bn"])).toMatchObject({ id: "bn-1" });
  expect(await bnJson(["claim"])).toMatchObject({ id: "bn-3" });
  expect(await bnJson(["claim"])).toBeNull();
});

test("human output", async () => {
  const list = await bn(["list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toBe("bn-1  P1  in_progress  bug      Fix the login  [@agent-1]\nbn-3  P3  in_progress  task     Plain  [@agent-1]\n");
  const show = await bn(["show", "bn-2"]);
  expect(show.stdout).toContain("bn-2  Write docs");
  expect(show.stdout).toContain("closed:");
  expect(show.stdout).toContain("Long\ndescription");
});

test("links, blocked derivation, parent filters and force close through the real CLI", async () => {
  const cwd = join(dir, "links-project");
  mkdirSync(cwd);
  const json = (args: string[]) => bnJson(args, { cwd });
  await json(["init", "lk"]);
  const blocker = await json(["create", "Blocker"]);
  const parent = await json(["create", "Parent", "--blocked-by", blocker.id]);
  const child = await json(["create", "Child", "--parent", parent.id, "--discovered-from", blocker.id]);
  expect((await json(["list", "--parent", parent.id])).map((b: any) => b.id)).toEqual([child.id]);
  const detail = await json(["dep", "add", child.id, blocker.id]);
  expect(detail.blockers.map((b: any) => b.id)).toEqual([blocker.id]);
  const blocked = await json(["blocked"]);
  expect(blocked.map((e: any) => e.boon.id)).toEqual([parent.id, child.id]);
  expect(blocked[1].reasons).toEqual([
    { kind: "blocker", id: blocker.id }, { kind: "inherited", id: blocker.id, via: parent.id },
  ]);
  const shown = await json(["show", child.id]);
  expect(shown).toMatchObject({ parent: { id: parent.id }, discovered_from: [{ id: blocker.id }], ready: false });
  const human = await bn(["show", child.id], { cwd });
  expect(human.stdout).toContain(`inherited: ${blocker.id} (via ${parent.id})`);
  expect(human.stdout).toContain("parent:");
  const cycle = await bn(["dep", "add", blocker.id, child.id], { cwd });
  expect(cycle.code).toBe(1);
  expect(cycle.stderr).toContain("cycle");
  expect((await bn(["claim", child.id], { cwd })).stderr).toContain("not ready");
  await json(["dep", "rm", child.id, blocker.id]);
  await json(["dep", "add", child.id, blocker.id, "--kind", "related"]);
  expect((await json(["show", blocker.id])).related.map((b: any) => b.id)).toEqual([child.id]);
  await json(["dep", "rm", blocker.id, child.id, "--kind", "related"]);
  expect((await json(["show", child.id])).related).toEqual([]);
  expect((await bn(["close", parent.id], { cwd })).stderr).toContain("unfinished children");
  expect(await json(["close", parent.id, "--force"])).toMatchObject({ status: "closed" });
  await json(["close", blocker.id]);
  expect((await json(["ready"])).map((b: any) => b.id)).toEqual([child.id]);
  expect(await json(["claim"])).toMatchObject({ id: child.id });
});

test("errors, help and connection failures", async () => {
  const help = await bn([]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("bn claim [id]");
  expect(help.stdout).not.toContain("defer");
  expect((await bn(["close", "--help"])).stdout).toContain("usage: bn close <id...> [-r reason]");

  const unknown = await bn(["frobnicate"]);
  expect(unknown).toMatchObject({ code: 1, stderr: "error: unknown command 'frobnicate' (see `bn help`)\n" });

  const badFlag = await bn(["list", "--bogus"]);
  expect(badFlag.code).toBe(1);
  expect(badFlag.stderr).toContain("bn list --help");

  const badToken = await bn(["projects"], { env: { BOONS_TOKEN: "nope" } });
  expect(badToken).toMatchObject({ code: 1, stderr: "error: missing or invalid token\n" });

  const invalid = await bn(["create", "x", "-p", "9"]);
  expect(invalid).toMatchObject({ code: 1, stderr: "error: priority must be an integer from 0 to 4\n" });

  const url = "http://127.0.0.1:1";
  const down = await bn(["projects"], { env: { BOONS_URL: url } });
  expect(down).toMatchObject({ code: 1, stderr: `error: cannot reach boons server at ${url} (is \`bn serve\` running?)\n` });
});
