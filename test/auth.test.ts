import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, createHandler } from "../src/server";
import { Store } from "../src/store";
import { bunDescribe, bunTest, openSql, openStore } from "./harness";

const dir = mkdtempSync(join(tmpdir(), "gigs-auth-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function call(handle: (req: Request) => Promise<Response>, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "X-Gigs-Actor": "a" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return handle(new Request(`http://gigs${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

describe("store tokens", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(join(dir, "store.db"));
    store.createProject("ab");
  });
  afterEach(() => store.dispose());

  test("plaintext only on creation, hashed at rest, several per project, revocable", () => {
    const first = store.createToken("AB", "laptop");
    const second = store.createToken("ab");
    expect(first).toMatchObject({ project: "ab", label: "laptop", revoked_at: null });
    expect(first.token).toMatch(/^gig_[A-Za-z0-9_-]{40,}$/);
    expect(second.id).not.toBe(first.id);
    expect(store.tokenProject(first.token)).toBe("ab");
    expect(store.tokenProject(second.token)).toBe("ab");
    expect(store.tokenProject("gig_nope")).toBeNull();

    const listed = store.listTokens("ab");
    expect(listed.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(listed.every((t) => !("token" in t))).toBe(true);

    const revoked = store.revokeToken(first.id);
    expect(revoked.revoked_at).not.toBeNull();
    expect(store.tokenProject(first.token)).toBeNull();
    expect(store.tokenProject(second.token)).toBe("ab");
    expect(() => store.revokeToken(first.id)).toThrow("already revoked");
    expect(() => store.revokeToken(999)).toThrow("not found");
    expect(() => store.revokeToken("nope")).toThrow("not found");
    expect(() => store.createToken("zz")).toThrow("not found");
    expect(() => store.createToken("ab", 5)).toThrow("label");

    const db = openSql(join(dir, "store.db"));
    const raw = db.all<Record<string, unknown>>("SELECT * FROM tokens");
    db.close();
    expect(JSON.stringify(raw)).not.toContain(first.token);
    expect(JSON.stringify(raw)).not.toContain(second.token);
  });
});

bunDescribe("auth off (no admin token)", () => {
  const store = openStore(join(dir, "off.db"));
  const handle = createHandler(store);
  afterAll(() => store.dispose());

  test("no token needed anywhere; health says auth is off", async () => {
    expect(await (await call(handle, "GET", "/health")).json()).toEqual({ ok: true, auth: false });
    expect((await call(handle, "POST", "/projects", undefined, { prefix: "of" })).status).toBe(201);
    expect((await call(handle, "GET", "/projects")).status).toBe(200);
    expect((await call(handle, "POST", "/projects/of/gigs", "anything", { title: "x" })).status).toBe(201);
  });
});

