// Child process for test/multiprocess.test.ts: opens the shared DB file, waits for
// the go-file (so all claimers start together), then claims until nothing is ready.
// Writes <go-file>.<actor> once the store is open, then prints the claimed ids as a JSON array on stdout.
import { existsSync, writeFileSync } from "node:fs";
import { BunSql } from "../../src/sql-bun";
import { Store } from "../../src/store";

const [path, goFile, actor] = process.argv.slice(2);
if (!path || !goFile || !actor) throw new Error("usage: claimer.ts <db-path> <go-file> <actor>");

const store = new Store({ sql: new BunSql(path) });
writeFileSync(`${goFile}.${actor}`, "");
while (!existsSync(goFile)) await Bun.sleep(1);

const claimed: string[] = [];
for (let gig = store.claimNext("gig", actor); gig; gig = store.claimNext("gig", actor)) {
  claimed.push(gig.id);
  // Yield briefly, like an agent doing work. In a tight loop one process re-takes the
  // write lock before the others' busy handlers wake, so it would claim everything alone.
  await Bun.sleep(1);
}
store.dispose();
console.log(JSON.stringify(claimed));
