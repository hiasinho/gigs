# Gigs

Gigs is a small, self-hosted ticket system for coding agents and the humans who work with them.
It borrows ideas from [beads](https://github.com/gastownhall/beads). Beads keeps its data inside
each repo. Gigs runs as one HTTP server with one SQLite database, so agents in many checkouts share
one source of truth. The core has five parts: gigs, blockers, parents, claims and comments.

## Requirements

Running from a checkout needs [Bun](https://bun.sh) 1.4. The repo pins it in `mise.toml`. Gigs has
no runtime dependencies. The release binaries need no Bun, see [As a single binary](#as-a-single-binary).

## Running the server

```sh
bun install
bun src/cli.ts serve
```

| Variable                 | Default                       | Meaning                                                |
| ------------------------ | ----------------------------- | ------------------------------------------------------ |
| `GIGS_HOST`              | `127.0.0.1`                   | Address to listen on                                   |
| `GIGS_PORT`              | `7357`                        | Port to listen on                                      |
| `GIGS_DB`                | `~/.local/share/gigs/gigs.db` | SQLite file. The server creates its directory.         |
| `GIGS_ADMIN_TOKEN`       | unset, so auth is off         | Admin token. Setting it turns auth on, see [Auth](#auth). |
| `GIGS_CLAIM_TTL_MINUTES` | `60`                          | How long a claim lasts without activity                |

Set `GIGS_ADMIN_TOKEN` before the server listens on any address other than localhost. The server
no longer reads `GIGS_TOKEN`. It refuses to start if `GIGS_TOKEN` is set and `GIGS_ADMIN_TOKEN` is not.

### Auth

Auth is one switch for the whole server. It is never set per project.

- **Off.** Without `GIGS_ADMIN_TOKEN`, no request needs a token. Use this on localhost or a tailnet.
- **On.** Every request except `GET /health` and the UI page at `/` needs
  `Authorization: Bearer <token>`. `GET /health` returns `{"ok":true,"auth":true}`.

With auth on, there are two kinds of token:

- The **admin token** can do everything. Only the admin token can create projects and manage tokens.
- A **project token** reads and writes its own project only. This covers every gig, spec, comment,
  label, dep and claim call. Ids in the body or the query must belong to that project too, for
  example in `--parent`, `--blocked-by`, `--spec` and link targets. Any other id gets
  `403 forbidden`. Related gigs in other projects show only their id. Listing projects with a
  project token returns only its own project.

The UI page asks for a token in a sign-in form. The browser keeps the token until you sign out.

A project can have several tokens. To rotate a token, add a new one, then revoke the old one. The
server stores tokens hashed and shows each token once, when it is created. With the admin token in
`GIGS_TOKEN`:

```sh
gig init ws --name "Web shop"   # creates ws and writes its first token into .gigs.local.json
gig token add --label ci        # prints {id, project, label, created_at, token}; the only time the token is shown
gig token list                  # [{id, project, label?, created_at, revoked_at?}], never the token
gig token revoke 3
```

Everyone who holds a project's token is trusted. The token names a project, not a person, so the
actor stays self-declared. The actor comes from `GIG_ACTOR` or `--as`.

### As a systemd user service

Once `gig` is installed, see [Installing `gig`](#installing-gig), create
`~/.config/systemd/user/gigs.service`:

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

To configure the server, add lines such as `Environment=GIGS_ADMIN_TOKEN=...` under `[Service]`.

### On Cloudflare Workers and Durable Objects

Gigs also runs on Cloudflare, configured in `wrangler.toml` and `src/worker.ts`. This target is
always on. The Worker forwards every request to one Durable Object backed by SQLite. That Durable
Object holds the whole database and serves the same API. Auth is always on there. The Worker
refuses requests with 503 until the `GIGS_ADMIN_TOKEN` secret is set. `GIGS_CLAIM_TTL_MINUTES` is a
var in `wrangler.toml`. The hosted instance is at `https://gigs.strapivo.dev`.

```sh
bunx wrangler deploy                          # with a wrangler login
bunx wrangler secret put GIGS_ADMIN_TOKEN
bun scripts/deploy.ts [--secret]              # without a wrangler login: the Cloudflare API through Composio
```

`scripts/deploy.ts` deploys the committed `HEAD` to the Cloudflare account named in
`CLOUDFLARE_ACCOUNT_ID`. Without that variable, it reads the account id from
`~/.config/gigs/cloudflare-account-id`. With `--secret`, it also sets the admin token from
`~/.config/gigs/admin-token`.

To back up a whole database, or move it to another server of either kind, set `GIGS_URL` to the
server and put the admin token in `GIGS_TOKEN`. The server refuses a binding's project token here.

```sh
GIGS_URL=<from> GIGS_TOKEN=<admin token> gig admin export > dump.json
GIGS_URL=<to>   GIGS_TOKEN=<admin token> gig admin import dump.json   # or `-` for stdin
```

The dump has the form `{version, tables: {<table>: [rows]}}`. `version` is the schema version, and
each table holds every row as stored. Import loads the dump in one transaction and keeps ids,
counters, timestamps and claims. It prints the number of rows imported per table. Import refuses
unless the target database has no rows and the same schema version. Over HTTP, these commands are
`GET /admin/export` and `POST /admin/import`. Import returns 409 when the target is not empty or
has another schema version.

To delete a project for good, use the admin token. The delete removes everything in the project:
gigs, specs, labels, comments and tokens. It also removes the links and parents in other projects
that point into it.

```sh
GIGS_TOKEN=<admin token> gig admin delete-project bn --yes   # refuses without --yes; prints the deleted project
```

Over HTTP, this is `DELETE /projects/<prefix>` with the admin token, in one transaction. A project
token gets 403, and an unknown project gets 404.

Gigs tracks its own work on the hosted server. Since gig-14, the whole database lives at
`https://gigs.strapivo.dev`. The local service is stopped and disabled. Its unit file and
`~/.local/share/gigs/gigs.db` stay as a fallback. The launcher, described in
[From a checkout](#from-a-checkout), sets `GIGS_DEFAULT_URL` to the hosted server, and each repo's
binding carries its project token.

To fall back to the local server, run `systemctl --user start gigs` and run `gig` with
`GIGS_URL=http://127.0.0.1:7357`. The local database holds the data as of the cutover. To move newer
data back, export it from the hosted server with `gig admin export`. Import needs an empty database,
so move the local `gigs.db` aside. Then run `gig admin import` against the local server.

## Installing `gig`

### As a single binary

Each [GitHub release](https://github.com/hiasinho/gigs/releases) has one executable per platform.
Each executable is about 100 MB because it includes the Bun runtime. The UI page and the agent skill
are embedded in it. The machine needs no checkout and no Bun.

```sh
curl -fsSL https://raw.githubusercontent.com/hiasinho/gigs/main/install.sh | sh
gig upgrade                     # later: install the latest release (--check only reports)
```

`install.sh` picks the asset for this machine, one of `gig-linux-x64`, `gig-linux-arm64`,
`gig-darwin-x64` and `gig-darwin-arm64`. It checks the download against the release's `SHA256SUMS`
and installs it to `~/.local/bin/gig`. To install a given release, set `GIG_VERSION=v0.1.0`. To
install to another directory, set `GIG_INSTALL_DIR`. Set both on `sh`, for example
`curl ... | GIG_VERSION=v0.1.0 sh`.

`gig version` prints the release tag. `gig upgrade <tag>` installs a given release, which also goes
back to an older one. `gig upgrade` checks every download against the release's `SHA256SUMS`. To
talk to a hosted server by default, set `GIGS_DEFAULT_URL` in your shell profile, see
[From a checkout](#from-a-checkout). `gig skill` prints the agent skill. To install the skill, run
`mkdir -p ~/.claude/skills/gigs && gig skill > ~/.claude/skills/gigs/SKILL.md`. The binary also
runs the server with `gig serve`.

To build the binaries, run `bun run build`, which compiles `dist/gig` for this machine.
`bun scripts/build.ts --all` cross-compiles `dist/gig-{linux,darwin}-{x64,arm64}`. `--version <tag>`
bakes the tag in. Without it, the binary says `dev`. When you push a tag that starts with `v`,
`.github/workflows/release.yml` tests, builds and publishes the release.

### From a checkout

After `bun install`, run `bun link`, which uses the `bin` entry in `package.json`. Or put a small
launcher on your `PATH`, for example at `~/.local/bin/gig`:

```sh
#!/usr/bin/env bash
exec bun "$HOME/src/gigs/src/cli.ts" "$@"
```

If you manage Bun with mise, pin the version in the launcher instead:

```sh
exec "$HOME/.local/bin/mise" exec bun@1.4 -- bun "$HOME/src/gigs/src/cli.ts" "$@"
```

To talk to a hosted server by default, add `export GIGS_DEFAULT_URL=https://gigs.strapivo.dev`
before the `exec` line. A binding's `"url"` and an explicit `GIGS_URL` still take precedence. Don't
set `GIGS_URL` in the launcher, because it would override every binding. Don't add
`-C <checkout>` either. `gig` must run in the caller's directory to find its binding.

The client reads these variables:

| Variable           | Default                     | Meaning                                         |
| ------------------ | --------------------------- | ----------------------------------------------- |
| `GIGS_URL`         | the binding's `"url"`       | Server to talk to                               |
| `GIGS_DEFAULT_URL` | `http://127.0.0.1:7357`     | Server when neither env nor binding names one   |
| `GIGS_TOKEN`       | the binding's `"token"`     | Bearer token, project or admin, when auth is on |
| `GIG_ACTOR`        | see the actor lookup below  | Who you act as, also `--as <actor>`             |
| `GIG_PROJECT`      | the binding's `"project"`   | Project prefix, also `-P <prefix>`              |

The client looks up the actor in this order and uses the first value it finds:

1. `--as`
2. `GIG_ACTOR`
3. `"actor"` in `.gigs.local.json`. This file is per checkout. The client never reads the actor
   from the committed `.gigs.json`.
4. `git config user.name`
5. `$USER`
6. `"unknown"`

The client skips blank values. Git only runs when a command writes, so reads start no git process.
`gig whoami` prints the actor and its source, for example `{"actor":"impl-a","source":"GIG_ACTOR"}`.
The sources are `--as`, `GIG_ACTOR`, `.gigs.local.json`, `git`, `USER` and `default`. `gig whoami`
needs no server.

The client looks up the server and the token in this order, and the first one found wins: the
environment variables `GIGS_URL` and `GIGS_TOKEN`, then `.gigs.local.json`, then `.gigs.json`, then
`GIGS_DEFAULT_URL`, then the built-in default. When the server rejects a token with 401 or 403, the
error says where the token came from, for example
`(token from GIGS_TOKEN, which overrides /repo/.gigs.local.json)`. This catches a `GIGS_TOKEN` left
over from another repo, which overrides the binding of the current directory.

## Projects

Each repo maps to a project with a prefix of 2 or 3 characters. Gig ids are `<prefix>-<n>`.

```sh
cd my-repo
gig init ws --name "Web shop"   # creates the project if missing, else binds to it
```

`gig init` writes the directory's **binding**, the file `.gigs.json`, for example
`{"project": "ws", "url": "..."}`. It writes `"url"` only when the server isn't the built-in
default. Commit the binding. `gig` walks up from the current directory to the nearest `.gigs.json`,
so everyone in the repo works on the same project on the same server.

When auth is on, `gig init` also writes a project token to `.gigs.local.json` next to the binding,
as `{"token": "..."}`. In a git repo, it adds `.gigs.local.json` to `.gitignore`. With the admin
token, `gig init` creates a new project token. With a project token in `GIGS_TOKEN`, it writes that
token. It never writes the admin token. Every agent shell then works with no environment setup.
This matters because direnv hooks don't run in non-interactive shells.

Running `gig init` again keeps the binding's token for that project while the server accepts it. A
revoked or invalid token gets replaced the same way as a missing one. Values in `.gigs.local.json`
override those in `.gigs.json`. An older `.gigs.json` that holds `"token"` itself keeps working.
Running `gig init` again moves that token to `.gigs.local.json`.

## Core concepts

See [GLOSSARY.md](GLOSSARY.md) for the exact vocabulary.

- **Status** is `open`, `in_progress`, `deferred` or `closed`. A claimed gig is `in_progress`.
- **Blockers.** "A blocks B" means B can't be ready until A is closed.
- **Parent.** A gig has at most one parent. Unfinished children block their parent, and a parent's
  blockers also block all its descendants. `--parent <id>` has two meanings. On `list`, it selects
  the direct children only. On `ready` and `claim`, it selects the whole subtree: children,
  grandchildren and further down, never the gig itself. Readiness is unchanged, so a blocker outside
  the subtree still blocks.
- **Ready** means open, not blocked and not under a deferred ancestor. **Blocked** is derived and
  never set by hand. `gig blocked` shows why a gig is blocked.
- **Claims** are exclusive. A claim lapses after `GIGS_CLAIM_TTL_MINUTES` without activity by the
  holder. Any update, comment, link change or `gig heartbeat` renews it. Anyone may `unclaim` or
  `close` a gig, because the server trusts its clients.
- **Deferred** gigs are never ready until someone runs `gig undefer` or their `--until` time
  passes. `gig create --defer [--until t]` files a gig that is already deferred, so no agent can
  claim it between creation and deferral.
- **Labels** are free-form markers such as `wontfix` or `triage:needs-info`. A label uses lowercase
  letters, digits, `.`, `_`, `:` and `-`, starts with a letter or digit, and has at most 50
  characters. Labels never change ready, blocked or claiming. `list`, `ready` and `claim` without an
  id can filter by them. `--label a,b` requires all of the labels, and `--exclude-label a,b` requires
  none of them. Adding a label that is present, or removing one that is missing, does nothing.
  Labels work on gigs of any status, including closed.
- **Human gigs** are worked only by a human. `gig claim` without an id never hands one out, whatever
  its filters, and picks the next ready non-human gig instead. Otherwise a human gig is like any gig.
  It shows in `ready`, anyone may claim it by id, it blocks and is blocked, and its claims lapse. Set
  it with `gig create --human-only`. Change it with `gig update --human-only` or `--no-human-only` on
  a gig of any status. The change counts as activity. `gig list --human-only` and
  `gig ready --human-only` show the human's queue.

## Specs

A spec is a temporary agreement stored in Gigs, with a title and a text. Gigs are created from it.
Spec ids are `<prefix>-s<n>`. Specs are optional. You can edit a spec at any time with
`gig spec update <id> [--title t] [-d text|-]`. A gig may point to one spec of its own project.
Children don't inherit the spec. `--spec <id>` on `list`, `ready`, `blocked` and `claim` limits them
to gigs that point to that spec. Readiness is unchanged, so a blocker outside the spec still blocks.
With `--spec`, the project comes from the spec id, so no `.gigs.json` is needed.

### Spec status

| Status   | Set by                                                       | New gig may point to it |
| -------- | ------------------------------------------------------------ | ----------------------- |
| `draft`  | default on `spec create`; `spec reopen`                      | no, `spec_draft`        |
| `ready`  | `gig spec ready <id>`, once the owner says the spec is final | yes                     |
| `active` | derived: the spec has at least one unfinished gig            | yes                     |
| `done`   | derived: the spec has gigs and all are closed                | no, `spec_done`         |
| `closed` | `gig spec close <id> -r <reason>`, for an abandoned spec     | no, `spec_closed`       |

Only draft, ready and closed are stored. Active and done are derived from the spec's gigs when the
spec is read, so they never go stale. A spec with gigs is active or done, whatever status was set by
hand. The exception is closed, which always wins. Deferred gigs count as unfinished.

- The server checks the status whenever a gig is pointed at a spec. That happens on
  `gig create --spec`, and on `gig update --spec` to a different spec. Clearing the spec with
  `--spec none` is always allowed, and so is setting the gig's current spec again. The `--spec`
  filters on `list`, `ready`, `blocked` and `claim` accept any status. Refusals are 409s:
  - `spec_draft` says "mark it ready first: gig spec ready X".
  - `spec_done` says "link the new gig with --discovered-from <gig> instead".
  - `spec_closed` says "reopen it first (gig spec reopen X) or file the gig without --spec".
- A follow-up is work found while the spec is active. It may still point to the spec, and it keeps
  the spec active. Once the spec is done, link follow-ups with `--discovered-from` instead. Running
  `gig reopen` on one of the spec's closed gigs is the intended way back to active.
- `gig spec close` needs a reason. The server refuses it with `spec_active` while the spec has
  unfinished gigs. Close those gigs or clear their spec first. A done spec can be closed.
  `gig spec reopen` undoes a close and sets the stored status back to draft. Mark the spec ready
  again if it is still final. A spec with gigs then derives active or done again.
- The server refuses `gig spec ready` on a closed spec with `spec_closed`. On a ready spec,
  `gig spec ready` does nothing.
- Status changes are not content changes. They bump no version and add no history entry.
- `gig spec list` shows draft, ready and active specs. `--all` adds done and closed specs.

Each spec starts at version 1. Every change to its title or text saves a new numbered version and a
compact history entry. An update that changes nothing saves nothing. Gigs point to the spec, not to
a particular version.

Use `gig spec edit` for exact text replacements. Each `old` must be non-empty and must occur exactly
once at its step. Edits run in order, and either all of them apply or none does. `new` may be empty,
but the final text may not. `gig spec update` still replaces the whole title or text.
`gig spec history <id>` shows the changes, and `gig spec show <id> --version n` reads an older
version.

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

`gig claim` without an id takes the same filters as `gig ready`: `--spec`, `--parent`, `--label`
and `--exclude-label`. All filters must match. It claims the first gig that `ready` would list and
skips human gigs:

```sh
gig claim --label ready-for-agent             # only gigs someone marked as fit for an agent
gig claim --parent ws-1 --exclude-label big   # next ready gig anywhere under the epic ws-1
```

When an agent needs a human decision, it files the question as a human gig that blocks its own gig.
It releases its claim, then stops or moves on to other work. The human answers in a comment and
closes the human gig. The agent's gig is then ready again.

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
gig whoami                         gig version                            gig upgrade [<tag>] [--check]
```

Types are `bug`, `feature`, `task`, `epic` and `chore`. Priority runs from `0`, critical, to `4`,
backlog. The default priority is 2.

`gig show <id>` prints a compact view. `gig show <id> --full` prints the raw API response, including
timestamps and closed relations. Output is compact JSON by default, see [For agents](#for-agents).
Add `--human` for readable text, or use `gig show <id> --human --full` for the complete text view.
`gig help`, `gig <command> --help`, `gig skill` and the server startup line are always plain text.

`gig edit` changes a gig's description by exact replacement. It follows the same rules as
`gig spec edit`. Each `old` is non-empty and found exactly once, edits run in order, and either all
of them apply or none does. The description may end up empty. Prefer `gig edit` over rewriting with
`update -d`. An edit based on a stale read fails, while a rewrite drops someone else's change without
warning. Text that starts with `-` needs `--old=<text>`.

`gig close --force` closes a parent that has unfinished children. The children stay open.
`gig help` and `gig <command> --help` have the details.

## For agents

- Output defaults to one line of compact JSON. Null and empty fields are left out.
  - `list`, `ready` and mutations such as `create`, `update`, `edit`, `close`, `defer` and `dep add`
    print rows of this shape:
    `{id, title, type, priority, status, parent?, spec?, labels?, human?, claimed_by?, claim_expires_at?, defer_until?, close_reason?}`.
    `human: true` appears only on human gigs. `close` with several ids prints an array. `blocked`
    adds `reasons: [{kind, id, via?}]`.
  - `show` and `claim` print the gig with `labels?`, `human?` and `description`. For open gigs they
    add `ready` and `reasons`. They also print the claim and close fields, `parent`, the unfinished
    relations as `{id, title, status}`, `closed` counts per relation, and
    `comments: [{author, at, body}]`. `claim` prints `null` if nothing is ready.
  - `comment` prints `{gig_id, author, at, body}`.
  - `token list` and `token revoke` print `{id, project, label?, created_at, revoked_at?}`.
    `token add` adds `token`. `init` prints the project, plus `token_id` when it wrote a new token.
  - `spec create`, `spec update`, `spec edit`, `spec ready`, `spec close`, `spec reopen` and
    `spec list` print `{id, title, version, status, close_reason?}`. `spec show` prints the same
    fields plus `text`.
  - `spec history` prints entries in ascending order as
    `{version, by, at, kind, title?, text?, edits?}`. Changed titles are included. Full text
    updates show `text: "replaced"`, and edits list their `{old,new}` replacements.
- Add `--full` to get the raw API response instead, with all fields. For `show`, the response is
  nested as `{gig, ...}`.
- Give every agent a unique actor name and pass it on every call, as in `GIG_ACTOR=claude-docs gig …`.
  Claims are per actor, and shells do not keep exported variables between calls.
- On long tasks, run `gig heartbeat <id>` or comment more often than `GIGS_CLAIM_TTL_MINUTES`.
  Otherwise the claim lapses and another agent may pick up the gig.
- Narrow what you pick up with `gig claim --label ready-for-agent`, or with
  `gig claim --parent <epic>` for the whole subtree under the epic. A filter that matches nothing
  prints `null`.
- Before you close your gig, file work you find but won't do with `--discovered-from <your gig>`.
  While the spec is active, the follow-up may also take `--spec`. Once the spec is done, the server
  refuses that.
- A done or closed spec is history. The code is the source of truth, not the spec text.
- Never claim a human gig, one with `human: true`, unless a human tells you to. When you need a
  human decision, create a human gig with `--human-only` and make it block your own with
  `gig dep add <yours> <new>`. Release yours with `gig unclaim <yours>`, then stop or move on.
- The agent skill is at [.agents/skills/gigs](.agents/skills/gigs). `gig skill` prints it, so any
  agent can read it or install it into its own skills directory.

## Development

```sh
bun install
bun run check    # tsc --noEmit && bun test && bun run test:do
git config core.hooksPath .githooks   # once per clone: gitleaks refuses commits containing secrets
```

Tokens never go in git. A repo's token lives in `.gigs.local.json`, which is gitignored. On every
push, CI runs gitleaks over the whole history, with an extra rule for `gig_` tokens in
`.gitleaks.toml`.

Gigs is licensed MIT, see [LICENSE](LICENSE). The vendored skills in `.agents/skills`, other than
`gigs` and `unslop`, come from [mattpocock/skills](https://github.com/mattpocock/skills), also MIT,
see [LICENSE-mattpocock-skills](.agents/skills/LICENSE-mattpocock-skills).

The store talks SQL through a small synchronous interface, [src/sql.ts](src/sql.ts), with two
adapters. [src/sql-bun.ts](src/sql-bun.ts) uses bun:sqlite and is the server's adapter.
[src/sql-do.ts](src/sql-do.ts) uses a Durable Object's SQLite storage.

`bun run test:do` runs the store tests inside workerd against a real Durable Object, using vitest
with `@cloudflare/vitest-plugin`. Tests open databases through `test/harness.ts`. `bun run test:do`
also runs the HTTP API tests end to end through the Worker entry, in `test/http.ts` and
`test/do/worker-entry.ts`.

The HTTP handler, [src/handler.ts](src/handler.ts), is runtime-neutral and has two entries.
[src/server.ts](src/server.ts) is the Bun entry and the only file that imports sql-bun.
[src/worker.ts](src/worker.ts) is the Cloudflare entry.
