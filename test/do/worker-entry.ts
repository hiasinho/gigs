// The Cloudflare Worker entry end to end in workerd (vitest only): Worker -> the one GigsDO -> handler.
import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker, { type Env } from "../../src/worker";

const ADMIN = "adm1n"; // vitest.config.ts binds it as GIGS_ADMIN_TOKEN

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "X-Gigs-Actor": "a" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(`https://gigs.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("worker entry", () => {
  test("health and the UI are public, auth is always on", async () => {
    expect(await (await call("GET", "/health")).json()).toEqual({ ok: true, auth: true });
    const ui = await call("GET", "/");
    expect(ui.headers.get("content-type")).toContain("text/html");
    expect(await ui.text()).toContain("<title>gigs</title>");
    expect((await call("GET", "/projects")).status).toBe(401);
    expect((await call("GET", "/projects", "wrong")).status).toBe(401);
  });

  test("every request reaches the same database", async () => {
    expect((await call("POST", "/projects", ADMIN, { prefix: "wk" })).status).toBe(201);
    const token = (await (await call("POST", "/projects/wk/tokens", ADMIN, {})).json() as { token: string }).token;
    expect((await call("POST", "/projects/wk/gigs", token, { title: "hello" })).status).toBe(201);
    expect(await (await call("GET", "/projects/wk/gigs", token)).json()).toMatchObject([{ id: "wk-1", title: "hello" }]);
  });

  test("a project token lists only its own project; creating projects and tokens stays admin-only", async () => {
    for (const prefix of ["pa", "pb"]) expect((await call("POST", "/projects", ADMIN, { prefix })).status).toBe(201);
    const token = (await (await call("POST", "/projects/pb/tokens", ADMIN, {})).json() as { token: string }).token;
    const prefixes = async (t: string) => (await (await call("GET", "/projects", t)).json() as { prefix: string }[]).map((p) => p.prefix);
    expect(await prefixes(ADMIN)).toEqual(expect.arrayContaining(["pa", "pb", "wk"]));
    expect(await prefixes(token)).toEqual(["pb"]);
    expect((await call("POST", "/projects", token, { prefix: "zz" })).status).toBe(403);
    expect((await call("POST", "/projects/pb/tokens", token, {})).status).toBe(403);
    expect((await call("GET", "/projects/pb/tokens", token)).status).toBe(403);
    expect((await call("POST", "/tokens/1/revoke", token)).status).toBe(403);
  });

  test("admin export and import, without the DO's own tables", async () => {
    expect((await call("POST", "/projects", ADMIN, { prefix: "ex" })).status).toBe(201);
    const token = (await (await call("POST", "/projects/ex/tokens", ADMIN, {})).json() as { token: string }).token;
    expect((await call("GET", "/admin/export", token)).status).toBe(403);
    const dump = await (await call("GET", "/admin/export", ADMIN)).json() as { version: number; tables: Record<string, unknown[]> };
    expect(dump.version).toBeGreaterThan(0);
    expect(Object.keys(dump.tables)).not.toContain("schema_version");
    expect(Object.keys(dump.tables).filter((t) => t.startsWith("_cf_"))).toEqual([]);
    expect(dump.tables.projects).toContainEqual(expect.objectContaining({ prefix: "ex" }));
    expect((await call("POST", "/admin/import", ADMIN, dump)).status).toBe(409);
  });

  test("refuses every request without the admin token secret", async () => {
    const res = await worker.fetch(new Request("https://gigs.test/health"), { ...(env as Env), GIGS_ADMIN_TOKEN: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "misconfigured" } });
  });
});
