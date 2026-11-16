import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, createHandler } from "../src/server";
import { Store } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "boons-server-"));
const store = new Store({ path: join(dir, "boons.db") });
const handle = createHandler(store, { token: "s3cret" });

afterAll(() => {
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, opts: { body?: string; actor?: string; token?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? "s3cret"}`;
  if (opts.actor !== undefined) headers["X-Boons-Actor"] = opts.actor;
  return handle(new Request(`http://boons${path}`, { method, headers, body: opts.body }));
}

test("health needs no token; everything else does", async () => {
  expect(await (await call("GET", "/health", { token: null })).json()).toEqual({ ok: true });
  const res = await call("GET", "/projects", { token: "wrong" });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "missing or invalid token" } });
});

test("malformed URL escapes authenticate first, then return JSON bad_request", async () => {
  for (const path of ["/boons/%ZZ", "/boons/%E0%A4%A"]) {
    expect((await call("GET", path, { token: null })).status).toBe(401);
    const res = await call("GET", path);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  }
});

test("claim TTL must be finite and representable as a Date", () => {
  for (const value of ["Infinity", "1e300", "1e10"]) {
    expect(() => configFromEnv({ BOONS_CLAIM_TTL_MINUTES: value })).toThrow();
  }
});

test("mutations require an actor", async () => {
  const res = await call("POST", "/projects", { body: JSON.stringify({ prefix: "bn" }) });
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error.code).toBe("bad_request");
  expect((await call("POST", "/projects", { body: JSON.stringify({ prefix: "bn" }), actor: "a" })).status).toBe(201);
});

test("bad JSON, unknown routes and domain errors use the error shape", async () => {
  const bad = await call("POST", "/projects/bn/boons", { body: "{nope", actor: "a" });
  expect(bad.status).toBe(400);
  const unknown = await call("GET", "/nope");
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as any).error.code).toBe("not_found");
  const missing = await call("GET", "/boons/bn-99");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: { code: "not_found", message: "boon bn-99 not found" } });
});

test("create, list with filters, detail, claim conflict", async () => {
  const created = await call("POST", "/projects/bn/boons", { body: JSON.stringify({ title: "x", type: "bug" }), actor: "a" });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as any;
  await call("POST", "/projects/bn/boons", { body: JSON.stringify({ title: "y" }), actor: "a" });
  const bugs = (await (await call("GET", "/projects/bn/boons?type=bug")).json()) as any[];
  expect(bugs.map((b) => b.id)).toEqual([id]);
  expect((await call("POST", `/boons/${id}/claim`, { actor: "a" })).status).toBe(200);
  const taken = await call("POST", `/boons/${id.toUpperCase()}/claim`, { actor: "b" });
  expect(taken.status).toBe(409);
  expect(((await taken.json()) as any).error.code).toBe("claimed");
  const detail = (await (await call("GET", `/boons/${id}`)).json()) as any;
  expect(detail).toMatchObject({ boon: { id, claimed_by: "a" }, ready: false, reasons: [] });
  const open = (await (await call("GET", "/projects/bn/boons?status=open,in_progress")).json()) as any[];
  expect(open).toHaveLength(2);
});

test("auth and actor requirements cover all mutation routes, including errors", async () => {
  const routes: [string, string][] = [
    ["POST", "/projects"], ["POST", "/projects/bn/boons"], ["POST", "/projects/bn/claim"], ["POST", "/projects/bn/specs"],
    ["PATCH", "/boons/bn-1"], ["POST", "/boons/bn-1/links"],
    ["DELETE", "/boons/bn-1/links/related/bn-2"], ["POST", "/missing"],
    ...["claim", "unclaim", "close", "reopen", "heartbeat", "defer", "undefer", "comments", "edits"]
      .map((action): [string, string] => ["POST", "/boons/bn-1/" + action]),
  ];
  for (const [method, path] of routes) {
    expect((await call(method, path, { token: null })).status).toBe(401);
    expect((await call(method, path)).status).toBe(400);
  }
  expect((await call("GET", "/missing", { token: null })).status).toBe(401);
  expect((await call("PUT", "/boons/bn-1", { actor: "a" })).status).toBe(404);
});

