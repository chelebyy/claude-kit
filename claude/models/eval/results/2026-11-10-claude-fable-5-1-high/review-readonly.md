Review of `checkout.js` complete. Found one critical bug and a few lower-severity correctness issues.

**Bugs**

- **`checkout.js:10` — critical.** `if (user.role = 'admin')` assigns instead of compares. The expression is always truthy, so `canRefund` returns `true` for every caller, and line 11 never runs. Input: `canRefund({id: 7, role: 'customer'}, {userId: 99, status: 'pending'})` returns `true`. It also mutates the caller's object, setting `user.role` to `'admin'`. If that object is later saved or used for other checks, a regular user is silently promoted to admin.

- **`checkout.js:5` — high.** Only `percent > 100` is rejected. Negative values pass and inflate the total: `applyDiscount(100, -50)` returns `150`. A missing or non-numeric percent also passes: `applyDiscount(100, undefined)` returns `NaN`, so `orderTotal(lines)` with the second argument omitted returns the string `"NaN"`.

- **`checkout.js:17` — medium.** The total is returned via `toString()`, which exposes raw floating-point error and changes the type. Input `orderTotal([{price: 0.1, qty: 3}], 0)` returns `"0.30000000000000004"`. Callers doing arithmetic on the result get string concatenation: `orderTotal(...) + 5` yields `"0.300000000000000045"` rather than a sum.

- **`checkout.js:16` — low.** Line items are not validated. A line with `qty: -1` reduces the total, and a line missing `price` or `qty` turns the whole total into `NaN`. Whether this is exploitable depends on whether line data comes from the client.

**Not a bug but worth knowing:** the `> 100` check at line 5 does catch the one case it targets, and line 11's ownership and status check is correct once line 10 is fixed to `===`.