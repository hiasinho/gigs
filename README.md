# Boons

Boons is a small, self-hosted ticket system for coding agents (and the humans working with them).
It borrows ideas from [beads](https://github.com/gastownhall/beads), but runs as one HTTP server
with a SQLite database instead of living inside each repo, so agents in many checkouts share one
source of truth. The core is deliberately tiny: boons, blockers, parents, claims, comments.

## Requirements

- [Bun](https://bun.sh) 1.4 (the repo pins it in `mise.toml`). No runtime dependencies.

## Running the server

```sh
bun install
bun src/cli.ts serve
```

| Variable                  | Default                           | Meaning                                            |
| ------------------------- | --------------------------------- | -------------------------------------------------- |
| `BOONS_HOST`              | `127.0.0.1`                       | Address to listen on                               |
| `BOONS_PORT`              | `7357`                            | Port to listen on                                  |
| `BOONS_DB`                | `~/.local/share/boons/boons.db`   | SQLite file (its directory is created)             |
| `BOONS_TOKEN`             | unset (no auth)                   | If set, clients must send `Authorization: Bearer`  |
| `BOONS_CLAIM_TTL_MINUTES` | `60`                              | How long a claim lasts without activity            |

`GET /health` answers without a token. Set `BOONS_TOKEN` before binding to anything but localhost.

### As a systemd user service

Once `bn` is installed (below), `~/.config/systemd/user/boons.service`:

```ini
[Unit]
Description=Boons server (bn serve)

[Service]
ExecStart=%h/.local/bin/bn serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now boons
journalctl --user -u boons -f
```

Add `Environment=BOONS_TOKEN=...` (etc.) under `[Service]` to configure it.

## Installing `bn`

From a checkout, after `bun install`, either run `bun link` (uses the `bin` entry in
`package.json`), or put a small launcher on your `PATH`, e.g. `~/.local/bin/bn`:

```sh
#!/usr/bin/env bash
exec bun "$HOME/src/boons/src/cli.ts" "$@"
```

If you manage Bun with mise, pin the version in the launcher instead:
`exec "$HOME/.local/bin/mise" exec bun@1.4 -- bun "$HOME/src/boons/src/cli.ts" "$@"`.
Don't add `-C <checkout>`: `bn` must run in the caller's directory to find its `.boons.json`.

Client environment:

| Variable      | Default                  | Meaning                                         |
| ------------- | ------------------------ | ----------------------------------------------- |
| `BOONS_URL`   | `http://127.0.0.1:7357`  | Server to talk to                               |
| `BOONS_TOKEN` | unset                    | Bearer token, if the server requires one        |
| `BN_ACTOR`    | `$USER`                  | Who you act as (also `--as <actor>`)            |
| `BN_PROJECT`  | nearest `.boons.json`    | Project prefix (also `-P <prefix>`)             |

## Projects

Each repo maps to a project with a 2–3 character prefix; boon IDs are `<prefix>-<n>`.

```sh
cd my-repo
bn init ws --name "Web shop"   # creates the project if missing, else links it
```

This writes `.boons.json` (`{"project": "ws"}`). Commit it: `bn` finds it by walking up from the
current directory, so everyone in the repo works on the same project.

## Core concepts

See [GLOSSARY.md](GLOSSARY.md) for the exact vocabulary.

- **Status** is `open`, `in_progress` (claimed), `deferred`, or `closed`.
- **Blockers**: "A blocks B" means B can't be ready until A is closed.
- **Parent**: a boon has at most one. Unfinished children block their parent; a parent's blockers
  also block all its descendants.
- **Ready** = open and not blocked and not under a deferred ancestor. **Blocked** is derived,
  never set by hand; `bn blocked` shows why.
- **Claims** are exclusive and lapse after `BOONS_CLAIM_TTL_MINUTES` without activity by the
  holder (any update, comment, link change, or `bn heartbeat` renews). Anyone may `unclaim` or
  `close` a boon: the server trusts its clients.
- **Deferred** boons are never ready until `bn undefer`, or until their `--until` time passes.

## Specs

A spec is an agreement (title and text) stored in Boons; IDs are `<prefix>-s<n>`. Specs are optional
and can be edited any time with `bn spec update <id> [--title t] [-d text|-]`. A boon may point to
one spec of its own project; children don't inherit it. `--spec <id>` on `list`, `ready`, `blocked`
and `claim` limits them to boons pointing to that spec, with readiness unchanged (a blocker outside
the spec still blocks). With `--spec`, the project comes from the spec id, so no `.boons.json` is
needed.

Each spec starts at version 1. Every change saves a new numbered state and a compact history
entry; a no-op saves nothing. Boons still point to the spec, not a particular version.
Use `bn spec edit` for exact text replacements: each `old` must be non-empty and occur exactly
once at that step. Edits run in order, all-or-nothing; `new` may be empty, but the final text may
not be empty. Full title/text replacement via `bn spec update` remains available.
`bn spec history <id>` shows the changes; `bn spec show <id> --version n` reads an older state.

```sh
bn spec create "Checkout v2" -d - < docs/checkout.md   # ws-s1
bn create "Payment API" --spec ws-s1
bn ready --spec ws-s1
bn claim --spec ws-s1
bn spec edit ws-s1 --old "Payment API" --new "Payments API"
printf '%s' '[{"old":"Checkout","new":"Checkout v2"}]' | bn spec edit ws-s1 -
bn spec history ws-s1
bn spec show ws-s1 --version 1
```

## Workflow

```sh
bn create "Checkout v2" -t epic -p 1                                  # ws-1
bn create "Design payment API" -t task --parent ws-1                  # ws-2
bn create "Implement payment API" -t feature --parent ws-1 --blocked-by ws-2   # ws-3
bn ready                 # ws-2 (ws-3 waits for ws-2, ws-1 for its children)
bn claim                 # claims the next ready boon: ws-2
bn comment ws-2 "schema drafted"
echo "Cart total is off by one cent" | bn create "Rounding bug" -t bug -p 0 -d - --discovered-from ws-2
bn close ws-2 -r "API spec in docs/payments.md"
bn ready                 # ws-4, then ws-3
```

## Commands

```
bn serve                          bn init <prefix> [--name <name>]       bn projects
bn create <title> [-t type] [-p 0-4] [-d desc|-] [--parent id] [--blocked-by id[,id]] [--discovered-from id] [--spec id]
bn list [--all] [--status s[,s]] [--type t] [--parent id] [--spec id]
bn ready [--spec id]              bn blocked [--spec id]                 bn show <id> [--full]
bn update <id> [--title t] [-d desc|-] [-t type] [-p n] [--parent id|none] [--spec id|none]
bn dep add|rm <id> <target-id> [--kind blocks|related|discovered-from]   # default: target blocks id
bn claim [id] [--spec id]         bn unclaim <id>                        bn heartbeat <id>
bn close <id...> [-r reason] [--force]                                   bn reopen <id>
bn defer <id> [--until <ISO time|YYYY-MM-DD|30m|4h|2d>]                  bn undefer <id>
bn comment <id> <text|->                                                 bn skill
bn spec create <title> -d text|-  bn spec show <id> [--version n] [--full]  bn spec list
bn spec update <id> [--title t] [-d text|-]
bn spec edit <id> --old text --new text   bn spec edit <id> -   # JSON array [{old,new}] on stdin
bn spec history <id>
```

Types: `bug`, `feature`, `task`, `epic`, `chore`. Priority: `0` (critical) to `4` (backlog), default 2.
`bn show <id>` is compact; `bn show <id> --full` prints the raw API response, including timestamps and closed relations.
Output is compact JSON by default (see [For agents](#for-agents)). Use `--human` for human-readable text,
or `bn show <id> --human --full` for the complete text view.
`bn help`, `bn <command> --help`, `bn skill`, and the server startup line remain plain text.
`bn close --force` closes a parent despite unfinished children (they stay open).
`bn help` and `bn <command> --help` have the details.

## For agents

- Output defaults to one line of compact JSON with null and empty fields omitted:
  - `list`, `ready` and mutations (`create`, `update`, `close`, `defer`, `dep add`, ...) print rows:
    `{id, title, type, priority, status, parent?, spec?, claimed_by?, claim_expires_at?, defer_until?, close_reason?}`
    (`close` with several ids prints an array); `blocked` adds `reasons: [{kind, id, via?}]`.
  - `show` and `claim` print the boon with `description`, `ready`/`reasons` (open boons only),
    claim/close fields, `parent` and relations as `{id, title, status}` (unfinished only), `closed`
    counts per relation, and `comments: [{author, at, body}]`. `claim` prints `null` if nothing is ready.
  - `comment` prints `{boon_id, author, at, body}`.
  - `spec create`, `spec update`, `spec edit` and `spec list` print `{id, title, version}`;
    `spec show` prints `{id, title, version, text}`.
  - `spec history` prints ascending `{version, by, at, kind, title?, text?, edits?}` entries:
    changed titles are included, full text updates use `text: "replaced"`, and edits include
    the `{old,new}` replacements.
- Add `--full` to get the raw API response instead (all fields, nested `{boon, ...}` for `show`).
- Give every agent a unique actor name and pass `BN_ACTOR=claude-docs bn …` on every call,
  since claims are per actor and shells do not persist exports between calls.
- Long tasks: run `bn heartbeat <id>` (or comment) more often than the claim TTL, or the claim
  lapses and someone else may pick the boon up.
- File work you find but won't do with `--discovered-from <your boon>`.
- An agent skill lives at [.agents/skills/boons](.agents/skills/boons); `bn skill` prints it, so any agent
  can read it or install it into its own skills directory.

## Development

```sh
bun install
bun run check    # tsc --noEmit && bun test
```
