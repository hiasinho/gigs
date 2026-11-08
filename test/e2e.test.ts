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
  const r = await bn(args, opts);
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
  const renamed = await bn(["init", "bn", "--name", "Other"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stderr).toBe('warning: project bn already exists as "Boons"; --name ignored\n');
  expect((await bnJson(["projects"])).map((p: any) => p.prefix)).toEqual(["bn"]);

  // Project is found from a subdirectory via .boons.json.
  const sub = join(repo, "sub");
  const first = await bnJson(["create", "Fix", "the", "login", "-t", "bug", "-p", "1"], { cwd: sub });
  // Mutations print the compact row: no description, no nulls, no audit fields.
  expect(first).toEqual({ id: "bn-1", title: "Fix the login", type: "bug", priority: 1, status: "open" });
  const second = await bnJson(["create", "Write docs", "-d", "-", "--full"], { stdin: "Long\ndescription\n" });
  expect(second).toMatchObject({ id: "bn-2", description: "Long\ndescription", priority: 2 });
  expect((await bn(["create", "Plain", "-p", "P3", "--human"])).stdout.trim()).toBe("bn-3");

  expect((await bnJson(["ready"])).map((b: any) => b.id)).toEqual(["bn-1", "bn-2", "bn-3"]);

  // --as overrides BN_ACTOR; claim-next picks priority order.
  expect(await bnJson(["claim", "--as", "agent-2"])).toMatchObject({ id: "bn-1", claimed_by: "agent-2" });
  expect(await bnJson(["claim", "BN-2"])).toMatchObject({ id: "bn-2", claimed_by: "agent-1" });
  const conflict = await bn(["claim", "bn-1"]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toMatch(/^error: bn-1 is already claimed by agent-2/);

  expect(await bnJson(["show", "bn-1", "--full"])).toMatchObject({ boon: { id: "bn-1", status: "in_progress" }, ready: false, reasons: [] });
  // Compact show of an in_progress boon: no ready/reasons, claim fields present.
  expect(await bnJson(["show", "bn-1"])).toEqual({
    id: "bn-1", title: "Fix the login", type: "bug", priority: 1, status: "in_progress",
    claimed_by: "agent-2", claim_expires_at: expect.any(String),
  });
  expect(await bnJson(["unclaim", "bn-1"])).toEqual({ id: "bn-1", title: "Fix the login", type: "bug", priority: 1, status: "open" });

  // Close several at once; single id prints one object, several print an array.
  const closed = await bnJson(["close", "bn-1", "bn-2", "-r", "done"]);
  expect(closed).toEqual([
    { id: "bn-1", title: "Fix the login", type: "bug", priority: 1, status: "closed", close_reason: "done" },
    { id: "bn-2", title: "Write docs", type: "task", priority: 2, status: "closed", close_reason: "done" },
  ]);
  expect((await bnJson(["list"])).map((b: any) => b.id)).toEqual(["bn-3"]);
  expect((await bnJson(["list", "--all"])).map((b: any) => b.id)).toEqual(["bn-1", "bn-2", "bn-3"]);
  expect((await bnJson(["list", "--status", "closed", "--type", "bug"])).map((b: any) => b.id)).toEqual(["bn-1"]);
  expect(await bnJson(["reopen", "bn-1", "--full"])).toMatchObject({ id: "bn-1", status: "open", closed_at: null });

  expect(await bnJson(["claim", "-P", "bn"])).toMatchObject({ id: "bn-1" });
  expect(await bnJson(["claim"])).toMatchObject({ id: "bn-3" });
  expect(await bnJson(["claim"])).toBeNull();
});

