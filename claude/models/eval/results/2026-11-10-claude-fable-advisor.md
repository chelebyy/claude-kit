# 2026-11-10: Claude Fable 5.2 for the advisor role, compared with Fable 5.1

Question: can `claude-fable-5-2` take the advisor role held by `claude-fable-5-1`? The `fable` alias had already moved to 5.2 when it appeared, so in practice the question was whether that move hides a regression.

This session runs on `claude-opus-5-5`, so neither model is grading itself. The built-in advisor (already on the `fable` alias) was not consulted about this evaluation.

## Setup

- The same five tasks and rubrics as the earlier evaluations, with both models at `high` effort and one run each. Advisors are called at low to xhigh effort; `high` is the usual level for design and root-cause questions.
- The runner path is `claude -p`, as in the 2026-11-08 subagent evaluation:
  - no shell, no MCP servers and no built-in advisor;
  - no setting sources, so no user plugins, hooks or CLAUDE.md;
  - reads outside the work dir are denied.

  See README "Bilinen sınırlar" for details.
- Raw results: `2026-11-10-claude-fable-5-2-high/` and `2026-11-10-claude-fable-5-1-high/`.
- Grading:
  - Blind, by the Codex frontier model (`gpt-6-astra`, high, read-only, no MCP), as the conflict-of-interest rule requires for Claude candidates.
  - Letters were shuffled per task. The grader saw only the task, the fixture, the rubric and the two answers. It reproduced attacks in Node.
  - The key was opened after grading.
- Maxima used by the grader: review-readonly 4 (3 seeded defects + 1 capped extra), the explanations for fix-pagination and sec-fix-traversal 2 each (both fixes passed their automatic checks), and the two security reviews 7 each.

## Results

| Model | fix-pagination | review-readonly | sec-fix-traversal | sec-review-auth | sec-review-fileserver | Total (of 22) | Wall time | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fable 5.2 high | 2 | 4 | 2 | 6 | 7 | **21** | ~144 s | 13.5 k | $0.97 |
| Fable 5.1 high | 2 | 4 | 2 | 5 | 7 | **20** | ~212 s | 9.7 k | $1.07 |

- Both models passed every automatic check (5/5), found every seeded bug, and changed nothing in the read-only tasks.
- Fable 5.1 lost one point in the auth review for a false claim: it said expiry validation rejects every non-numeric value. In fact `exp: "Infinity"` and `exp: [9999999999]` are accepted. Opus made a similar false expiry claim on 2026-11-08.
- Fable 5.2 writes more: about 1.4x the output tokens, mostly in the security reviews. It was still faster and slightly cheaper per run. The grader noted some answers were longer than asked, with no extra credit.

## Decision (Claude, with the grading done by Astra)

**`claude-fable-5-2` is approved as advisor (alias `fable`), and `claude-fable-5-1` is retired.**

The decision rule is met:

- no rule violations;
- not behind on correctness (21 vs 20);
- no worse on false claims (the only false claim was Fable 5.1's);
- cost acceptable.

Limits:

- One run per model.
- The task set is near its ceiling, so this is evidence of no regression, not of a clear gain.
- The fix tasks were graded on their explanation only.
- These runs had no user CLAUDE.md.
- No task targets advisor-specific behaviour (design trade-offs, root-cause questions, following "read-only, do not call the advisor tool").
