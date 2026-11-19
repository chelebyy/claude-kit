- **Critical — [checkout.js:10](checkout.js:10):** `user.role = 'admin'` assigns the role instead of comparing it. The assigned string is truthy, so a non-admin user can refund any order, including another user’s unpaid order. It also changes the user object’s role in memory.

- **Medium — [checkout.js:5](checkout.js:5):** Negative discounts are accepted. For example, `applyDiscount(100, -10)` returns `110`, increasing the price by $10.

- **Medium — [checkout.js:16](checkout.js:16):** Floating-point arithmetic can produce an incorrect monetary total. For example, `orderTotal([{price: 0.1, qty: 1}, {price: 0.2, qty: 1}], 0)` returns `"0.30000000000000004"` instead of `"0.30"` or `"0.3"`.