# Boons

Boons is a small, self-hosted ticket system that coding agents and humans talk to over the network, to create, pick up, and close units of work.

## Language

### Boons and projects

**Boon**:
A single unit of tracked work. Every boon belongs to exactly one project.
_Avoid_: Ticket, issue, bead

**Project**:
A body of work, usually one repository, whose boons are tracked together.
_Avoid_: Repo, workspace, board

**Prefix**:
A short code of 2–3 characters that identifies a project and begins the IDs of its boons.

**Type**:
The kind of work a boon represents: bug, feature, task, epic, or chore.
_Avoid_: Kind, category

**Priority**:
How urgent a boon is, from 0 (critical) to 4 (backlog).

**Actor**:
The name an agent or human acts under. Every claim, close, and comment records its actor.
_Avoid_: User, assignee, owner

**Comment**:
A note an actor adds to a boon over time, such as progress or a handoff.
_Avoid_: Note, message

### Status

**Open**:
Not yet finished and not being worked on.

**In progress**:
Claimed by an actor who is working on it.

**Deferred**:
Deliberately set aside for later: never ready, until someone undefers it or until its defer date passes.
_Avoid_: Draft, backlog, icebox, snoozed

**Closed**:
Finished, whether done or abandoned. A closed boon may carry a reason and can be reopened.
_Avoid_: Done, resolved, completed

**Unfinished**:
Any boon that is not closed, whatever its other status.

### Structure

**Blocker**:
A boon that must be closed before another boon can be ready. "A blocks B" means A is a blocker of B.
_Avoid_: Dependency (ambiguous about direction), prerequisite

**Blocked**:
The condition of an unfinished boon that has an unfinished blocker, an unfinished child, or an ancestor with an unfinished blocker. Never set by hand.

**Parent**:
A boon that another boon belongs to as part of a larger piece of work. A boon has at most one parent. A parent's unfinished children block it, and the parent's blockers also block all of its descendants.

**Related**:
A link between two boons that informs but never blocks.

**Discovered from**:
A link from a boon to the boon whose work turned it up.

**Plan**:
A set of boons connected by blockers. A plan is not a separate thing in Boons; it exists only as those connections.

**Spec**:
An ordinary document outside Boons that a boon's description refers to. Boons does not store or manage specs.

### Picking up work

**Ready**:
The condition of an open boon that is neither blocked nor has a deferred ancestor.

**Claim**:
An actor's exclusive hold on a boon, which puts it in progress. A claim lapses when its holder shows no activity on the boon for a while.
