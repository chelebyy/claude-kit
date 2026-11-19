# 2026-11-17: which setup should the Codex security review use

Question: does the mandatory Codex security review (security-role model `gpt-daybreak-blue-latest`) find more with (a) a different skill, (b) a higher effort, or (c) OpenAI's Codex Security plugin?

## Setup

- Cases: the five real commits A–E from `2026-11-08-codex-security-review` (criteria in that folder, written before the 2026-11-08 runs). Each case ran in a fresh repository fetched only up to that commit, so later fixes and the criteria were not readable.
- Case F: a synthetic 9-file, ~2.7k-line diff with a fail-open at line ~332 of the 9th file. Its generated guard file had a syntax error (a literal newline in a regex), so two answers dismissed the bug as unreachable. F is reported but not used for the decision; it ran only in the first two arms.
- Every arm: Daybreak, `codex exec -s read-only`, two runs per case, the same request text apart from the skill line, no hint about the known issue. The request already carried the 2026-11-16 override that the security-review-gate file/line caps do not apply.
- Arms:
  1. `high` + `security-review-gate` (current setup).
  2. `high` + revised `local-security-review` (profile `full`; branch `claude/security-review-skill`).
  3. `xhigh` + `security-review-gate`.
  4. `high` + Codex Security plugin `codex-security@openai-curated-remote` 0.1.32, skill `security-diff-scan`, MCP tools on, apps off, sandbox still read-only. This needed a time-boxed `model-guard` exception (exact command form only), approved by the user and removed right after the runs were started; the installed hook was restored byte for byte.
- Grading: blind, letters shuffled per case, Claude Opus (high, read-only) verifying mechanisms against the code with `node -e` and harmless shell probes. Arms 1–2 and arms 3–4 were graded by two separate grader runs with the same rubric and the first run's consistency rules. 2 = caught with a correct mechanism, 1 = same new code and symptom via another trigger, 0 = missed.

## Results (A–E, maximum 20 per arm)

| Case | 1: high + gate | 2: high + new skill | 3: xhigh + gate | 4: plugin |
| --- | --- | --- | --- | --- |
| A | 1, 1 | 1, 1 | 1, 1 | 0, 1 |
| B | 2, 2 | 2, 2 | 2, 2 | 2, 2 |
| C | 0, 1 | 0, 1 | 0, 1 | 0, 0 |
| D | 2, 1 | 1, 1 | 1, 1 | 0, 0 |
| E | 0, 2 | 0, 2 | 0, 0 | 0, 0 |
| **Total** | **12** | **11** | **9** | **5** |
| False positives | 1 | 5 | 1 | 1 |

Case F (arms 1–2 only): arm 1 scored 2, 1; arm 2 scored 1, 2. All four answers reached the 9th file.

## Reading

- No setup beat the current one. The revised skill tied on four cases and lost one point on D, with five times the false positives (it reports from score 50 in profile `full`). `xhigh` was not better than `high` (9 against 12; the E regex half was missed in both `xhigh` runs). The plugin was clearly worse on this case type: three of its ten answers said "no findings", and it never reached the D or E mechanisms.
- With two runs per case the noise is large: the same arm scored 0 and 2 on E. Differences of one or two points are not meaningful; the plugin's gap is.
- The 2026-11-08 single run of arm 1 scored 10/10. Today the same setup averaged 6/10 per run. The registry entry should cite this measurement, not the single run.
- The case set is narrow: five hook and eval-runner commits from one repository. The plugin is built for application code (threat model, discovery, validation, attack path); this set does not show how it does there.
- Arms 3–4 were graded by a different grader run than arms 1–2.

## Decision

Keep the Codex security review at `high` with `security-review-gate` plus the request-level cap override. Do not switch Daybreak to the revised skill or to the plugin on this evidence.

Raw answers, blind packages and keys: kept locally in `C:\All_Project\_seceval` (cases, blind, blind2) and the session scratchpad; not committed.
