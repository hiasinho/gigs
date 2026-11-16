---
name: boons
description: Boons ticket system via `bn` CLI. Use when repo has .boons.json, or user mentions boons/bn, tickets, track this, what's next, claiming work, resume after compaction.
---

# Boons (`bn`)
Ticket system. Ticket = boon, id like `bn-42`.
Use for work that outlives this session or others pick up; in-session steps → your own todo list.
Every call: `bn … --as <you>`. Pick a meaningful name once per session, unique among agents (short suffix helps, e.g. `auth-refactor-3f9a`), reuse it.
Output: JSON, empty fields omitted; `--full` = all fields. Syntax: `bn help`, `bn <cmd> --help`.

## Loop
```
bn ready                  # claimable now
bn claim [id]             # no id = next ready; returns boon (description, relations, comments) or null
bn claim --label ready-for-agent --parent <epic>   # no id: same filters as ready (--spec/--label/--exclude-label/--parent)
# work
bn comment <id> "<text>"   # as you go: survives compaction, lets others resume
bn close <id> [-r "<reason>"]
```
`--parent <id>` on `ready`/`claim` = whole subtree (not the boon itself); on `list` = direct children only.
`bn unclaim <id>` releases a claim.
Claim lapses after ~60 min without your activity; comment/update/link renews; long work: `bn heartbeat <id>`.
Lost track (compaction/new session): `bn list --status in_progress`, yours by `claimed_by`, then `bn show <id>`.

## File work
```
bn create "<title>" -t bug|feature|task|epic|chore -p 0-4 [--parent id] [--blocked-by id,id] [--discovered-from id] [-d text|-]
```
p0 critical … p4 backlog, default 2. `-d -` reads stdin (heredoc for long text).

## Edit descriptions
Small change → `edit`, not a full `update -d` rewrite: stale edits fail instead of clobbering others' changes.
```
bn edit <id> --old text --new text   # old must occur exactly once; `--old=- x` if text starts with -
bn edit <id> -                       # JSON array [{old,new}] on stdin; in order, all-or-nothing
```

## Specs
Spec = agreement (title + text), id like `bn-s3`.
```
bn spec show <id> [--version n] # {id,title,version,text}
bn spec history <id>
bn spec edit <id> --old text --new text
bn spec edit <id> -       # JSON array [{old,new}] on stdin
bn spec list
bn spec create "<title>" -d text|-
bn spec update <id> [--title t] [-d text|-]
```
`--spec <id>` on `create`, `update` (`none` clears), `list`, `ready`, `blocked`, `claim` (no id): only boons of that spec; project comes from the spec id.

## Labels
Free-form markers (lowercase, no spaces; `a-z0-9._:-`), e.g. `wontfix`, `triage:needs-info`. Inert: never affect ready/blocked/claim.
```
bn label add|rm <id> <label...>                        # no-op if already present/missing; any status
bn update <id> --add-label a --remove-label b          # swap in one call
bn create "<title>" --label a,b
bn list|ready|claim --label a,b --exclude-label c      # all of a,b; none of c (claim: no id)
```

## Human boons
`human: true` = only a human works it. `bn claim` (no id) never hands it out; it still shows in `ready`.
Never claim one by id unless a human tells you to.
Need a human decision? Create a human boon blocking your own, then stop or move on:
```
bn create "<question>" --human-only -d "<context>"   # → bn-50
bn dep add <your-id> bn-50                           # bn-50 blocks yours; ready again once the human answers and closes it
```
`bn update <id> --human-only|--no-human-only` · `bn list|ready --human-only` (the human's queue)

## Other
`show <id>` · `list [--all]` · `blocked` · `update <id> [--title t] [-d text|-] [-t type] [-p n] [--parent id|none]` · `dep add|rm <id> <blocker-id> [--kind related|discovered-from]` · `defer <id> [--until 4h|2d|YYYY-MM-DD]` · `undefer <id>` · `reopen <id>`

## Trouble
- unreachable: server down or wrong `BOONS_URL`; tell the user.
- no project: `bn init <prefix>` (2-3 chars) in repo root (writes `.boons.json`).
