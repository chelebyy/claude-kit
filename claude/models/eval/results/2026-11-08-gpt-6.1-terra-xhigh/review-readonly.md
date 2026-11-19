- **High — [checkout.js:10](<workdir>/checkout.js:10):** The condition assigns `'admin'` to `user.role` instead of comparing it. A customer requesting a refund for another user’s unpaid order receives `true`, and their role object is also changed to admin.

- **Medium — [checkout.js:6](<workdir>/checkout.js:6):** Negative discounts increase the price. For example, `applyDiscount(100, -10)` returns `110`.

- **Medium — [checkout.js:16](<workdir>/checkout.js:16):** Floating-point arithmetic produces an incorrect dollar total. For example, three items priced at `$0.10` result in the string `"0.30000000000000004"` instead of `$0.30`.