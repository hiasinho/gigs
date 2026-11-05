---
name: council
description: Trigger this if the user says 'council'.
license: ../LICENSE.tstack
---

# Council

Adapted from [t3dotgg/tstack](https://github.com/t3dotgg/tstack/tree/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/skills).

Bring in three delegates to help with the user's request, usually for review
or feedback. Use the installed `pi-subagents` skill and native async completion
notices. Set each review's `cwd` to the repository root.

Default members:

- Sol: use the native reviewer and model settings in [sol-loop](../sol-loop/SKILL.md#2-start-sol), with fresh context.
- Grok: project `cursor-grok`.
- Opus: project `cursor-opus`.

For the Cursor members, follow [cursor-review](../cursor-review/SKILL.md).
Their profiles select the models; do not pass Pi model or thinking overrides.
Keep the parent model unchanged. Do not probe for T3 tools.
If the user names different members, use those. If a member is unavailable,
report it instead of substituting.

Give each delegate the request and relevant context. For review or feedback,
keep their work read-only. Collect their responses and summarize the useful
findings, disagreements, and recommended next steps.

For a code review, ask each delegate for a score out of 10.
Count each full review pass as one round.
A fresh review after fixes starts a new round.

If the work ends in a pull request, put the results in the PR description.
Put this section before the model and harness line at the end:

```markdown
## Council review

Rounds: 2

| Delegate | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus | 7/10 | 9/10 |
| GPT Sol | 8/10 | 10/10 |
| Grok | 7/10 | 9/10 |
```

If a delegate gives no score, write `no score`. Do not invent one.
If the PR is open, edit the description. Do not post a comment for this.
If there is no PR, put the same results in the final reply only.

If you agree with their recommendations, make the changes and request a fresh
review after. Continue this process until all delegates are satisfied with the
outcome.

Do not let repeated reviews result in scope creep. It is your job to fight to
keep scope limited.
