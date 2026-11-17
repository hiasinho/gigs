// Deploys the committed HEAD to Cloudflare through the Cloudflare API, for when there is no
// wrangler login: the Composio CLI's CLOUDFLARE_MCP_EXECUTE tool runs the API calls.
// With a wrangler login, `bunx wrangler deploy` does the same from wrangler.toml.
//
//   bun scripts/deploy.ts [--secret]
//
// Bundles with `wrangler deploy --dry-run` (from a clean `git archive HEAD`, so uncommitted changes
// never ship), uploads the module Worker with wrangler.toml's bindings, vars and pending DO
// migrations (keeping its secrets), turns workers.dev off, and attaches the custom domain(s).
// --secret also sets GIGS_ADMIN_TOKEN from ~/.config/gigs/admin-token (never printed).
// Account: CLOUDFLARE_ACCOUNT_ID, else ~/.config/gigs/cloudflare-account-id.
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import config from "../wrangler.toml";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || readAccountFile();
function readAccountFile(): string {
  try {
    return readFileSync(join(homedir(), ".config/gigs/cloudflare-account-id"), "utf8").trim();
  } catch {
    throw new Error("set CLOUDFLARE_ACCOUNT_ID or write it to ~/.config/gigs/cloudflare-account-id");
  }
}
const root = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "gigs-deploy-"));

function run(cmd: string[], cwd = root) {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${proc.stderr.toString()}${proc.stdout.toString()}`);
  return proc.stdout.toString();
}

try {
  // 1. Bundle HEAD.
  const src = join(tmp, "src");
  run(["mkdir", "-p", src]);
  run(["sh", "-c", `git archive HEAD | tar -x -C "${src}"`]);
  symlinkSync(join(root, "node_modules"), join(src, "node_modules"));
  const out = join(tmp, "dist");
  run([process.execPath, "x", "wrangler", "deploy", "--dry-run", "--outdir", out], src);
  const main = "worker.js";
  const modules = readdirSync(out)
    .filter((f) => f === main || f.endsWith(".html"))
    .map((name) => ({
      name,
      type: name === main ? "application/javascript+module" : "text/plain; charset=utf-8",
      content: readFileSync(join(out, name), "utf8"),
    }));

  // 2. What to upload, from wrangler.toml.
  const bindings = [
    ...config.durable_objects.bindings.map((b: { name: string; class_name: string }) => ({ type: "durable_object_namespace", name: b.name, class_name: b.class_name })),
    ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ type: "plain_text", name, text: String(text) })),
  ];
  const plan = {
    script: config.name as string,
    metadata: {
      main_module: main,
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags ?? [],
      bindings,
      keep_bindings: ["secret_text"],
    },
    migrations: config.migrations as { tag: string }[],
    domains: (config.routes as { pattern: string; custom_domain?: boolean }[]).filter((r) => r.custom_domain).map((r) => r.pattern),
    modules,
    secret: process.argv.includes("--secret") ? readFileSync(join(homedir(), ".config/gigs/admin-token"), "utf8").trim() : null,
  };

  // 3. The API calls, run by Composio in its sandbox (cloudflare.request, accountId).
  const code = `async () => {
  const plan = ${JSON.stringify(plan)};
  const base = \`/accounts/\${accountId}/workers\`;
  const scripts = (await cloudflare.request({ method: "GET", path: \`\${base}/scripts\` })).result;
  const current = scripts.find((s) => s.id === plan.script)?.migration_tag ?? null;
  const pending = plan.migrations.slice(current ? plan.migrations.findIndex((m) => m.tag === current) + 1 : 0);
  const metadata = { ...plan.metadata };
  if (pending.length) metadata.migrations = { old_tag: current ?? undefined, new_tag: pending.at(-1).tag, steps: pending.map(({ tag, ...step }) => step) };
  const b = "gigs-" + crypto.randomUUID();
  const part = (name, type, content, filename) => [\`--\${b}\`, \`Content-Disposition: form-data; name="\${name}"\` + (filename ? \`; filename="\${filename}"\` : ""), \`Content-Type: \${type}\`, "", content].join("\\r\\n");
  const body = [part("metadata", "application/json", JSON.stringify(metadata)), ...plan.modules.map((m) => part(m.name, m.type, m.content, m.name)), \`--\${b}--\`, ""].join("\\r\\n");
  const upload = await cloudflare.request({ method: "PUT", path: \`\${base}/scripts/\${plan.script}\`, body, contentType: \`multipart/form-data; boundary=\${b}\`, rawBody: true });
  const report = { uploaded: upload.success, etag: upload.result?.etag, migrations: metadata.migrations ?? null };
  if (plan.secret) {
    const s = await cloudflare.request({ method: "PUT", path: \`\${base}/scripts/\${plan.script}/secrets\`, body: { name: "GIGS_ADMIN_TOKEN", text: plan.secret, type: "secret_text" } });
    report.secret = s.success;
  }
  const attempt = async (o) => { try { const r = await cloudflare.request(o); return r.success ? (r.result ?? true) : r.errors; } catch (e) { return String(e).split("\\n")[0]; } };
  report.workers_dev = await attempt({ method: "POST", path: \`\${base}/scripts/\${plan.script}/subdomain\`, body: { enabled: false } });
  report.domains = [];
  for (const hostname of plan.domains) {
    const zone = (await cloudflare.request({ method: "GET", path: "/zones", query: { name: hostname.split(".").slice(-2).join(".") } })).result[0];
    report.domains.push(await attempt({ method: "PUT", path: \`\${base}/domains\`, body: { hostname, service: plan.script, zone_id: zone.id, environment: "production" } }));
  }
  return report;
}`;
  const payload = join(tmp, "payload.json");
  writeFileSync(payload, JSON.stringify({ code, account_id: ACCOUNT }), { mode: 0o600 });
  console.log(run(["composio", "execute", "CLOUDFLARE_MCP_EXECUTE", "-d", `@${payload}`]));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