test("encoded case-insensitive IDs and JSON object validation", async () => {
  store.createProject("ur");
  const boon = store.createBoon("ur", "fixture", { title: "encoded" });
  const detail = await call("GET", "/boons/%55%52%2D1");
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ boon: { id: boon.id } });
  for (const body of ["null", "[]", "42", '"text"', "{nope"]) {
    const res = await call("POST", "/projects/ur/boons", { body, actor: "a" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  }
});

test("config from env", () => {
  expect(configFromEnv({ BOONS_PORT: "1234", BOONS_DB: "/x.db", BOONS_TOKEN: "t" })).toEqual({
    host: "127.0.0.1",
    port: 1234,
    db: "/x.db",
    token: "t",
    claimTtlMinutes: 60,
  });
  expect(configFromEnv({ BOONS_CLAIM_TTL_MINUTES: "15" }).claimTtlMinutes).toBe(15);
  expect(() => configFromEnv({ BOONS_PORT: "nope" })).toThrow();
  expect(() => configFromEnv({ BOONS_CLAIM_TTL_MINUTES: "0" })).toThrow();
});

test("slice 3 routes: update, heartbeat, defer, undefer, comments", async () => {
  const post = (path: string, body?: unknown, actor = "a") => call("POST", path, { actor, body: body === undefined ? undefined : JSON.stringify(body) });
  const { id } = (await (await post("/projects/bn/boons", { title: "slice3" })).json()) as any;
  const patched = await call("PATCH", `/boons/${id}`, { actor: "a", body: JSON.stringify({ title: "renamed", priority: 0 }) });
  expect(await patched.json()).toMatchObject({ id, title: "renamed", priority: 0 });
  const bad = await call("PATCH", `/boons/${id}`, { actor: "a", body: JSON.stringify({ status: "closed" }) });
  expect(bad.status).toBe(400);
  await post(`/boons/${id}/claim`);
  expect((await post(`/boons/${id}/heartbeat`, undefined, "b")).status).toBe(409);
  expect((await post(`/boons/${id}/heartbeat`)).status).toBe(200);
  const comment = await post(`/boons/${id}/comments`, { body: "progress" });
  expect(comment.status).toBe(201);
  expect(await comment.json()).toMatchObject({ boon_id: id, author: "a", body: "progress" });
  expect((await post(`/boons/${id}/defer`, { until: "2000-01-01T00:00:00Z" })).status).toBe(400);
  expect(await (await post(`/boons/${id}/defer`, { until: "2999-01-01T00:00:00Z" })).json()).toMatchObject({ status: "deferred", claimed_by: null, defer_until: "2999-01-01T00:00:00.000Z" });
  expect(await (await post(`/boons/${id}/undefer`)).json()).toMatchObject({ status: "open", defer_until: null });
  expect(((await (await call("GET", `/boons/${id}`)).json()) as any).comments).toHaveLength(1);
});

