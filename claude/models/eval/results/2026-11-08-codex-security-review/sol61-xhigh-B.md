Found **two medium-severity security issues** in `a69afe6`. All line references below refer to that commit. Both findings have high confidence and are grounded in the diff, committed source, and targeted execution probes.

1. **Medium — Exponential parsing causes a fail-open hook timeout**  
   Location: [claude/hooks/model-guard.cjs:54](/<workdir>/claude/hooks/model-guard.cjs:54)  
   ID: `model-guard-exponential-timeout` · Category: security-control bypass

   The new `lex()` concatenates both scans without removing duplicate command arrays. `invocations()` then recursively processes each duplicate, doubling work at every nested shell level. The 32-level depth limit does not bound this work.

   A failing PowerShell `tool_input.command` can be constructed as:

   ```js
   "# " + "pwsh -c ".repeat(24) +
   "Get-Date\ncodex exec -m gpt-6.1-terra -"
   ```

   This produces only **232 characters**. The repeated shell names are inside a comment; PowerShell executes only the subsequent Codex command.

   **Evidence and impact:** A five-second harness running the committed hook code timed out after approximately **5,014 ms with empty stdout**, so no denial was emitted. The parent commit denied the identical input in approximately **2 ms**. The committed hook configuration specifies a five-second timeout, and the repository documents that Claude Code permits the tool call when that timeout expires. This therefore bypasses the approved-model control.

   **Recommendation and verification:** Deduplicate lexer results before recursive inspection and impose a shared work budget that produces an explicit denial when exhausted. The reproducer must return `deny` within the configured timeout.

2. **Medium — Both lexer passes can miss the same prohibited invocation**  
   Location: [claude/hooks/model-guard.cjs:107](/<workdir>/claude/hooks/model-guard.cjs:107)  
   ID: `model-guard-combined-comment-bypass` · Category: security-control bypass

   Submit this PowerShell command:

   ```powershell
   # Don't use retired models
   Write-Host “ #”; codex exec -m gpt-6.1-terra -
   ```

   The comment-aware scan does not recognize PowerShell’s smart quotes, so it mistakes the quoted `#` for a comment and discards the Codex invocation. The other scan treats the apostrophe in `Don't` as the start of a string that consumes the remaining input. Combining the two results consequently still misses the call.

   **Evidence and impact:** The committed `check()` returned **`[]`**. Running the same command with a harmless PowerShell function replacing `codex` reached that function with `exec|-m|gpt-6.1-terra|-`. That model has `candidate` status in the committed registry, so the invocation should be denied. This remains an exploitable parsing gap after the change.

   **Recommendation and verification:** Handle PowerShell’s quote semantics correctly or deny syntax that cannot be interpreted reliably. Add a regression combining the apostrophe-bearing comment and smart-quoted hash; it must produce an explicit denial.

**Reviewed:** All three changed files and relevant committed hook configuration and control flow.  
**Not reviewed:** Later commits or live Claude Code timeout handling.  
**Assumptions:** Timeout handling follows the repository’s documented fail-open behavior.  
**Tools run:** Git inspection, in-memory Node probes with parent and positive controls, a bounded timeout harness, and a harmless PowerShell stub. No repository files were changed.