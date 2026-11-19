Found **three medium-severity security issues** in commit `7bfffb3`: two introduced comment-parsing bypasses and one fail-open timeout left open in the affected guard. All line numbers below refer to that commit.

1. **Medium — Bash comment detection hides executable commands** (`bash-comment-bypass`)  
   Location: [claude/hooks/model-guard.cjs:97](/<workdir>/claude/hooks/model-guard.cjs:97)

   Failing input:

   ```bash
   : ${x:- #}; codex exec -m unapproved-model -
   ```

   The lexer treats `#` as a comment because its current word is empty, then skips the remaining command. Bash treats that `#` as part of the parameter expansion and executes the subsequent `codex` call. This also occurs with:

   ```bash
   echo `# comment`; codex exec -m unapproved-model -
   ```

   **Evidence and impact:** The parent commit rejects both inputs; `7bfffb3` returns no issues. Actual Bash execution, using an in-memory `codex` function stub, confirmed that the prohibited call is reached. A caller controlling the Bash command can bypass registry approval.

   **Recommendation and verification:** Account for parameter-expansion and backtick boundaries before skipping comments, or deny syntax that cannot be interpreted safely. Both inputs should produce a denial while ordinary comments remain supported.

2. **Medium — PowerShell comments terminated by CR conceal the following command** (`powershell-cr-bypass`)  
   Location: [claude/hooks/model-guard.cjs:98](/<workdir>/claude/hooks/model-guard.cjs:98)

   Failing tool input, with `\r` representing an actual carriage return:

   ```json
   {
     "tool_name": "PowerShell",
     "tool_input": {
       "command": "# comment\rcodex exec -m unapproved-model -"
     }
   }
   ```

   The new comment loop stops only at LF (`\n`). PowerShell also recognizes a standalone CR as a line terminator, so the shell sees a separate executable command that the guard discards. This matches the [PowerShell 7.6 lexical specification](https://learn.microsoft.com/en-us/powershell/scripting/lang-spec/chapter-02?view=powershell-7.6#222-line-terminators).

   **Evidence and impact:** PowerShell’s native parser recognized the `codex` command without errors. The parent guard rejects it; `7bfffb3` permits it, bypassing model approval.

   **Recommendation and verification:** Recognize CR, LF and CRLF consistently as PowerShell comment and command boundaries. Verify that all three variants deny the prohibited call.

3. **Medium — Quadratic option scanning exceeds the hook timeout and fails open** (`guard-timeout-bypass`; pre-existing, left open)  
   Locations: [claude/hooks/model-guard.cjs:250](/<workdir>/claude/hooks/model-guard.cjs:250), [claude/hooks/model-guard.cjs:260](/<workdir>/claude/hooks/model-guard.cjs:260), [claude/settings.fragment.json:307](/<workdir>/claude/settings.fragment.json:307)

   Construct the Bash command as:

   ```javascript
   'sh -o '.repeat(32000) + '; codex exec -m unapproved-model -'
   ```

   Resetting `seen.bash` after each unsuccessful shell-option search makes subsequent `sh` tokens rescan the remaining suffix. The guard has no cumulative work limit.

   **Evidence and impact:** Checking this 192,034-character input took **9,460 ms**, exceeding the registered **five-second timeout**. A separate in-memory hook process capped at five seconds terminated with `ETIMEDOUT` and **empty stdout**, producing no denial. The hook configuration has no failure-blocking setting; documented `PreToolUse` timeout behavior lets the call continue through normal permissions. Thus a sufficiently large command can bypass the model guard. [Claude Code hook timeout documentation](https://code.claude.com/docs/en/hooks#timeouts)

   **Recommendation and verification:** Bound cumulative parsing steps and return a denial before timeout; configure failure blocking where supported. The constructed input should be rejected within the hook’s deadline.

All findings have **high confidence**, category `authz`, stage `review`, stack `common-web` applied to a Node CLI hook, and `evidence_source: code`.

- **Reviewed:** All five changed files and relevant surrounding guard, runner and hook-configuration code. No exploitable security issue found in the result-merging changes.
- **Not reviewed:** Live Claude Code execution of prohibited model calls or an end-to-end Claude timeout.
- **Assumptions:** The hook configuration at `7bfffb3` is used, and the requested model is unapproved.
- **Tools run:** `git show 7bfffb3`, parent comparisons, in-memory Node probes, native PowerShell parsing, harmless Bash stubs and bounded timing probes. No file was created, edited or deleted.