test("human output", async () => {
  const list = await bn(["--human", "list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toBe("bn-1  P1  in_progress  bug      Fix the login  [@agent-1]\nbn-3  P3  in_progress  task     Plain  [@agent-1]\n");
  const show = await bn(["show", "bn-2", "--human"]);
  expect(show.stdout).toContain("bn-2  Write docs");
  expect(show.stdout).toContain("task · P2 · closed by agent-1: done");
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
  expect((await bn(["dep", "add", child.id.toUpperCase(), blocker.id, "--human"], { cwd })).stdout).toBe(`${child.id} is now blocked by ${blocker.id}\n`);
  expect(await json(["dep", "add", child.id, blocker.id])).toEqual({ id: child.id, title: "Child", type: "task", priority: 2, status: "open", parent: parent.id });
  const detail = await json(["dep", "add", child.id, blocker.id, "--full"]);
  expect(detail.blockers.map((b: any) => b.id)).toEqual([blocker.id]);
  const blocked = await json(["blocked"]);
  expect(blocked).toEqual([
    { id: parent.id, title: "Parent", type: "task", priority: 2, status: "open", reasons: [{ kind: "blocker", id: blocker.id }, { kind: "child", id: child.id }] },
    {
      id: child.id, title: "Child", type: "task", priority: 2, status: "open", parent: parent.id,
      reasons: [{ kind: "blocker", id: blocker.id }, { kind: "inherited", id: blocker.id, via: parent.id }],
    },
  ]);
  expect((await json(["blocked", "--full"]))[1]).toMatchObject({ boon: { id: child.id, claimed_by: null } });
  const shown = await json(["show", child.id]);
  expect(shown).toEqual({
    id: child.id, title: "Child", type: "task", priority: 2, status: "open", ready: false,
    reasons: [{ kind: "blocker", id: blocker.id }, { kind: "inherited", id: blocker.id, via: parent.id }],
    parent: { id: parent.id, title: "Parent", status: "open" },
    blockers: [{ id: blocker.id, title: "Blocker", status: "open" }],
    discovered_from: [{ id: blocker.id, title: "Blocker", status: "open" }],
  });
  const human = await bn(["show", child.id, "--human"], { cwd });
  expect(human.stdout).toContain(`not ready: blocked by ${blocker.id}; inherits blocker ${blocker.id} via ${parent.id}`);
  expect(human.stdout).toContain("parent:");
  const cycle = await bn(["dep", "add", blocker.id, child.id], { cwd });
  expect(cycle.code).toBe(1);
  expect(cycle.stderr).toContain("cycle");
  expect((await bn(["claim", child.id], { cwd })).stderr).toContain("not ready");
  expect((await bn(["dep", "rm", child.id, blocker.id, "--human"], { cwd })).stdout).toBe(`${child.id} is no longer blocked by ${blocker.id}\n`);
  await json(["dep", "add", child.id, blocker.id, "--kind", "related"]);
  expect((await json(["show", blocker.id])).related.map((b: any) => b.id)).toEqual([child.id]);
  await json(["dep", "rm", blocker.id, child.id, "--kind", "related"]);
  expect((await json(["show", child.id])).related).toBeUndefined();
  expect((await bn(["close", parent.id], { cwd })).stderr).toContain("unfinished children");
  expect(await json(["close", parent.id, "--force"])).toMatchObject({ status: "closed" });
  await json(["close", blocker.id]);
  expect((await json(["ready"])).map((b: any) => b.id)).toEqual([child.id]);
  expect(await json(["claim"])).toMatchObject({ id: child.id });
});

test("update, heartbeat, defer and comments through the real CLI", async () => {
  const cwd = join(dir, "slice3-project");
  mkdirSync(cwd);
  const json = (args: string[], opts: Parameters<typeof bn>[1] = {}) => bnJson(args, { cwd, ...opts });
  const run = (args: string[], opts: Parameters<typeof bn>[1] = {}) => bn(args, { cwd, ...opts });
  await json(["init", "sl"]);
  const epic = await json(["create", "Epic", "-t", "epic"]);
  const task = await json(["create", "Task"]);

  expect(await json(["update", task.id, "--title", "Better task", "-p", "P0", "-t", "bug", "--parent", epic.id]))
    .toMatchObject({ title: "Better task", priority: 0, type: "bug", parent: epic.id });
  expect(await json(["update", task.id, "-d", "-", "--full"], { stdin: "from stdin\n" })).toMatchObject({ description: "from stdin" });
  expect(await json(["update", task.id, "--parent", "none"])).toEqual({ id: task.id, title: "Better task", type: "bug", priority: 0, status: "open" });
  expect((await run(["update", task.id])).stderr).toContain("nothing to update");
  expect((await run(["update", task.id, "-t", "story"])).stderr).toContain("type must be one of");
  expect((await run(["update", epic.id, "--parent", epic.id])).stderr).toContain("cycle");

  const claimed = await json(["claim", task.id]);
  expect(claimed.claim_expires_at).toBeString();
  expect(await json(["heartbeat", task.id])).toMatchObject({ claimed_by: "agent-1" });
  const stolen = await run(["heartbeat", task.id, "--as", "agent-2"]);
  expect(stolen.code).toBe(1);
  expect(stolen.stderr).toBe(`error: ${task.id} is claimed by agent-1, not agent-2; only the holder can heartbeat\n`);

  expect(await json(["comment", task.id, "halfway", "there"])).toEqual({ boon_id: task.id, author: "agent-1", at: expect.any(String), body: "halfway there" });
  await json(["comment", task.id, "-"], { stdin: "multi\nline\n", env: { BN_ACTOR: "agent-2" } });
  const shown = await json(["show", task.id]);
  expect(shown.comments.map((c: any) => [c.author, c.body])).toEqual([["agent-1", "halfway there"], ["agent-2", "multi\nline"]]);
  const human = (await run(["show", task.id, "--full", "--human"])).stdout;
  expect(human).toMatch(/claimed:   by agent-1 at \S+, expires \S+/);
  expect(human).toMatch(/comments:\n  \S+ agent-1:\n    halfway there\n  \S+ agent-2:\n    multi\n    line/);

  const before = Date.now();
  const deferred = await json(["defer", task.id, "--until", "2h"]);
  expect(deferred).toEqual({ id: task.id, title: "Better task", type: "bug", priority: 0, status: "deferred", defer_until: expect.any(String) });
  const until = Date.parse(deferred.defer_until);
  expect(until - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
  expect(until - before).toBeLessThan(2 * 3_600_000 + 60_000);
  expect((await json(["ready"])).map((b: any) => b.id)).toEqual([epic.id]);
  expect((await run(["list", "--human"])).stdout).toContain(`[until ${deferred.defer_until}]`);
  expect((await run(["show", task.id, "--full", "--human"])).stdout).toContain(`deferred:  until ${deferred.defer_until}`);
  expect((await run(["defer", task.id, "--until", "2001-01-01T00:00:00Z"])).stderr).toBe("error: until must be in the future\n");
  expect(await json(["defer", task.id, "--until", "2999-01-01T00:00:00Z"])).toMatchObject({ defer_until: "2999-01-01T00:00:00.000Z" });
  const day = await json(["defer", task.id, "--until", "2999-03-04"]);
  expect(day.defer_until).toBe(new Date(2999, 2, 4).toISOString());
  expect((await run(["defer", task.id, "--until", "2999-02-30"])).stderr).toBe("error: invalid date: 2999-02-30\n");
  // An ISO date-time without an offset is local time, like a plain date.
  const local = await json(["defer", task.id, "--until", "2999-03-04T10:30"]);
  expect(local.defer_until).toBe(new Date(2999, 2, 4, 10, 30).toISOString());
  expect((await json(["defer", task.id, "--until", "2999-03-04T10:30:15"])).defer_until).toBe(new Date(2999, 2, 4, 10, 30, 15).toISOString());
  expect((await run(["defer", task.id, "--until", "2999-02-30T10:00"])).stderr).toBe("error: invalid date: 2999-02-30T10:00\n");
  expect(await json(["defer", task.id])).toEqual({ id: task.id, title: "Better task", type: "bug", priority: 0, status: "deferred" });
  expect((await run(["undefer", task.id, "--human"])).stdout).toBe(`undeferred ${task.id}\n`);
  expect((await json(["ready"])).map((b: any) => b.id)).toEqual([task.id, epic.id]);
});

test("show --full prints every relation on its own indented line, with numeric ordering", async () => {
  store.createProject("sh");
  for (let n = 1; n <= 16; n++) store.createBoon("sh", "fixture", { title: `Boon ${n}` });
  store.update("sh-2", "fixture", { parent: "sh-1" });
  store.update("sh-10", "fixture", { parent: "sh-2" });
  store.update("sh-3", "fixture", { parent: "sh-2" });
  store.close("sh-3", "fixture");
  for (const id of ["sh-11", "sh-4"]) store.addLink("sh-2", id, "blocks", "fixture");
  for (const id of ["sh-12", "sh-5"]) store.addLink(id, "sh-2", "blocks", "fixture");
  store.addLink("sh-2", "sh-13", "related", "fixture");
  store.addLink("sh-6", "sh-2", "related", "fixture");
  for (const id of ["sh-14", "sh-7"]) store.addLink("sh-2", id, "discovered-from", "fixture");
  for (const id of ["sh-15", "sh-8"]) store.addLink(id, "sh-2", "discovered-from", "fixture");

  const json = await bnJson(["show", "sh-2", "--full"]);
  expect(json.children.map((b: any) => b.id)).toEqual(["sh-3", "sh-10"]);
  const human = await bn(["show", "sh-2", "--full", "--human"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain(`parent:\n  sh-1  open  Boon 1\nchildren:\n  sh-3  closed  Boon 3\n  sh-10  open  Boon 10\nblockers:\n  sh-4  open  Boon 4\n  sh-11  open  Boon 11\nblocks:\n  sh-5  open  Boon 5\n  sh-12  open  Boon 12\nrelated:\n  sh-6  open  Boon 6\n  sh-13  open  Boon 13\ndiscovered_from:\n  sh-7  open  Boon 7\n  sh-14  open  Boon 14\ndiscovered:\n  sh-8  open  Boon 8\n  sh-15  open  Boon 15\n`);
});

test("compact show covers statuses, relations and multiline comments without audit timestamps", async () => {
  store.createProject("co");
  const run = async (id: string, flags: string[] = []) => {
    const result = await bn(["show", id, "--human", ...flags], { env: { TZ: "UTC" } });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout;
  };
  const epic = store.createBoon("co", "fixture", { title: "Epic", type: "epic" });
  const task = store.createBoon("co", "fixture", { title: "Task", priority: 1, description: "First\nsecond", parent: epic.id });
  const done = store.createBoon("co", "fixture", { title: "Finished child", parent: epic.id });
  const alsoDone = store.createBoon("co", "fixture", { title: "Another finished child", parent: epic.id });
  store.close(done.id, "fixture", "verified");
  store.close(alsoDone.id, "fixture");
  expect(await run(task.id)).toBe(`${task.id}  Task\ntask · P1 · ready\nparent: ${epic.id} Epic\n\nFirst\nsecond\n`);
  expect(await run(epic.id)).toBe(`${epic.id}  Epic\nepic · P2 · open\nnot ready: child ${task.id} unfinished\nchildren:\n  ${task.id}  open  Task\n  +2 closed\n`);
  expect(await run(done.id)).toBe(`${done.id}  Finished child\ntask · P2 · closed by fixture: verified\nparent: ${epic.id} Epic\n`);
  expect(await run(alsoDone.id)).toContain("task · P2 · closed by fixture\n");

  // The old complete renderer is exact.
  const b = (await bnJson(["show", task.id, "--full"])).boon;
  expect(await run(task.id, ["--full"])).toBe(
    `${task.id}  Task\n\nstatus:    open (ready)\ntype:      task\npriority:  P1\ncreated:   ${b.created_at} by fixture\nupdated:   ${b.updated_at}\nparent:\n  ${epic.id}  open  Epic\n\nFirst\nsecond\n`,
  );

  await bnJson(["claim", task.id]);
  await bnJson(["comment", task.id, "First line\nSecond line\n\nFourth line"]);
  const short = "[A-Z][a-z]{2} \\d{1,2}(?: \\d{4})? \\d{2}:\\d{2}";
  const claimed = await run(task.id);
  expect(claimed).toMatch(new RegExp(`task · P1 · in progress, claimed by agent-1 until ${short}\\n`));
  expect(claimed).toMatch(new RegExp(`comments:\\n  agent-1 \\(${short}\\): First line\\n    Second line\\n    \\n    Fourth line\\n$`));
  expect(claimed).not.toMatch(/created:|updated:|not ready:|\\.\\d{3}Z/);

  await bnJson(["defer", task.id, "--until", "2999-03-04T10:30:00Z"]);
  const deferred = await run(task.id);
  expect(deferred).toContain("task · P1 · deferred until Mar 4 2999 10:30\n");
  expect(deferred).not.toContain("not ready:");
  await bnJson(["defer", task.id]);
  expect(await run(task.id)).toContain("task · P1 · deferred\n");
  await bnJson(["undefer", task.id]);

  // Every relation group uses the same unfinished/closed split; empty groups disappear.
  const blocker = store.createBoon("co", "fixture", { title: "Blocker" });
  store.addLink(task.id, blocker.id, "blocks", "fixture");
  expect(await run(task.id)).toContain(`task · P1 · open\nparent: ${epic.id} Epic\nnot ready: blocked by ${blocker.id}\nblockers:\n  ${blocker.id}  open  Blocker\n`);
  store.close(blocker.id, "fixture");
  store.addLink(task.id, done.id, "related", "fixture");
  store.addLink(task.id, alsoDone.id, "discovered-from", "fixture");
  store.addLink(done.id, task.id, "discovered-from", "fixture");
  store.addLink(done.id, task.id, "blocks", "fixture");
  const relations = await run(task.id);
  expect(relations).toContain("blockers: 1 closed\nblocks: 1 closed\nrelated: 1 closed\ndiscovered from: 1 closed\ndiscovered: 1 closed\n");
  await bnJson(["close", task.id]);
  const closedEpic = await run(epic.id);
  expect(closedEpic).toBe(`${epic.id}  Epic\nepic · P2 · ready\nchildren: 3 closed\n`);
});

test("compact JSON shapes for agents, and --full prints the raw API response", async () => {
  store.createProject("js");
  const env = { BN_PROJECT: "js" };
  const json = (args: string[], actor = "agent-1") => bnJson(args, { env: { ...env, BN_ACTOR: actor } });
  const epic = store.createBoon("js", "fixture", { title: "Epic", type: "epic", priority: 1, description: "The plan" });
  const a = store.createBoon("js", "fixture", { title: "A", parent: epic.id, description: "long text" });
  const b = store.createBoon("js", "fixture", { title: "B", parent: epic.id });
  const c = store.createBoon("js", "fixture", { title: "C", parent: epic.id });
  const blocker = store.createBoon("js", "fixture", { title: "Blocker", priority: 0 });
  store.addLink(b.id, blocker.id, "blocks", "fixture");
  store.addLink(epic.id, blocker.id, "related", "fixture");
  store.close(c.id, "fixture", "done");
  store.addComment(epic.id, "agent-2", "first\nsecond");

  // One line, no description in rows.
  const ready = await bn(["ready"], { env });
  expect(ready.stdout).toBe(
    `[{"id":"${blocker.id}","title":"Blocker","type":"task","priority":0,"status":"open"},` +
    `{"id":"${a.id}","title":"A","type":"task","priority":2,"status":"open","parent":"${epic.id}"}]\n`,
  );
  expect((await bn(["ready", "--json"], { env })).stdout).toBe(ready.stdout);
  // The legacy flag is a no-op, including when human output is requested.
  expect((await bn(["ready", "--human", "--json"], { env })).stdout)
    .toBe((await bn(["ready", "--human"], { env })).stdout);
  expect(await json(["list", "--status", "closed"])).toEqual([
    { id: c.id, title: "C", type: "task", priority: 2, status: "closed", parent: epic.id, close_reason: "done" },
  ]);
  expect(await json(["blocked"])).toEqual([
    { id: epic.id, title: "Epic", type: "epic", priority: 1, status: "open", reasons: [{ kind: "child", id: a.id }, { kind: "child", id: b.id }] },
    { id: b.id, title: "B", type: "task", priority: 2, status: "open", parent: epic.id, reasons: [{ kind: "blocker", id: blocker.id }] },
  ]);

  // Open, not ready: reasons, unfinished relations, closed counts, comments.
  expect(await json(["show", epic.id])).toEqual({
    id: epic.id, title: "Epic", type: "epic", priority: 1, status: "open", description: "The plan", ready: false,
    reasons: [{ kind: "child", id: a.id }, { kind: "child", id: b.id }],
    children: [{ id: a.id, title: "A", status: "open" }, { id: b.id, title: "B", status: "open" }],
    related: [{ id: blocker.id, title: "Blocker", status: "open" }],
    closed: { children: 1 },
    comments: [{ author: "agent-2", at: expect.any(String), body: "first\nsecond" }],
  });

  // claim returns the show shape; the claim lands on the next ready boon.
  const claimed = await json(["claim"]);
  expect(claimed).toEqual({
    id: blocker.id, title: "Blocker", type: "task", priority: 0, status: "in_progress",
    claimed_by: "agent-1", claim_expires_at: expect.any(String),
    blocks: [{ id: b.id, title: "B", status: "open" }],
    related: [{ id: epic.id, title: "Epic", status: "open" }],
  });
  expect(await json(["show", blocker.id])).toEqual(claimed);
  expect(await json(["close", blocker.id])).toEqual({ id: blocker.id, title: "Blocker", type: "task", priority: 0, status: "closed" });
  const shownB = await json(["show", b.id]);
  expect(shownB).toEqual({
    id: b.id, title: "B", type: "task", priority: 2, status: "open", ready: true,
    parent: { id: epic.id, title: "Epic", status: "open" }, closed: { blockers: 1 },
  });
  expect(await json(["claim", "--full"], "agent-2")).toMatchObject({ id: a.id, project: "js", claimed_by: "agent-2", closed_at: null });
  await json(["claim", b.id]);
  expect(await json(["claim"])).toBeNull();
  expect(await json(["claim", "--full"])).toBeNull();

  // --full prints exactly what the API returns, on one line.
  const api = async (path: string) => (await fetch(new URL(path, server.url), { headers: { Authorization: "Bearer t0k" } })).json();
  const raw = await bn(["show", epic.id, "--full"], { env });
  expect(raw.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(raw.stdout)).toEqual(await api(`/boons/${epic.id}`));
  expect(await json(["list", "--all", "--full"])).toEqual(await api("/projects/js/boons?all=1"));
  expect(await json(["projects"])).toEqual(await api("/projects"));
});

test("CLI rejects missing global values, unknown global flags and surplus positionals", async () => {
  for (const args of [["--as"], ["-P"], ["--bogus"], ["claim", "bn-2", "bn-3"], ["show", "bn-2", "extra"], ["ready", "extra"], ["dep", "add", "bn-2", "bn-3", "extra"]]) {
    const result = await bn(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error:");
  }
  expect((await bn(["--as", "early-actor", "--project=bn", "ready"])).code).toBe(0);
  expect((await bn(["--human"])).code).toBe(0);
});

test("not-ready claim errors are readable and API reasons stay structured", async () => {
  store.createProject("nr");
  const blocker = store.createBoon("nr", "fixture", { title: "blocker" });
  const child = store.createBoon("nr", "fixture", { title: "blocked", blocked_by: [blocker.id] });
  const result = await bn(["claim", child.id]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("error: " + child.id + " is not ready: blocked by " + blocker.id + "\n");
  const res = await fetch(new URL("/boons/" + child.id + "/claim", server.url), {
    method: "POST", headers: { Authorization: "Bearer t0k", "X-Boons-Actor": "fixture" },
  });
  expect(await res.json()).toMatchObject({ error: { code: "not_ready", reasons: [{ kind: "blocker", id: blocker.id }] } });
});

test("errors, help and connection failures", async () => {
  const help = await bn([]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("output: compact JSON by default");
  expect(help.stdout).toContain("--human");
  expect((await bn(["help", "--human"])).stdout).toBe(help.stdout);
  expect((await bn(["show", "--help", "--human"])).stdout)
    .toBe((await bn(["show", "--help"])).stdout);
  expect(help.stdout).toContain("bn claim [id]");
  expect(help.stdout).toContain("bn defer <id> [--until");
  expect(help.stdout.split("\n").every((line) => line.length <= 80)).toBe(true);
  expect((await bn(["help"])).stdout).toBe(help.stdout);
  expect(help.stdout).toContain("  bn ready [--spec id]\n    ready boons in priority order\n");
  expect((await bn(["show", "--help"])).stdout).toBe("usage: bn show <id> [--full]\n\nshow a compact boon (--full shows everything)\n");
  const createHelp = await bn(["create", "--help"]);
  expect(createHelp.code).toBe(0);
  expect(createHelp.stdout.split("\n").every((line) => line.length <= 80)).toBe(true);
  expect(createHelp.stdout).toContain("[--discovered-from id]");
  expect(createHelp.stdout).toContain("create a boon");
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

test("skill prints the agent skill without a server or project", async () => {
  const skill = readFileSync(join(import.meta.dir, "../.agents/skills/boons/SKILL.md"), "utf8");
  const env = { BOONS_URL: "http://127.0.0.1:1" };
  const r = await bn(["skill"], { cwd: dir, env });
  expect(r).toEqual({ stdout: skill, stderr: "", code: 0 });
  for (const flag of ["--json", "--human", "--full"]) {
    expect(await bn(["skill", flag], { cwd: dir, env })).toEqual(r);
  }
  expect((await bn(["skill", "extra"], { cwd: dir, env })).code).toBe(1);
});

test("specs through the real CLI: create, show, list, --spec filters, project from the spec id", async () => {
  const cwd = join(dir, "spec-project");
  mkdirSync(cwd);
  store.createProject("sq");
  store.createProject("sz");
  const env = { BN_PROJECT: "sq" };
  const json = (args: string[], opts: Parameters<typeof bn>[1] = { env }) => bnJson(args, opts);

  expect(await json(["spec", "create", "Checkout", "v2", "-d", "-"], { env, stdin: "We agree on\nthe flow.\n" })).toEqual({ id: "sq-s1", title: "Checkout v2" });
  expect(await json(["spec", "create", "Second", "-d", "short"])).toEqual({ id: "sq-s2", title: "Second" });
  expect((await bn(["spec", "create", "No text"], { env })).stderr).toContain("missing text");
  expect(await json(["spec", "show", "SQ-S1"], { cwd })).toEqual({ id: "sq-s1", title: "Checkout v2", text: "We agree on\nthe flow." });
  expect(await json(["spec", "show", "sq-s1", "--full"], { cwd })).toMatchObject({ id: "sq-s1", project: "sq", created_by: "agent-1" });
  expect((await bn(["spec", "show", "sq-s1", "--human"], { cwd })).stdout).toBe("sq-s1  Checkout v2\n\nWe agree on\nthe flow.\n");
  expect(await json(["spec", "list"])).toEqual([{ id: "sq-s1", title: "Checkout v2" }, { id: "sq-s2", title: "Second" }]);
  expect((await bn(["spec", "list", "--human"], { env })).stdout).toBe("sq-s1  Checkout v2\nsq-s2  Second\n");
  expect((await bn(["spec", "show", "sq-s9"], { cwd })).code).toBe(1);
  expect((await bn(["spec", "edit", "sq-s1"], { env })).code).toBe(1);

  // Without .boons.json, the project comes from the spec id; it wins over a different -P.
  const blocker = await json(["create", "Outside", "-p", "0"]);
  const a = await json(["create", "Within", "--spec", "SQ-S1", "--blocked-by", blocker.id], { cwd });
  expect(a).toEqual({ id: "sq-2", title: "Within", type: "task", priority: 2, status: "open", spec: "sq-s1" });
  const b = await json(["create", "Also within", "-p", "3", "--spec", "sq-s1", "-P", "sz"], { cwd });
  expect(b.id).toBe("sq-3");
  const moved = await json(["create", "Moved"]);
  expect(await json(["update", moved.id, "--spec", "sq-s2"], { cwd })).toMatchObject({ spec: "sq-s2" });
  expect(await json(["update", moved.id, "--spec", "none"], { cwd })).not.toHaveProperty("spec");

  expect((await json(["list", "--spec", "sq-s1"], { cwd })).map((x: any) => x.id)).toEqual([a.id, b.id]);
  expect((await json(["ready", "--spec", "sq-s1", "-P", "sz"], { cwd })).map((x: any) => x.id)).toEqual([b.id]);
  expect(await json(["blocked", "--spec", "sq-s1"], { cwd })).toEqual([{ ...a, reasons: [{ kind: "blocker", id: blocker.id }] }]);
  expect(await json(["show", a.id], { cwd })).toMatchObject({ id: a.id, spec: "sq-s1" });
  expect((await bn(["show", a.id, "--human"], { cwd })).stdout).toContain("\nspec: sq-s1\n");

  const wrong = await bn(["create", "x", "--spec", "nope"], { cwd });
  expect(wrong.stderr).toBe("error: invalid spec id: nope\n");
  expect((await bn(["claim", b.id, "--spec", "sq-s1"], { cwd })).stderr).toContain("--spec only works");
  expect(await json(["claim", "--spec", "sq-s1"], { cwd })).toMatchObject({ id: b.id, status: "in_progress", spec: "sq-s1" });
  expect(await json(["claim", "--spec", "sq-s1"], { cwd })).toBeNull();
  expect(await json(["claim"])).toMatchObject({ id: blocker.id });
});