test("spec routes: create, list, show, update, spec filters and claim within a spec", async () => {
  store.createProject("sp");
  store.createProject("so");
  const post = (path: string, body?: unknown) => call("POST", path, { actor: "a", body: body === undefined ? undefined : JSON.stringify(body) });
  const created = await post("/projects/sp/specs", { title: "Agreement", text: "We agree." });
  expect(created.status).toBe(201);
  const spec = (await created.json()) as any;
  expect(spec).toMatchObject({ id: "sp-s1", project: "sp", title: "Agreement", text: "We agree.", created_by: "a" });
  expect((await post("/projects/sp/specs", { title: "No text" })).status).toBe(400);
  expect(await (await call("GET", "/projects/sp/specs")).json()).toEqual([spec]);
  expect(await (await call("GET", "/specs/SP-S1")).json()).toEqual(spec);
  expect((await call("GET", "/specs/sp-s9")).status).toBe(404);
  for (const method of ["DELETE", "PUT"]) expect((await call(method, "/specs/sp-s1", { actor: "a", body: "{}" })).status).toBe(404);
  expect((await call("PATCH", "/specs/sp-s1", { body: JSON.stringify({ title: "x" }) })).status).toBe(400);
  const edited = await call("PATCH", "/specs/SP-S1", { actor: "a", body: JSON.stringify({ text: "We agree again." }) });
  expect(await edited.json()).toEqual({ ...spec, text: "We agree again.", version: 2 });
  await call("PATCH", "/specs/sp-s1", { actor: "a", body: JSON.stringify({ text: "We agree." }) });
  expect((await call("PATCH", "/specs/sp-s1", { actor: "a", body: "{}" })).status).toBe(400);
  expect((await call("PATCH", "/specs/sp-s9", { actor: "a", body: JSON.stringify({ title: "x" }) })).status).toBe(404);

  const within = (await (await post("/projects/sp/boons", { title: "within", spec: "sp-s1" })).json()) as any;
  expect(within.spec).toBe("sp-s1");
  const standalone = (await (await post("/projects/sp/boons", { title: "standalone", priority: 0 })).json()) as any;
  expect(standalone.spec).toBeNull();
  const other = (await (await post("/projects/so/specs", { title: "Other", text: "x" })).json()) as any;
  expect((await post("/projects/sp/boons", { title: "x", spec: other.id })).status).toBe(400);
  expect((await post("/projects/sp/boons", { title: "x", spec: "sp-s9" })).status).toBe(404);
  const cleared = await call("PATCH", `/boons/${within.id}`, { actor: "a", body: JSON.stringify({ spec: null }) });
  expect(((await cleared.json()) as any).spec).toBeNull();
  await call("PATCH", `/boons/${within.id}`, { actor: "a", body: JSON.stringify({ spec: "sp-s1" }) });

  const ids = async (path: string) => ((await (await call("GET", path)).json()) as any[]).map((b) => b.id ?? b.boon.id);
  expect(await ids("/projects/sp/boons?spec=sp-s1")).toEqual([within.id]);
  expect(await ids("/projects/sp/ready?spec=sp-s1")).toEqual([within.id]);
  expect(await ids("/projects/sp/blocked?spec=sp-s1")).toEqual([]);
  expect((await call("GET", `/projects/sp/ready?spec=${other.id}`)).status).toBe(400);
  expect(await (await post("/projects/sp/claim", { spec: "sp-s1" })).json()).toMatchObject({ id: within.id, claimed_by: "a" });
  expect(await (await post("/projects/sp/claim", { spec: "sp-s1" })).json()).toBeNull();
  expect(await (await post("/projects/sp/claim")).json()).toMatchObject({ id: standalone.id });
});

test("spec edit, history and version routes validate inputs and preserve snapshots", async () => {
  store.createProject("vh");
  const spec = store.createSpec("vh", "creator", { title: "Agreement", text: "one two two" });
  const path = `/specs/${spec.id}`;
  const edits = [{ old: "one", new: "first" }, { old: "first two two", new: "final" }];
  expect((await call("POST", `${path}/edits`, { body: JSON.stringify({ edits }) })).status).toBe(400);
  expect((await call("POST", `${path}/edits`, { actor: "a", token: null, body: JSON.stringify({ edits }) })).status).toBe(401);
  for (const body of ["{bad", "[]", "{}", '{"edits":[]}', '{"edits":[{"old":"","new":"x"}]}']) {
    expect((await call("POST", `${path}/edits`, { actor: "a", body })).status).toBe(400);
  }
  const conflict = await call("POST", `${path}/edits`, { actor: "a", body: JSON.stringify({ edits: [{ old: "two", new: "x" }] }) });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: { code: "edit_conflict", message: "edit 1: old text found 2 times; include more context" } });
  const edited = await call("POST", `${path}/edits`, { actor: "editor", body: JSON.stringify({ edits }) });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toEqual({ ...spec, text: "final", version: 2 });
  expect(await (await call("GET", `${path}?version=1`)).json()).toEqual(spec);
  expect(await (await call("GET", `${path}?version=2`)).json()).toEqual({ ...spec, text: "final", version: 2 });
  const history = await (await call("GET", `${path}/history`)).json();
  expect(history).toEqual([
    { version: 1, by: "creator", at: spec.created_at, kind: "create" },
    { version: 2, by: "editor", at: expect.any(String), kind: "edit", edits },
  ]);
  expect((await call("GET", `${path}?version=3`)).status).toBe(404);
  for (const version of ["", "0", "-1", "1.5", "abc", "Infinity"]) {
    expect((await call("GET", `${path}?version=${version}`)).status).toBe(400);
  }
  expect((await call("GET", "/specs/vh-s99/history")).status).toBe(404);
  expect((await call("POST", "/specs/vh-s99/edits", { actor: "a", body: JSON.stringify({ edits }) })).status).toBe(404);
});

