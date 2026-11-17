// Compiles the CLI into one self-contained executable (Bun runtime included; ui.html and the
// agent skill are embedded). `bun scripts/build.ts [--out <file>]` builds dist/gig (or <file>) for
// this machine; `--all` cross-compiles dist/gig-<os>-<arch> for every release target.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

const { values } = parseArgs({ options: { all: { type: "boolean" }, out: { type: "string" } } });
const builds = values.all ? TARGETS.map((t) => [`--target=bun-${t}`, `dist/gig-${t}`]) : [[undefined, values.out ? resolve(values.out) : "dist/gig"]];
for (const [target, out] of builds) {
  await $`bun build --compile --minify ${target ? [target] : []} src/cli.ts --outfile ${out!}`.cwd(`${import.meta.dir}/..`).quiet();
  console.log(out);
}
