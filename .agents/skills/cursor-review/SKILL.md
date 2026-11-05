---
name: cursor-review
description: Request a bounded, read-only Grok or Opus review through the project's Cursor CLI agents.
disable-model-invocation: true
---

# Cursor review

Use only when the user explicitly requests a Cursor review or delegates work to a named Cursor reviewer. This skill does not authorize code changes, publishing, merging, or additional reviewers.

## Select the reviewer

- Grok: `cursor-grok`, pinned to `grok-4.7-high`.
- Opus: `cursor-opus`, pinned to `claude-opus-5-5-high`.

If no reviewer is named, ask which one to use. Do not substitute models, use Auto, or fall back to another runner. These calls consume Cursor usage; access and billing follow the operator's Cursor account, not Pi's model connection.

## Prepare the handoff

Identify the repository root and requested review scope. Preserve user-owned changes. Supply the intent, relevant architecture requirements, scoped diff including relevant untracked files, base/head when applicable, and checks already run. Do not send credentials or environment-file contents.

Keep the handoff below 128 KiB. Narrow an oversized review with the user rather than silently dropping files. Ask for read-only findings with file locations, evidence, severity, and remaining uncertainty. The parent checks each finding before making changes.

## Launch

Enable pi-subagents if necessary. Launch the selected project agent asynchronously with `cwd` set to the repository root. Do not set Pi's `model`, `thinking`, native tool, skill, or structured-output options on these external runners.

```text
subagent({
  agent: "cursor-grok",
  cwd: "<absolute repository root>",
  task: "<review brief and scoped diff>",
  async: true
})
```

Use `cursor-opus` instead when requested. Return control and wait for the native completion notification; do not poll. Status, timeout, and stop are supported. Steering and retained resume are not; an authorized follow-up is a fresh review.

The parent remains on its current Pi model. Cursor runs its own harness in Ask mode with sandboxing enabled. Ask mode is not an OS-enforced read-only filesystem guarantee. Use an isolated review copy when stronger isolation is required.

## Results and failures

The wrapper reports both the requested Cursor model ID and the model label Cursor returned, or `unavailable` when Cursor did not expose one. Do not present a requested model as verified identity. A missing/failed terminal result, invalid protocol, or nonzero process exit is a failure, never approval.

On authentication, quota, trust, sandbox, or execution failure, report the actual error and stop. Do not retry with `--trust`, `--force`, `--yolo`, automatic MCP approval, disabled sandboxing, changed global settings, or a different model. Repository trust must be established by the operator through Cursor's normal interactive flow.

The profiles and wrapper are project-local. Run `/reload` after changes so Pi discovers them.
