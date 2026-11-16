import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { GigsError, Store } from "../src/store";

// Pointing a gig at a spec (create with spec, update to a different spec) needs a ready or active spec.

const dir = mkdtempSync(join(tmpdir(), "gigs-spec-enforce-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function error(fn: () => unknown, code: string, status: number, message?: string) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect(err).toMatchObject({ code, status, ...(message ? { message } : {}) });
    return;
  }
  throw new Error(`expected ${code}`);
}

const draftMessage = (id: string) => `spec ${id} is a draft; mark it ready first: gig spec ready ${id}`;
const doneMessage = (id: string) => `spec ${id} is done and is history; link the new gig with --discovered-from <gig> instead`;
const closedMessage = (id: string) => `spec ${id} is closed (abandoned); reopen it first (gig spec reopen ${id}) or file the gig without --spec`;

describe("store", () => {
  let store: Store;
  let n = 0;
  beforeEach(() => {
    store = new Store({ path: join(dir, `store-${++n}.db`) });
    store.createProject("gig");
  });
  afterEach(() => store.dispose());
  const spec = (title = "Agreement") => store.createSpec("gig", "alice", { title, text: "We agree." });
  const gig = (specId: string | null, title = "work") => store.createGig("gig", "a", { title, spec: specId });
  const status = (id: string) => store.getSpec(id).status;

  test("create: draft refused, ready and active allowed, done refused, reopening a gig allows it again", () => {
    const s = spec();
    error(() => gig(s.id), "spec_draft", 409, draftMessage(s.id));
    error(() => gig(" GIG-S1 "), "spec_draft", 409, draftMessage(s.id));
    expect(store.listGigs("gig", { all: true })).toEqual([]);
    store.readySpec(s.id, "owner");
    const a = gig(s.id, "a");
    expect(status(s.id)).toBe("active");
    // A follow-up while active keeps it active.
    const b = gig(s.id, "b");
    expect(status(s.id)).toBe("active");
    store.close(a.id, "a");
    store.close(b.id, "a");
    expect(status(s.id)).toBe("done");
    error(() => gig(s.id), "spec_done", 409, doneMessage(s.id));
    // New work after a done spec links to its gigs instead.
    const follow = store.createGig("gig", "a", { title: "follow-up", discovered_from: a.id });
    expect(follow.spec).toBeNull();
    expect(store.getDetail(follow.id).discovered_from.map((g) => g.id)).toEqual([a.id]);
    // Reopening one of its gigs makes the spec active again.
    store.reopen(b.id);
    expect(status(s.id)).toBe("active");
    expect(gig(s.id, "c").spec).toBe(s.id);
  });

  test("closed spec: refused on create and update; clearing is always allowed", () => {
    const s = spec();
    store.readySpec(s.id, "owner");
    const a = gig(s.id);
    store.close(a.id, "a");
    store.closeSpec(s.id, "owner", "abandoned");
    const free = gig(null);
    error(() => gig(s.id), "spec_closed", 409, closedMessage(s.id));
    error(() => store.update(free.id, "a", { spec: s.id }), "spec_closed", 409, closedMessage(s.id));
    expect(store.getGig(free.id).spec).toBeNull();
    // The closed gig still points at the closed spec; re-setting it is a no-op, clearing works.
    expect(store.update(a.id, "a", { spec: s.id }).spec).toBe(s.id);
    expect(store.update(a.id, "a", { spec: null }).spec).toBeNull();
    // Reopened, it is a draft again: still not assignable until marked ready.
    store.reopenSpec(s.id, "owner");
    error(() => gig(s.id), "spec_draft", 409, draftMessage(s.id));
  });

  test("update: moving to a draft, done or closed spec is refused; same spec and none are always fine", () => {
    const [draft, done, closed, ready] = ["draft", "done", "closed", "ready"].map((t) => spec(t));
    for (const s of [done, closed, ready]) store.readySpec(s!.id, "owner");
    const old = gig(done!.id);
    store.close(old.id, "a");
    store.closeSpec(closed!.id, "owner", "dropped");
    expect(status(done!.id)).toBe("done");
    const g = gig(ready!.id);
    error(() => store.update(g.id, "a", { spec: draft!.id }), "spec_draft", 409, draftMessage(draft!.id));
    error(() => store.update(g.id, "a", { spec: done!.id }), "spec_done", 409, doneMessage(done!.id));
    error(() => store.update(g.id, "a", { spec: closed!.id }), "spec_closed", 409, closedMessage(closed!.id));
    // A refused update changes nothing, not even other fields in the same call.
    error(() => store.update(g.id, "a", { title: "renamed", spec: draft!.id }), "spec_draft", 409);
    expect(store.getGig(g.id)).toMatchObject({ title: "work", spec: ready!.id });
    // Same spec as current on a done spec is a no-op for the check.
    expect(store.update(old.id, "a", { spec: done!.id, title: "still history" })).toMatchObject({ spec: done!.id, title: "still history" });
    expect(store.update(g.id, "a", { spec: null }).spec).toBeNull();
    expect(store.update(g.id, "a", { spec: null }).spec).toBeNull();
    // not_found and project mismatch come before the lifecycle.
    store.createProject("xy");
    const foreign = store.createSpec("xy", "a", { title: "Other", text: "x" });
    error(() => store.update(g.id, "a", { spec: foreign.id }), "bad_request", 400);
    error(() => gig(foreign.id), "bad_request", 400);
    error(() => gig("gig-s9"), "not_found", 404);
  });

  test("filters by spec stay read-only and accept any status", () => {
    const s = spec();
    expect(store.listGigs("gig", { spec: s.id })).toEqual([]);
    expect(store.ready("gig", s.id)).toEqual([]);
    expect(store.blocked("gig", s.id)).toEqual([]);
    expect(store.claimNext("gig", "a", s.id)).toBeNull();
    store.closeSpec(s.id, "owner", "dropped");
    expect(store.listGigs("gig", { spec: s.id, all: true })).toEqual([]);
  });
});

