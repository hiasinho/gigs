# AGENTS.md

## Agent skills

### Issue tracker

Specs and tickets live in Gigs (`gig` CLI, project `gig`). See `docs/agents/issue-tracker.md`.

### Triage labels

Category = gig type; state = label (`needs-triage`, `needs-info`, `ready-for-agent`, `wontfix`); `ready-for-human` = human gig. Pick up work with `gig claim --spec <id>` or `gig claim --label ready-for-agent`, never a bare `gig claim`. Specs have a status (`draft` until hiasinho says final; done/closed = history). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
