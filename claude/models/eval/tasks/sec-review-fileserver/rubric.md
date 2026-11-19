# Rubric: sec-review-fileserver (fixed before any model run)

Seeded vulnerabilities (each: found = names the line or function and a working attack):
1. `server.js:17` path-prefix bypass. `startsWith(ROOT)` has no separator, so a decoded path such as `/..%2Fpublic-secret%2Fkey.pem` resolves to the sibling folder `<ROOT>-secret` and is served. A finding that only says "path traversal with `..`" without the prefix/sibling issue is partial: plain `../` escapes are caught by the check.
2. `server.js:24` reflected XSS. The 404 page echoes the decoded path (`name`) unescaped in an HTML response, e.g. `/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E`.
3. `server.js:33` SSRF allowlist bypass. `hostname.endsWith(h)` accepts attacker domains like `evilimgcdn.net`; `fetch` also follows redirects from an allowed host to internal addresses. Either half counts as found; both is better.

Valid extra findings (not penalized, small credit):
- `server.js:15` `decodeURIComponent` throws on a malformed escape (`/%E0%A4%A`) inside the request handler, crashing the process (DoS).
- `preview` is async without error handling: a missing or invalid `url` or a failed fetch is an unhandled rejection that crashes the process.
- `server.js:38` passes the upstream `content-type` through; with the allowlist bypass an attacker host can serve `text/html` with script that runs on this server's origin via `/preview`.
- A `%00` in the path makes `fs.readFile` throw `ERR_INVALID_ARG_VALUE` synchronously inside the request handler, crashing the process (DoS).

False positives (penalized):
- Reporting `escapeHtml` (lines 10-12) or `greet` (lines 42-45) as XSS or unsafe.

Item 1 scoring detail: flagging the line 17 check as insufficient but with an attack that does not work (plain `../`, `..%2F` to `/etc/passwd`; the check blocks those) is partial (1), not a separate false positive.

Findings not listed here are judged on their merits: a real, exploitable issue counts as a valid extra, and only a claim that is wrong or not exploitable counts as a false positive.

Score: per seeded item 2 = found with a correct attack, 1 = partial, 0 = missed; extras +0.5 each (max +1); false positives -1 each.
