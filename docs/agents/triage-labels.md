# Triage Labels

Triage roles map to Gigs as follows: the category is the gig type, the state is a label (plus deferral), and `ready-for-human` is a human gig. Labels are inert, so deferral is what actually keeps untriaged gigs out of `gig ready` and `gig claim`.

## Category roles → gig type

| Role          | In Gigs      |
| ------------- | ------------ |
| `bug`         | `-t bug`     |
| `enhancement` | `-t feature` |

## State roles

| Role              | In Gigs                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `needs-triage`    | label `needs-triage`, and deferred without `--until`                     |
| `needs-info`      | label `needs-info`, and deferred                                        |
| `ready-for-agent` | label `ready-for-agent`, open                                           |
| `ready-for-human` | a human gig (`gig update <id> --human-only`), open, no state label       |
| `wontfix`         | label `wontfix` (or `duplicate`), then `gig close <id> -r "<why>"`        |

A gig has at most one state. To move a gig, swap labels in one call and fix the deferral, e.g. to `ready-for-agent`: `gig update <id> --remove-label needs-triage --add-label ready-for-agent`, then `gig undefer <id>`.

## Queries

- **Filing a raw report**: `gig create "<title>" -t bug|feature --label needs-triage --defer -d -`. This is one call, so the gig is never open. Don't use `--until` here: it would reopen the gig without anyone triaging it.
- **Inbox**: `gig list --status deferred --label needs-triage`. Re-check: `gig list --status deferred --label needs-info`.
- **Unlabeled**: `gig list --exclude-label needs-triage,needs-info,ready-for-agent`. Ignore epics, human gigs, `wayfinder:*` tickets and gigs that belong to a spec (a spec's gigs carry no triage label).
- **The human's queue**: `gig ready --human-only`.
