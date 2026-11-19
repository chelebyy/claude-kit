---
name: local-code-review
description: Correctness review of a local git diff (uncommitted work, a branch against its base, or a commit) — CLAUDE.md/AGENTS.md compliance, bugs in the changed lines, git-history context and code-comment guidance, with a confidence filter. Read-only and offline from GitHub. Use for the correctness pass of the pre-delivery review; use local-security-review for the security pass, and do not use this for GitHub pull requests.
---

# Local code review

The `code-review` plugin's pull-request review, adapted to a local diff. It runs inline in one agent: no sub-agents, no `gh`, nothing posted anywhere, no file edits.

## Inputs

- The diff command, e.g. `git diff HEAD`, `git diff --cached`, `git diff <base>...HEAD` or `git show <sha>`. If none was given, use `git diff HEAD` plus the untracked files and say so.
- Untracked files that belong to the change, if the caller listed them. `git diff` never shows untracked files.
- The effort level: `medium`, `high` or `xhigh` (default `medium`).
- What the change is meant to do, if the caller said.

## Process

1. Run the diff command. A bare `git diff` leaves out staged changes, so if you were given one, run `git diff HEAD` instead and say so. When the diff reviews the working tree, also run `git status --short` and `git ls-files --others --exclude-standard`, and read every untracked file that belongs to the change in full as an added file. If the diff fails, or it is empty and there are no such files, stop and report that; it is not the same as "nothing found".
2. Collect guidance: CLAUDE.md, CLAUDE.local.md, AGENTS.md and applicable `.claude/rules/*.md` at the repo root and in every directory, and parent directory, of a changed file. They are guidance for writing code; apply only the rules that bear on this change.
3. State the change's intent in one or two sentences, from the caller's context and the diff.
4. Review the changed lines along four axes:
   - **Guidance:** a changed line breaks a rule from step 2. Quote the rule and name its file.
   - **Bugs:** wrong logic, unhandled error or empty cases, broken contracts with callers, off-by-one, null/undefined, races, leaked resources, wrong types crossing a boundary.
   - **History:** the change undoes an earlier fix, brings back reverted behaviour, or contradicts the reason a commit message gives.
   - **Code comments:** the change violates an invariant, precondition or "must/never" note written in the comments of the modified files.
5. Go as deep as the effort level asks:
   - `medium`: the four axes on the diff; history from `git log` of the changed files.
   - `high`: also `git blame` / `git log -L` on the changed hunks, and read the direct callers and callees of changed functions to check their contracts.
   - `xhigh`: also trace every caller of changed public functions, types and config keys across the repo, and follow the data flow of the changed paths end to end.
6. Before keeping a candidate, reread the code as a sceptic and try to disprove it. Then score it:
   - 0: falls apart under light scrutiny, or is pre-existing.
   - 25: might be real, but you could not verify it.
   - 50: verified real, but a nitpick or rare in practice.
   - 75: verified and very likely to be hit in practice, or directly called out by guidance.
   - 100: certain; the evidence confirms it and it will happen often.

   Keep only candidates scoring 75 or more.

## Not findings

- Pre-existing issues, and issues on lines the diff did not change.
- Something that looks like a bug but is correct.
- Pedantic nitpicks a senior engineer would not raise.
- What a linter, typechecker, compiler or the test suite catches; the caller runs that validation separately.
- General quality concerns such as test coverage or documentation, unless guidance requires them.
- General security hardening, which belongs to the security pass. A concrete, exploitable defect in the changed lines is still a bug: report it.
- Issues the code explicitly silences, e.g. with a lint-ignore comment.
- Behaviour changes that are clearly intended and part of the change.

## Output

If the caller gave a report format, use it. Otherwise list the kept findings, most severe first, each with: score, severity, `file:line`, the defect in one sentence, the concrete failure scenario, the axis with its quoted rule or evidence, and a suggested fix. End with one line saying how many candidates the score filter discarded.
