I fixed two bugs in `paginate.js`, but I couldn't run `node test.js` because the Bash tool is disabled in this session. I traced the test cases by hand and they should pass, but that isn't a real run.

**Root cause:** the page count used `Math.floor` where it needed `Math.ceil`, so a partial last page was dropped (10 items at size 3 gave 3 pages, not 4). The start index was `page * pageSize` instead of `(page - 1) * pageSize`, which skipped the first page because pages start at 1.

Please run `node test.js` yourself to confirm. `test.js` is unchanged.