test("label routes: set on create, change via PATCH, filter list and ready by query", async () => {
  store.createProject("lb");
  const post = (path: string, body: unknown) => call("POST", path, { actor: "a", body: JSON.stringify(body) });
  const patch = (id: string, body: unknown) => call("PATCH", `/boons/${id}`, { actor: "a", body: JSON.stringify(body) });
  const a = (await (await post("/projects/lb/boons", { title: "a", labels: ["agent", "triage:ready"] })).json()) as any;
  expect(a.labels).toEqual(["agent", "triage:ready"]);
  const b = (await (await post("/projects/lb/boons", { title: "b" })).json()) as any;
  expect(b.labels).toEqual([]);
  expect((await post("/projects/lb/boons", { title: "x", labels: ["Bad Label"] })).status).toBe(400);
  expect(await (await patch(b.id, { add_labels: ["agent", "wontfix"], remove_labels: ["missing"] })).json()).toMatchObject({ labels: ["agent", "wontfix"] });
  expect((await patch(b.id, { add_labels: ["UPPER"] })).status).toBe(400);
  expect((await patch(b.id, { add_labels: ["x"], remove_labels: ["x"] })).status).toBe(400);
  expect(((await (await call("GET", `/boons/${b.id}`)).json()) as any).boon.labels).toEqual(["agent", "wontfix"]);

  const ids = async (path: string) => ((await (await call("GET", path)).json()) as any[]).map((x) => x.id);
  expect(await ids("/projects/lb/boons?label=agent")).toEqual([a.id, b.id]);
  expect(await ids("/projects/lb/boons?label=agent,%20wontfix")).toEqual([b.id]);
  expect(await ids("/projects/lb/boons?exclude_label=wontfix")).toEqual([a.id]);
  expect(await ids("/projects/lb/ready?label=agent&exclude_label=triage:ready")).toEqual([b.id]);
  expect((await call("GET", "/projects/lb/ready?label=Nope")).status).toBe(400);
});

test("human routes: set on create and via PATCH, filter list and ready, claim-next skips them", async () => {
  store.createProject("hu");
  const post = (path: string, body: unknown) => call("POST", path, { actor: "a", body: JSON.stringify(body) });
  const h = (await (await post("/projects/hu/boons", { title: "ask", human: true, priority: 0 })).json()) as any;
  expect(h.human).toBe(true);
  const b = (await (await post("/projects/hu/boons", { title: "work" })).json()) as any;
  expect(b.human).toBe(false);
  expect((await post("/projects/hu/boons", { title: "x", human: "yes" })).status).toBe(400);
  const ids = async (path: string) => ((await (await call("GET", path)).json()) as any[]).map((x) => x.id);
  expect(await ids("/projects/hu/boons?human=1")).toEqual([h.id]);
  expect(await ids("/projects/hu/ready?human=true")).toEqual([h.id]);
  expect(await ids("/projects/hu/ready")).toEqual([h.id, b.id]);
  expect(await (await post("/projects/hu/claim", {})).json()).toMatchObject({ id: b.id });
  expect(await (await post("/projects/hu/claim", {})).json()).toBeNull();
  const patched = await call("PATCH", `/boons/${h.id}`, { actor: "a", body: JSON.stringify({ human: false }) });
  expect(await patched.json()).toMatchObject({ human: false });
  expect(await (await post("/projects/hu/claim", {})).json()).toMatchObject({ id: h.id });
});

