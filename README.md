# Gigs

Gigs is a small, self-hosted ticket system for coding agents (and the humans working with them).
It borrows ideas from [beads](https://github.com/gastownhall/beads), but runs as one HTTP server
with a SQLite database instead of living inside each repo, so agents in many checkouts share one
source of truth. The core is deliberately tiny: gigs, blockers, parents, claims, comments.

## Requirements

- [Bun](https://bun.sh) 1.4 (the repo pins it in `mise.toml`). No runtime dependencies.

## Running the server

```sh
bun install
bun src/cli.ts serve
```

| Variable                 | Default                       | Meaning                                           |
| ------------------------ | ----------------------------- | ------------------------------------------------- |
| `GIGS_HOST`              | `127.0.0.1`                   | Address to listen on                              |
| `GIGS_PORT`              | `7357`                        | Port to listen on                                 |
| `GIGS_DB`                | `~/.local/share/gigs/gigs.db` | SQLite file (its directory is created)            |
| `GIGS_ADMIN_TOKEN`       | unset (auth off)              | Admin token; setting it turns auth on (see below) |
| `GIGS_CLAIM_TTL_MINUTES` | `60`                          | How long a claim lasts without activity           |

Set `GIGS_ADMIN_TOKEN` before binding to anything but localhost. The server no longer reads
`GIGS_TOKEN`; it refuses to start if that is set without `GIGS_ADMIN_TOKEN`.

### Auth

Auth is one switch for the whole server, never per project:

- **Off** (no `GIGS_ADMIN_TOKEN`): no tokens anywhere, for localhost or a tailnet.
- **On**: every request except `GET /health` and the UI page at `/` needs
  `Authorization: Bearer <token>`. The admin token can do everything. A **project token** reads and
  writes its own project only: every gig, spec, comment, label, dep and claim call, including ids in
  the body or query (`--parent`, `--blocked-by`, `--spec`, link targets, ...), must stay inside it,
  else `403 forbidden`. Related gigs in other projects show only their id. Listing projects with a
  project token returns just its own project. Creating projects and managing tokens need the admin
  token. `GET /health` says `{"ok":true,"auth":true}`. The UI page asks for a token with a sign-in
  form and keeps it in the browser until you sign out.

A project can have several tokens (rotate: add a new one, then revoke the old). They are stored
hashed and shown once, on creation. With the admin token in `GIGS_TOKEN`:

```sh
gig init ws --name "Web shop"   # creates ws and writes its first token into .gigs.local.json
gig token add --label ci        # prints {id, project, label, created_at, token}; the only time you see it
gig token list                  # [{id, project, label?, created_at, revoked_at?}], never the token
gig token revoke 3
```

Everyone holding a project's token is trusted: the token says which project, not who, so the actor
(`GIG_ACTOR` / `--as`) stays self-declared.

### As a systemd user service

Once `gig` is installed (below), `~/.config/systemd/user/gigs.service`:

```ini
[Unit]
Description=Gigs server (gig serve)

[Service]
ExecStart=%h/.local/bin/gig serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now gigs
journalctl --user -u gigs -f
```

Add `Environment=GIGS_ADMIN_TOKEN=...` (etc.) under `[Service]` to configure it.

### On Cloudflare (Workers + Durable Objects)

A second, always-on target (`wrangler.toml`, `src/worker.ts`): the Worker forwards every request to
one SQLite-backed Durable Object that holds the whole database and serves the same API. Auth is
always on there; requests are refused (503) until the `GIGS_ADMIN_TOKEN` secret is set.
`GIGS_CLAIM_TTL_MINUTES` is a var in `wrangler.toml`. Hosted at `https://gigs.strapivo.dev`.

```sh
bunx wrangler deploy                          # with a wrangler login
bunx wrangler secret put GIGS_ADMIN_TOKEN
bun scripts/deploy.ts [--secret]              # without one: the same through the Cloudflare API via Composio
```

`scripts/deploy.ts` deploys the committed `HEAD` and, with `--secret`, sets the admin token from
`~/.config/gigs/admin-token`.

To move a whole database between servers (either kind), with the admin token: `GET /admin/export`
returns `{version, tables: {<table>: [rows]}}` (schema version, every row as stored), and
`POST /admin/import` with that body loads it in one transaction, keeping ids, counters, timestamps
and claims. Import refuses (409) unless the target has no rows and the same schema version; it
answers `{version, tables: {<table>: <rows imported>}}`.

**This setup runs on the hosted server.** Since gig-14 the whole database lives at
`https://gigs.strapivo.dev`; the local service is stopped and disabled (its unit file and
`~/.local/share/gigs/gigs.db` are kept as a fallback). The launcher (below) sets `GIGS_DEFAULT_URL` to the
hosted server, and each repo's binding carries its project token. To fall back to local:
`systemctl --user start gigs` and run `gig` with `GIGS_URL=http://127.0.0.1:7357` (the local
database is as of the cutover; move newer data back with export/import).

## Installing `gig`

From a checkout, after `bun install`, either run `bun link` (uses the `bin` entry in
`package.json`), or put a small launcher on your `PATH`, e.g. `~/.local/bin/gig`:

```sh
#!/usr/bin/env bash
exec bun "$HOME/src/gigs/src/cli.ts" "$@"
```

If you manage Bun with mise, pin the version in the launcher instead:
`exec "$HOME/.local/bin/mise" exec bun@1.4 -- bun "$HOME/src/gigs/src/cli.ts" "$@"`.
To talk to a hosted server by default, add `export GIGS_DEFAULT_URL=https://gigs.strapivo.dev`
before the `exec` line (a binding's `"url"` and an explicit `GIGS_URL` still win; don't set
`GIGS_URL` in the launcher, as that would override every binding).
Don't add `-C <checkout>`: `gig` must run in the caller's directory to find its binding.

Client environment:

| Variable           | Default                     | Meaning                                        |
| ------------------ | --------------------------- | ---------------------------------------------- |
| `GIGS_URL`         | the binding's `"url"`       | Server to talk to                              |
| `GIGS_DEFAULT_URL` | `http://127.0.0.1:7357`     | Server when neither env nor binding names one  |
| `GIGS_TOKEN`       | the binding's `"token"`     | Bearer token (project or admin), if auth is on |
| `GIG_ACTOR`        | `$USER`                     | Who you act as (also `--as <actor>`)           |
| `GIG_PROJECT`      | the binding's `"project"`   | Project prefix (also `-P <prefix>`)            |

Server and token lookup, first wins: environment (`GIGS_URL`, `GIGS_TOKEN`), then
`.gigs.local.json`, then `.gigs.json`, then `GIGS_DEFAULT_URL`, then the built-in default. When the
server rejects a token (401 or 403), the error names where it came from, e.g. `(token from
GIGS_TOKEN, which overrides /repo/.gigs.local.json)`: a `GIGS_TOKEN` left over from another repo
overrides this directory's binding.

## Projects

Each repo maps to a project with a 2–3 character prefix; gig IDs are `<prefix>-<n>`.

```sh
cd my-repo
gig init ws --name "Web shop"   # creates the project if missing, else binds to it
```

This writes the directory's **binding**: `.gigs.json` (`{"project": "ws", "url": "..."}`; `"url"`
only when the server isn't the built-in default). Commit it: `gig` finds the nearest one by walking
up from the current directory, so everyone in the repo works on the same project on the same server.
When auth is on and you run `gig init` with the admin token, it also writes a new project token to
`.gigs.local.json` next to it (`{"token": "..."}`) and, in a git repo, adds `.gigs.local.json` to
`.gitignore`. Every agent shell then just works, with no environment setup (direnv hooks don't run
in non-interactive shells); re-running `init` keeps the token. Values in `.gigs.local.json`
override those in `.gigs.json`. An older `.gigs.json` that carries `"token"` itself keeps working;
re-running `init` moves the token to `.gigs.local.json`.

## Core concepts

See [GLOSSARY.md](GLOSSARY.md) for the exact vocabulary.

- **Status** is `open`, `in_progress` (claimed), `deferred`, or `closed`.
- **Blockers**: "A blocks B" means B can't be ready until A is closed.
- **Parent**: a gig has at most one. Unfinished children block their parent; a parent's blockers
  also block all its descendants. `--parent <id>` means two things: on `list`, the direct children
  only; on `ready` and `claim`, the whole subtree (children, grandchildren, ...), never the gig
  itself, with readiness unchanged (a blocker outside the subtree still blocks).
- **Ready** = open and not blocked and not under a deferred ancestor. **Blocked** is derived,
  never set by hand; `gig blocked` shows why.
- **Claims** are exclusive and lapse after `GIGS_CLAIM_TTL_MINUTES` without activity by the
  holder (any update, comment, link change, or `gig heartbeat` renews). Anyone may `unclaim` or
  `close` a gig: the server trusts its clients.
- **Deferred** gigs are never ready until `gig undefer`, or until their `--until` time passes.
  `gig create --defer [--until t]` files a gig already deferred, so it is never claimable in between.
- **Labels** are free-form markers such as `wontfix` or `triage:needs-info`: lowercase letters,
  digits, `.`, `_`, `:` and `-`, starting with a letter or digit, up to 50 characters. They are inert:
  they never change ready, blocked or claiming, but `list`, `ready` and `claim` (no id) can filter by them
  (`--label a,b`: all present; `--exclude-label a,b`: none present). Adding a present label or
  removing a missing one is a no-op; labels work on gigs of any status, closed included.
- **Human gigs** are worked only by a human. `gig claim` without an id (whatever its filters) never
  hands one out and picks the next ready non-human gig instead. Otherwise they are like any gig:
  they show in `ready`, anyone may claim one by id, they block and are blocked, and claims lapse.
  Set with `gig create --human-only`, change with `gig update --human-only` / `--no-human-only` (any
  status; counts as activity). `gig list --human-only` and `gig ready --human-only` show the human's queue.

## Specs

A spec is a temporary agreement (title and text) stored in Gigs, from which gigs are created; IDs
are `<prefix>-s<n>`. Specs are optional and can be edited any time with
`gig spec update <id> [--title t] [-d text|-]`. A gig may point to
one spec of its own project; children don't inherit it. `--spec <id>` on `list`, `ready`, `blocked`
and `claim` limits them to gigs pointing to that spec, with readiness unchanged (a blocker outside
the spec still blocks). With `--spec`, the project comes from the spec id, so no `.gigs.json` is
needed.

### Spec status

| Status   | Set by                                                      | New gig may point to it |
| -------- | ----------------------------------------------------------- | ----------------------- |
| `draft`  | default on `spec create`; `spec reopen`                     | no (`spec_draft`)       |
| `ready`  | `gig spec ready <id>`, once the owner says the spec is final | yes                     |
| `active` | derived: the spec has at least one unfinished gig           | yes                     |
| `done`   | derived: the spec has gigs and all are closed               | no (`spec_done`)        |
| `closed` | `gig spec close <id> -r <reason>` (abandoned)               | no (`spec_closed`)      |

Only draft, ready and closed are stored; active and done are derived from the spec's gigs at read
time, so they never go stale. A spec with gigs is active or done whatever was set by hand, except
closed, which always wins. Deferred gigs count as unfinished.

- The server checks the status whenever a gig is pointed at a spec: `gig create --spec` and
  `gig update --spec` to a different spec. Clearing (`--spec none`) and re-setting the gig's current
  spec are always allowed; `--spec` filters on `list`, `ready`, `blocked` and `claim` accept any status.
  Refusals are 409s: `spec_draft` ("mark it ready first: gig spec ready X"), `spec_done` ("link the new
  gig with --discovered-from <gig> instead"), `spec_closed` ("reopen it first (gig spec reopen X) or file
  the gig without --spec").
- Work found while the spec is active (a follow-up) may still point to it and keeps it active. Once it
  is done, link follow-ups with `--discovered-from` instead. `gig reopen` of one of its closed gigs is
  the intentional way back to active.
- `gig spec close` needs a reason and is refused (`spec_active`) while the spec has unfinished gigs:
  close them or clear their spec first. A done spec can be closed. `gig spec reopen` undoes a close
  and sets the stored state back to draft (mark it ready once more if it still is); a spec with gigs
  then derives active or done again.
- `gig spec ready` on a closed spec is refused (`spec_closed`); on a ready spec it is a no-op.
- Status changes are not content: they bump no version and add no history entry.
- `gig spec list` shows draft, ready and active specs; `--all` adds done and closed.

Each spec starts at version 1. Every change to its title or text saves a new numbered state and a compact history
entry; a no-op saves nothing. Gigs still point to the spec, not a particular version.
Use `gig spec edit` for exact text replacements: each `old` must be non-empty and occur exactly
once at that step. Edits run in order, all-or-nothing; `new` may be empty, but the final text may
not be empty. Full title/text replacement via `gig spec update` remains available.
`gig spec history <id>` shows the changes; `gig spec show <id> --version n` reads an older state.

```sh
gig spec create "Checkout v2" -d - < docs/checkout.md   # ws-s1, draft
gig spec ready ws-s1                                    # final: gigs may point to it
gig create "Payment API" --spec ws-s1                   # ws-s1 is now active
gig ready --spec ws-s1
gig claim --spec ws-s1
gig spec edit ws-s1 --old "Payment API" --new "Payments API"
printf '%s' '[{"old":"Checkout","new":"Checkout v2"}]' | gig spec edit ws-s1 -
gig spec history ws-s1
gig spec show ws-s1 --version 1
```

## Workflow

```sh
gig create "Checkout v2" -t epic -p 1                                  # ws-1
gig create "Design payment API" -t task --parent ws-1                  # ws-2
gig create "Implement payment API" -t feature --parent ws-1 --blocked-by ws-2   # ws-3
gig ready                 # ws-2 (ws-3 waits for ws-2, ws-1 for its children)
gig claim                 # claims the next ready gig: ws-2
gig comment ws-2 "schema drafted"
echo "Cart total is off by one cent" | gig create "Rounding bug" -t bug -p 0 -d - --discovered-from ws-2
gig close ws-2 -r "API spec in docs/payments.md"
gig ready                 # ws-4, then ws-3
```

`gig claim` without an id takes the same filters as `gig ready` (`--spec`, `--parent`, `--label`,
`--exclude-label`; all must match) and claims the first gig `ready` would list, skipping human gigs:

```sh
gig claim --label ready-for-agent             # only gigs someone marked as fit for an agent
gig claim --parent ws-1 --exclude-label big   # next ready gig anywhere under the epic ws-1
```

An agent waiting on a human decision files the question as a human gig that blocks its own gig,
releases its claim, then stops or moves on. The human answers in a comment and closes it; the agent's gig is ready again.

```sh
gig create "Which payment provider?" --human-only -d "Stripe or Adyen? Context in ws-3."   # ws-5
gig dep add ws-3 ws-5     # ws-5 blocks ws-3
gig unclaim ws-3          # without this, ws-3 stays claimed until the claim lapses
gig ready --human-only    # the human's queue: ws-5
gig comment ws-5 "Stripe." --as alice && gig close ws-5 --as alice   # ws-3 becomes ready again
```

## Commands

```
gig serve                          gig init <prefix> [--name <name>]       gig projects
gig token add [--label x]          gig token list                          gig token revoke <id>
gig create <title> [-t type] [-p 0-4] [-d desc|-] [--parent id] [--blocked-by id[,id]] [--discovered-from id] [--spec id] [--label l[,l]] [--human-only] [--defer] [--until t]
gig list [--all] [--status s[,s]] [--type t] [--parent id] [--spec id] [--label l[,l]] [--exclude-label l[,l]] [--human-only]   # --parent: direct children
gig ready [--spec id] [--parent id] [--label l[,l]] [--exclude-label l[,l]] [--human-only]   # --parent: whole subtree
gig blocked [--spec id]            gig show <id> [--full]
gig update <id> [--title t] [-d desc|-] [-t type] [-p n] [--parent id|none] [--spec id|none] [--add-label l[,l]] [--remove-label l[,l]] [--human-only|--no-human-only]
gig edit <id> --old text --new text   gig edit <id> -   # JSON array [{old,new}] on stdin
gig dep add|rm <id> <target-id> [--kind blocks|related|discovered-from]   # default: target blocks id
gig label add|rm <id> <label...>
gig claim [id]                     gig unclaim <id>                        gig heartbeat <id>
gig claim [--spec id] [--parent id] [--label l[,l]] [--exclude-label l[,l]]   # next ready non-human gig, filtered like ready
gig close <id...> [-r reason] [--force]                                   gig reopen <id>
gig defer <id> [--until <ISO time|YYYY-MM-DD|30m|4h|2d>]                  gig undefer <id>
gig comment <id> <text|->                                                 gig skill
gig spec create <title> -d text|-  gig spec show <id> [--version n] [--full]  gig spec list [--all]
gig spec ready <id>                gig spec close <id> -r reason          gig spec reopen <id>
gig spec update <id> [--title t] [-d text|-]
gig spec edit <id> --old text --new text   gig spec edit <id> -   # JSON array [{old,new}] on stdin
gig spec history <id>
```

Types: `bug`, `feature`, `task`, `epic`, `chore`. Priority: `0` (critical) to `4` (backlog), default 2.
`gig show <id>` is compact; `gig show <id> --full` prints the raw API response, including timestamps and closed relations.
Output is compact JSON by default (see [For agents](#for-agents)). Use `--human` for human-readable text,
or `gig show <id> --human --full` for the complete text view.
`gig help`, `gig <command> --help`, `gig skill`, and the server startup line remain plain text.
`gig edit` changes a gig's description by exact replacement, with the same rules as `gig spec edit`
(each `old` non-empty and found exactly once, in order, all-or-nothing); the description may end up
empty. Prefer it over rewriting with `update -d`: an edit based on a stale read fails instead of
silently dropping someone else's change. Text starting with `-` needs `--old=<text>`.
`gig close --force` closes a parent despite unfinished children (they stay open).
`gig help` and `gig <command> --help` have the details.

## For agents

- Output defaults to one line of compact JSON with null and empty fields omitted:
  - `list`, `ready` and mutations (`create`, `update`, `edit`, `close`, `defer`, `dep add`, ...) print rows:
    `{id, title, type, priority, status, parent?, spec?, labels?, human?, claimed_by?, claim_expires_at?, defer_until?, close_reason?}`
    (`human: true` only on human gigs)
    (`close` with several ids prints an array); `blocked` adds `reasons: [{kind, id, via?}]`.
  - `show` and `claim` print the gig with `labels?`, `human?`, `description`, `ready`/`reasons` (open gigs only),
    claim/close fields, `parent` and relations as `{id, title, status}` (unfinished only), `closed`
    counts per relation, and `comments: [{author, at, body}]`. `claim` prints `null` if nothing is ready.
  - `comment` prints `{gig_id, author, at, body}`.
  - `token list` and `token revoke` print `{id, project, label?, created_at, revoked_at?}`; `token add` adds
    `token`. `init` prints the project, plus `token_id` when it wrote a new token.
  - `spec create`, `spec update`, `spec edit`, `spec ready`, `spec close`, `spec reopen` and `spec list`
    print `{id, title, version, status, close_reason?}`; `spec show` prints the same plus `text`.
  - `spec history` prints ascending `{version, by, at, kind, title?, text?, edits?}` entries:
    changed titles are included, full text updates use `text: "replaced"`, and edits include
    the `{old,new}` replacements.
- Add `--full` to get the raw API response instead (all fields, nested `{gig, ...}` for `show`).
- Give every agent a unique actor name and pass `GIG_ACTOR=claude-docs gig …` on every call,
  since claims are per actor and shells do not persist exports between calls.
- Long tasks: run `gig heartbeat <id>` (or comment) more often than the claim TTL, or the claim
  lapses and someone else may pick the gig up.
- Narrow what you pick up with `gig claim --label ready-for-agent` or `gig claim --parent <epic>`
  (the whole subtree under it); a filter that matches nothing prints `null`.
- File work you find but won't do with `--discovered-from <your gig>`, before you close your gig: while
  the spec is active, the follow-up may also take `--spec`; once it is done, the server refuses that.
- A done or closed spec is history: the code is the source of truth, not the spec text.
- Never claim a human gig (`human: true`) unless a human tells you to. When you need a human
  decision, create a human gig that blocks your own (`--human-only`, then `gig dep add <yours> <new>`),
  release yours with `gig unclaim <yours>`, then stop or move on.
- An agent skill lives at [.agents/skills/gigs](.agents/skills/gigs); `gig skill` prints it, so any agent
  can read it or install it into its own skills directory.

## Development

```sh
bun install
bun run check    # tsc --noEmit && bun test && bun run test:do
```

The store talks SQL through a small synchronous interface ([src/sql.ts](src/sql.ts)) with two adapters:
bun:sqlite ([src/sql-bun.ts](src/sql-bun.ts), the server's) and a Durable Object's SQLite storage
([src/sql-do.ts](src/sql-do.ts)). `bun run test:do` runs the store-level tests inside workerd against a real
Durable Object (vitest with `@cloudflare/vitest-plugin`; tests open databases through `test/harness.ts`),
and the HTTP API tests through the Worker entry end to end (`test/http.ts`, `test/do/worker-entry.ts`). The HTTP handler ([src/handler.ts](src/handler.ts))
is runtime-neutral; [src/server.ts](src/server.ts) (Bun, the only importer of sql-bun) and
[src/worker.ts](src/worker.ts) (Cloudflare) are its two entries.
