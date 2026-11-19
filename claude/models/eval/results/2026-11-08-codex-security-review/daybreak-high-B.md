Found two exploitable security-control failures in commit `a69afe6`. Line numbers below refer to that commit.

### 1. Exponential scanning lets the hook time out and fail open

- **ID:** `model-guard-exponential-timeout`
- **Location:** `claude/hooks/model-guard.cjs:53-55`, `claude/hooks/model-guard.cjs:226-227`, `claude/hooks/model-guard.cjs:277`, `claude/hooks/model-guard.cjs:301`
- **Category:** security-control bypass / denial of service
- **Severity:** **high**
- **Confidence:** high
- **Evidence source:** diff and executable exact-commit probe
- **Attack input:** Construct the PowerShell tool command as:

  ```js
  "pwsh -c '" + "pwsh -c ".repeat(21) +
    "Write-Host ok'; codex exec -m gpt-0-unapproved -"
  ```

- **Evidence:** `lex()` concatenates the comment-aware and comment-blind results without deduplicating identical token lists. Every nested shell is therefore scanned twice at every level. The 225-character input above took **7,115 ms** under the exact `a69afe6` code, while the configured PreToolUse timeout is **5 seconds** at `claude/settings.fragment.json:307`. The same input took **0.409 ms** against the parent commit, confirming that this commit introduced the regression.
- **Impact:** The hook times out before reaching the protected `codex exec` command. Because hook failures/timeouts are fail-open, the unapproved model invocation proceeds unchecked. The crafted input also consumes substantial CPU in the hook process.
- **Recommendation:** Deduplicate the two lexer outputs, memoize already-inspected `(shell, script)` pairs, impose a total parsing-work budget, and return a deny decision when the budget is exceeded.
- **Verification:** The input above must finish comfortably below five seconds and return a denial. Add a regression that runs 21–25 nested shells and asserts both bounded execution time and fail-closed behavior.

### 2. Two different lexer misparses can still hide an unapproved model

- **ID:** `model-guard-two-pass-comment-bypass`
- **Location:** `claude/hooks/model-guard.cjs:53-55`, `claude/hooks/model-guard.cjs:102-111`, `claude/hooks/model-guard.cjs:148-159`
- **Category:** security-control bypass
- **Severity:** **medium**
- **Confidence:** high
- **Evidence source:** diff and executable exact-commit probe
- **Attack input:**

  ```bash
  # Don't use retired models
  codex exec ${x:- #} -m gpt-0-unapproved -
  ```

- **Evidence:** The exact `a69afe6` `check()` function returns an empty issue list for this input. In the comment-aware pass, the `#` inside `${x:- #}` is incorrectly treated as a comment and hides the model flag. In the comment-blind pass, the apostrophe in the genuine comment (`Don't`) opens a quote that consumes the following command. The union therefore contains no complete protected invocation. The parent commit also missed this input, so `a69afe6` attempted to address this class but left the bypass open.
- **Impact:** An unapproved model can be invoked despite the model registry policy. This may violate model-governance, cost, or data-handling restrictions.
- **Recommendation:** Do not assume that unioning two independently lossy parses guarantees coverage. Fail closed when the passes disagree around `#`, quotes, protected executables, or model flags, and add the exact input above as a regression.
- **Verification:** `check()` must return a denial for the exact two-line input while continuing to accept ordinary comments and valid parameter expansions that contain no protected invocation.

### Coverage

- **Reviewed:** Complete `a69afe6` diff; full commit version of `model-guard.cjs`; changed tests and documentation; hook timeout configuration; parent-commit comparison.
- **Not reviewed:** Unrelated repository code. I did not allow either proof input to launch a real Codex process.
- **Assumptions:** PreToolUse hook timeout remains non-blocking/fail-open, consistent with the guard’s documented failure behavior and the repository’s subsequent timeout-hardening comments.
- **Tools run:** `git show`, scoped `rg`, line-numbered source inspection, and read-only Node probes loading the exact commit snapshots. No files were edited, created, or deleted.