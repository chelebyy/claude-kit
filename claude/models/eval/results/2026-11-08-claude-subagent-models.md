# 2026-11-08: Claude Sonnet and Haiku for subagent work, compared with Opus

Question: can `claude-sonnet-5-5` and `claude-haiku-5-5` do the subagent work that currently runs on `claude-opus-5-5`?

Fable was not included, at the user's request. Opus is the comparison base only. It runs this session, so its own approval is not under evaluation (conflict-of-interest rule).

## Setup

- Same five tasks and rubrics as the Codex evaluations. All three models at `medium` effort, the effort most subagent calls use. One run per model.
- Runner path `claude -p` (see README "Bilinen sınırlar"):
  - No shell.
  - No MCP servers.
  - No built-in advisor.
  - No setting sources: no user plugins, hooks or CLAUDE.md.
  - Reads outside the work dir are denied.
- Because of these settings, the models cannot test their own fixes, and per-task input is about 20 k tokens versus about 200–300 k for Codex runs. Costs are therefore not comparable across the two families.
- Raw results: `2026-11-08-claude-opus-5-5-medium/`, `2026-11-08-claude-sonnet-5-5-medium/`, `2026-11-08-claude-haiku-5-5-medium/`.
- Grading was blind and done by the Codex frontier model (`gpt-6-astra`, high, read-only), as the conflict-of-interest rule requires for Claude candidates. Letters were shuffled per task, Astra reproduced the attacks in Node, and the key was opened after grading.
- In this batch the grader credited real extras in `review-readonly`, so that task's maximum is 7 here, not 6.

## Results

| Model | sec-review-auth | sec-review-fileserver | sec-fix-traversal | Security (of 15) | review-readonly (of 7) | Total (of 22) | Wall time | Input tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Opus medium | 5 | 7 | 2 | 14 | 7 | **21** | ~110 s | 78 k | $0.32 |
| Sonnet medium | 6 | 7 | 2 | 15 | 7 | **22** | ~79 s | 95 k | $0.14 |
| Haiku medium | 6 | 7 | 2 | 15 | 6.5 | **21.5** | ~85 s | 118 k | $0.012 |

- All three passed every automatic check (5/5) and found every seeded bug.
- Opus lost one point for a false claim in the auth review: it said the token never expires, but the expiry check works.

## Decision (Claude, with the grading done by Astra)

1. **`claude-sonnet-5-5` (subagent worker) and `claude-haiku-5-5` (light subagent worker) stay approved, now with evidence.**
   - On these tasks neither is behind Opus.
   - Haiku costs about 1/26 of Opus and Sonnet less than half, for the same scores.
   - In practice, exploration, search and simple edits go to Haiku, ordinary worker tasks go to Sonnet, and Opus is kept for the main session and the reviewers.
2. **Reviewers and the main model stay on Opus.** The task set has hit its ceiling: all three models score at or near the maximum, so it cannot tell them apart on hard review work. The subtle defects Opus reviewers caught in this project were well beyond these tasks; examples are a plugin language server running planted code, and regressions in heredoc parsing. Moving reviewers to Sonnet or Haiku needs harder tasks first: a larger code base and subtler bugs.

Limits: one run per model, an easy task set, explanation-only grading for the fix task, and no user CLAUDE.md in these runs.
