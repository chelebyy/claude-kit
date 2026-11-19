Fixed [paginate.js](<workdir>/paginate.js). The page count rounded down and omitted a partial final page, while the slice offset treated one-based page numbers as zero-based.

`node test.js` now passes, and `test.js` is unchanged.

- Local code review: no findings.
- Local security review: no findings; limited to the changed code.