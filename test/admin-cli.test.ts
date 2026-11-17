import { afterAll, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/handler";
import type { Dump, Store } from "../src/store";
import { bunDescribe, bunTest, openStore } from "./harness";

// `gig admin export` / `gig admin import`: moving a whole database between two servers with the CLI.
bunDescribe("gig admin", () => {
  const dir = mkdtempSync(join(tmpdir(), "gigs-admin-cli-"));
  const servers: { store: Store; server: ReturnType<typeof Bun.serve> }[] = [];
  afterAll(() => {
    for (const { store, server } of servers) { server.stop(true); store.dispose(); }
    rmSync(dir, { recursive: true, force: true });
  });

  function start(name: string, adminToken: string | undefined = "adm1n") {
    const store = openStore(join(dir, `${name}.db`), { now: () => new Date("2026-01-01T00:00:00.000Z") });
    const server = Bun.serve({ port: 0, fetch: createHandler(store, { adminToken }) });
    servers.push({ store, server });
    return { store, url: server.url.href };
  }

  /** Runs the CLI in an unbound directory, against `url` only (never a default or hosted server). */
  async function cli(url: string, args: string[], token: string | undefined = "adm1n") {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, GIGS_URL: url, GIGS_DEFAULT_URL: undefined, GIGS_TOKEN: token, GIG_PROJECT: undefined, GIG_ACTOR: "admin" } as unknown as Record<string, string>,
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  function seed(store: Store) {
    store.createProject("ab", "Alpha");
    const spec = store.createSpec("ab", "alice", { title: "S", text: "one" });
    store.readySpec(spec.id, "alice");
    const epic = store.createGig("ab", "alice", { title: "epic", type: "epic", spec: spec.id });
    const child = store.createGig("ab", "alice", { title: "child", parent: epic.id, labels: ["x"] });
    store.addComment(epic.id, "bob", "hi");
    store.claim(child.id, "carol");
    store.createToken("ab", "laptop");
  }

  bunTest("export from one server, import into an empty one: the second exports the same", async () => {
    const a = start("a");
    const b = start("b");
    seed(a.store);

    const exported = await cli(a.url, ["admin", "export"]);
    expect(exported).toMatchObject({ code: 0, stderr: "" });
    const dump = JSON.parse(exported.stdout) as Dump;
    expect(dump).toEqual(JSON.parse(JSON.stringify(a.store.exportDump())));
    const file = join(dir, "dump.json");
    writeFileSync(file, exported.stdout);

    const imported = await cli(b.url, ["admin", "import", file]);
    expect(imported).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(imported.stdout)).toEqual({
      version: dump.version,
      tables: Object.fromEntries(Object.entries(dump.tables).map(([t, rows]) => [t, rows.length])),
    });
    expect(JSON.parse((await cli(b.url, ["admin", "export"])).stdout)).toEqual(dump);

    // --human: one line per table.
    const c = start("c");
    const human = await cli(c.url, ["admin", "import", file, "--human"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`imported schema version ${dump.version}`);
    expect(human.stdout).toMatch(/^  gigs +2$/m);
  });

  bunTest("clear errors: a non-admin token, a non-empty target, another schema version, a bad file", async () => {
    const a = start("errors");
    seed(a.store);
    const projectToken = a.store.createToken("ab").token;
    const dump = (await cli(a.url, ["admin", "export"])).stdout;
    const file = join(dir, "errors.json");
    writeFileSync(file, dump);

    expect(await cli(a.url, ["admin", "export"], projectToken)).toMatchObject({ code: 1, stderr: "error: needs the admin token (token from GIGS_TOKEN)\n" });
    expect(await cli(a.url, ["admin", "import", file], projectToken)).toMatchObject({ code: 1, stderr: "error: needs the admin token (token from GIGS_TOKEN)\n" });
    expect(await cli(a.url, ["admin", "import", file])).toMatchObject({ code: 1, stderr: "error: import refused: this database is not empty (comments has rows)\n" });

    const empty = start("empty");
    const other = join(dir, "other-version.json");
    writeFileSync(other, JSON.stringify({ ...JSON.parse(dump), version: 999 }));
    expect(await cli(empty.url, ["admin", "import", other])).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error: import refused: the dump is schema version 999, this database \d+\n$/) });

    expect(await cli(empty.url, ["admin", "import", join(dir, "missing.json")])).toMatchObject({ code: 1, stderr: expect.stringContaining(`error: cannot read ${join(dir, "missing.json")}`) });
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    expect(await cli(empty.url, ["admin", "import", broken])).toMatchObject({ code: 1, stderr: `error: ${broken} is not JSON (expected a dump from \`gig admin export\`)\n` });
    expect((await cli(empty.url, ["admin", "import"])).code).toBe(1);
    expect((await cli(empty.url, ["admin", "nope"])).code).toBe(1);
    // Nothing got in.
    expect(empty.store.listProjects()).toEqual([]);
  });

  bunTest("delete-project refuses without --yes, then deletes the project", async () => {
    const a = start("delete");
    seed(a.store);
    a.store.createProject("cd");
    const projectToken = a.store.createToken("ab").token;

    expect(await cli(a.url, ["admin", "delete-project", "ab"])).toMatchObject({ code: 1, stderr: "error: deleting project ab and everything in it cannot be undone; rerun with --yes\n" });
    expect(await cli(a.url, ["admin", "delete-project", "ab", "--yes"], projectToken)).toMatchObject({ code: 1, stderr: "error: needs the admin token (token from GIGS_TOKEN)\n" });
    expect(await cli(a.url, ["admin", "delete-project", "zz", "--yes"])).toMatchObject({ code: 1, stderr: "error: project zz not found\n" });
    expect((await cli(a.url, ["admin", "delete-project", "--yes"])).code).toBe(1);
    expect((await cli(a.url, ["admin", "export", "--yes"])).code).toBe(1);
    expect(a.store.listProjects().map((p) => p.prefix)).toEqual(["ab", "cd"]);

    const deleted = await cli(a.url, ["admin", "delete-project", "ab", "--yes"]);
    expect(deleted).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(deleted.stdout)).toEqual({ prefix: "ab", name: "Alpha", created_at: "2026-01-01T00:00:00.000Z" });
    expect(a.store.listProjects().map((p) => p.prefix)).toEqual(["cd"]);
    expect(a.store.tokenProject(projectToken)).toBeNull();
    a.store.createProject("ab");
    expect(await cli(a.url, ["admin", "delete-project", "ab", "--yes", "--human"])).toMatchObject({ code: 0, stdout: "deleted project ab (ab)\n" });
  });
});
