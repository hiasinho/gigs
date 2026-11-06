---
name: boons
description: Boons ticket system via `bn` CLI. Use when repo has .boons.json, or user mentions boons/bn, tickets, tasks to track, what's next, claiming work.
---

# Boons (`bn`)
Ticket system. Ticket = boon, id like `bn-42`.
Every call: `bn … --as <you>`. Pick a random name once per session (e.g. `a7f3c9`), reuse it.
Output: JSON, empty fields omitted; `--full` = all fields. Syntax: `bn help`, `bn <cmd> --help`.

## Loop
```
bn ready                  # claimable now
bn claim [id]             # no id = next ready; returns boon (description, relations, comments) or null
# work
bn comment <id> "<text>"
bn close <id> [-r "<reason>"]
```
`bn unclaim <id>` releases a claim.
Claim lapses after ~60 min without your activity; comment/update/link renews; long work: `bn heartbeat <id>`.

## File work
```
bn create "<title>" -t bug|feature|task|epic|chore -p 0-4 [--parent id] [--blocked-by id,id] [--discovered-from id] [-d text|-]
```
p0 critical … p4 backlog, default 2. `-d -` reads stdin (heredoc for long text).

## Other
`show <id>` · `list [--all]` · `blocked` · `update <id> [--title t] [-d text|-] [-t type] [-p n] [--parent id|none]` · `dep add|rm <id> <blocker-id> [--kind related|discovered-from]` · `defer <id> [--until 4h|2d|YYYY-MM-DD]` · `undefer <id>` · `reopen <id>`

## Trouble
- unreachable: server down or wrong `BOONS_URL`; tell the user.
- no project: `bn init <prefix>` (2-3 chars) in repo root (writes `.boons.json`).
