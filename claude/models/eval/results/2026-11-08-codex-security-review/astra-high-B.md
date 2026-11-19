Found **two security issues introduced by `a69afe6`**.

1. **Medium — Duplicate parsing causes exponential work and a fail-open timeout**  
   **Location:** [claude/hooks/model-guard.cjs:54](/<workdir>/claude/hooks/model-guard.cjs:54)  
   **Failing input:** A PowerShell command consisting of `cmd /c ` repeated **24 times**, followed by `codex exec -m gpt-6.1-terra -`.

   Both lexer passes return identical commands for this input. `invocations()` recursively processes both copies at every nested shell level, producing exponential work despite remaining below `MAX_DEPTH = 32`.

   **Evidence:** The parent commit checked this input in approximately **0.6 ms**, returning one finding. `a69afe6` exceeded a **5.5-second** execution limit. At 20 wrappers, it produced **2,097,152 duplicate findings**. The hook’s configured timeout is **5 seconds** (`claude/settings.fragment.json:307`), and the repository documents that hook timeouts allow the tool call through.

   **Impact:** A short command can exhaust the guard before it emits a denial, allowing an unapproved model invocation.

   **Recommendation / verification:** Deduplicate commands before recursive inspection and enforce a shared parsing-work budget that returns a denial when exhausted. Verify nested inputs below the depth limit finish within the hook timeout or explicitly deny.

2. **Medium — Combining real and misidentified comments bypasses both lexer passes**  
   **Location:** [claude/hooks/model-guard.cjs:107](/<workdir>/claude/hooks/model-guard.cjs:107)  
   **Attack input** for the PowerShell tool—the second line uses curly double quotes:
   ```powershell
   # Don't lose this comment
   Write-Host “Step #1”; codex exec -m gpt-6.1-terra -
   ```

   The comment-aware pass skips the first line, then incorrectly treats `#1` inside PowerShell’s quoted string as a comment and discards the invocation. The comment-blind pass treats the apostrophe in `Don't` as an opening quote and consumes the invocation as quoted text.

   **Evidence:** With an unapproved model, the parent commit returned a denial reason; `a69afe6` returned **`[]`**. Executing the input with a harmless PowerShell `codex` stub confirmed that PowerShell calls it with `exec -m gpt-6.1-terra -`. The equivalent Bash input also returned `[]`:
   ```bash
   # Don't lose this comment
   echo ${x:- #}; codex exec -m gpt-6.1-terra -
   ```

   **Impact:** An explicit unapproved-model call passes the guard without an error or timeout.

   **Recommendation / verification:** Recognize the relevant shell quoting and expansion contexts before skipping comments, or deny ambiguous constructs. Add regression coverage combining real comments with these misidentified-comment cases.

Both findings have **high confidence**, concern authorization-control bypasses, and are grounded in the **commit diff, surrounding code, and in-memory reproductions**.

**Reviewed:** All three changed files and relevant hook configuration. **Not reviewed:** Unrelated code; live Claude Code timeout handling was not exercised. **Assumptions:** The configured hook is installed, and the selected model is unapproved. **Tools run:** `git show`, scoped reads/status, Node VM probes, and a harmless PowerShell stub. No files were edited, created, or deleted.