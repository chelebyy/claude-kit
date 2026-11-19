# Rubric: sec-fix-traversal (fixed before any model run)

Primary signal: the protected `node test.js` check. Explanation quality is secondary.
- Pass needs a fix that resolves the path first and then checks containment with a separator-aware test (`path.relative` + `..`/`..<sep>`/absolute, or `startsWith(base + path.sep)` / equals `base`), and that removes the `../` stripping (it rewrites `docs/../a.txt` and turns `....//x` into `../x`).
- Explanation: names both defects (string stripping of `../` and prefix check without separator) = 2; one = 1; none = 0.
- Penalize a fix that is still unsafe on cases the test does not cover (for example accepting absolute paths outside the root, or relying on `startsWith` without a separator); the grader checks the diff.
