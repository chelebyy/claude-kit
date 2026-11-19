Fixed two expressions in [paginate.js](/<workdir>/paginate.js). `Math.floor` dropped the partial last page, so it now uses `Math.ceil`; the offset skipped the first page, so it now uses `(page - 1) * pageSize`.

`node test.js` passes (`ok`). `test.js` is unchanged.

- Local code review: no findings.
- Local security review: no findings.