test("boon edit route: find/replace on the description, validation and conflicts", async () => {
  store.createProject("be");
  const boon = store.createBoon("be", "a", { title: "Edit me", description: "one two two" });
  const path = `/boons/${boon.id.toUpperCase()}/edits`;
  const edits = [{ old: "one", new: "first" }, { old: "first two two", new: "" }];
  expect((await call("POST", path, { body: JSON.stringify({ edits }) })).status).toBe(400);
  expect((await call("POST", path, { actor: "a", token: null, body: JSON.stringify({ edits }) })).status).toBe(401);
  for (const body of ["{bad", "[]", "{}", '{"edits":[]}', '{"edits":[{"old":"","new":"x"}]}']) {
    expect((await call("POST", path, { actor: "a", body })).status).toBe(400);
  }
  const conflict = await call("POST", path, { actor: "a", body: JSON.stringify({ edits: [{ old: "two", new: "x" }] }) });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: { code: "edit_conflict", message: "edit 1: old text found 2 times; include more context" } });
  const edited = await call("POST", path, { actor: "a", body: JSON.stringify({ edits }) });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ id: boon.id, description: "" });
  expect((await call("POST", "/boons/be-99/edits", { actor: "a", body: JSON.stringify({ edits }) })).status).toBe(404);
});

test("claim-next and ready filters: labels, exclude labels, parent subtree; claim never hands out human boons", async () => {
  store.createProject("cf");
  const post = (path: string, body?: unknown) => call("POST", path, { actor: "a", body: body === undefined ? undefined : JSON.stringify(body) });
  const create = async (body: Record<string, unknown>) => ((await (await post("/projects/cf/boons", body)).json()) as any).id as string;
  const epic = await create({ title: "epic" });
  const child = await create({ title: "child", parent: epic });
  const grand = await create({ title: "grandchild", parent: child, labels: ["agent"], priority: 1 });
  const ask = await create({ title: "ask", parent: child, labels: ["agent"], human: true, priority: 0 });
  const hold = await create({ title: "on hold", parent: epic, labels: ["agent", "hold"], priority: 0 });
  const outside = await create({ title: "outside", labels: ["agent"], priority: 0 });
  const ids = async (path: string) => ((await (await call("GET", path)).json()) as any[]).map((x) => x.id);
  expect(await ids(`/projects/cf/ready?parent=${epic}`)).toEqual([ask, hold, grand]);
  expect(await ids(`/projects/cf/ready?parent=${epic}&exclude_label=hold&label=agent`)).toEqual([ask, grand]);
  expect(await ids(`/projects/cf/boons?parent=${epic}`)).toEqual([hold, child]);
  expect((await call("GET", "/projects/cf/ready?parent=cf-99")).status).toBe(404);
  expect((await post("/projects/cf/claim", { parent: "cf-99" })).status).toBe(404);
  expect((await post("/projects/cf/claim", { label: "agent" })).status).toBe(400);
  expect((await post("/projects/cf/claim", { label: ["Bad"] })).status).toBe(400);
  // human: true is not a claim filter; human boons are skipped regardless.
  expect(await (await post("/projects/cf/claim", { parent: epic, label: ["agent"], exclude_label: ["hold"], human: true })).json()).toMatchObject({ id: grand, claimed_by: "a" });
  expect(await (await post("/projects/cf/claim", { parent: epic, exclude_label: ["hold"] })).json()).toBeNull();
  expect(await (await post("/projects/cf/claim", { label: ["agent"] })).json()).toMatchObject({ id: hold });
  expect(await (await post("/projects/cf/claim", { label: ["agent"], parent: null })).json()).toMatchObject({ id: outside });
  expect(await (await post("/projects/cf/claim")).json()).toBeNull();
});
