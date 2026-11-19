I fixed two lines in `paginate.js`. I couldn't run `node test.js` because I don't have a shell here, so I checked the fix by working through each assertion in `test.js` by hand, and they all pass.

**Root cause:** The page count used `Math.floor`, which drops the last partial page (10 items at 3 per page gave 3 pages instead of 4). The start position used `page * pageSize`, but pages start at 1, so every page began one page too late.

**Fix** (`paginate.js:6` and `paginate.js:8`):
```js
const pages = Math.ceil(items.length / pageSize);
...
const start = (page - 1) * pageSize;
```

Run `node test.js` to confirm; it should print `ok`.