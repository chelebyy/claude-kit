I found two critical-to-high bugs and two medium ones in `checkout.js`. Nothing was edited.

1. **`checkout.js:10`: critical.** `if (user.role = 'admin')` is an assignment, not a comparison. The expression is always truthy, so `canRefund` returns `true` for every user. Input: `canRefund({id: 1, role: 'customer'}, {userId: 2, status: 'paid'})` returns `true`, so any user can refund any order. The line also overwrites `user.role` with `'admin'` on every call. Fix: `===`.

2. **`checkout.js:5`: high.** The guard only rejects `percent > 100`, so negative percentages pass through and raise the price. Input: `applyDiscount(100, -50)` returns `150`, and `applyDiscount(100, -100)` returns `200`. `orderTotal` passes the value straight through, so a negative discount inflates a checkout total. The guard needs a lower bound of 0.

3. **`checkout.js:6` and `checkout.js:17`: medium.** The totals are computed in binary floating point and returned via `.toString()`, so cents can be wrong. Input: `orderTotal([{price: 0.1, qty: 3}], 0)` returns `"0.30000000000000004"`. Using integer cents, or rounding to two decimals before returning, would fix this.

4. **`checkout.js:5`, `checkout.js:17`: low.** A missing or non-numeric `discountPercent` is not rejected. `percent > 100` is false for `undefined`, so `applyDiscount(100, undefined)` returns `NaN`, and `orderTotal` returns the string `"NaN"`. The function should validate that `percent` is a finite number in `[0, 100]`.

No other bugs found. The `total` accumulation at line 16 has no input validation, but I did not count negative or non-numeric quantities as bugs on their own.