Found **two introduced security-control bypasses and one existing fail-open path left open in the modified guard**.

1. **Medium — Bash backtick comments hide subsequent commands.**  
   **Location:** [claude/hooks/model-guard.cjs:98](/<workdir>/claude/hooks/model-guard.cjs:98)  
   **Attack input:**
   ```bash
   echo `# comment`; codex exec -m gpt-6.1-terra -
   ```
   The new comment loop consumes everything through the next newline, including the closing backtick and subsequent command. Bash closes the backtick substitution and executes the subsequent `codex` invocation. Consequently, the guard returns no issues for an unapproved model.

   **Evidence:** The parent commit rejects this input; `7bfffb3` allows it. Real Bash execution with a harmless `codex` function confirmed the invocation executes.  
   **Fix/verification:** Preserve backtick-substitution boundaries when skipping comments; add a regression asserting this input is denied.

2. **Medium — PowerShell carriage-return line endings bypass inspection.**  
   **Location:** [claude/hooks/model-guard.cjs:98](/<workdir>/claude/hooks/model-guard.cjs:98)  
   **Attack input**, shown as a JSON string where `\r` represents an actual carriage return:
   ```json
   "# comment\rcodex exec -m gpt-6.1-terra -"
   ```
   PowerShell treats the carriage return as the end of the comment and executes `codex`. The guard only recognizes `\n`, so it discards the executable command as comment text. This bypasses the model approval control.

   **Evidence:** The parent commit rejects this input; `7bfffb3` returns no issues. Real PowerShell execution with a harmless stub confirmed execution.  
   **Fix/verification:** Recognize PowerShell’s carriage-return line endings and verify denial with CR, LF, and CRLF regression cases.

3. **Medium — Quadratic option scanning exceeds the fail-open hook timeout.**  
   **Location:** [claude/hooks/model-guard.cjs:250](/<workdir>/claude/hooks/model-guard.cjs:250), particularly resetting `seen.bash` at line 260; [claude/settings.fragment.json:307](/<workdir>/claude/settings.fragment.json:307).  
   **Attack input construction:**
   ```javascript
   "false && " + "sh -o ".repeat(40000) +
     "; codex exec -m gpt-6.1-terra -"
   ```
   Each `sh` triggers another scan over the remaining option/value pairs. The `false &&` prevents execution of the padding, while the command after `;` remains executable.

   **Evidence:** Checking this 240,040-character input took **13.53 seconds**, exceeding the configured **five-second timeout**. The repository documents that hook timeouts permit the tool call without a denial. Thus, an attacker-controlled tool command can exhaust the inspection window and bypass approval enforcement. This path predates the commit and remains open.  
   **Fix/verification:** Bound parsing work and return an explicit denial before the hook deadline; verify oversized inputs fail closed. The timing was measured directly; Claude Code’s host timeout behavior was not independently exercised.

**Reviewed:** All five changed files and relevant guard/runner context at `7bfffb3`. No exploitable finding in the result-preservation changes.  
**Tools run:** Read-only Git inspection, in-memory Node probes, and harmless shell stubs. No files were edited, created, or deleted.