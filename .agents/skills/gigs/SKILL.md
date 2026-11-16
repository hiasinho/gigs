---
name: gigs
description: Gigs ticket system via `gig` CLI. Use when repo has .gigs.json, or user mentions gigs/gig, tickets, track this, what's next, claiming work, resume after compaction.
---

# Gigs (`gig`)
Ticket system. Ticket = gig, id like `gig-42`.
Use for work that outlives this session or others pick up; in-session steps → your own todo list.
Every call: `gig … --as <you>`. Pick a meaningful name once per session, unique among agents (short suffix helps, e.g. `auth-refactor-3f9a`), reuse it.
Output: JSON, empty fields omitted; `--full` = all fields. Syntax: `gig help`, `gig <cmd> --help`.

## Loop
```
gig ready                  # claimable now
gig claim [id]             # no id = next ready; returns gig (description, relations, comments) or null
gig claim --label ready-for-agent --parent <epic>   # no id: same filters as ready (--spec/--label/--exclude-label/--parent)
# work
gig comment <id> "<text>"   # as you go: survives compaction, lets others resume
gig close <id> [-r "<reason>"]
```
`--parent <id>` on `ready`/`claim` = whole subtree (not the gig itself); on `list` = direct children only.
`gig unclaim <id>` releases a claim.
Claim lapses after ~60 min without your activity; comment/update/link renews; long work: `gig heartbeat <id>`.
Lost track (compaction/new session): `gig list --status in_progress`, yours by `claimed_by`, then `gig show <id>`.

## File work
```
gig create "<title>" -t bug|feature|task|epic|chore -p 0-4 [--parent id] [--blocked-by id,id] [--discovered-from id] [-d text|-]
```
p0 critical … p4 backlog, default 2. `-d -` reads stdin (heredoc for long text).

## Edit descriptions
Small change → `edit`, not a full `update -d` rewrite: stale edits fail instead of clobbering others' changes.
```
gig edit <id> --old text --new text   # old must occur exactly once; `--old=- x` if text starts with -
gig edit <id> -                       # JSON array [{old,new}] on stdin; in order, all-or-nothing
```

## Specs
Spec = agreement (title + text), id like `gig-s3`.
```
gig spec show <id> [--version n] # {id,title,version,text}
gig spec history <id>
gig spec edit <id> --old text --new text
gig spec edit <id> -       # JSON array [{old,new}] on stdin
gig spec list
gig spec create "<title>" -d text|-
gig spec update <id> [--title t] [-d text|-]
```
`--spec <id>` on `create`, `update` (`none` clears), `list`, `ready`, `blocked`, `claim` (no id): only gigs of that spec; project comes from the spec id.

## Labels
Free-form markers (lowercase, no spaces; `a-z0-9._:-`), e.g. `wontfix`, `triage:needs-info`. Inert: never affect ready/blocked/claim.
```
gig label add|rm <id> <label...>                        # no-op if already present/missing; any status
gig update <id> --add-label a --remove-label b          # swap in one call
gig create "<title>" --label a,b
gig list|ready|claim --label a,b --exclude-label c      # all of a,b; none of c (claim: no id)
```

## Human gigs
`human: true` = only a human works it. `gig claim` (no id) never hands it out; it still shows in `ready`.
Never claim one by id unless a human tells you to.
Need a human decision? Create a human gig blocking your own, release your claim, then stop or move on:
```
gig create "<question>" --human-only -d "<context>"   # → gig-50
gig dep add <your-id> gig-50                           # gig-50 blocks yours
gig unclaim <your-id>                                  # ready again once the human answers and closes gig-50
```
`gig update <id> --human-only|--no-human-only` · `gig list|ready --human-only` (the human's queue)

## Other
`show <id>` · `list [--all]` · `blocked` · `update <id> [--title t] [-d text|-] [-t type] [-p n] [--parent id|none]` · `dep add|rm <id> <blocker-id> [--kind related|discovered-from]` · `defer <id> [--until 4h|2d|YYYY-MM-DD]` · `undefer <id>` · `reopen <id>`

## Trouble
- unreachable: server down or wrong `GIGS_URL`; tell the user.
- no project: `gig init <prefix>` (2-3 chars) in repo root (writes `.gigs.json`).
