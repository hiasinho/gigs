import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { GigsError, Store } from "../src/store";

// Spec status: stored state (draft|ready|closed) plus status derived from the spec's gigs.

const at = "2026-01-01T00:00:00.000Z";
const dir = mkdtempSync(join(tmpdir(), "gigs-spec-status-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function error(fn: () => unknown, code: string, status: number, message?: string) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect(err).toMatchObject({ code, status, ...(message ? { message } : {}) });
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("store", () => {
  let path: string;
  let store: Store;
  let n = 0;
  beforeEach(() => {
    path = join(dir, `store-${++n}.db`);
    store = new Store({ path, now: () => new Date(at) });
    store.createProject("gig");
  });
  afterEach(() => store.dispose());
  const spec = (title = "Agreement") => store.createSpec("gig", "alice", { title, text: "We agree." });
  const gig = (specId: string, title = "work") => store.createGig("gig", "a", { title, spec: specId });
  const status = (id: string) => store.getSpec(id).status;

  test("a new spec is a draft with no close fields", () => {
    expect(spec()).toMatchObject({ state: "draft", status: "draft", close_reason: null, closed_by: null, closed_at: null });
  });

  test("migration 8 makes existing specs drafts", () => {
    const s = spec();
    store.dispose();
    const db = new Database(path);
    db.run("ALTER TABLE specs DROP COLUMN state; ALTER TABLE specs DROP COLUMN close_reason; ALTER TABLE specs DROP COLUMN closed_by; ALTER TABLE specs DROP COLUMN closed_at; PRAGMA user_version = 7;");
    db.close();
    store = new Store({ path, now: () => new Date(at) });
    expect(store.getSpec(s.id)).toEqual(s);
    expect(store.getSpec(s.id)).toMatchObject({ state: "draft", status: "draft" });
    const raw = new Database(path);
    try {
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
      expect(() => raw.run("UPDATE specs SET state = 'active'")).toThrow();
    } finally { raw.close(); }
  });

  test("derivation: draft, ready, active while a gig is unfinished, done once all are closed", () => {
    const s = spec();
    expect(status(s.id)).toBe("draft");
    expect(store.readySpec(s.id, "owner")).toMatchObject({ state: "ready", status: "ready" });
    const a = gig(s.id, "a");
    const b = gig(s.id, "b");
    expect(status(s.id)).toBe("active");
    store.close(a.id, "a");
    expect(status(s.id)).toBe("active");
    store.claim(b.id, "w");
    expect(status(s.id)).toBe("active");
    store.close(b.id, "w");
    expect(store.getSpec(s.id)).toMatchObject({ state: "ready", status: "done" });
    // Reopening a closed gig of a done spec makes it active again.
    store.reopen(a.id);
    expect(status(s.id)).toBe("active");
    // Clearing the spec of the unfinished gig makes it done.
    store.update(a.id, "a", { spec: null });
    expect(status(s.id)).toBe("done");
    // Deferred gigs are unfinished too.
    store.reopen(b.id);
    store.defer(b.id, "a");
    expect(status(s.id)).toBe("active");
  });

  test("ready is idempotent, works on active and done specs, and refuses a closed spec", () => {
    const s = spec();
    const ready = store.readySpec(" GIG-S1 ", "owner");
    expect(store.readySpec(s.id, "owner")).toEqual(ready);
    const g = gig(s.id);
    expect(store.readySpec(s.id, "owner")).toMatchObject({ state: "ready", status: "active" });
    store.close(g.id, "a");
    expect(store.readySpec(s.id, "owner")).toMatchObject({ state: "ready", status: "done" });
    store.closeSpec(s.id, "owner", "abandoned");
    error(() => store.readySpec(s.id, "owner"), "spec_closed", 409, `spec ${s.id} is closed; reopen it first: gig spec reopen ${s.id}`);
    error(() => store.readySpec("gig-s9", "owner"), "not_found", 404);
    error(() => store.readySpec(s.id, " "), "bad_request", 400);
  });

  test("close needs a reason, records who and when, and refuses a second close", () => {
    const s = spec();
    for (const reason of [undefined, null, "", "  ", 3]) error(() => store.closeSpec(s.id, "owner", reason), "bad_request", 400, "reason is required");
    expect(store.closeSpec(s.id, " owner ", "  superseded  ")).toMatchObject({
      state: "closed", status: "closed", close_reason: "superseded", closed_by: "owner", closed_at: at,
    });
    error(() => store.closeSpec(s.id, "owner", "again"), "conflict", 409, `spec ${s.id} is already closed`);
    error(() => store.closeSpec("gig-s9", "owner", "x"), "not_found", 404);
  });

  test("close is refused while the spec has unfinished gigs, listing them", () => {
    const s = spec();
    store.readySpec(s.id, "owner");
    const a = gig(s.id, "a");
    const b = gig(s.id, "b");
    const c = gig(s.id, "c");
    store.close(b.id, "a");
    error(() => store.closeSpec(s.id, "owner", "abandoned"), "spec_active", 409,
      `spec ${s.id} has unfinished gigs: ${a.id}, ${c.id}; close them or clear their spec (gig update <id> --spec none) first`);
    expect(store.getSpec(s.id)).toMatchObject({ state: "ready", status: "active", close_reason: null });
  });

  test("closed wins over derived active/done, even after a gig is reopened", () => {
    const s = spec();
    store.readySpec(s.id, "owner");
    const a = gig(s.id);
    store.close(a.id, "a");
    expect(status(s.id)).toBe("done");
    expect(store.closeSpec(s.id, "owner", "dropped").status).toBe("closed");
    store.reopen(a.id);
    expect(store.getSpec(s.id)).toMatchObject({ state: "closed", status: "closed" });
  });

  test("reopen makes a closed spec a draft and clears close fields; only closed specs", () => {
    const s = spec();
    store.readySpec(s.id, "owner");
    error(() => store.reopenSpec(s.id, "owner"), "conflict", 409, `spec ${s.id} is not closed`);
    store.closeSpec(s.id, "owner", "oops");
    expect(store.reopenSpec(s.id, "owner")).toMatchObject({ state: "draft", status: "draft", close_reason: null, closed_by: null, closed_at: null });
    error(() => store.reopenSpec(s.id, "owner"), "conflict", 409);
    error(() => store.reopenSpec("gig-s9", "owner"), "not_found", 404);
  });

  test("state changes bump no version and write no history", () => {
    const s = spec();
    store.readySpec(s.id, "owner");
    store.closeSpec(s.id, "owner", "x");
    store.reopenSpec(s.id, "owner");
    expect(store.getSpec(s.id).version).toBe(1);
    expect(store.specHistory(s.id)).toEqual([{ version: 1, by: "alice", at, kind: "create" }]);
    // Content changes keep the state; older versions report the current status.
    store.readySpec(s.id, "owner");
    expect(store.updateSpec(s.id, "bob", { title: "Renamed" })).toMatchObject({ version: 2, state: "ready", status: "ready" });
    expect(store.getSpec(s.id, 1)).toMatchObject({ version: 1, title: "Agreement", status: "ready" });
  });

  test("list shows draft, ready and active by default; all adds done and closed", () => {
    const [draft, ready, active, done, closed] = ["draft", "ready", "active", "done", "closed"].map((t) => spec(t));
    for (const s of [ready, active, done]) store.readySpec(s!.id, "owner");
    gig(active!.id);
    store.close(gig(done!.id).id, "a");
    store.closeSpec(closed!.id, "owner", "dropped");
    const list = (all?: boolean) => store.listSpecs("gig", all === undefined ? undefined : { all }).map((s) => [s.id, s.status]);
    expect(list()).toEqual([[draft!.id, "draft"], [ready!.id, "ready"], [active!.id, "active"]]);
    expect(list(false)).toEqual(list());
    expect(list(true)).toEqual([[draft!.id, "draft"], [ready!.id, "ready"], [active!.id, "active"], [done!.id, "done"], [closed!.id, "closed"]]);
  });
});

describe("http and cli", () => {
  const store = new Store({ path: join(dir, "http.db") });
  const server = Bun.serve({ port: 0, fetch: createHandler(store, { token: "t0k" }) });
  const handle = createHandler(store, { token: "t0k" });
  afterAll(() => { server.stop(true); store.dispose(); });

  function call(method: string, path: string, opts: { body?: unknown; actor?: string } = {}) {
    const headers: Record<string, string> = { Authorization: "Bearer t0k" };
    if (opts.actor !== undefined) headers["X-Gigs-Actor"] = opts.actor;
    return handle(new Request(`http://gigs${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
  }

  async function cli(args: string[]) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, GIGS_URL: server.url.href, GIGS_TOKEN: "t0k", GIG_ACTOR: "agent-1", GIG_PROJECT: "ht" } as Record<string, string>,
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

  test("routes: ready, close and reopen with error codes; list filter by ?all", async () => {
    store.createProject("hs");
    const s = store.createSpec("hs", "a", { title: "Agreement", text: "x" });
    const path = `/specs/${s.id}`;
    for (const action of ["ready", "close", "reopen"]) {
      expect((await call("POST", `${path}/${action}`)).status).toBe(400);
      expect((await call("POST", `/specs/hs-s9/${action}`, { actor: "a", body: { reason: "x" } })).status).toBe(404);
    }
    expect(await (await call("POST", `${path}/ready`, { actor: "a" })).json()).toMatchObject({ state: "ready", status: "ready", version: 1 });
    const g = store.createGig("hs", "a", { title: "w", spec: s.id });
    const active = await call("POST", `${path}/close`, { actor: "a", body: { reason: "x" } });
    expect(active.status).toBe(409);
    expect(await active.json()).toEqual({ error: { code: "spec_active", message: `spec ${s.id} has unfinished gigs: ${g.id}; close them or clear their spec (gig update <id> --spec none) first` } });
    store.close(g.id, "a");
    expect((await call("GET", "/projects/hs/specs")).status).toBe(200);
    expect(await (await call("GET", "/projects/hs/specs")).json()).toEqual([]);
    expect(await (await call("GET", "/projects/hs/specs?all=1")).json()).toMatchObject([{ id: s.id, status: "done" }]);
    expect(await (await call("GET", "/projects/hs/specs?all=true")).json()).toHaveLength(1);
    const missing = await call("POST", `${path}/close`, { actor: "a", body: {} });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: { code: "bad_request", message: "reason is required" } });
    expect(await (await call("POST", `${path}/close`, { actor: "closer", body: { reason: "done here" } })).json())
      .toMatchObject({ status: "closed", close_reason: "done here", closed_by: "closer" });
    const twice = await call("POST", `${path}/close`, { actor: "a", body: { reason: "x" } });
    expect(twice.status).toBe(409);
    expect(await twice.json()).toEqual({ error: { code: "conflict", message: `spec ${s.id} is already closed` } });
    const ready = await call("POST", `${path}/ready`, { actor: "a" });
    expect(ready.status).toBe(409);
    expect(await ready.json()).toEqual({ error: { code: "spec_closed", message: `spec ${s.id} is closed; reopen it first: gig spec reopen ${s.id}` } });
    expect(await (await call("POST", `${path}/reopen`, { actor: "a" })).json()).toMatchObject({ state: "draft", status: "done", close_reason: null });
    const notClosed = await call("POST", `${path}/reopen`, { actor: "a" });
    expect(notClosed.status).toBe(409);
    expect(await notClosed.json()).toEqual({ error: { code: "conflict", message: `spec ${s.id} is not closed` } });
    expect(await (await call("GET", `${path}/history`)).json()).toHaveLength(1);
  });

  test("cli: compact rows with status, ready/close/reopen, list --all, human output", async () => {
    store.createProject("ht");
    const s = await json(["spec", "create", "Checkout", "-d", "We agree."]);
    expect(s).toEqual({ id: "ht-s1", title: "Checkout", version: 1, status: "draft" });
    expect(await json(["spec", "ready", "HT-S1"])).toEqual({ ...s, status: "ready" });
    expect(await json(["spec", "ready", s.id])).toEqual({ ...s, status: "ready" });
    expect(await json(["spec", "ready", s.id, "--full"])).toMatchObject({ state: "ready", status: "ready", project: "ht" });
    const g = await json(["create", "Work", "--spec", s.id]);
    expect(await json(["spec", "show", s.id])).toEqual({ ...s, status: "active", text: "We agree." });
    const refused = await cli(["spec", "close", s.id, "-r", "dropped"]);
    expect(refused).toMatchObject({ code: 1, stderr: `error: spec ${s.id} has unfinished gigs: ${g.id}; close them or clear their spec (gig update <id> --spec none) first\n` });
    expect((await cli(["spec", "close", s.id])).stderr).toContain("missing reason: pass -r <reason>");
    expect((await cli(["spec", "close", s.id, "-r", " "])).code).toBe(1);
    expect((await cli(["spec", "list", "-r", "x"])).stderr).toContain("--reason only works with spec close");
    expect((await cli(["spec", "show", s.id, "--all"])).stderr).toContain("--all only works with spec list");
    expect((await cli(["spec", "ready", s.id, "extra"])).stderr).toContain("too many arguments");
    expect((await cli(["spec", "ready"])).stderr).toContain("missing <id>");

    await json(["close", g.id]);
    const other = await json(["spec", "create", "Other", "-d", "x"]);
    expect(await json(["spec", "list"])).toEqual([other]);
    expect(await json(["spec", "list", "--all"])).toEqual([{ ...s, status: "done" }, other]);
    expect((await cli(["spec", "list", "--all", "--human"])).stdout).toBe("ht-s1  done    Checkout\nht-s2  draft   Other\n");

    expect(await json(["spec", "close", s.id, "-r", "superseded"])).toEqual({ ...s, status: "closed", close_reason: "superseded" });
    expect(await json(["spec", "show", s.id])).toEqual({ ...s, status: "closed", close_reason: "superseded", text: "We agree." });
    expect((await cli(["spec", "show", s.id, "--human"])).stdout).toBe("ht-s1  Checkout\nv1 · closed by agent-1: superseded\n\nWe agree.\n");
    expect((await cli(["spec", "close", s.id, "--reason", "again"])).stderr).toBe(`error: spec ${s.id} is already closed\n`);
    expect((await cli(["spec", "ready", s.id])).stderr).toBe(`error: spec ${s.id} is closed; reopen it first: gig spec reopen ${s.id}\n`);
    expect((await cli(["spec", "list", "--all", "--human"])).stdout).toBe("ht-s1  closed  Checkout\nht-s2  draft   Other\n");
    expect((await cli(["spec", "reopen", s.id, "--human"])).stdout).toBe("reopened ht-s1; status done\n");
    expect((await cli(["spec", "reopen", s.id])).stderr).toBe(`error: spec ${s.id} is not closed\n`);
    expect((await cli(["spec", "ready", other.id, "--human"])).stdout).toBe("marked ht-s2; status ready\n");
    expect((await cli(["spec", "close", other.id, "-r", "x", "--human"])).stdout).toBe("closed ht-s2; status closed\n");
    expect(await json(["spec", "history", s.id])).toHaveLength(1);

    const help = (await cli(["spec", "--help"])).stdout;
    expect(help).toContain("spec list [--all]");
    expect(help).toContain("spec close <id> -r reason");
    expect(help.split("\n").every((line) => line.length <= 80)).toBe(true);
  });
});
