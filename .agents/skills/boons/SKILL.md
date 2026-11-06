---
name: boons
description: Use Boons when a repo has a .boons.json, when the user mentions boons or bn, tickets/tasks to track, "what's next", or claiming work.
---

# Boons

Boons is a small, self-hosted system for tracking units of work for agents and humans.
Use the `bn` CLI to talk to its HTTP server; the server owns the SQLite database.

Read the repo's `GLOSSARY.md` if present. Use its vocabulary: a **boon** is tracked work; **ready** means open and unblocked with no deferred ancestor; a **blocker** must close first; a **parent** groups children (unfinished children block it); a **claim** is an exclusive, expiring hold; **deferred** means deliberately set aside.

## Identify yourself on every call

Pick a unique actor per agent session, such as `claude-auth` or `pi-auth`.
Parallel agents must use distinct names. Pass `BN_ACTOR=<name> bn …` or `bn … --as <name>` on **every** call: shells do not persist exports between tool calls. Replace the example actor below with your own.

## Pick up and finish work

```sh
BN_ACTOR=pi-auth bn ready
BN_ACTOR=pi-auth bn claim <id>
BN_ACTOR=pi-auth bn show <id>
# Do the work; leave progress and handoff notes.
BN_ACTOR=pi-auth bn comment <id> "Implemented X; checking Y next."
BN_ACTOR=pi-auth bn close <id> -r "Implemented X and verified Y."
```

Use `bn claim` without an id to atomically claim the next ready boon. Claim before starting; do not assume a listed boon is still available. On failure or stopping unfinished work, comment why and release it with `bn unclaim <id>` (using your actor on both calls).

Claims lapse after about 60 minutes without holder activity (server-configurable). Any update, comment, or link change by the holder renews the claim. During long work, run `BN_ACTOR=pi-auth bn heartbeat <id>` before it expires.

Always add `--json`, for example `BN_ACTOR=pi-auth bn ready --json`. It prints one line of compact JSON; null and empty fields are omitted:

- `list`, `ready`, and mutations print rows: `{id, title, type, priority, status, parent?, claimed_by?, claim_expires_at?, defer_until?, close_reason?}`. `close` with several ids prints an array. `blocked` adds `reasons`.
- `show` and `claim` add `description`, `ready`/`reasons` (open boons only), `parent` and unfinished relations as `{id, title, status}`, `closed` counts per relation, and `comments: [{author, at, body}]`. `claim` prints `null` when nothing is ready.

Add `--full` only when you need every field, such as timestamps or closed relations; with `--json` it prints the raw API response.

## File and connect work

Create boons with `bn create <title> -t <type> -p <priority> --parent <id> --blocked-by <id[,id]> --discovered-from <current-id>`; pass your actor and only the options that apply. Types are `bug`, `feature`, `task`, `epic`, `chore`; priorities run from 0 (critical) to 4 (backlog).

Use `-d -` for long descriptions through stdin:

```sh
BN_ACTOR=pi-auth bn create "Handle expired sessions" -t bug -p 2 --discovered-from <current-id> -d - <<'DESC'
Explain the observed behavior, expected behavior, and verification steps.
Reference the relevant spec document here.
DESC
```

Represent plans as boons connected by blockers. Keep specs as documents referenced in descriptions, not separate plan objects.

- Inspect blocked work: `BN_ACTOR=pi-auth bn blocked`.
- Add a blocker: `BN_ACTOR=pi-auth bn dep add <blocked-id> <blocker-id>`; remove it with `bn dep rm <blocked-id> <blocker-id>` and your actor.
- Use `--kind related` or `--kind discovered-from` with `bn dep add` / `bn dep rm` for informational links. The first id was discovered from the second.
- Revise fields: `BN_ACTOR=pi-auth bn update <id> --title "New title" -p 1`; use `-d -` for a replacement description, `--parent <id>` to move it, or `--parent none` to clear its parent.
- Set aside: `BN_ACTOR=pi-auth bn defer <id> --until 4h` (omit `--until` for indefinite deferral). Resume with `BN_ACTOR=pi-auth bn undefer <id>`.

## Troubleshoot

- `cannot reach boons server`: the server is not running. Start it with `bn serve`, or `systemctl --user start boons` on this machine. Do not restart or stop a running server or manipulate its database directly.
- No project: run `BN_ACTOR=pi-auth bn init <prefix>` in the repo to create/link the project and write `.boons.json`.
- Check `bn help` and `bn <command> --help` for exact syntax.
