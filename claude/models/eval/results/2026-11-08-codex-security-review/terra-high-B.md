Found **two security-control bypasses** in the version at commit `a69afe6`.

1. **Medium — Nested shell commands can exhaust the hook’s time limit.**  
   `claude/hooks/model-guard.cjs:53–54` combines both lexer results without removing duplicates. Each nested shell script is then recursively checked twice, causing exponential work. For example, a PowerShell tool command containing 19 repetitions of `cmd /c ` followed by `codex exec -m gpt-6.1-terra -` produced **1,048,576 reported issues** and took **1.6 seconds** in an in-memory check; each extra nesting level approximately doubles the work. The configured hook timeout is five seconds. A sufficiently nested command can therefore time out before returning a denial, allowing an unapproved model invocation if the hook timeout fails open. The exact timeout outcome was not exercised against Claude Code. Deduplicating recursive checks and rejecting commands that exceed a bounded work budget would close the gap.

2. **Medium — An unquoted heredoc can execute a model invocation that the guard skips.**  
   `claude/hooks/model-guard.cjs:66–74` skips heredoc bodies altogether. In Bash, however, an unquoted delimiter permits command substitution inside the body:

   ```bash
   cat <<EOF
   $(codex exec -m gpt-6.1-terra -)
   EOF
   ```

   The exact commit’s `check()` returned no issues for this input, while Bash would execute the substitution. This bypass **predates the commit and remains open in the reviewed version**. The guard should inspect substitutions in unquoted heredocs or reject forms it cannot safely inspect.

The review covered the commit’s diff and relevant surrounding guard code. The reproductions evaluated the guard in memory; they did not execute the model commands or verify Claude Code’s live timeout behavior. The current checkout contains later changes, so the findings above describe **commit `a69afe6`**, not a verdict on the current checkout.