import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/server";
import { GigsError, Store } from "../src/store";
import { bunDescribe, openStore } from "./harness";
import { ADMIN_TOKEN, openTestServer } from "./http";

// Creating a gig already deferred: one atomic operation, so it is never open (and claimable) in between.

let dir: string;
let store: Store;
let clock: Date;
const T0 = "2026-01-01T00:00:00.000Z";
const minutes = (n: number) => (clock = new Date(clock.getTime() + n * 60_000));
const at = (offsetMinutes: number) => new Date(Date.parse(T0) + offsetMinutes * 60_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gigs-create-defer-"));
  clock = new Date(T0);
  store = openStore(join(dir, "gigs.db"), { now: () => clock, claimTtlMinutes: 30 });
  store.createProject("gig");
});
afterEach(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });

const create = (title: string, input = {}) => store.createGig("gig", "a", { title, ...input });
const ids = (gigs: { id: string }[]) => gigs.map((b) => b.id);
function error(fn: () => unknown, message?: string) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(GigsError);
    expect(err).toMatchObject({ code: "bad_request", status: 400 });
    if (message) expect((err as GigsError).message).toBe(message);
    return;
  }
  throw new Error("expected bad_request");
}

describe("create deferred", () => {
  test("--defer: deferred until undeferred, never ready or handed out", () => {
    const g = create("report", { defer: true });
    expect(g).toMatchObject({ status: "deferred", defer_until: null });
    expect(store.ready("gig")).toEqual([]);
    expect(store.claimNext("gig", "agent")).toBeNull();
    minutes(60 * 24 * 365);
    expect(store.getDetail(g.id).gig.status).toBe("deferred");
    expect(store.undefer(g.id, "a")).toMatchObject({ status: "open", defer_until: null });
    expect(ids(store.ready("gig"))).toEqual([g.id]);
  });

  test("defer_until implies defer and lapses to open when the time passes", () => {
    const g = create("later", { defer_until: at(60) });
    expect(g).toMatchObject({ status: "deferred", defer_until: at(60) });
    expect(create("later too", { defer: true, defer_until: at(30) })).toMatchObject({ status: "deferred", defer_until: at(30) });
    expect(store.claimNext("gig", "agent")).toBeNull();
    minutes(60);
    expect(store.getDetail(g.id).gig).toMatchObject({ status: "open", defer_until: null });
    expect(ids(store.ready("gig"))).toContain(g.id);
  });

  test("defer: false or absent creates an open gig; null defer_until is no time", () => {
    expect(create("a", { defer: false }).status).toBe("open");
    expect(create("b", { defer_until: null }).status).toBe("open");
    expect(create("c", { defer: true, defer_until: null })).toMatchObject({ status: "deferred", defer_until: null });
  });

  test("works with other create options", () => {
    const blocker = create("blocker");
    const parent = create("parent");
    const g = create("child", { defer: true, parent: parent.id, blocked_by: [blocker.id], labels: ["needs-triage"], human: true });
    expect(g).toMatchObject({ status: "deferred", parent: parent.id, labels: ["needs-triage"], human: true });
    expect(store.getDetail(g.id).blockers.map((b) => b.id)).toEqual([blocker.id]);
  });

  test("bad input is refused with defer's messages, and no gig or number is used", () => {
    error(() => create("x", { defer_until: "tomorrow" }), "until must be an ISO-8601 time");
    error(() => create("x", { defer_until: "10000-01-01T00:00:00Z" }), "until must be an ISO-8601 time");
    error(() => create("x", { defer_until: T0 }), "until must be in the future");
    error(() => create("x", { defer: true, defer_until: at(-5) }), "until must be in the future");
    error(() => create("x", { defer: false, defer_until: at(60) }), "defer_until requires defer");
    for (const bad of [1, "yes", null]) error(() => create("x", { defer: bad }), "defer must be a boolean");
    expect(store.listGigs("gig", { all: true })).toEqual([]);
    expect(create("x").id).toBe("gig-1");
  });
});

// Runs on Bun and, through the Worker, in workerd (see test/http.ts).
describe("create deferred over HTTP", () => {
  const api = openTestServer();
  afterAll(() => api.dispose());
  const post = (body: unknown) => api.fetch(new Request("http://gigs/projects/ch/gigs", {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "X-Gigs-Actor": "a" },
    body: JSON.stringify(body),
  }));

  test("http: defer and defer_until pass through; bad until is a 400", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await api.seed("/projects", { prefix: "ch" });
    const r = await post({ title: "report", defer_until: until });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ status: "deferred", defer_until: until });
    const bad = await post({ title: "report", defer: true, defer_until: "2000-01-01T00:00:00Z" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "bad_request", message: "until must be in the future" } });
  });
});

// Bun-only: drives the CLI against a Bun.serve server.
bunDescribe("create deferred through the CLI", () => {
  const sdir = mkdtempSync(join(tmpdir(), "gigs-create-defer-cli-"));
  const s = openStore(join(sdir, "gigs.db"));
  s.createProject("cd");
  const server = Bun.serve({ port: 0, fetch: createHandler(s, { adminToken: "t0k" }) });
  afterAll(() => { server.stop(true); s.dispose(); rmSync(sdir, { recursive: true, force: true }); });

  async function cli(args: string[]) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: sdir,
      env: { ...process.env, GIGS_URL: server.url.href, GIGS_TOKEN: "t0k", GIG_ACTOR: "agent-1", GIG_PROJECT: "cd" } as Record<string, string>,
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test("cli: --until implies --defer; --defer alone; neither is claimable", async () => {
    const before = Date.now();
    const r = await cli(["create", "Triage me", "--until", "2d", "--label", "needs-triage"]);
    expect(r.code).toBe(0);
    const g = JSON.parse(r.stdout);
    expect(g).toMatchObject({ status: "deferred", labels: ["needs-triage"] });
    const ms = Date.parse(g.defer_until) - before;
    expect(ms).toBeGreaterThan(2 * 86_400_000 - 60_000);
    expect(ms).toBeLessThan(2 * 86_400_000 + 60_000);

    const d = JSON.parse((await cli(["create", "Untriaged", "--defer"])).stdout);
    expect(d.status).toBe("deferred");
    expect(d).not.toHaveProperty("defer_until");
    expect(s.claimNext("cd", "agent")).toBeNull();

    // A time after --defer is refused, not appended to the title; nothing is created.
    expect(await cli(["create", "Report", "--defer", "4h"])).toMatchObject({ code: 1, stderr: "error: --defer takes no value; to defer until 4h, use --until 4h\n" });
    expect(s.listGigs("cd", { all: true }).some((g) => g.title.startsWith("Report"))).toBe(false);
    expect(JSON.parse((await cli(["create", "--defer", "Review", "PR"])).stdout)).toMatchObject({ title: "Review PR", status: "deferred" });

    expect(await cli(["create", "x", "--until", "2000-01-01"])).toMatchObject({ code: 1, stderr: "error: until must be in the future\n" });
  });
});
