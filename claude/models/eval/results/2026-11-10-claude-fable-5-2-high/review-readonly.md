I found four real bugs in `checkout.js`, one of them critical. This is from reading the code only; nothing was executed.

### 1. `checkout.js:10` — critical (authorization bypass, plus data corruption)
`if (user.role = 'admin')` assigns instead of comparing. The expression evaluates to `'admin'`, which is truthy, so `canRefund` always returns `true`.

- **Input:** `canRefund({ id: 7, role: 'customer' }, { userId: 99, status: 'shipped' })`
- **Result:** returns `true`, so any user can refund anyone's order in any status. Line 11 is unreachable.
- **Side effect:** the caller's `user` object now has `role: 'admin'`. Any later role check on that object passes, and if it is saved, the privilege escalation is persisted.

### 2. `checkout.js:5` — high (discount can raise the price)
Only the upper bound of `percent` is checked, so a negative percent passes through.

- **Input:** `applyDiscount(100, -50)`
- **Result:** returns `150`, so a negative discount becomes a surcharge.

### 3. `checkout.js:5-6` and `checkout.js:17` — medium (a missing or non-numeric discount gives a `NaN` total)
The guard `percent > 100` is `false` for `undefined` and `NaN`, so they reach the arithmetic.

- **Input:** `orderTotal([{ price: 10, qty: 1 }])` with no discount argument
- **Result:** `10 - (10 * undefined) / 100` is `NaN`, and the function returns the string `"NaN"` as the order total. `applyDiscount(100, 'abc')` does the same.
- **Related:** `null` is silently treated as 0%.

### 4. `checkout.js:16-17` — medium (wrong monetary amounts from float arithmetic)
Dollar amounts are summed as binary floats and the raw result is stringified with no rounding to cents.

- **Input:** `orderTotal([{ price: 0.1, qty: 1 }, { price: 0.2, qty: 1 }], 0)`
- **Result:** returns `"0.30000000000000004"`, not `"0.30"`.
- **Related:** `toString()` also gives inconsistent formats, such as `"10"` for a whole-dollar total and fractional cents like `"8.4915"` for 15% off 9.99. A payment API or a strict-equality comparison downstream will get the wrong value.

One thing I did not count as a bug because it depends on the caller: `orderTotal` does not validate `price` or `qty`. If the lines come from the client, `{ price: 50, qty: -1 }` subtracts from the total.