# 2026-11-08: which Codex model should do the security review

Question: in the new review structure, a separate Codex security review runs for trust-boundary (T3) changes. Which Codex model should do it, using the `security-review-gate` skill?

## Setup

- Five real commits from this repository. Each contained a security issue that a later review found (see `criteria.md` in the raw folder, written before any run):
  - A: a comment skip hides commands;
  - B: exponential nesting that fails open;
  - C: a heredoc body scan reads past EOF;
  - D: user plugins and hooks run model code;
  - E: `<<-` order and a quadratic regex.
- Each model reviewed each commit once, with the same prompt and `codex exec -s read-only`:
  - the prompt said "mandatory review, use `security-review-gate`, scope = this commit, real exploitable issues only";
  - it gave no hint about the known issue.
- Runs:
  - `gpt-6.1-terra` medium and high (fast tier);
  - `gpt-6-astra` high (default tier);
  - `gpt-6.1-sol` xhigh (fast tier);
  - `gpt-daybreak-blue-latest` high (default tier, `daybreak_blue`).
- Daybreak was unassigned at the time, and model-guard blocks Claude from calling unassigned models. So its run was started by the user from the prompt (`!` command).
- Two runs had to be retried:
  - Astra on case C: the OpenAI content classifier blocked it as a possible cybersecurity risk, which is not a model result. It was retried with `--cyber-access-program standard`.
  - Sol 6.1 on case E: it exited with an empty log, probably because the run script was edited while running. It was retried unchanged.
- Grading was blind. A Claude Opus reviewer (high, read-only) scored the answers against the criteria, with letters shuffled per case:
  - 2 = caught with a correct mechanism;
  - 1 = same new code and symptom through a different trigger;
  - 0 = missed.
  
  It verified claims against each commit and its parent by running the guard's `check()` in Node. The key was opened after grading.

## Results

| Model | A | B | C | D | E | Total (of 10) | Wall time (successful runs) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Daybreak high | 2 | 2 | 2 | 2 | 2 | **10** | ~35 min |
| Astra high | 2 | 2 | 0 | 1 | 2 | **7** | ~20 min |
| Sol 6.1 xhigh | 2 | 2 | 1 | 0 | 2 | **7** | ~31 min |
| Terra high | 1 | 2 | 0 | 0 | 2 | **5** | ~8 min |
| Terra medium | 1 | 0 | 0 | 0 | 2 | **3** | ~5 min (A–D; E not recorded) |

- No model made an invalid claim. Their extra findings were real issues, either new or pre-existing.
- Daybreak was the only Codex model to catch D. In the original review, only Claude's security pass had caught it.
- Daybreak was also the only model to catch C exactly.

## Decision (Claude)

- `gpt-daybreak-blue-latest` is approved for the new `security` role:
  - the Codex security review on T3 changes, and as an extra review on risky T2 changes;
  - always with `security-review-gate`, `--cyber-access-program daybreak_blue`, default tier, read-only.
  - Efforts: `high` was measured; `xhigh` is approved as the step above; `medium` was not measured.
- This reverses the 2026-11-07 decision, which kept Daybreak unassigned after it scored 19 vs Astra's 20. That was on small synthetic tasks where all models scored near the ceiling. On real, subtle vulnerabilities, Daybreak separates clearly.
- The Codex general review stays with Terra for ordinary changes and Astra for large or risky ones. Terra should not do the security review: it scored 3/10 at medium.

Times are summed from `timing.txt` over successful runs only; the blocked Astra C run (168 s) and the empty Sol E run (328 s) are excluded. Daybreak takes about 1.75x Astra's time.

Limits:
- Five cases, one run per model, one grader. Daybreak is slow, at several minutes per review.
- `criteria.md` was committed together with the results, so git does not prove it predates the answers. Only local file times support that (criteria written 17:45:33, first answer 17:47:30, 2026-11-08).
- The grader's per-answer reasoning was not saved; only the scores above are recorded.
- A later correctness reviewer argued that Astra's first finding on case C describes the same mechanism that earned Sol 1 point there (a line continuation hides the delimiter), so Astra C could be 1 instead of 0 (8/10). The blind scores are left as graded; Daybreak stays ahead either way.
- `gpt-daybreak-blue-latest` is a moving alias. `model-watch` compares slugs only, so it cannot see the provider repointing the alias to a new model; the approval covers the model measured on 2026-11-08. Re-measure when OpenAI announces a new Daybreak release.
