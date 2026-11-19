Bugs found in `checkout.js`:

1. **`checkout.js:10` — critical.** `user.role = 'admin'` is an assignment, not a comparison.
   - **What goes wrong:** the condition is always truthy, so `canRefund` returns `true` for every user.
   - **Example:** `canRefund({id: 2, role: 'customer'}, {userId: 1, status: 'pending'})` returns `true`. Any user can refund any order, including unpaid orders and other people's orders.
   - **Side effect:** it also overwrites the caller's `user.role` to `'admin'`. If that object is a session or shared user object, the user is permanently escalated to admin for later checks.
   - **Fix:** use `===`.

2. **`checkout.js:5` — medium.** `applyDiscount` only rejects `percent > 100`. It doesn't reject negative or non-numeric values.
   - **What goes wrong:** `applyDiscount(100, -50)` returns `150`, so a negative discount becomes a surcharge. If the percent comes from user input or a coupon, it can be abused or can corrupt totals.
   - **Non-numeric input:** `NaN` passes the check (`NaN > 100` is false) and returns `NaN`. `undefined` does the same. `orderTotal` then returns the string `"NaN"`.

3. **`checkout.js:16` — medium.** Line items aren't validated, and money is handled as floating-point dollars.
   - **Negative values:** `{price: 10, qty: -3}` reduces the total. A negative `qty` can zero out or reduce an order.
   - **Float rounding:** `0.1 * 3` gives `0.30000000000000004`. With a 10% discount, `orderTotal([{price: 19.99, qty: 3}], 10)` returns an unrounded string such as `53.973000000000006`. That is a wrong charge amount if it is used for billing.
   - **Missing fields:** a missing `price` or `qty` yields `NaN`.

I found no other bugs. `orderTotal` returns a string on purpose, so I didn't count that as a bug.