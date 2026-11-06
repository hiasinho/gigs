---
name: boons
description: Use Boons when a repo has a .boons.json, when the user mentions boons or bn, tickets/tasks to track, "what's next", or claiming work.
---

# Boons
Boons is a small, self-hosted ticket system; use `bn` to track work. A ticket is called a boon (ids like `bn-42`).
Pick a unique actor name per agent; parallel agents need different names.
Pass `BN_ACTOR=<name>` on **every** call: shells do not persist exports between calls.

## Work loop
```sh
BN_ACTOR=pi-auth bn ready             # what can be worked on now
BN_ACTOR=pi-auth bn claim [<id>]      # returns the boon: description, relations, comments
# Do the work, then record progress or verification.
BN_ACTOR=pi-auth bn comment <id> "Implemented X; verified Y."
BN_ACTOR=pi-auth bn close <id> -r "Implemented X and verified Y."
```

Claim before starting; `bn claim` without an id atomically picks the next ready boon (or prints `null`).
Use `bn show <id>` to read any other boon.
If stopping unfinished work, comment why, then `bn unclaim <id>`.
Claims lapse after about 60 minutes without holder activity (server-configurable).
Updates, comments and link changes renew your claim; use `bn heartbeat <id>` during long work.

## File work
Use `bn create <title> -t <type> -p <priority> --parent <id> --blocked-by <id[,id]> --discovered-from <current-id>` with only the options that apply.
Types: `bug`, `feature`, `task`, `epic`, `chore`; priorities: 0 (critical) to 4 (backlog).
Use `-d -` for a description from stdin:
```sh
BN_ACTOR=pi-auth bn create "Fix expired sessions" -t bug -p 2 -d - <<'DESC'
Describe the problem, expected behavior, and verification steps.
DESC
```

Other commands (always pass your actor): `list`, `blocked`, `projects`, `update <id> --title "New title" -p 1`, `reopen <id>`, `defer <id> [--until 4h]`, `undefer <id>`.
Use `dep add|rm <id> <blocker-id>` for blockers; `--kind related|discovered-from` for informational links.
See `bn help` or `bn <command> --help` for exact syntax.

Output is compact JSON by default: lists contain rows; `show` returns an object with description, relations and comments. Empty fields are omitted; `--full` returns raw API data. `--human` is for people. `bn skill` prints this markdown.

## Troubleshooting
- Server unreachable: check `BOONS_URL` and whether the server is running; `bn serve` starts one. Never restart/stop a running server or manipulate its database.
- No project: run `BN_ACTOR=<name> bn init <prefix>` in the repo to create/link it and write `.boons.json`.
