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
| `GIGS_TOKEN`             | unset (no auth)               | If set, clients must send `Authorization: Bearer` |
| `GIGS_CLAIM_TTL_MINUTES` | `60`                          | How long a claim lasts without activity           |

`GET /health` answers without a token. Set `GIGS_TOKEN` before binding to anything but localhost.

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

Add `Environment=GIGS_TOKEN=...` (etc.) under `[Service]` to configure it.

## Installing `gig`

From a checkout, after `bun install`, either run `bun link` (uses the `bin` entry in
`package.json`), or put a small launcher on your `PATH`, e.g. `~/.local/bin/gig`:

```sh
#!/usr/bin/env bash
exec bun "$HOME/src/gigs/src/cli.ts" "$@"
```

If you manage Bun with mise, pin the version in the launcher instead:
`exec "$HOME/.local/bin/mise" exec bun@1.4 -- bun "$HOME/src/gigs/src/cli.ts" "$@"`.
Don't add `-C <checkout>`: `gig` must run in the caller's directory to find its `.gigs.json`.

Client environment:

| Variable      | Default                 | Meaning                                  |
| ------------- | ----------------------- | ---------------------------------------- |
| `GIGS_URL`    | `http://127.0.0.1:7357` | Server to talk to                        |
| `GIGS_TOKEN`  | unset                   | Bearer token, if the server requires one |
| `GIG_ACTOR`   | `$USER`                 | Who you act as (also `--as <actor>`)     |
| `GIG_PROJECT` | nearest `.gigs.json`    | Project prefix (also `-P <prefix>`)      |

## Projects

Each repo maps to a project with a 2–3 character prefix; gig IDs are `<prefix>-<n>`.

```sh
cd my-repo
gig init ws --name "Web shop"   # creates the project if missing, else links it
```

This writes `.gigs.json` (`{"project": "ws"}`). Commit it: `gig` finds it by walking up from the
current directory, so everyone in the repo works on the same project.

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

A spec is an agreement (title and text) stored in Gigs; IDs are `<prefix>-s<n>`. Specs are optional
and can be edited any time with `gig spec update <id> [--title t] [-d text|-]`. A gig may point to
one spec of its own project; children don't inherit it. `--spec <id>` on `list`, `ready`, `blocked`
and `claim` limits them to gigs pointing to that spec, with readiness unchanged (a blocker outside
the spec still blocks). With `--spec`, the project comes from the spec id, so no `.gigs.json` is
needed.

Each spec starts at version 1. Every change saves a new numbered state and a compact history
entry; a no-op saves nothing. Gigs still point to the spec, not a particular version.
Use `gig spec edit` for exact text replacements: each `old` must be non-empty and occur exactly
once at that step. Edits run in order, all-or-nothing; `new` may be empty, but the final text may
not be empty. Full title/text replacement via `gig spec update` remains available.
`gig spec history <id>` shows the changes; `gig spec show <id> --version n` reads an older state.

```sh
gig spec create "Checkout v2" -d - < docs/checkout.md   # ws-s1
gig create "Payment API" --spec ws-s1
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
gig create <title> [-t type] [-p 0-4] [-d desc|-] [--parent id] [--blocked-by id[,id]] [--discovered-from id] [--spec id] [--label l[,l]] [--human-only]
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
gig spec create <title> -d text|-  gig spec show <id> [--version n] [--full]  gig spec list
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
  - `spec create`, `spec update`, `spec edit` and `spec list` print `{id, title, version}`;
    `spec show` prints `{id, title, version, text}`.
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
- File work you find but won't do with `--discovered-from <your gig>`.
- Never claim a human gig (`human: true`) unless a human tells you to. When you need a human
  decision, create a human gig that blocks your own (`--human-only`, then `gig dep add <yours> <new>`),
  release yours with `gig unclaim <yours>`, then stop or move on.
- An agent skill lives at [.agents/skills/gigs](.agents/skills/gigs); `gig skill` prints it, so any agent
  can read it or install it into its own skills directory.

## Development

```sh
bun install
bun run check    # tsc --noEmit && bun test
```
