// `gig upgrade`: replaces the running compiled binary with a release from GitHub (hiasinho/gigs).
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** The release tag baked in by `scripts/build.ts --version <tag>` (bun build --define); "dev" otherwise. */
export const VERSION: string = typeof GIGS_VERSION === "string" ? GIGS_VERSION : "dev";

export const RELEASES = "https://github.com/hiasinho/gigs/releases";
const LATEST_API = "https://api.github.com/repos/hiasinho/gigs/releases/latest";

/** Running as a `bun build --compile` binary (its modules live in Bun's embedded /$bunfs), not from a checkout. */
export const isCompiled = () => Bun.main.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/.test(Bun.main);

/** The release asset for this machine, as named by scripts/build.ts --all. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  const os = { linux: "linux", darwin: "darwin" }[platform];
  const cpu = { x64: "x64", arm64: "arm64" }[arch];
  if (!os || !cpu) throw new Error(`no gig release for ${platform}-${arch}`);
  return `gig-${os}-${cpu}`;
}

export interface UpgradeOptions {
  current: string;
  /** The binary to replace (process.execPath). */
  execPath: string;
  asset: string;
  /** A tag to install instead of the latest release (also to go back). */
  tag?: string;
  /** Only report; never download or write. */
  check?: boolean;
  fetch?: typeof fetch;
}

export type UpgradeResult = { from: string; to: string; status: "up_to_date" | "available" | "upgraded" };

export async function upgrade({ current, execPath, asset, tag, check, fetch: get = fetch }: UpgradeOptions): Promise<UpgradeResult> {
  const ok = async (url: string) => {
    const res = await get(url, { headers: { "user-agent": "gig-upgrade" } });
    if (!res.ok) throw new Error(res.status === 404 ? `not found: ${url}` : `${url}: HTTP ${res.status}`);
    return res;
  };
  const to = tag ?? String(((await (await ok(LATEST_API)).json()) as { tag_name?: unknown }).tag_name ?? "");
  if (!to) throw new Error("the latest release has no tag");
  if (to === current) return { from: current, to, status: "up_to_date" };
  if (check) return { from: current, to, status: "available" };

  const base = `${RELEASES}/download/${encodeURIComponent(to)}`;
  const sums = await (await ok(`${base}/SHA256SUMS`)).text();
  const want = sums.split("\n").map((l) => l.trim().split(/\s+\*?/)).find(([, name]) => name === asset)?.[0];
  if (!want) throw new Error(`${to}: SHA256SUMS has no entry for ${asset}`);
  const bytes = new Uint8Array(await (await ok(`${base}/${asset}`)).arrayBuffer());
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== want.toLowerCase()) throw new Error(`${to}/${asset}: checksum mismatch (got ${got}, want ${want}); nothing changed`);

  // Next to the binary (same file system), then rename over it: atomic, and fine while it runs.
  const tmp = `${execPath}.upgrade-${process.pid}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, execPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { from: current, to, status: "upgraded" };
}
