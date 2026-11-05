import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";

const CLAIMER = join(import.meta.dir, "fixtures", "claimer.ts");
const PROCESSES = 4;
const BOONS = 100;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boons-multiproc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test(
  "separate processes claiming from one DB file never claim the same boon",
  async () => {
    const path = join(dir, "boons.db");
    const goFile = join(dir, "go");
    const seed = new Store({ path });
    seed.createProject("bn");
    for (let i = 0; i < BOONS; i++) seed.createBoon("bn", "seed", { title: `boon ${i}` });
    seed.dispose();

    // Start every process before awaiting any; they block on the go-file so they race together.
    const procs = Array.from({ length: PROCESSES }, (_, i) =>
      Bun.spawn([process.execPath, CLAIMER, path, goFile, `agent-${i}`], { stdout: "pipe", stderr: "pipe" }),
    );
    // Wait until every process has opened the store, then release them all at once.
    while (!procs.every((_, i) => existsSync(`${goFile}.agent-${i}`))) {
      if (procs.some((p) => p.exitCode !== null)) break; // a crashed claimer fails below
      await Bun.sleep(5);
    }
    writeFileSync(goFile, "");

    const perProcess = await Promise.all(
      procs.map(async (proc) => {
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(err).toBe("");
        expect(code).toBe(0);
        return JSON.parse(out) as string[];
      }),
    );

    const all = perProcess.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(Array.from({ length: BOONS }, (_, i) => `bn-${i + 1}`).sort());
    // The claimers really interleaved: more than one process got work.
    expect(perProcess.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);

    const check = new Store({ path });
    expect(check.ready("bn")).toEqual([]);
    check.dispose();
  },
  15_000,
);
