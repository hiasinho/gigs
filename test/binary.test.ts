import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunDescribe, bunTest } from "./harness";

// The compiled `gig` (scripts/build.ts), run from a directory with no checkout around it: the
// embedded files must be inside the binary, and it must work as client and server.
bunDescribe("gig as a single binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "gigs-binary-"));
  const gig = join(dir, "gig");
  let server: ReturnType<typeof Bun.spawn> | undefined;
  afterAll(() => {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) =>
    ({ PATH: process.env.PATH, HOME: dir, GIG_ACTOR: "bin", ...extra }) as Record<string, string>;

  async function run(args: string[], extra?: Record<string, string>) {
    const proc = Bun.spawn([gig, ...args], { cwd: dir, env: env(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  beforeAll(async () => {
    const build = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/build.ts"), "--out", gig, "--version", "v9.9.9"], { stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`);
  }, 60_000);

  bunTest("the build's --version is baked in; a checkout says dev and refuses to upgrade", async () => {
    expect((await run(["--version"])).stdout.trim()).toBe("v9.9.9");
    expect(JSON.parse((await run(["version"])).stdout)).toEqual({ version: "v9.9.9" });
    const checkout = (args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { cwd: dir, env: env(), stdout: "pipe", stderr: "pipe" });
    expect(checkout(["--version"]).stdout.toString().trim()).toBe("dev");
    const refused = checkout(["upgrade"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("git pull");
  });

  bunTest("`gig skill` prints the embedded skill", async () => {
    const { stdout, code } = await run(["skill"]);
    expect(code).toBe(0);
    expect(stdout).toBe(readFileSync(join(import.meta.dir, "../.agents/skills/gigs/SKILL.md"), "utf8"));
  });

  bunTest("`gig serve` serves the embedded UI and the API, and the binary is its own client", async () => {
    const port = String(20000 + Math.floor(Math.random() * 20000));
    const url = `http://127.0.0.1:${port}`;
    server = Bun.spawn([gig, "serve"], { cwd: dir, env: env({ GIGS_PORT: port, GIGS_DB: join(dir, "gigs.db") }), stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) break;
      await Bun.sleep(100);
    }
    const page = await fetch(`${url}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(readFileSync(join(import.meta.dir, "../src/ui.html"), "utf8")).toBe(await page.text());

    expect((await run(["init", "bb"], { GIGS_URL: url })).code).toBe(0);
    const created = await run(["create", "from the binary"], { GIGS_URL: url });
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ id: "bb-1", title: "from the binary" });
  });
});
