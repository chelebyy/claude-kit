Found two bugs, reproduced with Node:

1. **High — Refund authorization always succeeds** — [checkout.js:10](<workdir>/checkout.js:10)  
   `user.role = 'admin'` assigns the role and evaluates to a truthy string. For `user = { id: 'a', role: 'customer' }` and `order = { userId: 'b', status: 'unpaid' }`, `canRefund` returns `true` and changes the customer’s role to `admin`. Any caller relying on this check permits unauthorized refunds.

2. **Medium — Negative discounts increase the charge** — [checkout.js:5](<workdir>/checkout.js:5)  
   The validation rejects percentages above 100 but accepts negative percentages. `applyDiscount(100, -10)` returns `110`, so an invalid discount silently adds $10 to the charge. The same value propagates through `orderTotal`.

No files were edited, created, or deleted.