Found **three medium-severity bypasses** in the model guard in commit `20a6b41`. Each can allow a shell tool call using an unapproved model to pass the guard.

1. **Medium — Guard can time out on a heredoc line.** [model-guard.cjs:102](/<workdir>/claude/hooks/model-guard.cjs:102)

   The trailing-backslash regex takes quadratic time when a long run of backslashes is followed by a non-backslash. Put such a line in an unquoted heredoc, followed by a `codex exec -m <unapproved-model>` command: the input remains below the four-million-character scan budget, but can make the hook exceed its five-second timeout. The documented timeout behavior allows the tool call through.

   The regex took 33 ms for 10,000 backslashes, 118 ms for 20,000 and 461 ms for 40,000 in a local probe. The full hook timeout was not exercised. Count trailing backslashes from the end of the line instead.

2. **Medium — Tab stripping can produce a false heredoc delimiter.** [model-guard.cjs:101](/<workdir>/claude/hooks/model-guard.cjs:101)

   For `<<-EOF`, the guard strips leading tabs from *each physical line* before joining continued lines. Bash joins first, then strips leading tabs from the resulting logical line. For example, `E\` followed by a line beginning with a tab and `OF` is not Bash’s `EOF` delimiter, but the guard treats it as one. A subsequent unmatched quote in the real heredoc body can then hide a `$(codex exec -m <unapproved-model> -)` substitution from the guard while Bash executes it.

   The commit’s guard returned no issues for this input. Join physical lines before stripping leading tabs and comparing the delimiter.

3. **Medium — A substitution formed across a continuation is missed.** [model-guard.cjs:109](/<workdir>/claude/hooks/model-guard.cjs:109)

   The delimiter search accounts for unquoted heredoc line continuations, but the body scanner receives the original physical lines. A `$` followed by backslash-newline and then `(codex exec -m <unapproved-model> -)` becomes `$(` when Bash removes the continuation. The scanner does not see `$(` and permits the call. This issue remains open in the changed heredoc handling.

   The commit’s guard returned no issues for this input. Apply heredoc continuation processing before scanning the body for substitutions.

**Verification limit:** Git Bash could not start in this environment, so the two shell parsing scenarios were checked against the guard and the code’s documented Bash behavior, but were not executed end to end. No files were edited.