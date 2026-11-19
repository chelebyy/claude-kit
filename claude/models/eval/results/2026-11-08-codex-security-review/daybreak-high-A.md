Found three exploitable fail-open issues in commit `7bfffb3`. All are medium severity.

### 1. Bash syntax can make executable code disappear from the guard

- **ID:** `model-guard-bash-false-comment`
- **Location:** `claude/hooks/model-guard.cjs:97-99` at `7bfffb3`
- **Severity:** medium
- **Confidence:** high
- **Category:** security-control bypass
- **Stage:** review
- **Stack:** common-web — Node.js CLI hook
- **Evidence source:** diff and runtime reproduction
- **Evidence:** The lexer treats `#` as the beginning of a comment whenever its internal `word` variable is `null`, then skips everything through LF. That internal state does not represent all Bash syntax contexts.
- **Attack input:**

  ```bash
  unset x; echo ${x:- #y}; codex exec -m definitely-unapproved-model -
  ```

  Bash treats `#y` as data inside the parameter expansion and executes the following `codex exec`. The exact committed guard produced no denial for this input. A legacy backtick substitution provides another bypass because Bash recognizes the closing backtick inside the apparent comment while the lexer consumes it:

  ```bash
  echo `# comment`; codex exec -m definitely-unapproved-model -
  ```

- **Impact:** A tool call can invoke an unapproved Codex model despite the model-registry guard, bypassing model-role and approval restrictions and potentially exposing repository context to an unapproved model.
- **Recommendation:** Do not discard text based solely on this partial comment model. Conservatively scan both interpretations—comments recognized and `#` treated as ordinary text—and deny if either interpretation discovers a prohibited invocation.
- **Verification:** Both inputs above must be denied while genuine comment-only invocations remain non-executable.

### 2. Bare carriage returns bypass PowerShell comment scanning

- **ID:** `model-guard-powershell-cr-comment`
- **Location:** `claude/hooks/model-guard.cjs:97-99` at `7bfffb3`
- **Severity:** medium
- **Confidence:** high
- **Category:** security-control bypass
- **Stage:** review
- **Stack:** common-web — Node.js CLI hook
- **Evidence source:** diff and runtime reproduction
- **Evidence:** The new loop terminates a line comment only at `\n`. PowerShell also treats a bare `\r` as a line terminator.
- **Attack input:** A PowerShell tool command containing this raw command string:

  ```text
  # comment\rcodex exec -m definitely-unapproved-model -
  ```

  Here `\r` represents one actual carriage-return character, not the two printable characters. The exact committed guard allowed it, while PowerShell executed a harmless command placed after the same bare CR during verification.
- **Impact:** An attacker-controlled tool command can hide an unapproved model invocation after a comment and bypass the registry guard.
- **Recommendation:** Recognize all PowerShell line terminators, including bare CR, and retain the conservative dual-interpretation scan described above.
- **Verification:** Feed the hook JSON commands separated by LF, CRLF, and bare CR; all executable unapproved-model invocations must be denied.

### 3. Partial reruns can preserve stale security-evaluation passes

- **ID:** `eval-summary-unversioned-retained-results`
- **Location:** `claude/models/eval/run.cjs:496-503` and `522-530` at `7bfffb3`
- **Severity:** medium
- **Confidence:** high
- **Category:** security-evidence integrity
- **Stage:** review
- **Stack:** common-web — Node.js evaluation runner
- **Evidence source:** diff and surrounding code
- **Evidence:** `previousResults()` validates only model, effort, tier, and cyber program. Retained task results are not bound to the task definition, fixture, check, rubric, runner version, or repository commit. `mergeResult()` then carries every non-rerun result into the new summary and counts it as current.
- **Failing input:**

  1. Run the full suite and obtain passing results.
  2. During the same UTC date, strengthen or otherwise change a security task, its fixture/check/rubric, or the evaluation runner.
  3. Rerun a different task with `--task <id>` using the same model, effort, tier, and cyber program.

  The changed but non-rerun task retains its old `pass: true` result and is included in the new summary’s passed and total counts.
- **Impact:** Evidence used to approve a model can claim that the current evaluation suite passed even though one or more current security tasks were never executed. This can fail open the model-approval process.
- **Recommendation:** Store a deterministic fingerprint for every task result covering its task definition, fixture, checks/rubric, and relevant runner version. Retain a result only when that fingerprint still matches; otherwise reject the partial rerun or mark and rerun the stale task.
- **Verification:** Change a non-selected task or fixture and perform a partial rerun. The runner must refuse to count the old result as current.

### Coverage

- **Reviewed:** The complete `git show 7bfffb3` diff, surrounding implementation in `model-guard.cjs` and `run.cjs`, and the changed tests/documentation.
- **Not reviewed:** Unrelated repository code. The full test suite was not run because it creates temporary and result files, which the read-only instruction prohibited.
- **Assumptions:** The guard receives the raw JSON command string, including representable bare CR characters; evaluation summaries are used as registry-approval evidence as documented in the repository.
- **Tools run:** `git show 7bfffb3`, line-numbered source inspection, in-memory execution of the exact committed guard, non-writing Bash and PowerShell syntax probes, and `git status`.
- **Repository state:** No files were created, edited, or deleted; the worktree remained clean.