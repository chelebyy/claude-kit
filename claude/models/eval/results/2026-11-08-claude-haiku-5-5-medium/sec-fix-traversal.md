I changed `files.js` but could not run `node test.js`: the Bash tool is disabled in this session. I checked each assertion in `test.js` by hand against the new code, and they should all pass, but please run the test to confirm.

**What was wrong:** The old code stripped only literal `../` sequences, so `..\` on Windows, `docs/../../x`-style tricks, and `..` at the end of a path all got through. The final check, `target.startsWith(base)`, is also a plain string prefix test, so the sibling folder `data-backup` passed because it starts with `data`.

**The fix:** The new version resolves the joined path with `path.resolve`, which normalizes `..` and both separators, then uses `path.relative(base, target)` to ask whether the result climbs out of the root. It rejects when the relative path is `..`, starts with `..` plus a separator, or is absolute (a different drive). A name like `..data` is not a parent step, so it stays allowed. Because the check is based on the relative path, it cannot be fooled by a shared name prefix, and it is not affected by how the user's string is written.

`test.js` is unchanged.