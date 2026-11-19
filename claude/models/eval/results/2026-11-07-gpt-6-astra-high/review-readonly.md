Found three bugs, reproduced with Node:

- **High — `checkout.js:10`: Refund authorization always succeeds and overwrites the user’s role.** `user.role = 'admin'` assigns a truthy string instead of comparing. For user `{ id: 1, role: 'customer' }` and order `{ userId: 2, status: 'refunded' }`, `canRefund` returns `true` and changes the user’s role to `'admin'`, bypassing both ownership and payment-status checks.

- **Medium — `checkout.js:5`: Negative discounts increase the charge.** The validation only rejects percentages above 100. `applyDiscount(100, -10)` returns `110`, silently applying a surcharge instead of rejecting an invalid discount.

- **Medium — `checkout.js:17`: The order total is converted to a string, breaking numeric addition.** `orderTotal([{ price: 10, qty: 2 }], 0)` returns `"20"`. Adding a numeric shipping charge of `5` produces `"205"` instead of `25`.

No files were changed.