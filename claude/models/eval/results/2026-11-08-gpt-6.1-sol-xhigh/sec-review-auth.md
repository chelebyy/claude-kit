1. **High — Signature verification bypass** — `auth.js:19`  
   Setting the token header to `{"alg":"none"}` skips signature verification. Concrete input to `verifyToken`:

   ```text
   eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ2aWN0aW0iLCJyb2xlIjoiYWRtaW4iLCJleHAiOjQxMDI0NDQ4MDB9.
   ```

   This unsigned token was accepted as `{sub:"victim", role:"admin", exp:4102444800}`. **Impact:** an attacker can impersonate any user and forge administrator claims without knowing `TOKEN_SECRET`.

2. **High — Cross-account invoice disclosure** — `auth.js:41`  
   `getInvoice` returns an invoice without checking `session` or comparing `invoice.ownerId` with the caller. With `INV-200` belonging to `victim`, this input returns the victim’s complete invoice with status `200`:

   ```js
   getInvoice(db, { sub: "attacker", role: "user" }, "INV-200")
   ```

   **Impact:** a caller who knows or guesses another account’s invoice ID can read its invoice data.

3. **High — Privilege escalation through profile mass assignment** — `auth.js:46`  
   An ordinary user can supply this profile-update input:

   ```js
   updateProfile(db, { sub: "attacker", role: "user" }, { role: "admin" })
   ```

   `Object.assign` overwrites the stored user’s role. Calling `issueToken` for that user then produces a valid signed token containing `role:"admin"`; this was reproduced. **Impact:** any ordinary user can persistently elevate their account’s role and obtain administrator claims in subsequently issued tokens.