describe("http and cli", () => {
  const store = new Store({ path: join(dir, "http.db") });
  const server = Bun.serve({ port: 0, fetch: createHandler(store, { adminToken: "t0k" }) });
  const handle = createHandler(store, { adminToken: "t0k" });
  afterAll(() => { server.stop(true); store.dispose(); });

  function call(method: string, path: string, opts: { body?: unknown; actor?: string } = {}) {
    const headers: Record<string, string> = { Authorization: "Bearer t0k" };
    if (opts.actor !== undefined) headers["X-Gigs-Actor"] = opts.actor;
    return handle(new Request(`http://gigs${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
  }

  async function cli(args: string[]) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, GIGS_URL: server.url.href, GIGS_TOKEN: "t0k", GIG_ACTOR: "agent-1", GIG_PROJECT: "ef" } as Record<string, string>,
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  async function json(args: string[]) {
    const r = await cli(args);
    if (r.code !== 0) throw new Error(`gig ${args.join(" ")} failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  test("http: 409 with the lifecycle code and message on create and update", async () => {
    store.createProject("eh");
    const s = store.createSpec("eh", "a", { title: "Agreement", text: "x" });
    const created = await call("POST", "/projects/eh/gigs", { actor: "a", body: { title: "w", spec: s.id } });
    expect(created.status).toBe(409);
    expect(await created.json()).toEqual({ error: { code: "spec_draft", message: draftMessage(s.id) } });
    const free = store.createGig("eh", "a", { title: "free" });
    store.closeSpec(s.id, "a", "dropped");
    const updated = await call("PATCH", `/gigs/${free.id}`, { actor: "a", body: { spec: s.id } });
    expect(updated.status).toBe(409);
    expect(await updated.json()).toEqual({ error: { code: "spec_closed", message: closedMessage(s.id) } });
  });

  test("cli: refusals print the message; the documented ways out work", async () => {
    store.createProject("ef");
    const s = await json(["spec", "create", "Checkout", "-d", "We agree."]);
    expect(await cli(["create", "Work", "--spec", s.id])).toMatchObject({ code: 1, stdout: "", stderr: `error: ${draftMessage(s.id)}\n` });
    await json(["spec", "ready", s.id]);
    const g = await json(["create", "Work", "--spec", s.id]);
    expect(g.spec).toBe(s.id);
    await json(["close", g.id]);
    expect(await cli(["create", "More", "--spec", s.id])).toMatchObject({ code: 1, stderr: `error: ${doneMessage(s.id)}\n` });
    const follow = await json(["create", "More", "--discovered-from", g.id]);
    expect(follow).not.toHaveProperty("spec");
    expect(await json(["update", g.id, "--spec", s.id, "-p", "1"])).toMatchObject({ spec: s.id, priority: 1 });
    expect(await cli(["update", follow.id, "--spec", s.id])).toMatchObject({ code: 1, stderr: `error: ${doneMessage(s.id)}\n` });
    await json(["spec", "close", s.id, "-r", "dropped"]);
    expect(await cli(["create", "More", "--spec", s.id])).toMatchObject({ code: 1, stderr: `error: ${closedMessage(s.id)}\n` });
    expect(await cli(["update", follow.id, "--spec", s.id])).toMatchObject({ code: 1, stderr: `error: ${closedMessage(s.id)}\n` });
    expect(await json(["update", g.id, "--spec", "none"])).not.toHaveProperty("spec");
  });
});
