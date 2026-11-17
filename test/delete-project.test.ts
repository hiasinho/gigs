import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_TOKEN, openTestServer } from "./http";

// Deleting a project with the admin token: everything in it goes, other projects keep their data
// apart from the links (and parents) that pointed into it. Runs on Bun and, through the Worker, in workerd.
describe("DELETE /projects/:prefix", () => {
  const api = openTestServer();
  const call = (method: string, path: string, token?: string, body?: unknown) => {
    const headers: Record<string, string> = { "X-Gigs-Actor": "a" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return api.fetch(new Request(`http://gigs${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  };
  const get = async (path: string) => (await (await call("GET", path, ADMIN_TOKEN)).json()) as any;
  let dpToken: string, otToken: string;
  beforeAll(async () => {
    const { seed } = api;
    await seed("/projects", { prefix: "dp", name: "Doomed" });
    await seed("/projects", { prefix: "ot" });
    dpToken = (await seed("/projects/dp/tokens", {})).token;
    otToken = (await seed("/projects/ot/tokens", {})).token;
    const spec = await seed("/projects/dp/specs", { title: "s", text: "t" });
    await call("POST", `/specs/${spec.id}/ready`, ADMIN_TOKEN);
    const d1 = await seed("/projects/dp/gigs", { title: "d1", spec: spec.id, labels: ["x"] });
    const d2 = await seed("/projects/dp/gigs", { title: "d2", parent: d1.id });
    await seed("/projects/dp/gigs", { title: "d3", blocked_by: [d2.id] });
    await seed(`/gigs/${d1.id}/comments`, { body: "hi" });
    const o1 = await seed("/projects/ot/gigs", { title: "o1", blocked_by: [d1.id], discovered_from: d1.id, labels: ["y"] });
    const o2 = await seed("/projects/ot/gigs", { title: "o2", parent: d1.id });
    await seed(`/gigs/${o1.id}/comments`, { body: "stays" });
    expect((await call("POST", `/gigs/${o1.id}/links`, ADMIN_TOKEN, { target: d1.id, kind: "related" })).status).toBe(200);
    expect((await call("POST", `/gigs/${d2.id}/links`, ADMIN_TOKEN, { target: o2.id, kind: "blocks" })).status).toBe(200);
  });
  afterAll(() => api.dispose());

  test("a project token is refused, its own project or another", async () => {
    for (const prefix of ["dp", "ot"]) {
      const res = await call("DELETE", `/projects/${prefix}`, otToken);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "forbidden", message: "needs the admin token" } });
    }
    expect((await call("DELETE", "/projects/dp", dpToken)).status).toBe(403);
    expect((await get("/projects")).map((p: any) => p.prefix)).toEqual(["dp", "ot"]);
  });

  test("an unknown project is 404", async () => {
    const res = await call("DELETE", "/projects/zz", ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "project zz not found" } });
  });

  test("the admin deletes the project and everything in it; other projects keep theirs", async () => {
    const res = await call("DELETE", "/projects/DP", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prefix: "dp", name: "Doomed", created_at: expect.any(String) });

    expect((await get("/projects")).map((p: any) => p.prefix)).toEqual(["ot"]);
    expect((await call("GET", "/projects/dp", ADMIN_TOKEN)).status).toBe(404);
    expect((await call("GET", "/gigs/dp-1", ADMIN_TOKEN)).status).toBe(404);
    expect((await call("GET", "/specs/dp-s1", ADMIN_TOKEN)).status).toBe(404);
    expect((await call("DELETE", "/projects/dp", ADMIN_TOKEN)).status).toBe(404);
    // Its token no longer authenticates; the other project's still does.
    expect((await call("GET", "/projects", dpToken)).status).toBe(401);
    expect((await call("GET", "/projects/ot/gigs", otToken)).status).toBe(200);

    const o1 = await get("/gigs/ot-1");
    expect(o1).toMatchObject({ gig: { title: "o1", labels: ["y"] }, blockers: [], blocks: [], related: [], discovered_from: [] });
    expect(o1.comments).toMatchObject([{ body: "stays" }]);
    expect(await get("/gigs/ot-2")).toMatchObject({ gig: { title: "o2", parent: null }, parent: null, blocks: [], blockers: [] });

    // Not a row left that names the project, in any table.
    const dump = await get("/admin/export");
    expect(JSON.stringify(dump.tables)).not.toMatch(/"dp(-|")/);
    expect(dump.tables.gigs).toHaveLength(2);
    expect(dump.tables.tokens).toHaveLength(1);

    // The prefix is free again, numbering from 1.
    await api.seed("/projects", { prefix: "dp" });
    expect((await api.seed("/projects/dp/gigs", { title: "new" })).id).toBe("dp-1");
  });
});
