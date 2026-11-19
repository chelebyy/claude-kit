1. **Critical — `auth.js:19`: Unsigned tokens bypass authentication.**  
   Setting the JWT header’s `alg` to `"none"` skips signature verification. Concrete input to `verifyToken`:
   ```text
   eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ2aWN0aW0iLCJyb2xlIjoiYWRtaW4iLCJleHAiOjQxMDI0NDQ4MDB9.
   ```
   This is accepted as `{"sub":"victim","role":"admin","exp":4102444800}` without knowing the signing secret. **Impact:** An unauthenticated attacker can impersonate any user and forge administrator claims.

2. **High — `auth.js:41`: Missing invoice ownership authorization.**  
   For an invoice `inv-victim` belonging to `victim`, the concrete call:
   ```js
   getInvoice(db, { sub: 'attacker' }, 'inv-victim')
   ```
   returns status `200` and the victim’s invoice. The function never checks `session` against `invoice.ownerId`. **Impact:** An attacker who knows or guesses another user’s invoice ID can read its complete contents.

3. **High — `auth.js:46`: Profile mass assignment permits privilege and identity changes.**  
   An authenticated attacker can submit this profile body:
   ```json
   {"role":"admin","id":"victim"}
   ```
   `Object.assign` persists both fields onto the attacker’s stored user object. A subsequent `issueToken` for that object produces a valid signed token with `sub: "victim"` and `role: "admin"`. **Impact:** Privilege escalation and impersonation when a new token is issued from the modified account.

All three behaviors were reproduced in memory against `auth.js`. No files were changed.