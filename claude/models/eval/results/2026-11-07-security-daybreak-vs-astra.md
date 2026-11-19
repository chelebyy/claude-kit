# 2026-11-07: Daybreak Blue vs Astra (security role)

Question: should `gpt-daybreak-blue-latest` take the security-review role (third reviewer next to Claude at high/xhigh) instead of `gpt-6-astra`?

## Setup

- Task set fixed before any run, at commit 79f208b (fixtures, prompts, rubrics). The `expect` regexes were tightened in f4db15d and c14056c before the runs. The models see only prompt.md and fixture/, so the regexes do not affect what they do.
- Both models: all 5 tasks, effort `high`, tier `default`. Daybreak with `--cyber-access-program daybreak_blue`; Astra with the server default.
- One run per model. Raw results are in `2026-11-07-gpt-6-astra-high/` and `2026-11-07-gpt-daybreak-blue-latest-high-daybreak_blue/`.
- Grading: blind. Answers were shuffled as A/B per task, and a Claude Opus reviewer (high, read-only) scored them. It reproduced every claimed attack in Node. The key was opened only after grading.
  - The three security tasks were scored by their committed rubric.md.
  - review-readonly has no committed rubric (README requires one only for security tasks). The grader was given its three seeded bugs and the same scale: 2 = found with a correct concrete input, 1 = partial, 0 = missed; +0.5 per real extra (max +1); -1 per wrong or style-only claim.

## Automatic checks (summary.json)

| Task | Astra | Daybreak |
| --- | --- | --- |
| fix-pagination | check passed | check passed |
| sec-fix-traversal | check passed | check passed |
| review-readonly | missed float-money (regex) | all 3 hits |
| sec-review-auth | 3/3 hits, no decoy citations | 3/3 hits, no decoy citations |
| sec-review-fileserver | 3/3 hits, no decoy citations | 1/3 hits (regex missed its XSS finding, which does not use the word "XSS") |
| Rule violations (read-only, protected files) | none | none |

## Blind rubric scores

| Task | Astra | Daybreak | Note |
| --- | --- | --- | --- |
| sec-review-auth | 6 | 6 | Both found alg none, IDOR and mass assignment with working attacks. |
| sec-review-fileserver | 7 | 5 | Daybreak missed the `startsWith` sibling-prefix bypass (the main file-disclosure bug). It found more crash/DoS extras, but extras are capped at +1. Astra covered both halves of the SSRF. |
| review-readonly | 5 | 6 | Astra reported the string return but not float rounding (partial). |
| sec-fix-traversal (explanation) | 2 | 2 | Both named both defects. The fixed code was not kept by the runner, so it was not graded. |
| **Total** | **20** | **19** | No false positives and no non-working attacks on either side. |
| Rubric-backed tasks only (3 security tasks) | 15 | 13 | |

## Cost (5 tasks)

| | Astra | Daybreak |
| --- | --- | --- |
| Wall time | ~373 s | ~826 s |
| Input tokens | ~1.11 M | ~2.64 M |
| Output tokens | ~6 k | ~28 k |

## Decision (Claude)

Daybreak is not assigned the security role. The decision rule requires a candidate to be no worse than the current model on accuracy. Daybreak is behind: 19 vs 20 overall, 13 vs 15 on the rubric-backed security tasks, and it missed the main file-disclosure bug in the file-server review. Cost is a second reason: about 2.2× the time and 2.4× the input tokens. A second run was not made, because even a tie on accuracy would leave the higher cost with nothing to pay for it, so it could not change the decision. Daybreak stays `unassigned`. The security review's third opinion stays with the frontier model (Astra).

Limits: one run per model, four graded tasks. The runner does not keep the code a model writes in fix tasks, so fix quality beyond the protected test was not graded. Re-evaluate when a new Daybreak version appears.
