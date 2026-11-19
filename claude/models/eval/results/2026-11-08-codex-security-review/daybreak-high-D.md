Found one exploitable security issue in `ce5290f`.

### High — Copied fixture settings can execute arbitrary host commands

- **Location:** `claude/models/eval/run.cjs:125-129`, `claude/models/eval/run.cjs:233-244`, `claude/models/eval/run.cjs:438-447`
- **Category:** Arbitrary command execution / security-boundary bypass
- **Confidence:** High
- **Evidence:** The fixture is recursively copied and used as the working directory for `claude -p`. The arguments restrict built-in tools and MCP servers, but do not disable user, project, or local Claude settings. All `.claude/` changes are subsequently classified as harmless harness files. Claude Code command hooks execute host commands outside the model’s built-in tool allowlist. [`-p` is non-interactive](https://docs.anthropic.com/en/docs/claude-code/cli-usage), while [Claude hooks may run configured shell commands](https://github.com/anthropics/claude-code/blob/v2.1.278/plugins/plugin-dev/skills/hook-development/SKILL.md).
- **Attack/failing input:** Add a `.claude/settings.local.json` to an evaluation fixture containing a `SessionStart` or tool hook that launches PowerShell, Node, or another executable. When the operator runs the evaluation, `fs.cpSync` copies that configuration and `claude -p` starts inside the copied directory. Print mode skips the workspace-trust dialog, so the hook executes as the operator even though `Bash` is absent from `--tools` and MCP servers are disabled. A fix-task model can also write `.claude` configuration; the blanket harness classification prevents that modification from affecting the result.
- **Impact:** Arbitrary code execution with the operator’s privileges, including reading credentials, modifying files outside the evaluation directory, making network requests, or establishing persistence. This breaks the commit’s claimed “no shell” isolation boundary.
- **Recommendation:** Launch Claude without user/project/local setting sources—for example, with `--setting-sources ''` on the reviewed CLI generation—and preferably use the CLI’s restricted/safe customization mode where compatible. Reject executable `.claude` configuration in fixtures, and do not automatically treat model-created `.claude/` files as harmless harness output.
- **Verification:** Use a harmless fixture hook that attempts to write a marker outside the work directory. The corrected runner must either reject the fixture before launch or complete without executing the hook. Separately verify that a model-created `.claude/settings.local.json` is reported as a policy violation rather than ignored.

No other real, exploitable issues were found in the commit.

- **Reviewed:** Exact `git show ce5290f` diff, relevant surrounding `run.cjs` control flow, task definitions, and Claude Code CLI 2.1.319 permission/customization behavior.
- **Not reviewed:** Later commits and live model execution; the latter would create evaluation outputs and temporary files, contrary to the read-only instruction.
- **Tools run:** `git show`, `git ls-tree`, read-only Git comparisons/status, `claude --version`, `claude --help`, and Claude Code v2.1.278 documentation through Context7.
- **Repository state:** Clean; no repository files were changed, created, or deleted.