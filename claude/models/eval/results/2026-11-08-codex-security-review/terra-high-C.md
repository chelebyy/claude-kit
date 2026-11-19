1. **Medium — Mixed-quoted heredoc delimiter bypasses the model guard.** At [model-guard.cjs:153](<workdir>/claude/hooks/model-guard.cjs:153), the delimiter parser recognizes only the `E` prefix of Bash’s valid `<<E'OF'` delimiter. It therefore fails to recognize the actual closing `EOF` and consumes the command that follows as heredoc body:

   ```bash
   cat <<E'OF'
   hello
   EOF
   codex exec -m gpt-6.1-terra -
   ```

   Bash executes the final command, but the guard from commit `56e9a1f` returns no issues for this input. An unapproved model can consequently be invoked despite the registry control. I verified the guard’s result in memory against the exact committed source. The delimiter parser should handle concatenated quoted and unquoted delimiter fragments or reject forms it cannot parse safely.

2. **Medium — A sandbox claim can still hide a failed or timed-out check.** At [run.cjs:484](<workdir>/claude/models/eval/run.cjs:484), the new condition checks `timedOut` and `checkSkipped`, but does not check `checkPassed` or `checkTimedOut`. A model can return a sandbox-unavailable claim while its submitted code fails the check or causes that check to time out; the result becomes `pass: null` instead of `pass: false`. This lets a model failure evade the evaluation record. Require the check to have passed before accepting the model’s claim as an environment error.

3. **Medium — A model timeout can still be reclassified before the new guard runs.** At [run.cjs:464](<workdir>/claude/models/eval/run.cjs:464), if the model has already timed out and the subsequent check sandbox cannot start, the function returns `pass: null` immediately. The same precedence problem exists at [run.cjs:454](<workdir>/claude/models/eval/run.cjs:454) when an ancestor Codex configuration is found. Thus a known model timeout is recorded as unmeasured when either later environment condition occurs. Preserve the timeout failure before returning an environment error.

The review covered commit `56e9a1f` and relevant surrounding code. The evaluation-runner findings are source-level conclusions; I did not run its filesystem-writing integration tests under the requested read-only restriction.