bunDescribe("auth on (admin token)", () => {
  const store = openStore(join(dir, "on.db"));
  const handle = createHandler(store, { adminToken: "adm1n" });
  store.createProject("ab");
  store.createProject("cd");
  const ab = store.createToken("ab").token;
  const cd = store.createToken("cd").token;
  const a1 = store.createGig("ab", "x", { title: "a1" });
  const c1 = store.createGig("cd", "x", { title: "c1" });
  store.addLink(a1.id, c1.id, "blocks", "x");
  store.createSpec("ab", "x", { title: "s", text: "t" });
  store.createSpec("cd", "x", { title: "s", text: "t" });
  afterAll(() => store.dispose());

  test("health and the UI page are public; everything else needs a valid token", async () => {
    expect(await (await call(handle, "GET", "/health")).json()).toEqual({ ok: true, auth: true });
    expect((await call(handle, "GET", "/")).status).toBe(200);
    for (const token of [undefined, "wrong", "adm1n2"]) {
      const res = await call(handle, "GET", "/projects/ab/gigs", token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "missing or invalid token" } });
    }
  });

  test("the admin token can do everything", async () => {
    expect((await call(handle, "GET", "/projects", "adm1n")).status).toBe(200);
    expect((await call(handle, "GET", `/gigs/${c1.id}`, "adm1n")).status).toBe(200);
    expect((await call(handle, "POST", "/projects/ab/gigs", "adm1n", { title: "x", blocked_by: [c1.id] })).status).toBe(201);
    const detail = (await (await call(handle, "GET", `/gigs/${a1.id}`, "adm1n")).json()) as any;
    expect(detail.blockers).toEqual([{ id: c1.id, title: "c1", status: "open", type: "task", priority: 2 }]);
  });

  test("listing projects: the admin token sees all, a project token only its own", async () => {
    const names = async (token: string) => ((await (await call(handle, "GET", "/projects", token)).json()) as any[]).map((p) => p.prefix);
    expect(await names("adm1n")).toEqual(["ab", "cd"]);
    expect(await names(ab)).toEqual(["ab"]);
    expect(await names(cd)).toEqual(["cd"]);
    expect((await call(handle, "GET", "/projects", "wrong")).status).toBe(401);
  });

  test("a project token reads and writes its own project", async () => {
    expect((await call(handle, "GET", "/projects/ab", ab)).status).toBe(200);
    expect((await call(handle, "GET", "/projects/AB/gigs", ab)).status).toBe(200);
    expect((await call(handle, "GET", "/projects/ab/ready", ab)).status).toBe(200);
    expect((await call(handle, "GET", "/projects/ab/blocked", ab)).status).toBe(200);
    expect((await call(handle, "GET", "/projects/ab/specs", ab)).status).toBe(200);
    expect((await call(handle, "GET", "/specs/ab-s1", ab)).status).toBe(200);
    expect((await call(handle, "POST", "/projects/ab/gigs", ab, { title: "child", parent: a1.id, labels: ["x"] })).status).toBe(201);
    const created = await call(handle, "POST", "/projects/ab/gigs", ab, { title: "mine" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as any;
    expect((await call(handle, "POST", `/gigs/${id}/comments`, ab, { body: "hi" })).status).toBe(201);
    expect((await call(handle, "POST", `/gigs/${id.toUpperCase()}/claim`, ab)).status).toBe(200);
    expect((await call(handle, "POST", `/gigs/${id}/close`, ab, {})).status).toBe(200);
  });

  test("a project token is refused (403) on any other project, by path, body or query", async () => {
    const refused: [string, string, unknown?][] = [
      ["GET", "/projects/cd"], ["GET", "/projects/cd/gigs"], ["GET", "/projects/cd/ready"], ["GET", "/projects/cd/blocked"],
      ["GET", "/projects/cd/specs"], ["POST", "/projects/cd/specs", { title: "s", text: "t" }], ["POST", "/projects/cd/gigs", { title: "x" }],
      ["POST", "/projects/cd/claim"], ["GET", `/gigs/${c1.id}`], ["PATCH", `/gigs/${c1.id}`, { title: "x" }],
      ["POST", `/gigs/${c1.id}/comments`, { body: "x" }], ["POST", `/gigs/${c1.id}/claim`], ["POST", `/gigs/${c1.id}/close`],
      ["POST", `/gigs/${c1.id}/links`, { target: a1.id, kind: "related" }], ["DELETE", `/gigs/${c1.id}/links/blocks/${a1.id}`],
      ["GET", "/specs/cd-s1"], ["GET", "/specs/cd-s1/history"], ["PATCH", "/specs/cd-s1", { title: "x" }], ["POST", "/specs/cd-s1/ready"],
      // References to the other project inside an own-project call:
      ["POST", "/projects/ab/gigs", { title: "x", parent: c1.id }],
      ["POST", "/projects/ab/gigs", { title: "x", blocked_by: [a1.id, c1.id] }],
      ["POST", "/projects/ab/gigs", { title: "x", discovered_from: c1.id }],
      ["POST", "/projects/ab/gigs", { title: "x", spec: "cd-s1" }],
      ["PATCH", `/gigs/${a1.id}`, { parent: c1.id }],
      ["POST", `/gigs/${a1.id}/links`, { target: c1.id, kind: "related" }],
      ["DELETE", `/gigs/${a1.id}/links/blocks/${c1.id}`],
      ["POST", "/projects/ab/claim", { parent: c1.id }],
      ["GET", `/projects/ab/ready?parent=${c1.id}`],
      ["GET", `/projects/ab/gigs?parent=${c1.id}`],
      // Admin only:
      ["POST", "/projects", { prefix: "ef" }],
      ["GET", "/projects/ab/tokens"], ["POST", "/projects/ab/tokens", {}], ["POST", "/tokens/1/revoke"],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(handle, method, path, ab, body);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect(((await res.json()) as any).error.code).toBe("forbidden");
    }
    // Nothing leaked through: the other project is unchanged.
    expect(store.getGig(c1.id)).toMatchObject({ title: "c1", status: "open" });
    expect(store.getDetail(a1.id).blockers.map((g) => g.id)).toEqual([c1.id]);
  });

  test("links to gigs in other projects show only the id", async () => {
    const detail = (await (await call(handle, "GET", `/gigs/${a1.id}`, ab)).json()) as any;
    expect(detail.blockers).toEqual([{ id: c1.id }]);
    expect(detail.reasons).toContainEqual({ kind: "blocker", id: c1.id });
  });

  test("token management with the admin token", async () => {
    const res = await call(handle, "POST", "/projects/ab/tokens", "adm1n", { label: "ci" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    expect(created).toMatchObject({ project: "ab", label: "ci" });
    expect((await call(handle, "GET", "/projects/ab/gigs", created.token)).status).toBe(200);
    const list = (await (await call(handle, "GET", "/projects/ab/tokens", "adm1n")).json()) as any[];
    expect(list.map((t) => t.label)).toEqual([null, "ci"]);
    expect(list.some((t) => "token" in t || "hash" in t)).toBe(false);
    expect((await call(handle, "POST", `/tokens/${created.id}/revoke`, "adm1n")).status).toBe(200);
    expect((await call(handle, "GET", "/projects/ab/gigs", created.token)).status).toBe(401);
    expect((await call(handle, "GET", "/projects/ab/gigs", cd)).status).toBe(403);
  });
});

bunTest("config: GIGS_ADMIN_TOKEN turns auth on; a leftover server GIGS_TOKEN fails closed", () => {
  expect(configFromEnv({ GIGS_ADMIN_TOKEN: "x" }).adminToken).toBe("x");
  expect(configFromEnv({}).adminToken).toBeUndefined();
  expect(() => configFromEnv({ GIGS_TOKEN: "old" })).toThrow("GIGS_ADMIN_TOKEN");
  expect(configFromEnv({ GIGS_TOKEN: "client", GIGS_ADMIN_TOKEN: "x" }).adminToken).toBe("x");
});

bunDescribe("CLI", () => {
  const store = openStore(join(dir, "cli.db"));
  const server = Bun.serve({ port: 0, fetch: createHandler(store, { adminToken: "adm1n" }) });
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  afterAll(() => { server.stop(true); store.dispose(); });

  async function cli(args: string[], env: Record<string, string | undefined> = {}, cwd = repo) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd,
      env: { ...process.env, GIGS_URL: server.url.href, GIGS_TOKEN: undefined, GIG_PROJECT: undefined, GIG_ACTOR: "agent", ...env } as unknown as Record<string, string>,
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test("init with the admin token writes the project's first token; the repo then just works", async () => {
    const init = await cli(["init", "rp", "--name", "Repo"], { GIGS_TOKEN: "adm1n" });
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ prefix: "rp", name: "Repo", token_id: expect.any(Number) });
    const config = JSON.parse(readFileSync(join(repo, ".gigs.json"), "utf8"));
    expect(Object.keys(config)).toEqual(["project", "token"]);
    expect(store.tokenProject(config.token)).toBe("rp");

    // No env token: the .gigs.json token is used, also from a subdirectory.
    expect(JSON.parse((await cli(["create", "hello"], {}, join(repo, "sub"))).stdout)).toMatchObject({ id: "rp-1" });
    // GIGS_TOKEN overrides it.
    expect(await cli(["list"], { GIGS_TOKEN: "wrong" })).toMatchObject({ code: 1, stderr: "error: missing or invalid token\n" });
    // Re-running init keeps the token instead of minting another.
    expect(JSON.parse((await cli(["init", "rp"], { GIGS_TOKEN: "adm1n" })).stdout)).not.toHaveProperty("token_id");
    expect(JSON.parse(readFileSync(join(repo, ".gigs.json"), "utf8")).token).toBe(config.token);
    expect(store.listTokens("rp")).toHaveLength(1);
    // A project token can link its own existing project, and lists only that one.
    expect((await cli(["init", "rp"])).code).toBe(0);
    expect(JSON.parse((await cli(["projects"])).stdout).map((p: any) => p.prefix)).toEqual(["rp"]);
  });

  test("token add, list and revoke", async () => {
    const add = await cli(["token", "add", "--label", "ci", "-P", "rp"], { GIGS_TOKEN: "adm1n" });
    expect(add.code).toBe(0);
    const created = JSON.parse(add.stdout);
    expect(Object.keys(created)).toEqual(["id", "project", "label", "created_at", "token"]);
    const list = JSON.parse((await cli(["token", "list", "-P", "rp"], { GIGS_TOKEN: "adm1n" })).stdout);
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ id: created.id, project: "rp", label: "ci", created_at: created.created_at });
    const revoked = JSON.parse((await cli(["token", "revoke", String(created.id)], { GIGS_TOKEN: "adm1n" })).stdout);
    expect(revoked).toMatchObject({ id: created.id, revoked_at: expect.any(String) });
    expect((await cli(["list", "-P", "rp"], { GIGS_TOKEN: created.token })).code).toBe(1);
    expect(await cli(["token", "add"])).toMatchObject({ code: 1, stderr: "error: needs the admin token\n" });
    expect((await cli(["token", "nope"], { GIGS_TOKEN: "adm1n" })).code).toBe(1);
  });

  test("auth off: init writes no token", async () => {
    const offStore = openStore(join(dir, "cli-off.db"));
    const off = Bun.serve({ port: 0, fetch: createHandler(offStore) });
    const offRepo = join(dir, "off-repo");
    mkdirSync(offRepo);
    writeFileSync(join(offRepo, ".gigs.json"), "{}");
    try {
      expect((await cli(["init", "of"], { GIGS_URL: off.url.href }, offRepo)).code).toBe(0);
      expect(JSON.parse(readFileSync(join(offRepo, ".gigs.json"), "utf8"))).toEqual({ project: "of" });
    } finally {
      off.stop(true);
      offStore.dispose();
    }
  });
});
