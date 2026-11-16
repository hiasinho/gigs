# Gigs

Gigs is a small, self-hosted ticket system that coding agents and humans talk to over the network, to create, pick up, and close units of work.

## Language

### Gigs and projects

**Gig**:
A single unit of tracked work. Every gig belongs to exactly one project.
_Avoid_: Ticket, issue, bead

**Project**:
A body of work, usually one repository, whose gigs are tracked together.
_Avoid_: Repo, workspace, board

**Prefix**:
A short code of 2–3 characters that identifies a project and begins the IDs of its gigs.

**Type**:
The kind of work a gig represents: bug, feature, task, epic, or chore.
_Avoid_: Kind, category

**Priority**:
How urgent a gig is, from 0 (critical) to 4 (backlog).

**Actor**:
The name an agent or human acts under. Every claim, close, and comment records its actor.
_Avoid_: User, assignee, owner

**Project token**:
A secret that lets whoever holds it read and write one project, and nothing else, while auth is on. It says which project, not which actor.
_Avoid_: API key, password

**Admin token**:
The server's one secret that can do everything, including creating projects and managing project tokens. Configuring it turns auth on for the whole server; without it there is no auth.

**Comment**:
A note an actor adds to a gig over time, such as progress or a handoff.
_Avoid_: Note, message

**Label**:
A free-form marker on a gig, such as `wontfix` or `triage:needs-info`, written in lowercase without spaces. A gig has any number of labels, closed or not. Labels are inert: they never change whether a gig is ready, blocked, or claimable; they only help to find gigs.
_Avoid_: Tag, category

### Status

**Open**:
Not yet finished and not being worked on.

**In progress**:
Claimed by an actor who is working on it.

**Deferred**:
Deliberately set aside for later: never ready, until someone undefers it or until its defer date passes.
_Avoid_: Draft, backlog, icebox, snoozed

**Closed**:
Finished, whether done or abandoned. A closed gig may carry a reason and can be reopened.
_Avoid_: Done, resolved, completed

**Unfinished**:
Any gig that is not closed, whatever its other status.

### Structure

**Blocker**:
A gig that must be closed before another gig can be ready. "A blocks B" means A is a blocker of B.
_Avoid_: Dependency (ambiguous about direction), prerequisite

**Blocked**:
The condition of an unfinished gig that has an unfinished blocker, an unfinished child, or an ancestor with an unfinished blocker. Never set by hand.

**Parent**:
A gig that another gig belongs to as part of a larger piece of work. A gig has at most one parent. A parent's unfinished children block it, and the parent's blockers also block all of its descendants.

**Related**:
A link between two gigs that informs but never blocks.

**Discovered from**:
A link from a gig to the gig whose work turned it up.

**Plan**:
A set of gigs connected by blockers. A plan is not a separate thing in Gigs; it exists only as those connections.

**Spec**:
A temporary agreement about a body of work, kept in Gigs, from which gigs are created and which they can point to. A gig points to at most one spec, of its own project, and pointing to one changes nothing about whether the gig is ready. Once its gigs are done, the code is the source of truth and the spec is history.
_Avoid_: Document, requirements

**Spec status**:
Where a spec is in its life. Draft, ready and closed are set by hand; active and done follow from the spec's gigs and are never set by hand. A new gig can point only to a ready or active spec.
_Avoid_: Spec state

**Draft spec**:
A spec still being written. Every spec starts as a draft.

**Ready spec**:
A spec its owner has declared final, so gigs may now be created from it.

**Active spec**:
A spec with at least one unfinished gig, whatever was set by hand, unless it is closed.

**Done spec**:
A spec that has gigs, all of them closed. It is history: new work it turns up is linked as discovered from one of its gigs.

**Closed spec**:
A spec abandoned by hand, with a reason. Closed wins over active and done; it can be reopened as a draft.

**Version**:
A numbered state of a spec's title and text; every change to them makes a new one. Status changes do not.

### Picking up work

**Ready**:
The condition of an open gig that is neither blocked nor has a deferred ancestor.

**Claim**:
An actor's exclusive hold on a gig, which puts it in progress. A claim lapses when its holder shows no activity on the gig for a while.

**Human gig**:
A gig that only a human works. Claiming the next ready gig never hands it out; it can still be claimed by id, and is otherwise like any gig.
_Avoid_: Manual, assignee
