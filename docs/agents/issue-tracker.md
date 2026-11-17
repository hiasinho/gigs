# Issue tracker: Gigs

Specs and tickets for this repo live in Gigs, a self-hosted ticket server, under project `gig` (see `.gigs.json`). Use the `gig` CLI; `gig skill` and `gig <cmd> --help` have the full usage. Ids look like `gig-42` (gig) and `gig-s3` (spec).

## Conventions

- **Actor**: `--as <you>` on every call. Pick one name per session, unique among agents (e.g. `to-tickets-3f9a`), and reuse it.
- **Server unreachable**: tell the user. Don't fall back to another tracker.
- **Specs** have a lifecycle instead of labels. `draft` is the default on create. `ready` is set with `gig spec ready`. `active` (has unfinished gigs) and `done` (all its gigs closed) are derived from the gigs. `closed` means abandoned and is set with `gig spec close <id> -r "<why>"`. Gigs refuses to close a spec that still has unfinished gigs (`spec_active`): close those gigs or clear their spec (`gig update <id> --spec none`) first. `gig spec reopen` undoes a close and puts the spec back to draft.
  - `gig spec list` shows current specs (draft, ready, active); `--all` adds done and closed.
  - **A done or closed spec is history.** The code is the source of truth, not the spec text.
  - Only a ready or active spec takes new gigs (`--spec`). The server refuses the others with `spec_draft`, `spec_done` or `spec_closed`.
- **Create a ticket**: `gig create "<title>" -t <type> -p 0-4 -d -`, plus `--spec <id>`, `--parent <id>`, `--blocked-by <id>,<id>` and `--label <labels>` as needed. Create blockers first.
- **Read**: `gig show <id>` (description, labels, relations, comments, ready state); `gig spec show <id>`.
- **List**: `gig list` with `--spec`, `--parent` (direct children only), `--type`, `--label`, `--exclude-label`, `--status`, `--all`.
- **Blocking**: native, via `--blocked-by` or `gig dep add <id> <blocker>`. `gig blocked` explains why. Unfinished children block their parent.
- **Edit a description**: `gig edit <id> --old ... --new ...`, or a JSON `[{old,new}]` array on stdin. Never rewrite a whole description with `gig update -d`; a stale edit must fail, not overwrite someone else's.
- **Comment**: `gig comment <id> -`. **Close**: `gig close <id> -r "<reason>"`.
- **Found work**: `gig create ... --discovered-from <your-gig>`. If your gig belongs to a spec, also pass `--spec <id>`, and file the follow-up **before** you close your own gig: closing the spec's last gig makes the spec done, and a done spec takes no new gigs. After that, use `--discovered-from` only.
- **Raw reports** (not yet triaged): `gig create "<title>" --label needs-triage --defer -d -`. Never file one with a plain `gig create`.
- **Labels and human gigs**: see `triage-labels.md`.

## Picking up work

- In this repo, never run `gig claim` without an id and without a filter. Wayfinder tickets and raw reports aren't agent-ready.
- Next gig of a spec: `gig claim --spec <id>`. Next triaged gig: `gig claim --label ready-for-agent`. Scope either with `--parent <id>` if needed. Neither hands out a human gig.
- A claim lapses after ~60 min without activity from you; comment or `gig heartbeat <id>` during long work.
- Never claim a human gig (`human: true`) by id unless a human tells you to.
- **Needs a human decision**: `gig create "<question>" --human-only -d -`, then `gig dep add <yours> <question>` and `gig unclaim <yours>` (otherwise yours stays claimed after the human closes the question), then stop or move on.

## Pull requests as a triage surface

**PRs as a request surface: no.** Gigs doesn't track PRs. Close a gig once its work has landed.

## When a skill says "publish to the issue tracker"

- **A spec** (`to-spec`): `gig spec create`. It stays `draft`, so you can still refine it with `gig spec edit`. Run `gig spec ready <id>` only once hiasinho says it's final. Specs take no triage label: the spec's status replaces it.
- **Tickets from a spec** (`to-tickets`): `gig create ... --spec <id>`, with no `ready-for-agent` label, since belonging to a ready spec already says the gig can be built. If the server answers `spec_draft`, ask hiasinho whether the spec is final; never run `gig spec ready` yourself. `spec_done` or `spec_closed` means the spec is history, so file without `--spec`.
- **Tickets without a spec**: `gig create` with `--label ready-for-agent`, unless the skill says otherwise.

## When a skill says "fetch the relevant ticket"

`gig show <id>`. For a spec: `gig spec show <id>`, then `gig list --spec <id>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic; its descendants are the tickets.

- **Map**: `gig create "<effort>" -t epic --human-only -d -`, with the Notes / Decisions-so-far / Not-yet-specified body. `--human-only` keeps blind claims from picking up the map once it has no open children. Never claim it.
- **Child ticket**: `gig create "<question>" -t task --parent <map> --label wayfinder:<type> -d -`, where type is `research`, `prototype`, `grilling` or `task`. Add `--human-only` for HITL tickets (grilling, prototype, a HITL task). No triage labels.
- **Blocking**: native, as above.
- **Frontier**: `gig ready --parent <map>`, which includes human gigs. Take the first one, or the ticket the user named.
- **Claim**: `gig claim <id>`, the session's first write. The human started the session, so claiming a HITL human gig by id is allowed here. In an AFK-only run, use `gig claim --parent <map>`, which skips HITL tickets.
- **Resolve**: `gig comment <id> -` with the answer, then `gig close <id> -r "<gist>"`, then add a context pointer (gist and gig id) to Decisions-so-far with `gig edit <map>`. Anchor the edit on the section's last line and replace it with that line plus the new pointer.
