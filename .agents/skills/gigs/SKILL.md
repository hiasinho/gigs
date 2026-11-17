---
name: gigs
description: Gigs ticket system via `gig` CLI. Use when repo has .gigs.json, or user mentions gigs/gig, tickets, track this, what's next, claiming work, resume after compaction.
---

# Gigs (`gig`)
Ticket system. Ticket = gig, id like `gig-42`.
Use for work that outlives this session or others pick up; in-session steps → your own todo list.
Every call: `gig … --as <you>`. Pick a meaningful name once per session, unique among agents (short suffix helps, e.g. `auth-refactor-3f9a`), reuse it.
Without `--as`: `GIG_ACTOR`, `"actor"` in `.gigs.local.json`, `git config user.name`, `$USER`. `gig whoami` → `{actor,source}`.
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
gig create "<title>" -t bug|feature|task|epic|chore -p 0-4 [--parent id] [--blocked-by id,id] [--discovered-from id] [-d text|-] [--defer] [--until t]
```
p0 critical … p4 backlog, default 2. `-d -` reads stdin (heredoc for long text).
Must not be picked up yet (e.g. untriaged reports)? File it with `--defer` (`--until t` implies it): never claimable in between.

## Edit descriptions
Small change → `edit`, not a full `update -d` rewrite: stale edits fail instead of clobbering others' changes.
```
gig edit <id> --old text --new text   # old must occur exactly once; `--old=- x` if text starts with -
gig edit <id> -                       # JSON array [{old,new}] on stdin; in order, all-or-nothing
```

## Specs
Spec = temporary agreement (title + text) to create gigs from, id like `gig-s3`.
```
gig spec show <id> [--version n] # {id,title,version,status,text}
gig spec history <id>
gig spec edit <id> --old text --new text
gig spec edit <id> -       # JSON array [{old,new}] on stdin
gig spec list [--all]      # draft/ready/active; --all adds done/closed
gig spec create "<title>" -d text|-   # starts draft
gig spec update <id> [--title t] [-d text|-]
gig spec ready <id>                   # only when the human says it's final
gig spec close <id> -r "<reason>"     # abandon; refused while it has unfinished gigs
gig spec reopen <id>                  # undo close → draft (or active/done if it has gigs)
```
`status`: `draft` → `ready` (by hand) → `active` (has unfinished gigs) → `done` (all its gigs closed); `closed` = abandoned. active/done are derived; `gig reopen` of one of its gigs makes it active again.
**done or closed spec = history; the code is the source of truth, not the spec.**
`--spec <id>` on `create`/`update` only for ready/active specs (server refuses: `spec_draft`, `spec_done`, `spec_closed`); `none` clears. On `list`, `ready`, `blocked`, `claim` (no id): only gigs of that spec, any status; project comes from the spec id.
Follow-ups: file them (`--discovered-from <your-id>`, plus `--spec` while it's active) **before** closing your own gig; closing the last gig makes the spec done.

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

## Auth
Off unless the server has an admin token. The binding (nearest `.gigs.json` plus gitignored `.gigs.local.json` next to it) sets project, server and token, so no env setup is needed.
Lookup, first wins: `GIGS_URL`/`GIGS_TOKEN` env, then `.gigs.local.json`, then `.gigs.json`, then `GIGS_DEFAULT_URL` (launcher) or `http://127.0.0.1:7357`.
A project token covers its own project only; gigs elsewhere show as `{id}`. Don't create, revoke or paste tokens unless the user asks.
Admin token only: `gig token add [--label x]` (shown once) · `gig token list` · `gig token revoke <id>`. `gig projects` with a project token lists just its project. `gig admin delete-project <prefix> --yes` deletes a project and everything in it for good; only when the user asks.

## Trouble
- unreachable: server down or wrong `GIGS_URL` / `"url"`; tell the user.
- no project: `gig init <prefix>` (2-3 chars) in repo root (writes the binding).
- `unauthorized` (401): missing/revoked token; `forbidden` (403): token is for another project or needs admin. The error names where the token came from; a stray `GIGS_TOKEN` overrides the binding, so retry with it unset. Otherwise tell the user.
