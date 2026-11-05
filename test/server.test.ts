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

test("config from env", () => {
  expect(configFromEnv({ BOONS_PORT: "1234", BOONS_DB: "/x.db", BOONS_TOKEN: "t" })).toEqual({
    host: "127.0.0.1",
    port: 1234,
    db: "/x.db",
    token: "t",
  });
  expect(() => configFromEnv({ BOONS_PORT: "nope" })).toThrow();
});
