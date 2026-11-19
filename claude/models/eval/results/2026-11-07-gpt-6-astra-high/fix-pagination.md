Fixed two lines in [paginate.js](<workdir>/paginate.js). `Math.floor` dropped the partial last page, and `page * pageSize` skipped the first page; using `Math.ceil` and `(page - 1) * pageSize` corrects both.

`node test.js` now prints `ok`; `test.js` is unchanged.

- Local code review: no findings.
- Local security review: no findings in the two-line change.