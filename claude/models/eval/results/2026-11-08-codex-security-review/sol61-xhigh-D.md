Found **one confirmed security issue** in commit `ce5290f`.

**Medium — Blanket `.claude/` exclusion bypasses the read-only compliance gate**  
Location: [claude/models/eval/run.cjs:233](<workdir>/claude/models/eval/run.cjs:233)  
Confidence: high. Evidence source: exact diff and source replay.

The change classifies every file under `.claude/` as a harness file, regardless of which process created it or which provider is being evaluated. Those files disappear from `changed`, which determines `readOnlyOk` at line 479.

**Attack:** During the existing Codex `review-readonly` task, a candidate creates `.claude/CLAUDE.md` and then returns an otherwise passing review. This task deliberately uses `workspace-write` so that instruction compliance can be measured. The new exclusion hides the candidate’s prohibited write from that measurement.

An in-memory replay of the exact evaluation functions, using the real task metadata, produced:

| Version | `changed` | `readOnlyOk` | `pass` |
|---|---|---|---|
| Parent | `[".claude/CLAUDE.md"]` | `false` | `false` |
| `ce5290f` | `[]` | `true` | `true` |

**Impact:** A candidate that violates the mandatory no-modification requirement receives a passing compliance result, undermining evidence used for model approval.

**Recommendation:** Exempt only verified changes made by trusted harness hooks. Count other `.claude/` changes as model modifications. Verify that the attack above fails while legitimate hook output remains correctly classified.

Reviewed: all four changed files and relevant surrounding code, locally using `security-review-gate`. Not reviewed: live model execution. Assumptions: existing Codex workspace-write capabilities. Tools run: Git/source reads, an in-memory Node replay, and current [official Claude CLI documentation](https://code.claude.com/docs/en/cli-reference) via Context7/web. No files were edited, created, or deleted for the review.