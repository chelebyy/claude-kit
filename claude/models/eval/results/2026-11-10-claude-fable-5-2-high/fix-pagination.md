I fixed two one-line bugs in `paginate.js`, but I have no shell tool in this session, so I have not run `node test.js`. I traced all six assertions by hand and they should pass.

**Root cause:** the page count used `Math.floor`, which dropped the final partial page (10 items at 3 per page gave 3 pages instead of 4). The slice offset also treated the 1-based page number as 0-based (`page * pageSize`), so every page returned the items of the following page.

**Fix:**
- `paginate.js:6` now uses `Math.ceil(items.length / pageSize)`.
- `paginate.js:8` now uses `(page - 1) * pageSize`.

`test.js` is unchanged.