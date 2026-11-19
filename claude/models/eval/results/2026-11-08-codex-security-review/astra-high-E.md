Found **two exploitable security-control weaknesses** in the heredoc handling reviewed at commit `20a6b41`: one introduced by the commit and one left open.

1. **Medium — Quadratic regex processing can time out the guard and bypass enforcement.**  
   Location: [claude/hooks/model-guard.cjs:102](/<workdir>/claude/hooks/model-guard.cjs:102)  
   **Introduced by this commit.**

   The new `/\\*$/` expression repeatedly scans a backslash run when a non-backslash character follows it. Processing becomes quadratic, and neither scan budget interrupts this regex.

   **Attack input:** a Bash command constructed as:
   ```js
   'cat <<EOF\n' + '\\'.repeat(120000) +
   'x\nEOF\ncodex exec -m gpt-0-unapproved -'
   ```
   The input stays below the four-million-character budget. In bounded probes, this commit exceeded **6 seconds** and was interrupted; the parent rejected the same command in approximately **1 ms**. The hook has a **5-second timeout** in `claude/settings.fragment.json:307`, and the repository documents that timeout permits the tool call.

   **Impact:** someone controlling a Bash tool command can exhaust the guard before it denies the trailing unapproved-model invocation.

   **Recommendation:** count trailing backslashes with a backward linear scan, with bounded work. Verify that this input receives an explicit denial within the hook timeout.

2. **Medium — Continued heredoc lines can conceal an executable command substitution.**  
   Location: [claude/hooks/model-guard.cjs:109](/<workdir>/claude/hooks/model-guard.cjs:109), following the new joining logic at lines 102–103.  
   **Pre-existing weakness left open by this commit.**

   The change joins lines when identifying the delimiter, but passes the original, unjoined body to `lexOnce`. Bash also removes backslash-newline continuations before expanding the body.

   **Attack input:**
   ```bash
   cat <<EOF
   $\
   (codex exec -m gpt-0-unapproved -)
   EOF
   ```
   The guard returns `[]`—no denial—in both this commit and its parent. Bash joins `$` and `(` and executes the command substitution. I verified execution using a harmless local `codex` function that printed its arguments; no actual model was launched.

   **Impact:** an unapproved-model invocation escapes inspection inside an unquoted heredoc.

   **Recommendation:** apply Bash-compatible continuation handling to the body before scanning substitutions. Verify that the example is denied while quoted heredoc bodies remain literal.

Both findings have **high confidence**, based on the exact commit’s code, its diff, and runtime probes.

**Reviewed:** all five changed files and relevant surrounding guard, hook configuration, and evaluation-result logic.  
**Not reviewed:** unrelated repository code; live Claude Code timeout behavior was not exercised.  
**Assumptions:** the timeout finding uses the repository’s documented fail-open timeout behavior.  
**Tools run:** read-only Git inspection, bounded in-memory Node probes, and Bash with a harmless stub. No files were edited, created, or deleted.