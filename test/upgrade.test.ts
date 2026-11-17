import { afterAll, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, RELEASES, upgrade } from "../src/upgrade";
import { bunDescribe, bunTest } from "./harness";

// `gig upgrade` against a fake GitHub: the latest-release API, SHA256SUMS and the asset.
bunDescribe("gig upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "gigs-upgrade-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
  const NEW = "#!new binary\n";

  function github(latest: string, { sums = `${sha(NEW)}  gig-linux-arm64\n${sha("other")}  gig-linux-x64\n`, asset = NEW } = {}) {
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/releases/latest")) return Response.json({ tag_name: latest });
      if (url.endsWith("/SHA256SUMS")) return new Response(sums);
      if (url.endsWith("/gig-linux-arm64")) return new Response(asset);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  let n = 0;
  function binary() {
    const path = join(dir, `gig-${n++}`);
    writeFileSync(path, "#!old binary\n", { mode: 0o755 });
    return path;
  }
  const base = (execPath: string, gh: ReturnType<typeof github>) => ({ current: "v0.1.0", execPath, asset: "gig-linux-arm64", fetch: gh.fetch });

  bunTest("already on the latest release: nothing downloaded, nothing written", async () => {
    const path = binary();
    const gh = github("v0.1.0");
    expect(await upgrade(base(path, gh))).toEqual({ from: "v0.1.0", to: "v0.1.0", status: "up_to_date" });
    expect(gh.calls).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("#!old binary\n");
  });

  bunTest("a newer release replaces the binary with the verified asset, still executable", async () => {
    const path = binary();
    const gh = github("v0.2.0");
    expect(await upgrade(base(path, gh))).toEqual({ from: "v0.1.0", to: "v0.2.0", status: "upgraded" });
    expect(readFileSync(path, "utf8")).toBe(NEW);
    expect(statSync(path).mode & 0o111).toBe(0o111);
    expect(gh.calls).toContain(`${RELEASES}/download/v0.2.0/gig-linux-arm64`);
    expect(readdirSync(dir).filter((f) => f.includes(".upgrade-"))).toEqual([]);
  });

  bunTest("--check reports a newer release without downloading it", async () => {
    const path = binary();
    const gh = github("v0.2.0");
    expect(await upgrade({ ...base(path, gh), check: true })).toEqual({ from: "v0.1.0", to: "v0.2.0", status: "available" });
    expect(gh.calls).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("#!old binary\n");
  });

  bunTest("a given tag is installed without asking for the latest (also to go back)", async () => {
    const path = binary();
    const gh = github("v0.3.0");
    expect(await upgrade({ ...base(path, gh), current: "v0.3.0", tag: "v0.1.1" })).toMatchObject({ to: "v0.1.1", status: "upgraded" });
    expect(gh.calls.some((u) => u.endsWith("/releases/latest"))).toBe(false);
  });

  bunTest("a checksum mismatch, a missing SHA256SUMS entry or a missing release changes nothing", async () => {
    const path = binary();
    await expect(upgrade(base(path, github("v0.2.0", { asset: "tampered" })))).rejects.toThrow("checksum mismatch");
    await expect(upgrade(base(path, github("v0.2.0", { sums: `${sha(NEW)}  gig-darwin-arm64\n` })))).rejects.toThrow("no entry for gig-linux-arm64");
    await expect(upgrade({ ...base(path, github("v0.2.0")), asset: "gig-darwin-x64", tag: "v0.2.0", fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch })).rejects.toThrow("not found");
    expect(readFileSync(path, "utf8")).toBe("#!old binary\n");
    expect(readdirSync(dir).filter((f) => f.includes(".upgrade-"))).toEqual([]);
  });

  bunTest("a failed write leaves the old binary and no temp file", async () => {
    const path = join(dir, "missing-dir", "gig");
    await expect(upgrade(base(path, github("v0.2.0")))).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  bunTest("asset names match scripts/build.ts --all", () => {
    expect(assetName("linux", "x64")).toBe("gig-linux-x64");
    expect(assetName("darwin", "arm64")).toBe("gig-darwin-arm64");
    expect(() => assetName("win32", "x64")).toThrow("no gig release for win32-x64");
  });
});
