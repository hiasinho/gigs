// The Bun entry: `gig serve` over a bun:sqlite file. The only module that imports sql-bun.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHandler as createApiHandler, type HandlerOptions } from "./handler";
import { BunSql } from "./sql-bun";
import { Store, validClaimTtl } from "./store";

const UI_PATH = new URL("./ui.html", import.meta.url).pathname;

/** The API handler, serving ui.html from disk at `GET /`. */
export function createHandler(store: Store, options: HandlerOptions = {}) {
  return createApiHandler(store, { ui: () => Bun.file(UI_PATH), ...options });
}

export interface ServerConfig {
  host: string;
  port: number;
  db: string;
  adminToken?: string;
  claimTtlMinutes: number;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const port = Number(env.GIGS_PORT ?? 7357);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid GIGS_PORT: ${env.GIGS_PORT}`);
  const claimTtlMinutes = Number(env.GIGS_CLAIM_TTL_MINUTES || 60);
  if (!validClaimTtl(claimTtlMinutes)) throw new Error(`invalid GIGS_CLAIM_TTL_MINUTES: ${env.GIGS_CLAIM_TTL_MINUTES}`);
  // The server used to read GIGS_TOKEN; starting without auth when it is still set would silently open it up.
  if (env.GIGS_TOKEN && !env.GIGS_ADMIN_TOKEN) {
    throw new Error("the server no longer reads GIGS_TOKEN; set GIGS_ADMIN_TOKEN instead (auth is on whenever it is set)");
  }
  return {
    host: env.GIGS_HOST || "127.0.0.1",
    port,
    db: env.GIGS_DB || join(homedir(), ".local/share/gigs/gigs.db"),
    adminToken: env.GIGS_ADMIN_TOKEN || undefined,
    claimTtlMinutes,
  };
}

export function serve(config: ServerConfig) {
  mkdirSync(dirname(config.db), { recursive: true });
  const store = new Store({ sql: new BunSql(config.db), claimTtlMinutes: config.claimTtlMinutes });
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createHandler(store, { adminToken: config.adminToken }),
  });
}
