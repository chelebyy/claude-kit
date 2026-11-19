# 2026-11-08: gpt-6.1-terra for the fast and workhorse roles, and gpt-6.1-sol on the security tasks

Questions:
1. Fast role: should `gpt-6.1-terra` replace `gpt-6-luna`?
2. Workhorse role: should `gpt-6.1-terra` replace `gpt-6.1-sol`?
3. Where does `gpt-6.1-sol` stand on the security tasks, next to the 2026-11-07 Astra / Daybreak / gpt-5.6-sol runs?

## Setup

- Same five tasks and rubrics as the 2026-11-07 security evaluation (frozen at 79f208b; the `expect` regexes were adjusted before any run). The models see only `prompt.md` and `fixture/`.
- Same effort for each pair, all on the `fast` tier:
  - Fast role: Terra `medium` vs Luna `medium`.
  - Workhorse role: Terra `xhigh` vs Sol 6.1 `xhigh`. `xhigh` is the only effort the registry allows for Sol 6.1.
- One run per model. Raw results: `2026-11-08-gpt-6.1-terra-medium/`, `2026-11-08-gpt-6-luna-medium/`, `2026-11-08-gpt-6.1-terra-xhigh/`, `2026-11-08-gpt-6.1-sol-xhigh/`.
- Grading was blind. All seven answer sets were graded together: the four runs above plus the 2026-11-07 Astra, Daybreak and gpt-5.6-sol runs (gpt-5.6-sol raw results are kept locally, not committed).
  - Letters were shuffled per task, and a Claude Opus reviewer (high, read-only) scored them by rubric, reproducing the attacks in Node.
  - The key was opened after grading.
  - The grader gave Astra, Daybreak and gpt-5.6-sol the same totals as the two earlier, independent graders (20, 19, 20).
- Scoring (four graded tasks; `fix-pagination` is measured by its protected check only, which all four runs passed):
  - The three security tasks use their committed `rubric.md`.
  - `review-readonly` has no rubric. It was scored on its three seeded bugs with the same scale: 2 found with a correct input, 1 partial, 0 missed; +0.5 per real extra (max +1); -1 per wrong claim.

## Blind rubric scores

| Run | sec-review-auth | sec-review-fileserver | sec-fix-traversal | Security (of 15) | review-readonly (of 6) | Total (of 21) |
| --- | --- | --- | --- | --- | --- | --- |
| Terra medium | 6 | 7 | 2 | 15 | 6 | **21** |
| Luna medium | 6 | 1 | 2 | 9 | 2 | **11** |
| Terra xhigh | 6 | 6.5 | 2 | 14.5 | 6 | **20.5** |
| Sol 6.1 xhigh | 6 | 7 | 2 | 15 | 4 | **19** |
| Astra high (11-07) | 6 | 7 | 2 | 15 | 5 | 20 |
| gpt-5.6-sol high (11-07) | 6 | 7 | 2 | 15 | 5 | 20 |
| Daybreak high (11-07) | 6 | 5 | 2 | 13 | 6 | 19 |

Notes from the grader:
- Luna, file server:
  - It missed the prefix bypass and the XSS.
  - Its SSRF input (`imgcdn.net.attacker.example`) does not pass the check, so it got partial credit for naming the weak check.
- Luna, review-readonly: it found only the role assignment.
- Sol 6.1, review-readonly: it missed float rounding.
- No run produced a false positive.

## Cost (5 tasks)

| Run | Wall time | Input tokens | Automatic pass (summary.json) |
| --- | --- | --- | --- |
| Terra medium | ~371 s | 1.56 M | 5/5 |
| Luna medium | ~393 s | 1.26 M | 3/5 |
| Terra xhigh | ~407 s | 2.17 M | 5/5 |
| Sol 6.1 xhigh | ~628 s | 2.10 M | 4/5 |

## Decisions (Claude)

1. **Fast role: `gpt-6.1-terra` replaces `gpt-6-luna`.**
   - Same effort, 21 vs 11.
   - Luna missed two of three seeded bugs in the file-server review and in the general review (it found all three in the auth review).
   - Terra costs about 24% more input tokens for the same wall time.
   - The gap is far larger than single-run noise.
   - `gpt-6-luna` is retired.
   - Approved efforts: `medium` and `xhigh` were measured; `high` is approved as in between; `low` was not measured.
2. **Workhorse role: `gpt-6.1-sol` stays.**
   - Terra at `xhigh` is not behind (20.5 vs 19), uses about the same tokens and is about 35% faster.
   - A 1.5-point lead on one run is within noise, and this is the most used role.
   - The registry notes Terra as a workhorse contender, to re-measure before any change.
3. **Security:**
   - `gpt-6.1-sol` (xhigh) scores 15 of 15 on the security tasks, level with Astra and gpt-5.6-sol, ahead of Daybreak (13).
   - It ran at `xhigh` against the others' `high`; `xhigh` is the only effort the registry allows for it.
   - The security review's third opinion stays with the frontier model (Astra): same security accuracy at about half the input tokens.

Limits: one run per model; the runner does not keep fix-task code, so `sec-fix-traversal` was graded on its test result and explanation only.
