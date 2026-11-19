I found 5 bugs in `checkout.js`. The worst is line 10, which lets every user refund any order.

### 1. `checkout.js:10`: assignment instead of comparison (critical)
`if (user.role = 'admin')` sets `user.role` to `'admin'` instead of comparing it. The string `'admin'` is truthy, so the function always returns `true`.
- **Input:** `canRefund({ id: 2, role: 'customer' }, { userId: 1, status: 'refunded' })` returns `true`. Any user can refund any order, including other people's orders and orders already refunded or not yet paid.
- **Side effect:** the caller's `user` object now has `role === 'admin'`. Any later permission check in the same request that uses this object will also treat the user as an admin, so the damage spreads past refunds.
- **Fix:** `user.role === 'admin'`.

### 2. `checkout.js:5`: negative and non-numeric percents are not rejected (high)
The check only rejects values above 100.
- **Negative input:** `applyDiscount(100, -50)` returns `150`. A negative "discount" adds a surcharge. If the percent comes from a coupon or request field, this changes charges without anyone noticing.
- **Missing or non-numeric input:** `undefined > 100` and `NaN > 100` are both `false`, so the check passes. Then `orderTotal(lines)` (no discount argument) returns `"NaN"`. A string percent such as `'10'` gets converted to a number and works by accident.
- **Fix:** `if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw ...`, or default `discountPercent = 0`.

### 3. `checkout.js:16–17`: decimal rounding errors in money (medium)
Prices are stored as dollars in ordinary JavaScript numbers, which can't represent most cents exactly, and the result is never rounded before `.toString()`.
- **Input:** `orderTotal([{ price: 0.1, qty: 3 }], 0)` returns `"0.30000000000000004"`.
- **Input:** `orderTotal([{ price: 19.99, qty: 1 }], 15)` returns `"16.9915"`.
- These strings can be shown to customers or sent to a payment provider, which may reject them or round them differently than your records. Totals that are off by a cent cause reconciliation problems.
- **Fix:** work in whole cents, or at least round to 2 decimals (`Math.round(x * 100) / 100`, then `.toFixed(2)`).

### 4. `checkout.js:16`: line items are not validated (medium, if `lines` comes from the client)
`price` and `qty` are used without any checks.
- **Input:** `[{ price: 500, qty: 1 }, { price: 500, qty: -1 }]` gives a total of `"0"`. A negative `qty` or `price` lowers the total.
- **Input:** a missing `qty` makes the total `"NaN"`.
- **Fix:** reject values that aren't finite numbers, and reject negative values. Ideally, look up `price` on the server.

### 5. `checkout.js:17`: the total is returned as a string (low)
`applyDiscount` returns a number, but `orderTotal` returns a string.
- **Input:** `orderTotal(a) + shipping` gives `"50" + 5`, which is `"505"`, not `55`.
- **Fix:** return a number and format it only when displaying it.