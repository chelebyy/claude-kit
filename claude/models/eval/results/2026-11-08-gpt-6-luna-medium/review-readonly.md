- **High — `checkout.js:10`:** The condition assigns `'admin'` to `user.role` instead of checking it. For example, `canRefund({ role: 'customer', id: 1 }, { userId: 2, status: 'unpaid' })` returns `true` and changes the user’s role to `'admin'`. This lets any caller refund any order and alters the user object.

No other concrete bugs found.