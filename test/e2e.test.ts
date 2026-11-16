import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { Store } from "../src/store";

const CLI = join(import.meta.dir, "../src/cli.ts");
const dir = mkdtempSync(join(tmpdir(), "gigs-e2e-"));
const repo = join(dir, "repo");
mkdirSync(join(repo, "sub"), { recursive: true });
const store = new Store({ path: join(dir, "gigs.db") });
const server = Bun.serve({ port: 0, fetch: createHandler(store, { token: "t0k" }) });

afterAll(() => {
  server.stop(true);
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIGS_URL: server.url.href,
    GIGS_TOKEN: "t0k",
    GIG_ACTOR: "agent-1",
    GIG_PROJECT: undefined,
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

async function cliJson(args: string[], opts?: Parameters<typeof cli>[1]) {
  const r = await cli(args, opts);
  if (r.code !== 0) throw new Error(`gig ${args.join(" ")} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("full workflow through the CLI", async () => {
  // A command that needs a project fails with a hint before init.
  const noProject = await cli(["ready"]);
  expect(noProject.code).toBe(1);
  expect(noProject.stderr).toContain("gig init");

  expect(await cliJson(["init", "gig", "--name", "Gigs"])).toMatchObject({ prefix: "gig", name: "Gigs" });
  expect(JSON.parse(readFileSync(join(repo, ".gigs.json"), "utf8"))).toEqual({ project: "gig" });
  // Idempotent: linking an existing project succeeds.
  expect(await cliJson(["init", "gig"])).toMatchObject({ prefix: "gig", name: "Gigs" });
  const renamed = await cli(["init", "gig", "--name", "Other"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stderr).toBe('warning: project gig already exists as "Gigs"; --name ignored\n');
  expect((await cliJson(["projects"])).map((p: any) => p.prefix)).toEqual(["gig"]);

  // Project is found from a subdirectory via .gigs.json.
  const sub = join(repo, "sub");
  const first = await cliJson(["create", "Fix", "the", "login", "-t", "bug", "-p", "1"], { cwd: sub });
  // Mutations print the compact row: no description, no nulls, no audit fields.
  expect(first).toEqual({ id: "gig-1", title: "Fix the login", type: "bug", priority: 1, status: "open" });
  const second = await cliJson(["create", "Write docs", "-d", "-", "--full"], { stdin: "Long\ndescription\n" });
  expect(second).toMatchObject({ id: "gig-2", description: "Long\ndescription", priority: 2 });
  expect((await cli(["create", "Plain", "-p", "P3", "--human"])).stdout.trim()).toBe("gig-3");

  expect((await cliJson(["ready"])).map((b: any) => b.id)).toEqual(["gig-1", "gig-2", "gig-3"]);

  // --as overrides GIG_ACTOR; claim-next picks priority order.
  expect(await cliJson(["claim", "--as", "agent-2"])).toMatchObject({ id: "gig-1", claimed_by: "agent-2" });
  expect(await cliJson(["claim", "GIG-2"])).toMatchObject({ id: "gig-2", claimed_by: "agent-1" });
  const conflict = await cli(["claim", "gig-1"]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toMatch(/^error: gig-1 is already claimed by agent-2/);

  expect(await cliJson(["show", "gig-1", "--full"])).toMatchObject({ gig: { id: "gig-1", status: "in_progress" }, ready: false, reasons: [] });
  // Compact show of an in_progress gig: no ready/reasons, claim fields present.
  expect(await cliJson(["show", "gig-1"])).toEqual({
    id: "gig-1", title: "Fix the login", type: "bug", priority: 1, status: "in_progress",
    claimed_by: "agent-2", claim_expires_at: expect.any(String),
  });
  expect(await cliJson(["unclaim", "gig-1"])).toEqual({ id: "gig-1", title: "Fix the login", type: "bug", priority: 1, status: "open" });

  // Close several at once; single id prints one object, several print an array.
  const closed = await cliJson(["close", "gig-1", "gig-2", "-r", "done"]);
  expect(closed).toEqual([
    { id: "gig-1", title: "Fix the login", type: "bug", priority: 1, status: "closed", close_reason: "done" },
    { id: "gig-2", title: "Write docs", type: "task", priority: 2, status: "closed", close_reason: "done" },
  ]);
  expect((await cliJson(["list"])).map((b: any) => b.id)).toEqual(["gig-3"]);
  expect((await cliJson(["list", "--all"])).map((b: any) => b.id)).toEqual(["gig-1", "gig-2", "gig-3"]);
  expect((await cliJson(["list", "--status", "closed", "--type", "bug"])).map((b: any) => b.id)).toEqual(["gig-1"]);
  expect(await cliJson(["reopen", "gig-1", "--full"])).toMatchObject({ id: "gig-1", status: "open", closed_at: null });

  expect(await cliJson(["claim", "-P", "gig"])).toMatchObject({ id: "gig-1" });
  expect(await cliJson(["claim"])).toMatchObject({ id: "gig-3" });
  expect(await cliJson(["claim"])).toBeNull();
});

test("human output", async () => {
  const list = await cli(["--human", "list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toBe("gig-1  P1  in_progress  bug      Fix the login  [@agent-1]\ngig-3  P3  in_progress  task     Plain  [@agent-1]\n");
  const show = await cli(["show", "gig-2", "--human"]);
  expect(show.stdout).toContain("gig-2  Write docs");
  expect(show.stdout).toContain("task · P2 · closed by agent-1: done");
  expect(show.stdout).toContain("Long\ndescription");
});

test("links, blocked derivation, parent filters and force close through the real CLI", async () => {
  const cwd = join(dir, "links-project");
  mkdirSync(cwd);
  const json = (args: string[]) => cliJson(args, { cwd });
  await json(["init", "lk"]);
  const blocker = await json(["create", "Blocker"]);
  const parent = await json(["create", "Parent", "--blocked-by", blocker.id]);
  const child = await json(["create", "Child", "--parent", parent.id, "--discovered-from", blocker.id]);
  expect((await json(["list", "--parent", parent.id])).map((b: any) => b.id)).toEqual([child.id]);
  expect((await cli(["dep", "add", child.id.toUpperCase(), blocker.id, "--human"], { cwd })).stdout).toBe(`${child.id} is now blocked by ${blocker.id}\n`);
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
  expect((await json(["blocked", "--full"]))[1]).toMatchObject({ gig: { id: child.id, claimed_by: null } });
  const shown = await json(["show", child.id]);
  expect(shown).toEqual({
    id: child.id, title: "Child", type: "task", priority: 2, status: "open", ready: false,
    reasons: [{ kind: "blocker", id: blocker.id }, { kind: "inherited", id: blocker.id, via: parent.id }],
    parent: { id: parent.id, title: "Parent", status: "open" },
    blockers: [{ id: blocker.id, title: "Blocker", status: "open" }],
    discovered_from: [{ id: blocker.id, title: "Blocker", status: "open" }],
  });
  const human = await cli(["show", child.id, "--human"], { cwd });
  expect(human.stdout).toContain(`not ready: blocked by ${blocker.id}; inherits blocker ${blocker.id} via ${parent.id}`);
  expect(human.stdout).toContain("parent:");
  const cycle = await cli(["dep", "add", blocker.id, child.id], { cwd });
  expect(cycle.code).toBe(1);
  expect(cycle.stderr).toContain("cycle");
  expect((await cli(["claim", child.id], { cwd })).stderr).toContain("not ready");
  expect((await cli(["dep", "rm", child.id, blocker.id, "--human"], { cwd })).stdout).toBe(`${child.id} is no longer blocked by ${blocker.id}\n`);
  await json(["dep", "add", child.id, blocker.id, "--kind", "related"]);
  expect((await json(["show", blocker.id])).related.map((b: any) => b.id)).toEqual([child.id]);
  await json(["dep", "rm", blocker.id, child.id, "--kind", "related"]);
  expect((await json(["show", child.id])).related).toBeUndefined();
  expect((await cli(["close", parent.id], { cwd })).stderr).toContain("unfinished children");
  expect(await json(["close", parent.id, "--force"])).toMatchObject({ status: "closed" });
  await json(["close", blocker.id]);
  expect((await json(["ready"])).map((b: any) => b.id)).toEqual([child.id]);
  expect(await json(["claim"])).toMatchObject({ id: child.id });
});

test("update, heartbeat, defer and comments through the real CLI", async () => {
  const cwd = join(dir, "slice3-project");
  mkdirSync(cwd);
  const json = (args: string[], opts: Parameters<typeof cli>[1] = {}) => cliJson(args, { cwd, ...opts });
  const run = (args: string[], opts: Parameters<typeof cli>[1] = {}) => cli(args, { cwd, ...opts });
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

  expect(await json(["comment", task.id, "halfway", "there"])).toEqual({ gig_id: task.id, author: "agent-1", at: expect.any(String), body: "halfway there" });
  await json(["comment", task.id, "-"], { stdin: "multi\nline\n", env: { GIG_ACTOR: "agent-2" } });
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
  for (let n = 1; n <= 16; n++) store.createGig("sh", "fixture", { title: `Gig ${n}` });
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

  const json = await cliJson(["show", "sh-2", "--full"]);
  expect(json.children.map((b: any) => b.id)).toEqual(["sh-3", "sh-10"]);
  const human = await cli(["show", "sh-2", "--full", "--human"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain(`parent:\n  sh-1  open  Gig 1\nchildren:\n  sh-3  closed  Gig 3\n  sh-10  open  Gig 10\nblockers:\n  sh-4  open  Gig 4\n  sh-11  open  Gig 11\nblocks:\n  sh-5  open  Gig 5\n  sh-12  open  Gig 12\nrelated:\n  sh-6  open  Gig 6\n  sh-13  open  Gig 13\ndiscovered_from:\n  sh-7  open  Gig 7\n  sh-14  open  Gig 14\ndiscovered:\n  sh-8  open  Gig 8\n  sh-15  open  Gig 15\n`);
});

test("compact show covers statuses, relations and multiline comments without audit timestamps", async () => {
  store.createProject("co");
  const run = async (id: string, flags: string[] = []) => {
    const result = await cli(["show", id, "--human", ...flags], { env: { TZ: "UTC" } });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout;
  };
  const epic = store.createGig("co", "fixture", { title: "Epic", type: "epic" });
  const task = store.createGig("co", "fixture", { title: "Task", priority: 1, description: "First\nsecond", parent: epic.id });
  const done = store.createGig("co", "fixture", { title: "Finished child", parent: epic.id });
  const alsoDone = store.createGig("co", "fixture", { title: "Another finished child", parent: epic.id });
  store.close(done.id, "fixture", "verified");
  store.close(alsoDone.id, "fixture");
  expect(await run(task.id)).toBe(`${task.id}  Task\ntask · P1 · ready\nparent: ${epic.id} Epic\n\nFirst\nsecond\n`);
  expect(await run(epic.id)).toBe(`${epic.id}  Epic\nepic · P2 · open\nnot ready: child ${task.id} unfinished\nchildren:\n  ${task.id}  open  Task\n  +2 closed\n`);
  expect(await run(done.id)).toBe(`${done.id}  Finished child\ntask · P2 · closed by fixture: verified\nparent: ${epic.id} Epic\n`);
  expect(await run(alsoDone.id)).toContain("task · P2 · closed by fixture\n");

  // The old complete renderer is exact.
  const b = (await cliJson(["show", task.id, "--full"])).gig;
  expect(await run(task.id, ["--full"])).toBe(
    `${task.id}  Task\n\nstatus:    open (ready)\ntype:      task\npriority:  P1\ncreated:   ${b.created_at} by fixture\nupdated:   ${b.updated_at}\nparent:\n  ${epic.id}  open  Epic\n\nFirst\nsecond\n`,
  );

  await cliJson(["claim", task.id]);
  await cliJson(["comment", task.id, "First line\nSecond line\n\nFourth line"]);
  const short = "[A-Z][a-z]{2} \\d{1,2}(?: \\d{4})? \\d{2}:\\d{2}";
  const claimed = await run(task.id);
  expect(claimed).toMatch(new RegExp(`task · P1 · in progress, claimed by agent-1 until ${short}\\n`));
  expect(claimed).toMatch(new RegExp(`comments:\\n  agent-1 \\(${short}\\): First line\\n    Second line\\n    \\n    Fourth line\\n$`));
  expect(claimed).not.toMatch(/created:|updated:|not ready:|\\.\\d{3}Z/);

  await cliJson(["defer", task.id, "--until", "2999-03-04T10:30:00Z"]);
  const deferred = await run(task.id);
  expect(deferred).toContain("task · P1 · deferred until Mar 4 2999 10:30\n");
  expect(deferred).not.toContain("not ready:");
  await cliJson(["defer", task.id]);
  expect(await run(task.id)).toContain("task · P1 · deferred\n");
  await cliJson(["undefer", task.id]);

  // Every relation group uses the same unfinished/closed split; empty groups disappear.
  const blocker = store.createGig("co", "fixture", { title: "Blocker" });
  store.addLink(task.id, blocker.id, "blocks", "fixture");
  expect(await run(task.id)).toContain(`task · P1 · open\nparent: ${epic.id} Epic\nnot ready: blocked by ${blocker.id}\nblockers:\n  ${blocker.id}  open  Blocker\n`);
  store.close(blocker.id, "fixture");
  store.addLink(task.id, done.id, "related", "fixture");
  store.addLink(task.id, alsoDone.id, "discovered-from", "fixture");
  store.addLink(done.id, task.id, "discovered-from", "fixture");
  store.addLink(done.id, task.id, "blocks", "fixture");
  const relations = await run(task.id);
  expect(relations).toContain("blockers: 1 closed\nblocks: 1 closed\nrelated: 1 closed\ndiscovered from: 1 closed\ndiscovered: 1 closed\n");
  await cliJson(["close", task.id]);
  const closedEpic = await run(epic.id);
  expect(closedEpic).toBe(`${epic.id}  Epic\nepic · P2 · ready\nchildren: 3 closed\n`);
});

test("compact JSON shapes for agents, and --full prints the raw API response", async () => {
  store.createProject("js");
  const env = { GIG_PROJECT: "js" };
  const json = (args: string[], actor = "agent-1") => cliJson(args, { env: { ...env, GIG_ACTOR: actor } });
  const epic = store.createGig("js", "fixture", { title: "Epic", type: "epic", priority: 1, description: "The plan" });
  const a = store.createGig("js", "fixture", { title: "A", parent: epic.id, description: "long text" });
  const b = store.createGig("js", "fixture", { title: "B", parent: epic.id });
  const c = store.createGig("js", "fixture", { title: "C", parent: epic.id });
  const blocker = store.createGig("js", "fixture", { title: "Blocker", priority: 0 });
  store.addLink(b.id, blocker.id, "blocks", "fixture");
  store.addLink(epic.id, blocker.id, "related", "fixture");
  store.close(c.id, "fixture", "done");
  store.addComment(epic.id, "agent-2", "first\nsecond");

  // One line, no description in rows.
  const ready = await cli(["ready"], { env });
  expect(ready.stdout).toBe(
    `[{"id":"${blocker.id}","title":"Blocker","type":"task","priority":0,"status":"open"},` +
    `{"id":"${a.id}","title":"A","type":"task","priority":2,"status":"open","parent":"${epic.id}"}]\n`,
  );
  expect((await cli(["ready", "--json"], { env })).stdout).toBe(ready.stdout);
  // The legacy flag is a no-op, including when human output is requested.
  expect((await cli(["ready", "--human", "--json"], { env })).stdout)
    .toBe((await cli(["ready", "--human"], { env })).stdout);
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

  // claim returns the show shape; the claim lands on the next ready gig.
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
  const raw = await cli(["show", epic.id, "--full"], { env });
  expect(raw.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(raw.stdout)).toEqual(await api(`/gigs/${epic.id}`));
  expect(await json(["list", "--all", "--full"])).toEqual(await api("/projects/js/gigs?all=1"));
  expect(await json(["projects"])).toEqual(await api("/projects"));
});

test("CLI rejects missing global values, unknown global flags and surplus positionals", async () => {
  for (const args of [["--as"], ["-P"], ["--bogus"], ["claim", "gig-2", "gig-3"], ["show", "gig-2", "extra"], ["ready", "extra"], ["dep", "add", "gig-2", "gig-3", "extra"]]) {
    const result = await cli(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error:");
  }
  expect((await cli(["--as", "early-actor", "--project=gig", "ready"])).code).toBe(0);
  expect((await cli(["--human"])).code).toBe(0);
});

test("not-ready claim errors are readable and API reasons stay structured", async () => {
  store.createProject("nr");
  const blocker = store.createGig("nr", "fixture", { title: "blocker" });
  const child = store.createGig("nr", "fixture", { title: "blocked", blocked_by: [blocker.id] });
  const result = await cli(["claim", child.id]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("error: " + child.id + " is not ready: blocked by " + blocker.id + "\n");
  const res = await fetch(new URL("/gigs/" + child.id + "/claim", server.url), {
    method: "POST", headers: { Authorization: "Bearer t0k", "X-Gigs-Actor": "fixture" },
  });
  expect(await res.json()).toMatchObject({ error: { code: "not_ready", reasons: [{ kind: "blocker", id: blocker.id }] } });
});

test("errors, help and connection failures", async () => {
  const help = await cli([]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("output: compact JSON by default");
  expect(help.stdout).toContain("--human");
  expect((await cli(["help", "--human"])).stdout).toBe(help.stdout);
  expect((await cli(["show", "--help", "--human"])).stdout)
    .toBe((await cli(["show", "--help"])).stdout);
  expect(help.stdout).toContain("gig claim [id]");
  expect(help.stdout).toContain("gig defer <id> [--until");
  expect(help.stdout.split("\n").every((line) => line.length <= 80)).toBe(true);
  expect((await cli(["help"])).stdout).toBe(help.stdout);
  expect(help.stdout).toContain("  gig ready [--spec id] [--parent id] [--label l[,l]] [--exclude-label l[,l]]\n    [--human-only]\n    ready gigs in priority order (--parent: the whole subtree, i.e. all\n    descendants, not the gig itself; --human-only: only human gigs, the human's\n    queue)\n");
  expect(help.stdout).toContain("--parent: direct children only");
  expect((await cli(["show", "--help"])).stdout).toBe("usage: gig show <id> [--full]\n\nshow a compact gig (--full shows everything)\n");
  const createHelp = await cli(["create", "--help"]);
  expect(createHelp.code).toBe(0);
  expect(createHelp.stdout.split("\n").every((line) => line.length <= 80)).toBe(true);
  expect(createHelp.stdout).toContain("[--discovered-from id]");
  expect(createHelp.stdout).toContain("create a gig");
  expect((await cli(["close", "--help"])).stdout).toContain("usage: gig close <id...> [-r reason]");

  const unknown = await cli(["frobnicate"]);
  expect(unknown).toMatchObject({ code: 1, stderr: "error: unknown command 'frobnicate' (see `gig help`)\n" });

  const badFlag = await cli(["list", "--bogus"]);
  expect(badFlag.code).toBe(1);
  expect(badFlag.stderr).toContain("gig list --help");

  const badToken = await cli(["projects"], { env: { GIGS_TOKEN: "nope" } });
  expect(badToken).toMatchObject({ code: 1, stderr: "error: missing or invalid token\n" });

  const invalid = await cli(["create", "x", "-p", "9"]);
  expect(invalid).toMatchObject({ code: 1, stderr: "error: priority must be an integer from 0 to 4\n" });

  const url = "http://127.0.0.1:1";
  const down = await cli(["projects"], { env: { GIGS_URL: url } });
  expect(down).toMatchObject({ code: 1, stderr: `error: cannot reach gigs server at ${url} (is \`gig serve\` running?)\n` });
});

test("skill prints the agent skill without a server or project", async () => {
  const skill = readFileSync(join(import.meta.dir, "../.agents/skills/gigs/SKILL.md"), "utf8");
  const env = { GIGS_URL: "http://127.0.0.1:1" };
  const r = await cli(["skill"], { cwd: dir, env });
  expect(r).toEqual({ stdout: skill, stderr: "", code: 0 });
  for (const flag of ["--json", "--human", "--full"]) {
    expect(await cli(["skill", flag], { cwd: dir, env })).toEqual(r);
  }
  expect((await cli(["skill", "extra"], { cwd: dir, env })).code).toBe(1);
});

test("specs through the real CLI: create, show, list, --spec filters, project from the spec id", async () => {
  const cwd = join(dir, "spec-project");
  mkdirSync(cwd);
  store.createProject("sq");
  store.createProject("sz");
  const env = { GIG_PROJECT: "sq" };
  const json = (args: string[], opts: Parameters<typeof cli>[1] = { env }) => cliJson(args, opts);

  expect(await json(["spec", "create", "Checkout", "v2", "-d", "-"], { env, stdin: "We agree on\nthe flow.\n" })).toEqual({ id: "sq-s1", title: "Checkout v2", version: 1, status: "draft" });
  expect(await json(["spec", "create", "Second", "-d", "short"])).toEqual({ id: "sq-s2", title: "Second", version: 1, status: "draft" });
  expect((await cli(["spec", "create", "No text"], { env })).stderr).toContain("missing text");
  expect(await json(["spec", "show", "SQ-S1"], { cwd })).toEqual({ id: "sq-s1", title: "Checkout v2", version: 1, status: "draft", text: "We agree on\nthe flow." });
  expect(await json(["spec", "show", "sq-s1", "--full"], { cwd })).toMatchObject({ id: "sq-s1", project: "sq", created_by: "agent-1" });
  expect((await cli(["spec", "show", "sq-s1", "--human"], { cwd })).stdout).toBe("sq-s1  Checkout v2\nv1 · draft\n\nWe agree on\nthe flow.\n");
  expect(await json(["spec", "list"])).toEqual([{ id: "sq-s1", title: "Checkout v2", version: 1, status: "draft" }, { id: "sq-s2", title: "Second", version: 1, status: "draft" }]);
  expect((await cli(["spec", "list", "--human"], { env })).stdout).toBe("sq-s1  draft   Checkout v2\nsq-s2  draft   Second\n");
  expect((await cli(["spec", "show", "sq-s9"], { cwd })).code).toBe(1);
  expect((await cli(["spec", "edit", "sq-s1"], { env })).code).toBe(1);
  expect(await json(["spec", "update", "sq-s2", "--title", "Second v2", "-d", "-"], { env, stdin: "Longer\ntext\n" })).toEqual({ id: "sq-s2", title: "Second v2", version: 2, status: "draft" });
  expect(await json(["spec", "show", "sq-s2"], { env })).toEqual({ id: "sq-s2", title: "Second v2", version: 2, status: "draft", text: "Longer\ntext" });
  expect((await cli(["spec", "update", "sq-s2", "--human", "-d", "short"], { env })).stdout).toBe("updated sq-s2\n");
  expect((await cli(["spec", "update", "sq-s2"], { env })).stderr).toContain("nothing to update");
  expect(await json(["spec", "update", "sq-s2", "--title", "Second"], { env })).toEqual({ id: "sq-s2", title: "Second", version: 4, status: "draft" });
  for (const id of ["sq-s1", "sq-s2"]) expect(await json(["spec", "ready", id])).toMatchObject({ id, status: "ready" });

  // Without .gigs.json, the project comes from the spec id; it wins over a different -P.
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
  expect((await cli(["show", a.id, "--human"], { cwd })).stdout).toContain("\nspec: sq-s1\n");

  const wrong = await cli(["create", "x", "--spec", "nope"], { cwd });
  expect(wrong.stderr).toBe("error: invalid spec id: nope\n");
  expect((await cli(["claim", b.id, "--spec", "sq-s1"], { cwd })).stderr).toContain("--spec only works");
  expect(await json(["claim", "--spec", "sq-s1"], { cwd })).toMatchObject({ id: b.id, status: "in_progress", spec: "sq-s1" });
  expect(await json(["claim", "--spec", "sq-s1"], { cwd })).toBeNull();
  expect(await json(["claim"])).toMatchObject({ id: blocker.id });
});

test("spec edit and history through CLI: flags, stdin, snapshots, raw and human output", async () => {
  store.createProject("ve");
  const opts = { env: { GIG_PROJECT: "ve" } };
  const first = await cliJson(["spec", "create", "Agreement", "-d", "one two"], opts);
  expect(first).toEqual({ id: "ve-s1", title: "Agreement", version: 1, status: "draft" });
  expect(await cliJson(["spec", "edit", first.id, "--old", "one", "--new", "first"], opts)).toEqual({ ...first, version: 2 });
  const edits = [{ old: "first", new: "last" }, { old: "last two", new: "done" }];
  expect(await cliJson(["spec", "edit", first.id, "-"], { ...opts, stdin: JSON.stringify(edits) })).toEqual({ ...first, version: 3 });
  expect(await cliJson(["spec", "show", first.id, "--version", "1"], opts)).toEqual({ ...first, text: "one two" });
  expect(await cliJson(["spec", "show", first.id, "--version", "2", "--full"], opts)).toMatchObject({ version: 2, text: "first two", project: "ve", created_by: "agent-1" });
  expect((await cli(["spec", "show", first.id, "--version", "1", "--human"], opts)).stdout).toContain("one two");
  const history = await cliJson(["spec", "history", first.id], opts);
  expect(history).toEqual([
    { version: 1, by: "agent-1", at: expect.any(String), kind: "create" },
    { version: 2, by: "agent-1", at: expect.any(String), kind: "edit", edits: [{ old: "one", new: "first" }] },
    { version: 3, by: "agent-1", at: expect.any(String), kind: "edit", edits },
  ]);
  expect(await cliJson(["spec", "history", first.id, "--full"], opts)).toEqual(history);
  const human = (await cli(["spec", "history", first.id, "--human"], opts)).stdout;
  expect(human).toContain("v3  edit  agent-1");
  expect(human).toContain('  - "last two"\n  + "done"');
  expect(await cliJson(["spec", "edit", first.id, "--old", "done", "--new", "done"], opts)).toEqual({ ...first, version: 3 });
  expect((await cli(["spec", "edit", first.id, "--old", "missing", "--new", "x"], opts)).stderr).toContain("edit 1: old text not found");
  expect((await cli(["spec", "edit", first.id, "--old", "done", "--new", ""], opts)).stderr).toContain("text is required");
  expect(await cliJson(["spec", "edit", first.id, "--old", "done", "--new", "done!", "--full"], opts)).toMatchObject({ version: 4, text: "done!", project: "ve" });
  expect((await cli(["spec", "edit", first.id, "--old", "!", "--new", "", "--human"], opts)).stdout).toBe("edited ve-s1 (version 5)\n");
  for (const stdin of ["invalid", "{}", "[]", '[{"old":"done"}]']) {
    expect((await cli(["spec", "edit", first.id, "-"], { ...opts, stdin })).code).toBe(1);
  }
  for (const args of [
    ["edit", first.id, "--old", "done"], ["edit", first.id, "--new", "x"],
    ["edit", first.id, "-", "--old", "done", "--new", "x"],
    ["edit", first.id, "extra"], ["history", first.id, "extra"],
    ["show", first.id, "--version", "0"], ["show", first.id, "--version", "abc"],
    ["show", first.id, "--version", "99"], ["history", "ve-s99"],
    ["edit", first.id, "--version", "1"],
  ]) expect((await cli(["spec", ...args], opts)).code).toBe(1);
  expect(await cliJson(["spec", "list"], opts)).toEqual([{ ...first, version: 5 }]);
  expect(await cliJson(["spec", "history", first.id], opts)).toHaveLength(5);
});

test("labels through the real CLI: create, label add|rm, update, filters, rows, show and human output", async () => {
  store.createProject("lx");
  const opts = { env: { GIG_PROJECT: "lx" } };
  const a = await cliJson(["create", "Triage me", "--label", "needs-triage,agent"], opts);
  expect(a).toEqual({ id: "lx-1", title: "Triage me", type: "task", priority: 2, status: "open", labels: ["agent", "needs-triage"] });
  const b = await cliJson(["create", "Plain", "-p", "3"], opts);
  expect(b).not.toHaveProperty("labels");
  expect(await cliJson(["label", "add", b.id, "agent", "triage:needs-info,agent"], opts)).toEqual({ ...b, labels: ["agent", "triage:needs-info"] });
  expect(await cliJson(["label", "rm", b.id, "triage:needs-info", "missing"], opts)).toEqual({ ...b, labels: ["agent"] });
  expect(await cliJson(["update", a.id, "--add-label", "ready-for-agent", "--remove-label", "needs-triage"], opts)).toEqual({ ...a, labels: ["agent", "ready-for-agent"] });
  expect((await cli(["label", "add", a.id, "Needs Triage"], opts)).stderr).toContain("invalid label");
  expect((await cli(["label", "add", a.id], opts)).stderr).toContain("missing <label>");
  expect((await cli(["label", "tag", a.id, "x"], opts)).stderr).toContain("expected `gig label add` or `gig label rm`");
  expect((await cli(["label", "add", b.id, "x", "--human"], opts)).stdout).toBe(`${b.id} labels: agent, x\n`);
  expect((await cli(["label", "rm", b.id, "x", "agent", "--human"], opts)).stdout).toBe(`${b.id} labels: none\n`);

  const ids = async (args: string[]) => (await cliJson(args, opts)).map((x: any) => x.id);
  expect(await ids(["list", "--label", "agent"])).toEqual([a.id]);
  expect(await ids(["list", "--exclude-label", "agent"])).toEqual([b.id]);
  expect(await ids(["ready", "--label", "agent,ready-for-agent"])).toEqual([a.id]);
  expect(await ids(["ready", "--exclude-label", "ready-for-agent"])).toEqual([b.id]);
  expect((await cli(["list", "--label", "Bad"], opts)).code).toBe(1);

  // Closed gigs keep and change labels too.
  await cliJson(["close", b.id, "-r", "dupe"], opts);
  expect(await cliJson(["label", "add", b.id, "duplicate"], opts)).toMatchObject({ status: "closed", labels: ["duplicate"] });
  expect(await ids(["list", "--all", "--label", "duplicate"])).toEqual([b.id]);

  expect(await cliJson(["show", a.id], opts)).toMatchObject({ id: a.id, labels: ["agent", "ready-for-agent"], ready: true });
  expect((await cliJson(["show", a.id, "--full"], opts)).gig.labels).toEqual(["agent", "ready-for-agent"]);
  expect((await cli(["show", a.id, "--human"], opts)).stdout).toContain("\nlabels: agent, ready-for-agent\n");
  expect((await cli(["show", a.id, "--human", "--full"], opts)).stdout).toContain("\nlabels:    agent, ready-for-agent\n");
  expect((await cli(["list", "--human"], opts)).stdout).toBe(`${a.id}  P2  open         task     Triage me  [agent, ready-for-agent]\n`);
});

test("human gigs through the real CLI: --human-only on create, list, ready; update sets and clears; claim-next skips", async () => {
  store.createProject("hx");
  const opts = { env: { GIG_PROJECT: "hx" } };
  const mine = await cliJson(["create", "My work"], opts);
  expect(mine).not.toHaveProperty("human");
  const ask = await cliJson(["create", "Which API version?", "--human-only", "-p", "0"], opts);
  expect(ask).toEqual({ id: "hx-2", title: "Which API version?", type: "task", priority: 0, status: "open", human: true });
  // The agent's gig waits on the human's answer.
  await cliJson(["dep", "add", mine.id, ask.id], opts);
  const ids = async (args: string[]) => (await cliJson(args, opts)).map((x: any) => x.id);
  expect(await ids(["ready"])).toEqual([ask.id]);
  expect(await ids(["ready", "--human-only"])).toEqual([ask.id]);
  expect(await cliJson(["claim"], opts)).toBeNull();
  await cliJson(["comment", ask.id, "Use v2."], { ...opts, env: { ...opts.env, GIG_ACTOR: "human" } });
  await cliJson(["close", ask.id], { ...opts, env: { ...opts.env, GIG_ACTOR: "human" } });
  expect(await cliJson(["claim"], opts)).toMatchObject({ id: mine.id, claimed_by: "agent-1" });

  expect(await cliJson(["update", mine.id, "--human-only"], opts)).toMatchObject({ id: mine.id, human: true });
  expect(await ids(["list", "--human-only"])).toEqual([mine.id]);
  expect(await cliJson(["show", mine.id], opts)).toMatchObject({ id: mine.id, human: true });
  expect((await cliJson(["show", mine.id, "--full"], opts)).gig.human).toBe(true);
  expect((await cli(["show", mine.id, "--human"], opts)).stdout).toContain(" · human only\n");
  expect((await cli(["show", mine.id, "--human", "--full"], opts)).stdout).toContain("\nhuman:     only a human works it\n");
  expect((await cli(["list", "--human"], opts)).stdout).toBe(`${mine.id}  P2  in_progress  task     My work  [@agent-1]  [human]\n`);
  const cleared = await cliJson(["update", mine.id, "--no-human-only"], opts);
  expect(cleared).not.toHaveProperty("human");
  expect(await ids(["list", "--human-only"])).toEqual([]);
  // --no-human-only is only for update; --human-only takes no value.
  expect((await cli(["create", "x", "--no-human-only"], opts)).code).toBe(1);
  expect((await cli(["update", mine.id, "--human-only=yes"], opts)).code).toBe(1);
});

test("claim-next filters and ready --parent through the real CLI", async () => {
  store.createProject("cx");
  const opts = { env: { GIG_PROJECT: "cx" } };
  const id = async (args: string[]) => (await cliJson(args, opts)).id as string;
  const ids = async (args: string[]) => (await cliJson(args, opts)).map((x: any) => x.id);
  const epic = await id(["create", "Epic", "-t", "epic"]);
  const child = await id(["create", "Child", "--parent", epic]);
  const grand = await id(["create", "Grandchild", "--parent", child, "--label", "ready-for-agent", "-p", "3"]);
  const ask = await id(["create", "Ask", "--parent", child, "--label", "ready-for-agent", "--human-only", "-p", "0"]);
  const big = await id(["create", "Big", "--parent", epic, "--label", "ready-for-agent,big", "-p", "1"]);
  const outside = await id(["create", "Outside", "--label", "ready-for-agent", "-p", "0"]);
  // list --parent: direct children; ready --parent: the whole subtree, not the parent.
  expect(await ids(["list", "--parent", epic])).toEqual([big, child]);
  expect(await ids(["ready", "--parent", epic])).toEqual([ask, big, grand]);
  expect(await ids(["ready", "--parent", epic, "--exclude-label", "big"])).toEqual([ask, grand]);
  expect((await cli(["ready", "--parent", "cx-99"], opts)).stderr).toContain("gig cx-99 not found");
  expect((await cli(["claim", "--parent", "cx-99"], opts)).stderr).toContain("gig cx-99 not found");
  // Filters only make sense without an id; --human-only is not a claim option.
  expect((await cli(["claim", grand, "--label", "x"], opts)).stderr).toBe("error: --label only works with `gig claim` without an id\n");
  expect((await cli(["claim", grand, "--parent", epic, "--spec", "cx-s1"], opts)).stderr).toBe("error: --spec, --parent only work with `gig claim` without an id\n");
  expect((await cli(["claim", "--human-only"], opts)).stderr).toContain("gig claim --help");
  expect(await cliJson(["claim", "--parent", epic, "--label", "ready-for-agent", "--exclude-label", "big"], opts)).toMatchObject({ id: grand, claimed_by: "agent-1" });
  expect(await cliJson(["claim", "--parent", epic, "--exclude-label", "big"], opts)).toBeNull();
  expect((await cli(["claim", "--parent", epic, "--human"], opts)).stdout).toBe(`claimed ${big}: Big\n`);
  expect(await cliJson(["claim", "--label", "ready-for-agent"], opts)).toMatchObject({ id: outside });
  expect(await cliJson(["claim", "--label", "ready-for-agent"], opts)).toBeNull();
  expect(await cliJson(["show", ask], opts)).toMatchObject({ status: "open", human: true });
  const help = (await cli(["claim", "--help"], opts)).stdout;
  expect(help).toContain("[--parent id]");
  expect(help).toContain("--parent: the whole subtree");
});

test("edit through CLI: --old/--new, JSON on stdin, row, human and raw output, errors", async () => {
  store.createProject("ed");
  const opts = { env: { GIG_PROJECT: "ed" } };
  const gig = await cliJson(["create", "Map", "-d", "Log:\n- a"], opts);
  const row = { id: gig.id, title: "Map", type: "task", priority: 2, status: "open" };
  // Text starting with "-" needs the --old=<text> form (parseArgs would take it for an option).
  expect(await cliJson(["edit", gig.id, "--old=- a", "--new=- a\n- b"], opts)).toEqual(row);
  const edits = [{ old: "- b", new: "- b\n- c" }, { old: "Log:", new: "Decisions:" }];
  expect(await cliJson(["edit", gig.id, "-"], { ...opts, stdin: JSON.stringify(edits) })).toEqual(row);
  expect((await cliJson(["show", gig.id], opts)).description).toBe("Decisions:\n- a\n- b\n- c");
  expect(await cliJson(["edit", gig.id, "--old", "b\n- c", "--new", "b\n- d", "--full"], opts)).toMatchObject({ id: gig.id, description: "Decisions:\n- a\n- b\n- d" });
  expect((await cli(["edit", gig.id, "--old", "\n- d", "--new", "", "--human"], opts)).stdout).toBe(`edited ${gig.id}\n`);
  const missing = await cli(["edit", gig.id, "--old", "missing", "--new", "x"], opts);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("edit 1: old text not found");
  for (const stdin of ["invalid", "{}", "[]", '[{"old":"- a"}]', '[{"old":"","new":"x"}]']) {
    expect((await cli(["edit", gig.id, "-"], { ...opts, stdin })).code).toBe(1);
  }
  for (const args of [
    [gig.id, "--old", "a"], [gig.id, "--new", "x"], [gig.id, "-", "--old", "a", "--new", "x"],
    [gig.id, "extra"], [], ["ed-99", "--old", "a", "--new", "b"],
  ]) expect((await cli(["edit", ...args], opts)).code).toBe(1);
  expect((await cliJson(["show", gig.id], opts)).description).toBe("Decisions:\n- a\n- b");
});
