Found **four confirmed issues** in commit `20a6b41`: three regressions and one bypass left open by the heredoc change. All are **medium severity, high confidence**, supported by exact-commit source inspection and the probes below.

1. **Tab stripping before line joining lets `<<-` bypass the model guard.**  
   Location: [claude/hooks/model-guard.cjs:101](/<workdir>/claude/hooks/model-guard.cjs:101). ID: `heredoc-tab-join`; category: input validation.

   Failing input, with **one literal tab before `OF`**:

   ```bash
   cat <<-EOF
   E\
   	OF
   '
   EOF
   codex exec -m gpt-0-unapproved -
   ```

   The guard strips the tab from each physical line before joining, incorrectly recognizing `E` + `OF` as the delimiter. It then treats the standalone apostrophe as an opening shell quote and swallows the subsequent invocation. Bash joins the lines first: `E<TAB>OF` is not the delimiter, the apostrophe remains harmless heredoc text, and the final `codex` command executes.

   **Evidence:** the parent rejects this input; `20a6b41` returns no issues. A real Bash run with harmless `cat` and `codex` function stubs confirmed that the invocation is reached.

   **Impact:** a prohibited model invocation bypasses the registry guard. **Fix/verification:** join physical lines before stripping leading tabs from the completed logical line; this input must produce a denial.

2. **The new trailing-backslash regex can exhaust the hook timeout and fail open.**  
   Location: [claude/hooks/model-guard.cjs:102](/<workdir>/claude/hooks/model-guard.cjs:102). ID: `heredoc-regex-timeout`; category: resource exhaustion.

   `/\\*$/` takes quadratic time on a long run of backslashes followed by a non-backslash. Nested unquoted heredocs repeatedly inspect that line. This JavaScript constructs a triggering Bash command:

   ```javascript
   let body = "\\".repeat(20000) + "x";
   for (let i = 0; i < 24; i++)
     body = `$(cat <<E${i}\n${body}\nE${i}\n)`;
   const command =
     `cat <<OUT\n${body}\nOUT\ncodex exec -m gpt-0-unapproved -`;
   ```

   **Evidence:** this **20,460-character** input took **6,184 ms** in the committed guard versus approximately **1 ms** in its parent. It stays below the configured depth and character limits. The hook timeout is **five seconds**, and the repository documents timeout behavior as allowing the tool call.

   **Impact:** the guard cannot emit its denial before the fail-open timeout, allowing the prohibited invocation through. **Fix/verification:** count trailing backslashes with a linear backward scan and budget lexer work; the payload must be denied within the timeout.

3. **Continuation-created command substitutions remain invisible inside heredoc bodies.**  
   Location: [claude/hooks/model-guard.cjs:109](/<workdir>/claude/hooks/model-guard.cjs:109). ID: `heredoc-split-substitution`; category: input validation. **Existing issue left open.**

   ```bash
   cat <<EOF
   $\
   (codex exec -m gpt-0-unapproved -)
   EOF
   ```

   The change joins lines for delimiter recognition but passes the original, unnormalized body to the substitution scanner. That scanner never sees contiguous `$(`. Bash removes the backslash-newline first and executes the resulting command substitution.

   **Evidence:** both the parent and `20a6b41` return no issues. A real Bash run with a harmless `codex` function stub confirmed execution.

   **Impact:** another prohibited model invocation bypasses the guard without requiring a timeout. **Fix/verification:** normalize unquoted heredoc continuations before scanning expansions; this input must produce a denial.

4. **A model can suppress a failed evaluation by claiming a sandbox outage.**  
   Location: [claude/models/eval/run.cjs:490](/<workdir>/claude/models/eval/run.cjs:490). ID: `forged-sandbox-outage`; category: integrity/trust boundary.

   Failing scenario: the model leaves the `fix-pagination` fixture unchanged, exits normally, and returns:

   ```text
   The Windows sandbox backend is unavailable.
   ```

   The fixture’s check fails, but `changed.length === 0` now permits the model-controlled sentence to replace that measured failure with `environmentError` and `pass: null`. No independent evidence establishes that the model’s sandbox failed.

   **Evidence:** replaying the exact `evaluateIn` function with in-memory filesystem/process stubs produced `checkPassed: false, pass: false` in the parent and `checkPassed: false, pass: null` in this commit. The same override also applies to `checkTimedOut: true`.

   **Impact:** the evaluated model can hide failed or timed-out checks as infrastructure outages, corrupting evaluation evidence. This suppresses failure; it does **not** produce `pass: true`. **Fix/verification:** require independent runner-observed infrastructure evidence; a successful model process returning this sentence must retain its failed result.

**Reviewed:** all five changed files and relevant guard/runner context at `20a6b41`. **Not reviewed:** live Claude hook timeout handling or real model runs. **Assumptions:** the configured five-second timeout follows the fail-open behavior documented in the repository. **Tools run:** Git inspection, file-free Node probes, and harmless Bash function stubs. No repository files were changed.