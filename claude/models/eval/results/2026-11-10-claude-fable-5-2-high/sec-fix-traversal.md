I fixed `resolveInside` in `files.js`, but I have no shell tool in this session, so I could not run `node test.js`; I only traced each test case by hand, and all should pass.

**What was wrong:** the old code tried to sanitise the string by deleting `../`. That missed Windows `..\` steps and mangled legitimate names like `....//data-backup`. Its `startsWith(base)` check was a plain string-prefix test, so a sibling folder such as `data-backup` counted as inside `data`.

**Why the new version is safe:** it no longer edits the input. `path.resolve` normalises it (both separators, `..` steps, absolute paths, drive letters), and `path.relative(base, target)` then gives the route from the root to the result. The path is rejected if that route is `..`, starts with `..` plus a separator, or is absolute (another drive or UNC share), so the check works on whole path segments rather than characters. It also rejects non-string input and NUL bytes.

The check is purely lexical: a symlink inside the root that points outside it would still be followed. If untrusted users can create links there, the caller needs an `fs.realpath` check on top.